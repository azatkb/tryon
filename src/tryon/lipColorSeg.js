// lipColorSeg.js — lip contour fitted to the frame's own colours.
//
// Lips always have a clean, continuous outline. So the output here is NOT a
// per-pixel mask (those get holes from highlights, dents from shadows, ragged
// edges from noise) but ONE smooth closed curve:
//
//  1. Base shape: the MediaPipe outer-lip spline, densified to K points. It
//     carries the anatomy (cupid's bow, corners).
//  2. Colour model: Fisher LDA in CIELAB trained on this frame — lip samples
//     from the core of the MP polygon, skin samples from a ring outside it.
//     A heavy ridge on L keeps the decision chromatic (shadows ≠ lip).
//  3. Edge search: from each contour point, walk along the normal FROM THE
//     SKIN SIDE inward until the colour turns to lip and stays lip. Starting
//     on skin means highlights / dark spots INSIDE the lip can't dent the edge.
//  4. Regularise: weighted median outlier rejection, Gaussian smoothing of the
//     offsets along the contour, taper to zero at the mouth corners, temporal
//     EMA per point. Offsets are smooth, so the curve is smooth.
//  5. Confidence: when lip and skin colours can't be told apart (bare, pale
//     lips) offsets fade to zero → the MP spline.
//
// Lipstick = fill(outer curve) − mouth opening. Liner = fill(outer curve) −
// fill(outer curve pushed inward by the liner width). Both share the curve,
// so their outer edges coincide by construction, and neither can have holes.

import { LIPS_OUTER, LIPS_INNER } from './lips.js';
import { CFG } from './lipRenderer.js';

const GW = 224, GH = 140, N = GW * GH;
const SUB = 5;                       // samples per MP segment
const K = LIPS_OUTER.length * SUB;   // dense contour points (100)
const CORNER_L = 0, CORNER_R = 10 * SUB; // dense indices of landmarks 61 / 291

let cropCv, priorCv;
let prevPts = null, prevBox = null, prevInner = null;
let cutoutActive = false;
let version = 0;
let lastSeg = null;
let edgeRough = 0.75;  // 0 = perfectly smooth outline, 1 = most organic

/** Edge realism: 0 = clean vector-like outline, 1 = strongest organic roughness. */
export function setLipRoughness(v) { edgeRough = Math.max(0, Math.min(1, +v || 0)); }
export function getLipRoughness() { return edgeRough; }

// ── Organic edge texture ────────────────────────────────────────────────
// Deterministic hash → value noise that is PERIODIC along the closed contour.
// It's parameterised by contour position u ∈ [0,1) (anchored to the MP
// landmarks), so the texture travels with the lips and never shimmers.
function hash01(i, seed) {
  let x = (i * 374761393 + seed * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
function vnoise(u, F, seed) {
  const x = u * F, i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f);
  const a = hash01(((i % F) + F) % F, seed), b = hash01((((i + 1) % F) + F) % F, seed);
  return (a + (b - a) * s) * 2 - 1;
}
// Lip-line notches: narrow inward dips where vertical lip creases meet the edge.
const NOTCHES = Array.from({ length: 26 }, (_, i) => ({
  u: (i + 0.5 + 0.7 * (hash01(i, 7) - 0.5)) / 26,
  depth: 0.4 + 0.9 * hash01(i, 9),
  widthPx: 1.2 + 1.8 * hash01(i, 13),
}));

/**
 * Turn the smooth outline into an organic one: dense resample (~1.5 px),
 * then displace along the normal by multi-octave noise + lip-line notches.
 * Also returns a slightly larger, independently-noised "fringe" curve that is
 * painted semi-transparent: pigment catching skin texture at the very edge.
 */
function roughen(outer, nOut, t, perim, persp) {
  const amp0 = edgeRough * Math.max(0.15, 0.055 * t);  // image px (near side), ∝ lip size
  const notchScale = Math.max(0.3, Math.min(2, t / 20));  // notch width ∝ lip size
  const out = [], fringe = [];
  const n = outer.length;
  for (let k = 0; k < n; k++) {
    const a = outer[k], b = outer[(k + 1) % n], na = nOut[k], nb = nOut[(k + 1) % n];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const M = Math.max(1, Math.ceil(seg / 1.5));
    for (let j = 0; j < M; j++) {
      const f = j / M, u = (k + f) / n;
      const x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
      let nx = na[0] + (nb[0] - na[0]) * f, ny = na[1] + (nb[1] - na[1]) * f;
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      // Far side of a turned head: texture foreshortens with the surface.
      const amp = amp0 * (persp[k] + (persp[(k + 1) % n] - persp[k]) * f);
      // Upper lip has a crisper vermilion border than the lower one; both
      // fade to clean at the mouth corners (u = 0 and u = 0.5).
      const region = u < 0.5 ? 0.7 : 1.0;
      const cornerDist = Math.min(u, Math.abs(u - 0.5), 1 - u);
      const corner = Math.min(1, cornerDist / 0.05);
      let notch = 0;
      for (const N of NOTCHES) {
        let du = Math.abs(u - N.u); if (du > 0.5) du = 1 - du;
        const dpx = du * perim;
        const nw = N.widthPx * notchScale;
        if (dpx < 4 * nw) notch += N.depth * Math.exp(-(dpx * dpx) / (nw * nw));
      }
      const d = amp * region * corner * (0.55 * vnoise(u, 40, 1) + 0.35 * vnoise(u, 130, 2)
                                        + 0.22 * vnoise(u, 330, 4) - 1.5 * notch);
      out.push([x + nx * d, y + ny * d]);
      const df = d + amp * corner * (0.9 + 0.8 * vnoise(u, 95, 3) + 0.3 * vnoise(u, 260, 5));
      fringe.push([x + nx * df, y + ny * df]);
    }
  }
  return { out, fringe };
}

// Scratch buffers (allocated once)
const Lc = new Float32Array(N), Ac = new Float32Array(N), Bc = new Float32Array(N);
const OUT = new Float32Array(N), INN = new Float32Array(N);
const dIn = new Float32Array(N), dOut = new Float32Array(N), dMouth = new Float32Array(N);
const seed = new Uint8Array(N);
const P = new Float32Array(N), Pb = new Float32Array(N), Q = new Float32Array(N), Lb = new Float32Array(N);
const lipSel = new Uint8Array(N), skinSel = new Uint8Array(N);
const idxBuf = new Int32Array(N);
const rawOff = new Float32Array(K), wOff = new Float32Array(K), medOff = new Float32Array(K), smOff = new Float32Array(K);

// sRGB -> linear LUT
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
// Lab f(t) LUT (replaces cbrt in the per-pixel loop)
const FL_N = 4096, FL_MAX = 1.1;
const FLAB = new Float32Array(FL_N + 2);
for (let i = 0; i <= FL_N + 1; i++) {
  const t = (i / FL_N) * FL_MAX;
  FLAB[i] = t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}
function flab(t) {
  const f = t * (FL_N / FL_MAX);
  const i = f | 0;
  if (i >= FL_N) return FLAB[FL_N];
  return FLAB[i] + (FLAB[i + 1] - FLAB[i]) * (f - i);
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c._ctx = c.getContext('2d', { willReadFrequently: true });
  return c;
}
function ensure() {
  if (cropCv) return;
  cropCv = canvas(GW, GH);
  priorCv = canvas(GW, GH);
}

/** Same Bezier construction as lipRenderer's traceSmooth, sampled densely. */
function densify(pts) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    for (let s = 0; s < SUB; s++) {
      const u = s / SUB, v = 1 - u;
      const a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
      out.push([a * p1[0] + b * c1x + c * c2x + d * p2[0], a * p1[1] + b * c1y + c * c2y + d * p2[1]]);
    }
  }
  return out;
}

function polyPath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

/** One canvas pass, one readback: outer polygon -> R, mouth opening -> G. */
function rasterPriors(xf, outerD, innerD) {
  const c = priorCv._ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = '#000';
  c.fillRect(0, 0, GW, GH);
  c.setTransform(xf[0], 0, 0, xf[1], xf[2], xf[3]);
  c.globalCompositeOperation = 'lighter';
  c.fillStyle = '#f00'; polyPath(c, outerD); c.fill();
  c.fillStyle = '#0f0'; polyPath(c, innerD); c.fill();
  c.globalCompositeOperation = 'source-over';
  c.setTransform(1, 0, 0, 1, 0, 0);
  const d = c.getImageData(0, 0, GW, GH).data;
  for (let i = 0, o = 0; i < N; i++, o += 4) { OUT[i] = d[o] / 255; INN[i] = d[o + 1] / 255; }
}

/** 2-pass chamfer distance (image px) from every pixel to the nearest seed. */
function chamfer(d, ux, uy) {
  const ud = Math.hypot(ux, uy), BIG = 1e9;
  for (let i = 0; i < N; i++) d[i] = seed[i] ? 0 : BIG;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const i = y * GW + x; let v = d[i];
    if (x > 0 && d[i - 1] + ux < v) v = d[i - 1] + ux;
    if (y > 0) {
      if (d[i - GW] + uy < v) v = d[i - GW] + uy;
      if (x > 0 && d[i - GW - 1] + ud < v) v = d[i - GW - 1] + ud;
      if (x < GW - 1 && d[i - GW + 1] + ud < v) v = d[i - GW + 1] + ud;
    }
    d[i] = v;
  }
  for (let y = GH - 1; y >= 0; y--) for (let x = GW - 1; x >= 0; x--) {
    const i = y * GW + x; let v = d[i];
    if (x < GW - 1 && d[i + 1] + ux < v) v = d[i + 1] + ux;
    if (y < GH - 1) {
      if (d[i + GW] + uy < v) v = d[i + GW] + uy;
      if (x < GW - 1 && d[i + GW + 1] + ud < v) v = d[i + GW + 1] + ud;
      if (x > 0 && d[i + GW - 1] + ud < v) v = d[i + GW - 1] + ud;
    }
    d[i] = v;
  }
}

function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-9) return null;
  const s = 1 / det;
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

/** Mean + covariance of selected pixels, with one 2.5σ trimming pass. */
function stats(sel) {
  let n = 0;
  for (let i = 0; i < N; i++) if (sel[i]) idxBuf[n++] = i;
  for (let pass = 0; pass < 2; pass++) {
    if (n < 40) return null;
    let mL = 0, mA = 0, mB = 0;
    for (let k = 0; k < n; k++) { const i = idxBuf[k]; mL += Lc[i]; mA += Ac[i]; mB += Bc[i]; }
    mL /= n; mA /= n; mB /= n;
    let cLL = 0, cLA = 0, cLB = 0, cAA = 0, cAB = 0, cBB = 0;
    for (let k = 0; k < n; k++) {
      const i = idxBuf[k];
      const l = Lc[i] - mL, a = Ac[i] - mA, b = Bc[i] - mB;
      cLL += l * l; cLA += l * a; cLB += l * b; cAA += a * a; cAB += a * b; cBB += b * b;
    }
    const cov = [cLL / n, cLA / n, cLB / n, cLA / n, cAA / n, cAB / n, cLB / n, cAB / n, cBB / n];
    if (pass === 1) return { n, mu: [mL, mA, mB], cov };
    const sL = 2.5 * Math.sqrt(cov[0]) + 1e-3, sA = 2.5 * Math.sqrt(cov[4]) + 1e-3, sB = 2.5 * Math.sqrt(cov[8]) + 1e-3;
    let m = 0;
    for (let k = 0; k < n; k++) {
      const i = idxBuf[k];
      if (Math.abs(Lc[i] - mL) < sL && Math.abs(Ac[i] - mA) < sA && Math.abs(Bc[i] - mB) < sB) idxBuf[m++] = i;
    }
    n = m;
  }
  return null;
}

const smooth01 = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** Bilinear sample of the blurred lip-probability grid at image coords. */
function sampleP(x, y, xf) {
  const gx = x * xf[0] + xf[2] - 0.5, gy = y * xf[1] + xf[3] - 0.5;
  if (gx < 0 || gy < 0 || gx >= GW - 1 || gy >= GH - 1) return 0;
  const x0 = gx | 0, y0 = gy | 0, fx = gx - x0, fy = gy - y0, i = y0 * GW + x0;
  return (Q[i] * (1 - fx) + Q[i + 1] * fx) * (1 - fy) + (Q[i + GW] * (1 - fx) + Q[i + GW + 1] * fx) * fy;
}

function sampleGrid(arr, x, y, xf) {
  const gx = x * xf[0] + xf[2] - 0.5, gy = y * xf[1] + xf[3] - 0.5;
  if (gx < 0 || gy < 0 || gx >= GW - 1 || gy >= GH - 1) return 0;
  const x0 = gx | 0, y0 = gy | 0, fx = gx - x0, fy = gy - y0, i = y0 * GW + x0;
  return (arr[i] * (1 - fx) + arr[i + 1] * fx) * (1 - fy) + (arr[i + GW] * (1 - fx) + arr[i + GW + 1] * fx) * fy;
}

/**
 * Raw per-point edge offsets → smooth correction: robust median rejects
 * outliers, weighted Gaussian along the contour, pull toward 0 where evidence
 * is thin, taper, clamp.
 */
function regularise(raw, wt, out, t, taperFn, lo, hi, scale, supOut = null) {
  const win = 4, tmpV = [];
  for (let k = 0; k < K; k++) {
    tmpV.length = 0;
    for (let j = -win; j <= win; j++) { const q = (k + j + K) % K; if (wt[q] > 0.05) tmpV.push(raw[q]); }
    if (tmpV.length) { tmpV.sort((a, b) => a - b); medOff[k] = tmpV[tmpV.length >> 1]; } else medOff[k] = 0;
  }
  for (let k = 0; k < K; k++) if (Math.abs(raw[k] - medOff[k]) > 0.15 * t) wt[k] *= 0.05;
  const sigma = 3.0, R = 9;
  for (let k = 0; k < K; k++) {
    let sv = 0, sw = 0;
    for (let j = -R; j <= R; j++) {
      const q = (k + j + K) % K, ww = Math.exp(-(j * j) / (2 * sigma * sigma)) * wt[q];
      sv += ww * raw[q]; sw += ww;
    }
    const support = Math.min(1, sw / 1.5);
    if (supOut) supOut[k] = support;
    const v = sw > 1e-6 ? (sv / sw) * support : 0;
    out[k] = Math.max(lo, Math.min(hi, v * taperFn(k) * scale));
  }
}

// ── Bilateral symmetry ────────────────────────────────────────────────────
// Lips are left/right symmetric. Contour order (both outer and inner):
// upper corner→corner over dense 0..50, lower back over 50..100, so the
// mirror of k is 50−k on the upper lip and 150−k on the lower lip (pairs
// 61↔291, 185↔409 … 0↔0, 17↔17).
const mirrorK = (k) => (k <= CORNER_R ? CORNER_R - k : 3 * CORNER_R - k) % K;
const supBuf = new Float32Array(K);

let symStrength = 0.6;
/** 0 = each side fitted independently, 1 = strong symmetric prior. */
export function setLipSymmetry(v) { symStrength = Math.max(0, Math.min(1.5, +v || 0)); }

/**
 * Symmetric SHAPE, not symmetric corrections: MediaPipe's own errors differ
 * per side, so mirroring offsets would copy the wrong fix across. Instead the
 * lip's thickness profile — distance from the mouth line (inner contour) to
 * the outer edge, which a head turn barely foreshortens — is blended with the
 * mirror point's, weighted by how well each is SEEN (perspective visibility³ ×
 * colour-edge support). Frontal: both sides reliable, each keeps mostly its
 * own shape. Turned head: the barely-visible side takes the visible side's
 * profile. `tgt` (2K floats, x/y) is rebuilt in place from the mouth line.
 */
const thk = new Float32Array(K), mx = new Float32Array(K);
function symmetriseThickness(tgt, innerD, sup, persp) {
  if (symStrength <= 0) return;
  // Mouth frame: X along corner→corner, Y perpendicular, pointing to the lips
  // of the upper half. Thickness is measured straight across the mouth line,
  // so the horizontal squash on the far side of a turn doesn't distort it.
  const L0 = innerD[CORNER_L], R0 = innerD[CORNER_R];
  let ex = R0[0] - L0[0], ey = R0[1] - L0[1];
  const el = Math.hypot(ex, ey) || 1; ex /= el; ey /= el;
  let ux = ey, uy = -ex;                                   // perpendicular
  const cx = (L0[0] + R0[0]) / 2, cy = (L0[1] + R0[1]) / 2;
  if ((tgt[2 * (CORNER_R / 2)] - cx) * ux + (tgt[2 * (CORNER_R / 2) + 1] - cy) * uy < 0) { ux = -ux; uy = -uy; }
  const toX = (x, y) => (x - cx) * ex + (y - cy) * ey;
  const toY = (x, y) => (x - cx) * ux + (y - cy) * uy;
  // Mouth line (inner contour) as y(x) for the upper and the lower half.
  const half = (from, to) => {
    const pts = [];
    for (let k = from; k <= to; k++) { const q = innerD[k % K]; pts.push([toX(q[0], q[1]), toY(q[0], q[1])]); }
    pts.sort((p1, p2) => p1[0] - p2[0]);
    return pts;
  };
  const upLine = half(0, CORNER_R), loLine = half(CORNER_R, K);
  const yAt = (line, xq) => {
    if (xq <= line[0][0]) return line[0][1];
    for (let i = 1; i < line.length; i++) {
      if (xq <= line[i][0]) {
        const f = (xq - line[i - 1][0]) / Math.max(1e-6, line[i][0] - line[i - 1][0]);
        return line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f;
      }
    }
    return line[line.length - 1][1];
  };
  for (let k = 0; k < K; k++) {
    const x = toX(tgt[2 * k], tgt[2 * k + 1]), y = toY(tgt[2 * k], tgt[2 * k + 1]);
    const upper = k <= CORNER_R;
    mx[k] = x;
    thk[k] = upper ? y - yAt(upLine, x) : yAt(loLine, x) - y;   // ≥ 0 inside the lip
  }
  for (let k = 0; k < K; k++) {
    if (k === CORNER_L || k === CORNER_R) continue;         // corners stay put
    const m = mirrorK(k);
    const pk = persp[k], pm = persp[m];
    const rk = pk * pk * pk * (0.25 + 0.75 * sup[k]);
    const rm = pm * pm * pm * (0.25 + 0.75 * sup[m]) * symStrength;
    const t2 = (rk * thk[k] + rm * thk[m]) / Math.max(1e-6, rk + rm);
    const upper = k <= CORNER_R;
    const y2 = upper ? yAt(upLine, mx[k]) + t2 : yAt(loLine, mx[k]) - t2;
    tgt[2 * k] = cx + ex * mx[k] + ux * y2;
    tgt[2 * k + 1] = cy + ey * mx[k] + uy * y2;
  }
}

/**
 * Per-point visibility / foreshortening of the outer contour from MediaPipe's
 * 3D points (1 = facing the camera, smaller = turned away), plus the mouth's
 * 3D width. Used for liner width, edge texture and the symmetry weights.
 */
function contourPerspective(lms, w, h) {
  const P3 = (i) => [lms[i].x * w, lms[i].y * h, (lms[i].z || 0) * w];
  const m61 = P3(61), m291 = P3(291);
  const mouth3D = Math.hypot(m61[0] - m291[0], m61[1] - m291[1], m61[2] - m291[2]);
  const nMP = LIPS_OUTER.length, fMP = new Float32Array(nMP);
  for (let i = 0; i < nMP; i++) {
    const a3 = P3(LIPS_OUTER[(i - 1 + nMP) % nMP]), b3 = P3(LIPS_OUTER[(i + 1) % nMP]);
    const o3 = P3(LIPS_OUTER[i]), q3 = P3(LIPS_INNER[i]);
    let tx = b3[0] - a3[0], ty = b3[1] - a3[1], tz = b3[2] - a3[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    const along = Math.hypot(tx, ty) / tl;               // edge foreshortening (yaw)
    tx /= tl; ty /= tl; tz /= tl;
    let ux3 = q3[0] - o3[0], uy3 = q3[1] - o3[1], uz3 = q3[2] - o3[2];
    const dot = ux3 * tx + uy3 * ty + uz3 * tz;
    ux3 -= dot * tx; uy3 -= dot * ty; uz3 -= dot * tz;     // across the lip, ⟂ edge
    const ul = Math.hypot(ux3, uy3, uz3);
    const across = ul > 1e-6 ? Math.hypot(ux3, uy3) / ul : 1; // band foreshortening (pitch / far corner)
    // The lip is a curved surface: on the far side of a turn the whole patch
    // shrinks. Weighted geometric mean of both directions (edge direction
    // dominant) reads as natural perspective.
    fMP[i] = Math.pow(Math.max(0.05, along), 0.7) * Math.pow(Math.max(0.05, across), 0.3);
  }
  const sorted = Array.from(fMP).sort((x, y) => x - y);
  const ref = Math.max(0.2, sorted[Math.floor(sorted.length * 0.8)]);
  const persp = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    const i = Math.floor(k / SUB), f = (k % SUB) / SUB;
    const v = fMP[i] + (fMP[(i + 1) % nMP] - fMP[i]) * f;
    persp[k] = Math.max(0.3, Math.min(1, v / ref));
  }
  return { persp, mouth3D };
}

/** Proper intersection point of segments ab and cd, or null. */
function segX(a, b, c, d) {
  const r0 = b[0] - a[0], r1 = b[1] - a[1], s0 = d[0] - c[0], s1 = d[1] - c[1];
  const den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-12) return null;
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const tt = (qx * s1 - qy * s0) / den, uu = (qx * r1 - qy * r0) / den;
  if (tt <= 1e-9 || tt >= 1 - 1e-9 || uu <= 1e-9 || uu >= 1 - 1e-9) return null;
  return [a[0] + tt * r0, a[1] + tt * r1];
}

/**
 * Remove self-intersection loops from a closed polyline. A loop that folds
 * back over the shape has the opposite winding, and filling it would punch a
 * HOLE in the lips (dense far-corner points on a turned head, offsets, edge
 * texture). The smaller side of each crossing is cut off.
 */
function untangle(pts) {
  let p = pts;
  for (let guard = 0; guard < 64; guard++) {
    const n = p.length;
    if (n < 4) return p;
    const bx0 = new Float32Array(n), bx1 = new Float32Array(n), by0 = new Float32Array(n), by1 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n];
      bx0[i] = Math.min(a[0], b[0]);
      bx1[i] = Math.max(a[0], b[0]);
      by0[i] = Math.min(a[1], b[1]);
      by1[i] = Math.max(a[1], b[1]);
    }
    let hit = null;
    for (let i = 0; i < n && !hit; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (bx1[j] < bx0[i] || bx0[j] > bx1[i] || by1[j] < by0[i] || by0[j] > by1[i]) continue;
        const X = segX(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n]);
        if (X) {
          hit = [i, j, X];
          break;
        }
      }
    }
    if (!hit) return p;
    const [i, j, X] = hit;
    p = j - i <= n - (j - i) ? [...p.slice(0, i + 1), X, ...p.slice(j + 1)] : [X, ...p.slice(i + 1, j + 1)];
  }
  return p;
}

/** Outward unit normals of a closed polyline (orientation-safe). */
function normals(pts) {
  const n = pts.length;
  let cx = 0, cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= n;
  cy /= n;
  const out = new Array(n);
  let vote = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    out[i] = [ty, -tx];
    vote += out[i][0] * (pts[i][0] - cx) + out[i][1] * (pts[i][1] - cy);
  }
  if (vote < 0) for (const v of out) {
    v[0] = -v[0];
    v[1] = -v[1];
  }
  return out;
}

/**
 * Fit the lip outline of one frame.
 * @returns {{ outer, outerSmooth, fringe, linerInner, inner, safe, bbox, conf, dprime, version } | null}
 *   Curves are arrays of [x, y] in frame px. `safe` is null unless the mouth
 *   is open (then cut = inner ∩ safe).
 */
export function segmentLipsColor(src, w, h, lms, opts = {}) {
  if (!src || !lms || lms.length < 468) return null;
  ensure();
  const Pt = (i) => [lms[i].x * w, lms[i].y * h];
  const outerMP = LIPS_OUTER.map(Pt), innerMP = LIPS_INNER.map(Pt);
  const outerD = densify(outerMP), innerD = densify(innerMP);
  const dist = (a2, b) => Math.hypot(a2[0] - b[0], a2[1] - b[1]);
  const t = Math.max(4, Math.min(dist(Pt(0), Pt(13)), dist(Pt(14), Pt(17))));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of outerD) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const pad = 1.15 * t + 4;
  const bx = Math.max(0, Math.floor(x0 - pad)), by = Math.max(0, Math.floor(y0 - pad));
  const bw = Math.min(w, Math.ceil(x1 + pad)) - bx, bh = Math.min(h, Math.ceil(y1 + pad)) - by;
  if (bw < 8 || bh < 8) return null;
  const sx = GW / bw, sy = GH / bh, ux = 1 / sx, uy = 1 / sy;
  const xf = [sx, sy, -bx * sx, -by * sy];
  const p3 = (i) => [lms[i].x * w, lms[i].y * h, (lms[i].z || 0) * w];
  const d3 = (a2, b) => Math.hypot(a2[0] - b[0], a2[1] - b[1], a2[2] - b[2]);
  const gap = d3(p3(13), p3(14)), lipW = d3(p3(61), p3(291));
  const ratio = lipW > 0 ? gap / lipW : 0;
  cutoutActive = ratio > (cutoutActive ? 0.03 : 0.05);
  const cc = cropCv._ctx;
  cc.imageSmoothingEnabled = true;
  try {
    cc.drawImage(src, bx, by, bw, bh, 0, 0, GW, GH);
  } catch (_) {
    return null;
  }
  const px = cc.getImageData(0, 0, GW, GH).data;
  for (let i = 0, o = 0; i < N; i++, o += 4) {
    const r = LIN[px[o]], g = LIN[px[o + 1]], b = LIN[px[o + 2]];
    const fx = flab((0.4124 * r + 0.3576 * g + 0.1805 * b) * (1 / 0.95047));
    const fy = flab(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const fz = flab((0.0193 * r + 0.1192 * g + 0.9505 * b) * (1 / 1.08883));
    Lc[i] = 116 * fy - 16;
    Ac[i] = 500 * (fx - fy);
    Bc[i] = 200 * (fy - fz);
  }
  rasterPriors(xf, outerD, innerD);
  for (let i = 0; i < N; i++) seed[i] = OUT[i] < 0.5 ? 1 : 0;
  chamfer(dIn, ux, uy);
  for (let i = 0; i < N; i++) seed[i] = OUT[i] >= 0.5 ? 1 : 0;
  chamfer(dOut, ux, uy);
  for (let i = 0; i < N; i++) seed[i] = INN[i] >= 0.5 ? 1 : 0;
  chamfer(dMouth, ux, uy);
  const coreD = 0.45 * t, skinLo = 0.42 * t, skinHi = 0.95 * t, mouthGuard = 0.25 * t;
  for (let i = 0; i < N; i++) {
    const L = Lc[i];
    lipSel[i] = OUT[i] >= 0.5 && dIn[i] >= coreD && dMouth[i] >= mouthGuard && L > 8 && L < 92 ? 1 : 0;
    skinSel[i] = OUT[i] < 0.5 && dOut[i] >= skinLo && dOut[i] <= skinHi && L > 12 && L < 97 ? 1 : 0;
  }
  const S = stats(skinSel), Lp = stats(lipSel);
  let conf = 0, dprime = 0;
  if (S && Lp) {
    const sw = S.n + Lp.n;
    const cov = S.cov.map((v, k) => (v * S.n + Lp.cov[k] * Lp.n) / sw);
    cov[0] += 60;
    cov[4] += 1.5;
    cov[8] += 1.5;
    const ic = inv3(cov);
    if (ic) {
      const d0 = Lp.mu[0] - S.mu[0], d1 = Lp.mu[1] - S.mu[1], d2 = Lp.mu[2] - S.mu[2];
      const w0 = ic[0] * d0 + ic[1] * d1 + ic[2] * d2;
      const w1 = ic[3] * d0 + ic[4] * d1 + ic[5] * d2;
      const w2 = ic[6] * d0 + ic[7] * d1 + ic[8] * d2;
      const proj = (m) => w0 * m[0] + w1 * m[1] + w2 * m[2];
      const sd = (C) => Math.sqrt(Math.max(
        1e-6,
        w0 * (C[0] * w0 + C[1] * w1 + C[2] * w2) + w1 * (C[3] * w0 + C[4] * w1 + C[5] * w2) + w2 * (C[6] * w0 + C[7] * w1 + C[8] * w2)
      ));
      const pL = proj(Lp.mu), pS = proj(S.mu), sL = sd(Lp.cov), sS = sd(S.cov);
      dprime = (pL - pS) / Math.sqrt(0.5 * (sL * sL + sS * sS));
      const thr = 0.5 * (pL + pS);
      const scale = 2.4 / (0.5 * (sL + sS));
      conf = smooth01(1, 2.2, dprime);
      for (let i = 0; i < N; i++) {
        const s = w0 * Lc[i] + w1 * Ac[i] + w2 * Bc[i];
        P[i] = 1 / (1 + Math.exp(-(s - thr) * scale));
      }
      for (let y = 0; y < GH; y++) {
        const ya = y > 0 ? -GW : 0, yb = y < GH - 1 ? GW : 0;
        for (let x = 0; x < GW; x++) {
          const i = y * GW + x, xa = x > 0 ? -1 : 0, xb = x < GW - 1 ? 1 : 0;
          Pb[i] = (P[i + ya + xa] + P[i + ya] + P[i + ya + xb] + P[i + xa] + P[i] + P[i + xb] + P[i + yb + xa] + P[i + yb] + P[i + yb + xb]) / 9;
        }
      }
      for (let y = 0; y < GH; y++) {
        const ya = y > 0 ? -GW : 0, yb = y < GH - 1 ? GW : 0;
        for (let x = 0; x < GW; x++) {
          const i = y * GW + x, xa = x > 0 ? -1 : 0, xb = x < GW - 1 ? 1 : 0;
          Lb[i] = (Lc[i + ya + xa] + Lc[i + ya] + Lc[i + ya + xb] + Lc[i + xa] + Lc[i] + Lc[i + xb] + Lc[i + yb + xa] + Lc[i + yb] + Lc[i + yb + xb]) / 9;
        }
      }
      let mr = 0, mr2 = 0, nr = 0;
      for (let i = 0; i < N; i++) if (skinSel[i]) {
        const r = Math.hypot(Ac[i], Bc[i]) / (Lc[i] + 5);
        mr += r;
        mr2 += r * r;
        nr++;
      }
      mr /= nr;
      const sr = Math.sqrt(Math.max(1e-6, mr2 / nr - mr * mr));
      const hiL = S.mu[0] + 6, hiR = Math.min(mr - 2 * sr, 0.8 * mr);
      for (let i = 0; i < N; i++) {
        const r = Math.hypot(Ac[i], Bc[i]) / (Lc[i] + 5);
        P[i] = Lc[i] > hiL && r < hiR ? 1 : 0;
      }
      for (let y = 0; y < GH; y++) {
        const ya = y > 0 ? -GW : 0, yb = y < GH - 1 ? GW : 0;
        for (let x = 0; x < GW; x++) {
          const i = y * GW + x, xa = x > 0 ? -1 : 0, xb = x < GW - 1 ? 1 : 0;
          const hb = (P[i + ya + xa] + P[i + ya] + P[i + ya + xb] + P[i + xa] + P[i] + P[i + xb] + P[i + yb + xa] + P[i + yb] + P[i + yb + xb]) / 9;
          Q[i] = Pb[i] > hb ? Pb[i] : hb;
        }
      }
    }
  }
  const nrm = normals(outerD);
  const rOut = 0.5 * t, rIn = 0.35 * t, step = 0.5;
  const nSteps = Math.max(4, Math.ceil((rOut + rIn) / step));
  for (let k = 0; k < K; k++) {
    rawOff[k] = 0;
    wOff[k] = 0;
    if (conf <= 0) continue;
    const [bxk, byk] = outerD[k], [nx, ny] = nrm[k];
    const at = (s) => sampleP(bxk + nx * s, byk + ny * s, xf);
    if (at(rOut) >= 0.5 || at(rOut - step) >= 0.5) continue;
    let found = false;
    for (let j = 1; j <= nSteps; j++) {
      const s = rOut - j * step;
      if (at(s) >= 0.5 && at(s - step) >= 0.5 && at(s - 2 * step) >= 0.5) {
        const pa = at(s + step), pb = at(s);
        const f = pb - pa > 1e-4 ? (0.5 - pa) / (pb - pa) : 0.5;
        let edge = s + step - f * step;
        const Lat = (s2) => sampleGrid(Lb, bxk + nx * s2, byk + ny * s2, xf);
        const skinRef = (Lat(edge + 0.35 * t) + Lat(edge + 0.45 * t)) / 2;
        const lipRef = (Lat(edge - 0.15 * t) + Lat(edge - 0.25 * t)) / 2;
        const rollMin = Math.max(skinRef, lipRef) + 3;
        const maxRoll = Math.min(0.22 * t, 5);
        let e2 = edge;
        for (let s2 = edge + step; s2 <= edge + maxRoll; s2 += step) {
          if (Lat(s2) > rollMin) e2 = s2;
          else if (s2 - edge > 1.5) break;
        }
        rawOff[k] = Math.min(rOut, e2);
        const pin = (at(s - step) + at(s - 2 * step)) / 2, pout = (at(s + 2 * step) + at(s + 3 * step)) / 2;
        wOff[k] = Math.max(0, Math.min(1, (pin - pout) * 1.6));
        found = true;
        break;
      }
    }
    if (!found) {
      rawOff[k] = -rIn;
      wOff[k] = 0.15;
    }
  }
  const taper = (k) => {
    const d = Math.min(Math.abs(k - CORNER_L), K - Math.abs(k - CORNER_L), Math.abs(k - CORNER_R));
    return smooth01(0, 2.5 * SUB, d);
  };
  regularise(rawOff, wOff, smOff, t, taper, -rIn, rOut, conf, supBuf);
  // Perspective visibility per contour point (liner width, edge texture and
  // the symmetric shape prior below).
  const { persp, mouth3D } = contourPerspective(lms, w, h);
  const box = [bx, by, bw, bh];
  let fresh = !prevPts || !prevBox;
  if (!fresh) {
    const dc = Math.hypot(bx + bw / 2 - (prevBox[0] + prevBox[2] / 2), by + bh / 2 - (prevBox[1] + prevBox[3] / 2));
    if (dc > 0.2 * bw || Math.abs(bw / prevBox[2] - 1) > 0.2 || Math.abs(bh / prevBox[3] - 1) > 0.35) fresh = true;
  }
  if (!prevPts) prevPts = new Float32Array(K * 2);
  const a = fresh ? 1 : opts.moving ? 0.75 : 0.3;
  const outer = new Array(K);
  const tgt = new Float32Array(K * 2);
  for (let k = 0; k < K; k++) {
    tgt[2 * k] = outerD[k][0] + nrm[k][0] * smOff[k];
    tgt[2 * k + 1] = outerD[k][1] + nrm[k][1] * smOff[k];
  }
  // Left/right proportion: the side you can barely see gets the seen side's shape.
  symmetriseThickness(tgt, innerD, supBuf, persp);
  for (let k = 0; k < K; k++) {
    const tx = tgt[2 * k], ty = tgt[2 * k + 1];
    const x = prevPts[2 * k] * (1 - a) + tx * a, y = prevPts[2 * k + 1] * (1 - a) + ty * a;
    prevPts[2 * k] = x;
    prevPts[2 * k + 1] = y;
    outer[k] = [x, y];
  }
  prevBox = box;
  let inner = innerD;
  if (cutoutActive && conf > 0 && Lp) {
    const nIn = normals(innerD);
    const lipLmin = Lp.mu[0] - 2.2 * Math.sqrt(Lp.cov[0]);
    const lipLike = (x, y) => sampleGrid(Pb, x, y, xf) >= 0.5 && sampleGrid(Lb, x, y, xf) >= lipLmin;
    const rB = 0.45 * t;
    for (let k = 0; k < K; k++) {
      rawOff[k] = 0;
      wOff[k] = 0;
      const o = innerD[(K - k) % K];
      const gapK = Math.hypot(o[0] - innerD[k][0], o[1] - innerD[k][1]);
      if (gapK < 3) continue;
      const rA = 0.45 * gapK;
      const [bxk, byk] = innerD[k], [nx, ny] = nIn[k];
      const like = (s2) => lipLike(bxk + nx * s2, byk + ny * s2);
      if (like(-rA) || like(-rA + step)) continue;
      const n2 = Math.ceil((rA + rB) / step);
      for (let j = 1; j <= n2; j++) {
        const s2 = -rA + j * step;
        if (like(s2) && like(s2 + step) && like(s2 + 2 * step)) {
          rawOff[k] = s2 - 0.5 * step;
          wOff[k] = 1;
          break;
        }
      }
    }
    const innerTaper = (k) => {
      const d = Math.min(Math.abs(k - CORNER_L), K - Math.abs(k - CORNER_L), Math.abs(k - CORNER_R));
      return smooth01(0.3 * SUB, 1.5 * SUB, d);
    };
    regularise(rawOff, wOff, smOff, t, innerTaper, -0.7 * t, 0.2 * t, conf);
    if (!prevInner || fresh) prevInner = new Float32Array(K * 2).fill(NaN);
    const ai = opts.moving ? 0.75 : 0.35;
    inner = new Array(K);
    for (let k = 0; k < K; k++) {
      const tx = innerD[k][0] + nIn[k][0] * smOff[k], ty = innerD[k][1] + nIn[k][1] * smOff[k];
      const px0 = prevInner[2 * k], py0 = prevInner[2 * k + 1];
      const x = Number.isNaN(px0) ? tx : px0 * (1 - ai) + tx * ai;
      const y = Number.isNaN(py0) ? ty : py0 * (1 - ai) + ty * ai;
      prevInner[2 * k] = x;
      prevInner[2 * k + 1] = y;
      inner[k] = [x, y];
    }
  } else {
    prevInner = null;
  }

  // ── Liner geometry: perspective + thickness cap ──
  // Width scales with the mouth's 3D size (not the frame), shrinks on the far
  // side of a turned head, and never exceeds a third of the local lip
  // thickness (a thin upper lip must not turn dark).
  // Strictly proportional to the mouth's 3D width: CFG.lipLiner.width is the
  // liner width (× frame width) for a mouth spanning 16 % of the frame. A
  // far-away face gets a proportionally thin line; under ~1 px the canvas
  // anti-aliasing turns it into a lighter hairline, which is what it looks
  // like on a real face at that distance.
  const linerPx = Math.max(0.6, (CFG.lipLiner.width / 0.16) * mouth3D);

  const nOut = normals(outer);
  const linerInner = outer.map(([x, y], k) => {
    // local lip thickness: distance to the nearest inner-edge point
    let dmin = Infinity;
    for (let j = 0; j < K; j++) { const q = innerD[j]; const dd = (q[0] - x) ** 2 + (q[1] - y) ** 2; if (dd < dmin) dmin = dd; }
    const wk = Math.min(linerPx * persp[k], Math.sqrt(dmin) / 3);
    return [x - nOut[k][0] * wk, y - nOut[k][1] * wk];
  });
  let perim = 0;
  for (let k = 0; k < K; k++) { const a2 = outer[k], b2 = outer[(k + 1) % K]; perim += Math.hypot(b2[0] - a2[0], b2[1] - a2[1]); }
  const rough = edgeRough > 0 ? roughen(outer, nOut, t, perim, persp) : null;
  let safe = null;
  if (cutoutActive) {
    let ocx = 0, ocy = 0;
    for (const [x, y] of outer) { ocx += x; ocy += y; }
    ocx /= outer.length; ocy /= outer.length;
    // Refined inner edge is trustworthy → a looser safety clamp.
    const shrink = inner !== innerD ? 0.12 : 0.25;
    safe = outer.map(([x, y]) => [x + (ocx - x) * shrink, y + (ocy - y) * shrink]);
  }

  lastSeg = {
    outer: untangle(rough ? rough.out : outer),   // organic outline (what gets painted)
    outerSmooth: outer,                    // the regularised fit, for overlays
    fringe: rough ? untangle(rough.fringe) : null, // semi-transparent pigment fringe
    linerInner: untangle(linerInner), inner: untangle(inner), safe, bbox: box, conf, dprime, version: ++version,
    t,                                     // lip thickness (px) — shaders scale their edge band by it
  };
  return lastSeg;
}

/** Most recent fit (for debug overlays). */
export function getLastLipSeg() { return lastSeg; }

/** Forget temporal state (call on source change). */
export function resetLipSeg() { prevPts = null; prevBox = null; prevInner = null; lastSeg = null; cutoutActive = false; }