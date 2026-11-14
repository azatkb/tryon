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

let edgeSoft = 1.0;    // lip→skin transition width multiplier (0 = hard cut-out edge)
/** Lip→skin transition softness: 0 = hard edge, 1 = natural (default), 2 = very soft. */
export function setLipSoftness(v) { edgeSoft = Math.max(0, Math.min(2, +v || 0)); }
// Mouth opening from pixels (experimental). Off = MediaPipe decides open/closed
// and the inner edge is refined around MP's inner contour (previous behaviour).
// Inner lip edge / mouth opening mode:
//   'mp'      — MediaPipe's 3D gap decides open/closed, inner edge refined
//               from colour around MP's inner contour (default, previous)
//   'predict' — inner edge PREDICTED from the fitted outer contour and this
//               person's lip thickness (learned while the mouth is closed);
//               pixels only refine it inside a narrow band
//   'pixel'   — experimental: opening searched in the pixels
let openMode = 'mp';
const OUTER_RULES = false;
export function setLipOpenDetect(v) {
  openMode = v === true ? 'pixel' : v === 'predict' || v === 'pixel' ? v : 'mp';
  prevInner = null;
}
export function getLipOpenDetect() { return openMode; }
// Per-person lip thickness model ('predict'): upper/lower vermilion thickness
// per mouth column, in eye-distance units, learned on a closed, still mouth.
const MC = 51;   // columns corner→corner (= CORNER_R + 1)
let lipModel = null;
export function getLipModel() { return lipModel; }
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
 * Turn the smooth outline into the painted edge.
 *
 * Sampling is FIXED: SS samples per contour segment, uniform in the anatomical
 * parameter u. (Sampling by arc length made the sample count jump frame to
 * frame, and the finest noise octave aliased into visible edge shimmer.)
 *
 * Per sample:
 *  · organic displacement along the normal — multi-octave value noise +
 *    lip-line notches, anchored to u so it travels with the lips;
 *  · a transition width `soft` — how gradually lip colour fades into skin.
 *    From the references: the upper vermilion border is fairly defined
 *    (~0.10 t), the lower lip edge melts into skin / the shadow below
 *    (~0.22 t), and the mouth corners dissolve (up to ~3.5× softer).
 *
 * The edge is then built as LAYERS nested curves (from slightly outside the
 * edge to inside it), each painted at 1/LAYERS alpha — a smooth, uneven,
 * natural fade instead of a cut-out sticker edge. Inward offsets are capped
 * by the local lip thickness so layers can't fold over at the corners.
 */
const SS = 5, LAYERS = 8;
function roughen(outer, nOut, t, perim, persp, thick) {
  const amp0 = edgeRough * Math.max(0.15, 0.055 * t);  // image px (near side), ∝ lip size
  const notchScale = Math.max(0.3, Math.min(2, t / 20));  // notch width ∝ lip size
  const n = outer.length;
  const base = [], nrmS = [], soft = [], thk = [], outFrac = [];
  for (let k = 0; k < n; k++) {
    const a = outer[k], b = outer[(k + 1) % n], na = nOut[k], nb = nOut[(k + 1) % n];
    for (let j = 0; j < SS; j++) {
      const f = j / SS, u = (k + f) / n;
      const x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
      let nx = na[0] + (nb[0] - na[0]) * f, ny = na[1] + (nb[1] - na[1]) * f;
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      const pz = persp[k] + (persp[(k + 1) % n] - persp[k]) * f;   // far side foreshortens
      const th = thick[k] + (thick[(k + 1) % n] - thick[k]) * f;
      const upper = u < 0.5;
      const cornerDist = Math.min(u, Math.abs(u - 0.5), 1 - u);
      // organic displacement
      let d = 0;
      if (amp0 > 0) {
        const corner = Math.min(1, cornerDist / 0.05);
        let notch = 0;
        for (const N of NOTCHES) {
          let du = Math.abs(u - N.u); if (du > 0.5) du = 1 - du;
          const dpx = du * perim, nw = N.widthPx * notchScale;
          if (dpx < 4 * nw) notch += N.depth * Math.exp(-(dpx * dpx) / (nw * nw));
        }
        d = amp0 * pz * (upper ? 0.7 : 1.0) * corner
          * (0.55 * vnoise(u, 40, 1) + 0.35 * vnoise(u, 130, 2) + 0.18 * vnoise(u, 200, 4) - 1.5 * notch);
      }
      base.push([x + nx * d, y + ny * d]);
      nrmS.push([nx, ny]);
      // transition width (px)
      const cornerBoost = 1 + 1.2 * (1 - smooth01(0, 0.07, cornerDist));
      const unevenness = 1 + 0.25 * vnoise(u, 25, 6);          // the fade itself isn't uniform
      soft.push(Math.max(0.5, edgeSoft * t * (upper ? 0.10 : 0.22) * cornerBoost * pz * unevenness) * (edgeSoft > 0 ? 1 : 0));
      thk.push(th);
      // Near the corners the fade must not spill outward past the mouth —
      // colour fades INTO the corner (see the corner fade in the renderer).
      outFrac.push(0.45 - 0.37 * (1 - smooth01(0, 0.07, cornerDist)));
    }
  }
  // Lipstick layers: real lipstick colours the lip right up to its border and
  // fades OUTSIDE it — so coverage is ~90 % on the fitted edge (a 50 % edge
  // let the pale natural lip / white roll show as a light rim). Offsets run
  // from +(outFrac+0.3)·soft onto the skin to −0.25·soft.
  const mk = (n, from, span) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const fpos = (i + 0.5) / n;
      const pts = new Array(base.length);
      for (let q = 0; q < base.length; q++) {
        let off = soft[q] * (from(q) - span * fpos);
        if (off < 0) off = Math.max(off, -0.35 * thk[q]);    // never fold inward at thin parts
        pts[q] = [base[q][0] + nrmS[q][0] * off, base[q][1] + nrmS[q][1] * off];
      }
      out.push(pts);
    }
    return out;
  };
  const layers = mk(LAYERS, (q) => outFrac[q] + 0.3, 1.0);
  // Liner layers stop AT the edge (a dark liner fading onto the skin read as a
  // dark stripe above the upper lip); just a short inward fade.
  const linerLayers = mk(4, () => 0.06, 0.45);
  return { base, layers, linerLayers };
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

/**
 * Temporal filter for a contour (in place on `prev`, 2K floats):
 *  1. carry the previous contour along with the face — least-squares
 *     similarity (translation + rotation + scale) from prev → target, applied
 *     to prev. Rigid head motion is followed with zero lag;
 *  2. then smooth only the per-point RESIDUAL. That residual is mostly
 *     landmark noise, so it's damped hard; a large residual (mouth opening,
 *     a real shape change) raises the gain so it's followed quickly.
 */
function trackContour(prev, tgt, n, base, gain) {
  let pcx = 0, pcy = 0, qcx = 0, qcy = 0;   // eslint-disable-line prefer-const
  for (let k = 0; k < n; k++) { pcx += prev[2 * k]; pcy += prev[2 * k + 1]; qcx += tgt[2 * k]; qcy += tgt[2 * k + 1]; }
  pcx /= n; pcy /= n; qcx /= n; qcy /= n;
  let sa = 0, sb = 0, sp = 0;
  for (let k = 0; k < n; k++) {
    const px = prev[2 * k] - pcx, py = prev[2 * k + 1] - pcy, qx = tgt[2 * k] - qcx, qy = tgt[2 * k + 1] - qcy;
    sa += px * qx + py * qy; sb += px * qy - py * qx; sp += px * px + py * py;
  }
  let A = sp > 1e-9 ? sa / sp : 1, B = sp > 1e-9 ? sb / sp : 0;   // (A + iB) = s·e^{iθ}
  // A sub-pixel rigid "motion" is landmark noise moving the whole contour —
  // carry it only partly. From ~1 px of mean displacement up, carry fully.
  let disp = 0;
  for (let k = 0; k < n; k++) {
    const px = prev[2 * k] - pcx, py = prev[2 * k + 1] - pcy;
    disp += Math.hypot(A * px - B * py + qcx - prev[2 * k], B * px + A * py + qcy - prev[2 * k + 1]);
  }
  disp /= n;
  const g = Math.min(1, 0.2 + disp / 1.2);
  A = 1 + (A - 1) * g; B *= g;
  qcx = pcx + (qcx - pcx) * g; qcy = pcy + (qcy - pcy) * g;
  for (let k = 0; k < n; k++) {
    const px = prev[2 * k] - pcx, py = prev[2 * k + 1] - pcy;
    const cx = A * px - B * py + qcx, cy = B * px + A * py + qcy;     // carried
    const rx = tgt[2 * k] - cx, ry = tgt[2 * k + 1] - cy;            // residual
    const a = Math.min(0.9, base + Math.hypot(rx, ry) / gain);
    prev[2 * k] = cx + rx * a; prev[2 * k + 1] = cy + ry * a;
  }
}

/** True if a closed polyline crosses itself (bbox-pruned O(n²)). */
function selfIntersects(p) {
  const n = p.length;
  const bx0 = new Float32Array(n), bx1 = new Float32Array(n), by0 = new Float32Array(n), by1 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    bx0[i] = Math.min(a[0], b[0]); bx1[i] = Math.max(a[0], b[0]);
    by0[i] = Math.min(a[1], b[1]); by1[i] = Math.max(a[1], b[1]);
  }
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (bx1[j] < bx0[i] || bx0[j] > bx1[i] || by1[j] < by0[i] || by0[j] > by1[i]) continue;
    if (segX(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return true;
  }
  return false;
}

/**
 * Which parts of a lip contour FACE the camera (0 = turned away / hidden).
 * Face normal from MediaPipe's 3D points (cheek→cheek × forehead→chin); the
 * lips wrap around the face, so each point's local normal is that normal
 * rotated about the face's up-axis by its lateral position on the mouth
 * (±40° at the corners). In profile the far half gets visibility ≤ 0.
 */
function contourVisibility(lms, w, h, IDX) {
  const P3 = (i) => [lms[i].x * w, lms[i].y * h, (lms[i].z || 0) * w];
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const nrm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const right = sub3(P3(454), P3(234)), down = sub3(P3(152), P3(10));
  const c = [right[1] * down[2] - right[2] * down[1], right[2] * down[0] - right[0] * down[2], right[0] * down[1] - right[1] * down[0]];
  const nf = nrm3([-c[0], -c[1], -c[2]]);                      // toward the camera when frontal
  let r = nrm3(right);
  const rd = dot3(r, nf); r = nrm3([r[0] - rd * nf[0], r[1] - rd * nf[1], r[2] - rd * nf[2]]);
  const m61 = P3(61), m291 = P3(291);
  const mc = [(m61[0] + m291[0]) / 2, (m61[1] + m291[1]) / 2, (m61[2] + m291[2]) / 2];
  const half = Math.max(1e-3, Math.hypot(...sub3(m291, m61)) / 2);
  const nMP = IDX.length, vMP = new Float32Array(nMP);
  const phi = 40 * Math.PI / 180;
  for (let i = 0; i < nMP; i++) {
    const sLat = Math.max(-1.2, Math.min(1.2, dot3(sub3(P3(IDX[i]), mc), r) / half));
    const th = sLat * phi, ct = Math.cos(th), st = Math.sin(th);
    const nz = nf[2] * ct + r[2] * st;                       // z of the rotated normal
    vMP[i] = -nz;                                            // camera looks along +z
  }
  const vis = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    const i = Math.floor(k / SUB), f = (k % SUB) / SUB;
    vis[k] = vMP[i] + (vMP[(i + 1) % nMP] - vMP[i]) * f;
  }
  return vis;
}

/**
 * Push contour points outward (along the contour normal) as long as the
 * pixels stay lip-coloured — applied to the silhouette run of a turned head
 * (and its neighbours), where the outline came from geometry, not colour.
 * Small gaps (highlights) are bridged; growth is smoothed along the run and
 * limited to ~0.9× lip thickness.
 */
function growOverLip(pts, vis, thr, t, xf) {
  const n = pts.length, sw = new Float32Array(n);
  let any = false;
  // selection fades in toward the silhouette (no step where it starts)
  for (let k = 0; k < n; k++) { sw[k] = 1 - smooth01(thr, thr + 0.35, vis[k]); if (sw[k] > 0.01) any = true; }
  if (!any) return;
  const nr = normals(pts), off = new Float32Array(n), wt = new Float32Array(n);
  const step = 0.5, maxOut = 0.9 * t, gapMax = Math.max(1.5, 0.08 * t);
  for (let k = 0; k < n; k++) {
    if (sw[k] <= 0.01) continue;
    const [x, y] = pts[k], [nx, ny] = nr[k];
    const lip = (sv) => sampleP(x + nx * sv, y + ny * sv, xf) >= 0.5;
    if (!lip(-1) && !lip(-2.5)) continue;          // no lip evidence here: unknown (weight 0), not "zero growth"
    let last = 0, gap = 0;
    for (let sv = step; sv <= maxOut; sv += step) {
      if (lip(sv)) { last = sv; gap = 0; } else if ((gap += step) > gapMax) break;
    }
    off[k] = last; wt[k] = 1;
  }
  // weighted smoothing along the contour; unknown points take their neighbours' value
  const sm = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (sw[k] <= 0.01) continue;
    let s0 = 0, s1 = 0;
    for (let d = -6; d <= 6; d++) { const j = (k + d + n) % n; const g = Math.exp(-(d * d) / 12) * wt[j]; s0 += g; s1 += g * off[j]; }
    sm[k] = s0 > 1e-3 ? s1 / s0 : 0;
  }
  for (let k = 0; k < n; k++) {
    const g = sm[k] * sw[k];
    if (g > 0.25) pts[k] = [pts[k][0] + nr[k][0] * g, pts[k][1] + nr[k][1] * g];
  }
}

/**
 * Replace each run of hidden points (vis < thr) by a straight chord between
 * the visible points on either side — the silhouette. In profile this removes
 * the far half that would otherwise fold over the near one. Returns the
 * midpoints of the chords (for fading out a hidden corner).
 */
function hideRuns(pts, vis, thr) {
  const n = pts.length, hidden = new Uint8Array(n);
  let any = false, all = true;
  for (let k = 0; k < n; k++) { hidden[k] = vis[k] < thr ? 1 : 0; any = any || !!hidden[k]; all = all && !!hidden[k]; }
  if (!any || all) return [];
  let start = 0; while (hidden[start]) start++;               // a visible point to start from
  const mids = [];
  for (let s0 = 0; s0 < n; s0++) {
    const k = (start + s0) % n;
    if (!hidden[k] || hidden[(k - 1 + n) % n]) continue;      // run begins at k
    let e = k, len = 0;
    while (hidden[e % n] && len < n) { e = (e + 1) % n; len++; }
    const a = pts[(k - 1 + n) % n], b = pts[e];
    // The silhouette isn't a straight cut: if the hidden points reach outward
    // past the chord (the lips' profile bulge), run a quadratic through the
    // most outward of them; otherwise the chord.
    let cx2 = 0, cy2 = 0;
    for (const p2 of pts) { cx2 += p2[0]; cy2 += p2[1]; }
    cx2 /= n; cy2 /= n;
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    let ox = -dy, oy = dx;                                     // chord normal, outward
    if (((a[0] + b[0]) / 2 - cx2) * ox + ((a[1] + b[1]) / 2 - cy2) * oy < 0) { ox = -ox; oy = -oy; }
    let best = 0.5, E = null;
    for (let j = 0; j < len; j++) {
      const q = pts[(k + j) % n];
      const dOut = (q[0] - a[0]) * ox + (q[1] - a[1]) * oy;
      if (dOut > best) { best = dOut; E = q; }
    }
    let C = null, tE = 0.5;
    if (E) {
      tE = Math.max(0.15, Math.min(0.85, ((E[0] - a[0]) * dx + (E[1] - a[1]) * dy) / dl));
      const u1 = 1 - tE;
      C = [(E[0] - u1 * u1 * a[0] - tE * tE * b[0]) / (2 * tE * u1), (E[1] - u1 * u1 * a[1] - tE * tE * b[1]) / (2 * tE * u1)];
    }
    for (let j = 0; j < len; j++) {
      const f = (j + 1) / (len + 1), q = (k + j) % n, g = 1 - f;
      pts[q] = C
        ? [g * g * a[0] + 2 * f * g * C[0] + f * f * b[0], g * g * a[1] + 2 * f * g * C[1] + f * f * b[1]]
        : [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    const mid = pts[(k + (len >> 1)) % n];
    mids.push([mid[0], mid[1], k, len]);
  }
  return mids;
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
 * Keep the OUTER lip outline anatomically sane (runs on the fitted target,
 * before temporal tracking). Lips can't grow lumps, can't cave in, and keep
 * MediaPipe's geometry on head turns — the colour fit may only move the edge
 * by a bounded, smooth amount. In the mouth frame (heights vs along-position):
 *  1. bounds per column, relative to the LOCAL lip thickness from MP (outer →
 *     inner): the fit may not make a lip thinner than 70 % / thicker than 135 %
 *     of MP's — a lump near a thin corner was allowed by the old global limit
 *  2. robust smoothing: residuals against a wide Gaussian are clamped to a
 *     small tolerance — spikes ("chunks") and sudden drops are cut back, the
 *     cupid's bow and real curvature survive
 *  3. shape: the lower lip falls monotonically from each corner to its lowest
 *     point (no dents); the upper lip rises from each corner to its peak, and
 *     the philtrum dip between the peaks is limited
 * Columns at the silhouette of a turned head are left to the colour fit
 * (MP is least reliable there).
 */
function cleanOuter(tgt, outerD, innerD, persp, vis) {
  const half = CORNER_R;
  const pL = [tgt[2 * CORNER_L], tgt[2 * CORNER_L + 1]], pR = [tgt[2 * CORNER_R], tgt[2 * CORNER_R + 1]];
  const mw = Math.hypot(pR[0] - pL[0], pR[1] - pL[1]);
  if (mw < 8) return tgt;
  const axX = (pR[0] - pL[0]) / mw, axY = (pR[1] - pL[1]) / mw;
  let upX = axY, upY = -axX;
  const c0 = [(pL[0] + pR[0]) / 2, (pL[1] + pR[1]) / 2];
  const top = outerD[5 * SUB];
  if ((top[0] - c0[0]) * upX + (top[1] - c0[1]) * upY < 0) { upX = -upX; upY = -upY; }
  const hOf = (x, y) => (x - c0[0]) * upX + (y - c0[1]) * upY;
  const aOf = (x, y) => (x - c0[0]) * axX + (y - c0[1]) * axY;
  const curve = (pts, idxOf) => {
    const c2 = [];
    for (let k = 0; k <= half; k++) { const p2 = pts[idxOf(k)]; c2.push([aOf(p2[0], p2[1]), hOf(p2[0], p2[1])]); }
    return c2.sort((a2, b2) => a2[0] - b2[0]);
  };
  const interp = (c2, a) => {
    if (a <= c2[0][0]) return c2[0][1];
    for (let i = 1; i < c2.length; i++) if (a <= c2[i][0]) { const f = (a - c2[i - 1][0]) / Math.max(1e-6, c2[i][0] - c2[i - 1][0]); return c2[i - 1][1] + f * (c2[i][1] - c2[i - 1][1]); }
    return c2[c2.length - 1][1];
  };
  const MU = curve(outerD, (k) => k), MD = curve(outerD, (k) => (K - k) % K);
  const IU = curve(innerD, (k) => k), ID = curve(innerD, (k) => (K - k) % K);
  const n = half + 1;
  const sides = [
    { idx: (k) => k, sign: 1 },                 // upper: outward = +up
    { idx: (k) => (K - k) % K, sign: -1 },      // lower: outward = −up
  ];
  for (const side of sides) {
    const A = new Float32Array(n), Hf = new Float32Array(n), Hm = new Float32Array(n), Th = new Float32Array(n), Pz = new Float32Array(n);
    for (let k = 0; k <= half; k++) {
      const q = side.idx(k);
      const x = tgt[2 * q], y = tgt[2 * q + 1];
      A[k] = aOf(x, y); Hf[k] = hOf(x, y);
      Hm[k] = interp(side.sign > 0 ? MU : MD, A[k]);
      const inner = interp(side.sign > 0 ? IU : ID, A[k]);
      Th[k] = Math.max(1, side.sign * (Hm[k] - inner));      // MP's local lip thickness
      Pz[k] = vis ? smooth01(0.25, 0.6, vis[q]) : 1;   // silhouette columns: trust the colour fit
    }
    // work in "outwardness" o = sign·h (bigger = further from the mouth line)
    const O = new Float32Array(n), Om = new Float32Array(n);
    for (let k = 0; k <= half; k++) { O[k] = side.sign * Hf[k]; Om[k] = side.sign * Hm[k]; }
    // 1. local bounds vs MP thickness (tighter where the side is foreshortened)
    for (let k = 1; k < half; k++) {
      const lo = Om[k] - 0.3 * Th[k], hi = Om[k] + 0.4 * Th[k];
      if (Pz[k] < 1e-3) continue;
      O[k] = Math.min(hi, Math.max(lo, O[k]));
    }
    // 2. robust smoothing: clamp residuals against a wide Gaussian (2 passes)
    const gauss = (Arr, sg) => {
      const o = new Float32Array(n), r = Math.ceil(2.5 * sg);
      for (let k = 0; k <= half; k++) {
        let sw = 0, sv = 0;
        for (let d = -r; d <= r; d++) { const j = k + d; if (j < 0 || j > half) continue; const wg = Math.exp(-(d * d) / (2 * sg * sg)); sw += wg; sv += wg * Arr[j]; }
        o[k] = sv / sw;
      }
      return o;
    };
    // Robust: MP's own offset error is broad (whole-lip scale), a lump or a
    // dent is local — fit the deviation with a wide, outlier-down-weighted
    // Gaussian, then allow only a small tolerance around it.
    const dev = new Float32Array(n), wts = new Float32Array(n).fill(1);
    for (let k = 0; k <= half; k++) dev[k] = O[k] - Om[k];
    let sm = null;
    for (let pass = 0; pass < 3; pass++) {
      sm = new Float32Array(n);
      const sg = 7, r = Math.ceil(2.5 * sg);
      for (let k = 0; k <= half; k++) {
        let sw = 0, sv = 0;
        for (let d = -r; d <= r; d++) { const j = k + d; if (j < 0 || j > half) continue; const wg = Math.exp(-(d * d) / (2 * sg * sg)) * wts[j]; sw += wg; sv += wg * dev[j]; }
        sm[k] = sw > 1e-6 ? sv / sw : dev[k];
      }
      for (let k = 0; k <= half; k++) {
        const tol = Math.max(0.8, 0.06 * Th[k]);
        const e = Math.abs(dev[k] - sm[k]) / tol;
        wts[k] = e <= 1 ? 1 : 1 / (e * e);       // Cauchy-like down-weighting
      }
    }
    for (let k = 1; k < half; k++) {
      const tol = Math.max(0.8, 0.06 * Th[k]);
      const r = dev[k] - sm[k];
      O[k] = Om[k] + sm[k] + Math.max(-tol, Math.min(tol, r));
    }
    // 3. shape
    if (side.sign < 0) {
      // lower lip: outwardness rises monotonically from each corner to the lowest point
      let pk = 0; for (let k = 1; k <= half; k++) if (O[k] > O[pk]) pk = k;
      for (let k = 1; k <= pk; k++) if (O[k] < O[k - 1]) O[k] = O[k - 1] - 0.0;
      for (let k = half - 1; k >= pk; k--) if (O[k] < O[k + 1]) O[k] = O[k + 1];
    } else {
      // upper lip: rise from each corner to its peak; limited philtrum dip
      const mid = half >> 1;
      let pl = 1; for (let k = 1; k <= mid; k++) if (O[k] > O[pl]) pl = k;
      let pr = half - 1; for (let k = half - 1; k >= mid; k--) if (O[k] > O[pr]) pr = k;
      for (let k = 1; k <= pl; k++) if (O[k] < O[k - 1]) O[k] = O[k - 1];
      for (let k = half - 1; k >= pr; k--) if (O[k] < O[k + 1]) O[k] = O[k + 1];
      const floorDip = Math.min(O[pl], O[pr]) - 0.45 * Th[mid];
      for (let k = pl + 1; k < pr; k++) if (O[k] < floorDip) O[k] = floorDip;
    }
    // back to points: move along `up`, weighted by how vertical the outline is
    // here (near the corners the edge runs vertically — leave it alone)
    for (let k = 1; k < half; k++) {
      const q = side.idx(k);
      const dh = side.sign * O[k] - Hf[k];
      const cw = smooth01(0, 0.12 * half, Math.min(k, half - k)) * Pz[k];
      tgt[2 * q] += upX * dh * cw; tgt[2 * q + 1] += upY * dh * cw;
    }
  }
  return tgt;
}

/**
 * Make the mouth opening anatomically plausible (all inner-edge modes).
 * The opening is ONE smooth lens between the lips: no notch, no island, no
 * step between neighbouring columns, closing smoothly into both corners, and
 * left/right alike (the better-seen side leads, like the outer contour).
 * Works in the mouth frame on the inner target curve tgt (K×2, in place):
 *  1. per column: upper/lower inner-lip thickness as seen from the outer contour
 *  2. symmetry: thickness blended with the mirrored column (perspective-weighted)
 *  3. gap: despiked, then its unimodal envelope — rises from each corner to the
 *     widest point and never dips back (a dent in the opening = a lipstick
 *     bridge/hole in the cut), Gaussian-smoothed, tapered into the corners
 *  4. centre line smoothed; edges kept ≥ 1 px inside the outer contour.
 */
function cleanInner(tgt, outer, persp, midPt, mpOuter = null, mpInner = null) {
  const half = CORNER_R;
  const oL = outer[CORNER_L], oR = outer[CORNER_R];
  const mw = Math.hypot(oR[0] - oL[0], oR[1] - oL[1]);
  if (mw < 8) return tgt;
  const axX = (oR[0] - oL[0]) / mw, axY = (oR[1] - oL[1]) / mw;
  let upX = axY, upY = -axX;
  const c0 = [(oL[0] + oR[0]) / 2, (oL[1] + oR[1]) / 2];
  const topRef = outer[5 * SUB];
  if ((topRef[0] - c0[0]) * upX + (topRef[1] - c0[1]) * upY < 0) { upX = -upX; upY = -upY; }
  const hOf = (x, y) => (x - c0[0]) * upX + (y - c0[1]) * upY;
  const aOf = (x, y) => (x - c0[0]) * axX + (y - c0[1]) * axY;   // along the mouth, 0 = centre
  const n = half + 1;
  // outer upper / lower lip as height(along) — inner points sit at their own
  // along-positions (MP's inner and outer points are not spaced alike)
  const curve = (idxOf, pts = outer) => {
    const c2 = [];
    for (let k = 0; k <= half; k++) { const p2 = pts[idxOf(k)]; c2.push([aOf(p2[0], p2[1]), hOf(p2[0], p2[1])]); }
    return c2.sort((a2, b2) => a2[0] - b2[0]);
  };
  const interp = (c2, a) => {
    if (a <= c2[0][0]) return c2[0][1];
    for (let i = 1; i < c2.length; i++) if (a <= c2[i][0]) { const f = (a - c2[i - 1][0]) / Math.max(1e-6, c2[i][0] - c2[i - 1][0]); return c2[i - 1][1] + f * (c2[i][1] - c2[i - 1][1]); }
    return c2[c2.length - 1][1];
  };
  const OU = curve((k) => k), OD = curve((k) => (K - k) % K);
  const HU = new Float32Array(n), HD = new Float32Array(n), T = new Float32Array(n), B = new Float32Array(n), A = new Float32Array(n);
  for (let k = 0; k <= half; k++) {
    const kl = (K - k) % K;
    const a = 0.5 * (aOf(tgt[2 * k], tgt[2 * k + 1]) + aOf(tgt[2 * kl], tgt[2 * kl + 1]));
    A[k] = a; HU[k] = interp(OU, a); HD[k] = interp(OD, a);
    T[k] = hOf(tgt[2 * k], tgt[2 * k + 1]); B[k] = hOf(tgt[2 * kl], tgt[2 * kl + 1]);
  }
  // 1–2. symmetry: the opening's own edges (heights in the mouth frame) are
  // blended with the mirrored along-position — the outer contour's small
  // errors don't leak in; the better-seen side leads
  const TU = [], TD = [], PV = [];
  for (let k = 0; k <= half; k++) { TU.push([A[k], T[k]]); TD.push([A[k], B[k]]); PV.push([A[k], 0.5 * (persp[k] + persp[(K - k) % K])]); }
  TU.sort((a2, b2) => a2[0] - b2[0]); TD.sort((a2, b2) => a2[0] - b2[0]); PV.sort((a2, b2) => a2[0] - b2[0]);
  const TS = new Float32Array(T), BS = new Float32Array(B);
  if (symStrength > 0) {
    // mirror about the anatomical mouth centre (MP 13/14), each side scaled by
    // its own half-width — a turned head foreshortens the far side
    const aL = aOf(oL[0], oL[1]), aR = aOf(oR[0], oR[1]);
    const aM = midPt ? Math.min(aR - 1, Math.max(aL + 1, aOf(midPt[0], midPt[1]))) : 0.5 * (aL + aR);
    const mirror = (a) => (a >= aM ? aM - (a - aM) / (aR - aM) * (aM - aL) : aM + (aM - a) / (aM - aL) * (aR - aM));
    for (let k = 1; k < half; k++) {
      const am = mirror(A[k]);
      const pk = interp(PV, A[k]), pm = interp(PV, am);
      const a = Math.min(0.5, 0.5 * symStrength) * 2 * pm / Math.max(1e-3, pk + pm);   // frontal: ≤ 50 % mirror
      TS[k] = T[k] + (interp(TU, am) - T[k]) * a; BS[k] = B[k] + (interp(TD, am) - B[k]) * a;
    }
  }
  const tuS = new Float32Array(n), tdS = new Float32Array(n);
  for (let k = 0; k <= half; k++) { tuS[k] = HU[k] - TS[k]; tdS[k] = BS[k] - HD[k]; }
  const g = new Float32Array(n), c = new Float32Array(n);
  for (let k = 0; k <= half; k++) {
    const t2 = HU[k] - tuS[k], b2 = HD[k] + tdS[k];
    g[k] = Math.max(0, t2 - b2); c[k] = 0.5 * (t2 + b2);
  }
  g[0] = g[half] = 0;
  // the opening closes INTO the mouth corners — the fitted outer corners,
  // not MP's (noisier) inner corner points
  c[0] = hOf(oL[0], oL[1]); c[half] = hOf(oR[0], oR[1]);
  // 3. despike (median of 5) → unimodal envelope → smooth → corner taper
  const med = new Float32Array(n), win = [];
  for (let k = 0; k <= half; k++) {
    win.length = 0;
    for (let d = -2; d <= 2; d++) { const j = k + d; if (j >= 0 && j <= half) win.push(g[j]); }
    win.sort((a2, b2) => a2 - b2); med[k] = win[win.length >> 1];
  }
  const Lm = new Float32Array(n), Rm = new Float32Array(n);
  for (let k = 0, mx = 0; k <= half; k++) { mx = Math.max(mx, med[k]); Lm[k] = mx; }
  for (let k = half, mx = 0; k >= 0; k--) { mx = Math.max(mx, med[k]); Rm[k] = mx; }
  const env = new Float32Array(n);
  for (let k = 0; k <= half; k++) env[k] = Math.min(Lm[k], Rm[k]);
  const gauss = (A, sg) => {
    const o = new Float32Array(n), r = Math.ceil(2.5 * sg);
    for (let k = 0; k <= half; k++) {
      let sw = 0, sv = 0;
      for (let d = -r; d <= r; d++) { const j = k + d; if (j < 0 || j > half) continue; const wgt = Math.exp(-(d * d) / (2 * sg * sg)); sw += wgt; sv += wgt * A[j]; }
      o[k] = sv / sw;
    }
    return o;
  };
  const cMed = new Float32Array(c);
  for (let k = 1; k < half; k++) {
    win.length = 0;
    for (let d = -2; d <= 2; d++) { const j = k + d; if (j >= 0 && j <= half) win.push(c[j]); }
    win.sort((a2, b2) => a2 - b2); cMed[k] = win[win.length >> 1];
  }
  const gs = gauss(env, 2.0), cs = gauss(cMed, 2.5);
  cs[0] = c[0]; cs[half] = c[half];
  const taperN = Math.max(2, 0.12 * half);
  for (let k = 0; k <= half; k++) gs[k] *= smooth01(0, taperN, Math.min(k, half - k));
  // 4. rebuild edges. Each lip keeps at least ~60 % of the thickness MP's
  //    mesh gives it here (min 1 px): a wrong inner edge (gloss read as teeth,
  //    a smile, a stale thickness model) can never cut the lipstick down to a
  //    thin rim — the opening is between the lips, not through them.
  let MOU = null, MIU = null, MOD = null, MID = null;
  if (mpOuter && mpInner) {
    MOU = curve((k) => k, mpOuter); MOD = curve((k) => (K - k) % K, mpOuter);
    MIU = curve((k) => k, mpInner); MID = curve((k) => (K - k) % K, mpInner);
  }
  for (let k = 0; k <= half; k++) {
    let t2 = cs[k] + 0.5 * gs[k], b2 = cs[k] - 0.5 * gs[k];
    let minU = 1, minD = 1;
    if (MOU) {
      minU = Math.max(1, 0.6 * (interp(MOU, A[k]) - interp(MIU, A[k])));
      minD = Math.max(1, 0.6 * (interp(MID, A[k]) - interp(MOD, A[k])));
    }
    const lo = HD[k] + minD, hi = HU[k] - minU;
    if (hi > lo) {
      if (t2 > hi) { const d = t2 - hi; t2 -= d; b2 = Math.max(lo, b2 - d); }
      if (b2 < lo) { const d = lo - b2; b2 += d; t2 = Math.min(hi, t2 + d); }
      if (t2 < b2) t2 = b2 = 0.5 * (t2 + b2);
    } else { t2 = b2 = HD[k] + (HU[k] - HD[k]) * minD / Math.max(1e-3, minU + minD); }
    const kl = (K - k) % K;
    const du = t2 - T[k], dd = b2 - B[k];
    tgt[2 * k] += upX * du; tgt[2 * k + 1] += upY * du;
    if (kl !== k) { tgt[2 * kl] += upX * dd; tgt[2 * kl + 1] += upY * dd; }
  }
  return tgt;
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
  let conf = 0, dprime = 0, gridOK = false;
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
      gridOK = true;
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
  // Facing / hidden parts of the contour (profile views): no colour fitting on
  // parts turned away from the camera.
  const visOut = contourVisibility(lms, w, h, LIPS_OUTER);
  const visIn = contourVisibility(lms, w, h, LIPS_INNER);
  const HIDDEN = 0.02;   // strictly turned away — near-grazing parts are still visible
  const rOut = 0.5 * t, rIn = 0.35 * t, step = 0.5;
  const rOutAt = new Float32Array(K);
  for (let k = 0; k < K; k++) rOutAt[k] = rOut + 0.6 * t * (1 - smooth01(0.15, 0.6, visOut[k]));
  const nSteps = Math.max(4, Math.ceil((rOut + rIn) / step));
  for (let k = 0; k < K; k++) {
    rawOff[k] = 0;
    wOff[k] = 0;
    if (conf <= 0 || visOut[k] < 0.08) continue;   // turned away: keep the model shape
    // Near the silhouette of a turned head MP pulls the lip points inward —
    // search further out there (the lip runs right up to the silhouette).
    const rOutK = rOutAt[k];
    const [bxk, byk] = outerD[k], [nx, ny] = nrm[k];
    const at = (s) => sampleP(bxk + nx * s, byk + ny * s, xf);
    if (at(rOutK) >= 0.5 || at(rOutK - step) >= 0.5) continue;
    let found = false;
    const nStepsK = Math.max(4, Math.ceil((rOutK + rIn) / step));
    for (let j = 1; j <= nStepsK; j++) {
      const s = rOutK - j * step;
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
        rawOff[k] = Math.min(rOutK, e2);
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
  regularise(rawOff, wOff, smOff, t, taper, -rIn, rOut + 0.6 * t, conf, supBuf);
  for (let k = 0; k < K; k++) if (smOff[k] > rOutAt[k]) smOff[k] = rOutAt[k];   // the wider reach only at the silhouette
  // Perspective visibility per contour point (liner width, edge texture and
  // the symmetric shape prior below).
  const { persp, mouth3D } = contourPerspective(lms, w, h);
  const mouthMid = [(lms[13].x + lms[14].x) * 0.5 * w, (lms[13].y + lms[14].y) * 0.5 * h];   // anatomical mouth centre
  const box = [bx, by, bw, bh];
  let fresh = !prevPts || !prevBox;
  if (!fresh) {
    const dc = Math.hypot(bx + bw / 2 - (prevBox[0] + prevBox[2] / 2), by + bh / 2 - (prevBox[1] + prevBox[3] / 2));
    if (dc > 0.2 * bw || Math.abs(bw / prevBox[2] - 1) > 0.2 || Math.abs(bh / prevBox[3] - 1) > 0.35) fresh = true;
  }
  if (!prevPts) prevPts = new Float32Array(K * 2);
  const outer = new Array(K);
  const tgt = new Float32Array(K * 2);
  for (let k = 0; k < K; k++) {
    tgt[2 * k] = outerD[k][0] + nrm[k][0] * smOff[k];
    tgt[2 * k + 1] = outerD[k][1] + nrm[k][1] * smOff[k];
  }
  // Left/right proportion: the side you can barely see gets the seen side's shape.
  symmetriseThickness(tgt, innerD, supBuf, persp);
  // Shape rules for the outer edge (cleanOuter) are OFF: on a real profile
  // frame they clamped the fit to MP's own (too thin) lip at the front and
  // cut a spike into the upper lip. The colour fit + regularisation alone
  // follow the real lip there. Kept for experiments: OUTER_RULES = true.
  if (OUTER_RULES) cleanOuter(tgt, outerD, innerD, persp, visOut);
  // Head motion carried with zero lag, per-point noise damped (see trackContour).
  if (fresh) prevPts.set(tgt);
  else trackContour(prevPts, tgt, K, opts.moving ? 0.22 : 0.12, 0.35 * t);
  for (let k = 0; k < K; k++) outer[k] = [prevPts[2 * k], prevPts[2 * k + 1]];
  const hiddenOuter = hideRuns(outer, visOut, HIDDEN);
  // The part of the mouth MP calls "turned away" is replaced by a silhouette
  // curve — but real lips protrude: on a turn they bulge past that curve and
  // showed as bare lip beyond the lipstick. Grow the silhouette outward over
  // whatever is still lip-coloured, so the lipstick always covers the lip.
  if (conf > 0) growOverLip(outer, visOut, HIDDEN, t, xf);
  prevBox = box;
  // ── Inner lip edge PREDICTED from the outer contour ('predict' mode) ──
  // Lip tissue barely compresses: when the mouth opens the lips part, but each
  // lip keeps (about) its thickness. So
  //   upper inner edge = upper outer contour − upper-lip thickness
  //   lower inner edge = lower outer contour + lower-lip thickness
  //   opening          = outer height − both thicknesses   (> 0 → open)
  // — the opening follows from geometry even when MP calls the mouth closed
  // and nothing inside the mouth is visible. Thickness is learned per person
  // while the mouth is closed and still (outer contour vs the dark contact
  // seam), stored in eye-distance units; scaled for stretch (smile thins the
  // lips, ~1/√stretch) and for head pitch (vertical foreshortening). Pixels
  // only nudge the predicted edge inside a narrow band. Until the model has
  // seen enough closed frames this returns null → MediaPipe mode.
  function predictInner() {
    const half = CORNER_R;
    const oL = outer[CORNER_L], oR = outer[CORNER_R];
    const mw = Math.hypot(oR[0] - oL[0], oR[1] - oL[1]);
    if (mw < 8) return null;
    const axX = (oR[0] - oL[0]) / mw, axY = (oR[1] - oL[1]) / mw;
    let upX = axY, upY = -axX;
    const c0 = [(oL[0] + oR[0]) / 2, (oL[1] + oR[1]) / 2];
    const topRef = outer[5 * SUB];
    if ((topRef[0] - c0[0]) * upX + (topRef[1] - c0[1]) * upY < 0) { upX = -upX; upY = -upY; }
    const hOf = (p2) => (p2[0] - c0[0]) * upX + (p2[1] - c0[1]) * upY;
    const eyeD = d3(p3(33), p3(263));
    const vert3 = d3(p3(168), p3(152)), vert2 = Math.hypot(lms[168].x * w - lms[152].x * w, lms[168].y * h - lms[152].y * h);
    const fore = vert3 > 0 ? vert2 / vert3 : 1;          // 1 = frontal, < 1 = pitched
    const wRel = eyeD > 0 ? lipW / eyeD : 1;             // mouth width vs face (smile → larger)
    if (!(eyeD > 4)) return null;
    const sdL = Math.sqrt(Math.max(1, Lp.cov[0]));
    const still = !opts.moving;

    // ── learn: closed, still mouth → thickness per column ──
    const HU = new Float32Array(MC), HD = new Float32Array(MC);
    for (let k = 0; k <= half; k++) { HU[k] = hOf(outer[k]); HD[k] = hOf(outer[(K - k) % K]); }
    const calibrated = lipModel && lipModel.n >= 8;
    const frontal = visOut[CORNER_L] > 0.3 && visOut[CORNER_R] > 0.3;   // learn only on a near-frontal mouth
    if (still && frontal && conf > 0.3 && ratio < 0.025) {   // MP: closed (the seam-width check below rejects a parted mouth)
      const tU = new Float32Array(MC), tD = new Float32Array(MC), ok = new Uint8Array(MC);
      let good = 0;
      for (let k = 2; k <= half - 2; k++) {
        if (visOut[k] < 0.5 || visOut[(K - k) % K] < 0.5) continue;
        const U = outer[k], D = outer[(K - k) % K], H = HU[k] - HD[k];
        if (H < 3) continue;
        // darkest point between 25 % and 80 % of the height (from the bottom)
        let best = Infinity, bh = 0;
        const n = Math.max(6, Math.ceil(H / 0.5));
        const Ls = new Float32Array(n + 1);
        for (let i = 0; i <= n; i++) {
          const f = 0.25 + 0.55 * i / n;
          const L = sampleGrid(Lb, D[0] + (U[0] - D[0]) * f, D[1] + (U[1] - D[1]) * f, xf);
          Ls[i] = L;
          if (L > 0 && L < best) { best = L; bh = f; }
        }
        if (!(Lp.mu[0] - best > Math.max(4, 0.6 * sdL))) continue;   // no visible seam here
        // a SEAM is thin; a dark band wider than that means the mouth is a bit open
        const half2 = (best + Lp.mu[0]) / 2;
        let wd = 0; for (let i = 0; i <= n; i++) if (Ls[i] < half2) wd++;
        if (wd * (0.55 * H / n) > Math.max(4, 0.08 * H)) continue;
        // teeth showing → parted, not a seam
        let teeth = 0;
        for (let i = 0; i <= n; i++) if (Ls[i] > Lp.mu[0] + 1.5 * sdL) {
          const f = 0.25 + 0.55 * i / n, x = D[0] + (U[0] - D[0]) * f, y = D[1] + (U[1] - D[1]) * f;
          if (Math.hypot(sampleGrid(Ac, x, y, xf), sampleGrid(Bc, x, y, xf)) < 0.5 * Math.hypot(Lp.mu[1], Lp.mu[2])) teeth++;
        }
        if (teeth * (0.55 * H / n) > 1.5) continue;
        tU[k] = (1 - bh) * H / (eyeD * fore); tD[k] = bh * H / (eyeD * fore); ok[k] = 1; good++;
      }
      if (good >= 0.5 * (half - 3)) {
        // fill gaps from neighbours, then blend into the model
        for (let k = 1; k < half; k++) if (!ok[k]) {
          let a = k - 1; while (a > 0 && !ok[a]) a--;
          let b = k + 1; while (b < half && !ok[b]) b++;
          const ta = ok[a] ? [tU[a], tD[a]] : [0, 0], tb = ok[b] ? [tU[b], tD[b]] : [0, 0];
          const f = b > a ? (k - a) / (b - a) : 0;
          tU[k] = ta[0] + (tb[0] - ta[0]) * f; tD[k] = ta[1] + (tb[1] - ta[1]) * f;
        }
        // reject a frame that disagrees wildly with what we know (half-open mouth slipped through)
        let agree = true;
        if (calibrated) {
          let dif = 0, tot = 0;
          for (let k = 5; k <= half - 5; k++) { dif += Math.abs(tU[k] + tD[k] - lipModel.tU[k] - lipModel.tD[k]); tot += lipModel.tU[k] + lipModel.tD[k]; }
          agree = dif < 0.15 * tot;
        }
        if (agree) {
          if (!lipModel) lipModel = { tU: new Float32Array(tU), tD: new Float32Array(tD), n: 0, wRel: wRel, fore: fore };
          const a = 1 / Math.min(30, lipModel.n + 1);   // running mean, then slow EMA
          for (let k = 0; k < MC; k++) { lipModel.tU[k] += (tU[k] - lipModel.tU[k]) * a; lipModel.tD[k] += (tD[k] - lipModel.tD[k]) * a; }
          lipModel.wRel += (wRel - lipModel.wRel) * a;
          lipModel.n++;
        }
      }
    }
    if (!lipModel || lipModel.n < 8) return null;

    // ── predict ──
    // Sanity: the model must roughly agree with MP's own lip thickness here
    // (a model learned on another face / a bad frame would cut the lipstick
    // down to a rim). Way off → forget it, fall back to MP, relearn.
    {
      const kStr = Math.sqrt(Math.max(0.5, Math.min(2, lipModel.wRel / wRel)));
      const sc = eyeD * fore * kStr;
      const rs = [];
      for (let k = Math.round(0.25 * half); k <= Math.round(0.75 * half); k++) {
        const ou = outerD[k], od = outerD[(K - k) % K], iu = innerD[k], id = innerD[(K - k) % K];
        const mpT = Math.abs(hOf(ou) - hOf(iu)) + Math.abs(hOf(id) - hOf(od));
        if (mpT > 2) rs.push((lipModel.tU[k] + lipModel.tD[k]) * sc / mpT);
      }
      rs.sort((p2, q) => p2 - q);
      const med = rs.length ? rs[rs.length >> 1] : 1;
      if (med < 0.45 || med > 2.2) { lipModel = null; return null; }
    }
    const kStretch = Math.sqrt(Math.max(0.5, Math.min(2, lipModel.wRel / wRel)));
    const scale = eyeD * fore * kStretch;
    const T = new Float32Array(MC), B = new Float32Array(MC), gapA = [];
    // pixel nudge inside a narrow band: strongest colour change across the edge
    // Pixel nudge inside a narrow band: the lip→mouth transition, directional —
    // lip on the lip side, not-lip on the mouth side (so a teeth→gap edge
    // inside the mouth can't be taken for the lip edge).
    const edgeAt = (P, hP, hPred, band, dir) => {   // dir +1: lip lies "up" (upper lip), −1: down
      const base = [P[0] + upX * (hPred - hP), P[1] + upY * (hPred - hP)];
      const lipP = (d) => {
        const x = base[0] + upX * d, y = base[1] + upY * d;
        return sampleGrid(Lb, x, y, xf) >= lipLminP ? sampleGrid(Pb, x, y, xf) : 0;
      };
      let best = 0, bestD = 0;
      for (let d = -band; d <= band; d += 0.5) {
        const sc = lipP(d + dir * 1.5) - lipP(d - dir * 1.5) - 0.02 * Math.abs(d);   // mild pull to the prediction
        if (sc > best) { best = sc; bestD = d; }
      }
      return best > 0.35 ? bestD * Math.min(1, 0.5 + (best - 0.35)) : 0;
    };
    const lipLminP = Lp.mu[0] - 2.2 * sdL;
    for (let k = 0; k <= half; k++) {
      const H = HU[k] - HD[k];
      let tu = lipModel.tU[k] * scale, td = lipModel.tD[k] * scale;
      if (k === 0 || k === half || H <= 0) { T[k] = B[k] = (HU[k] + HD[k]) / 2; continue; }
      const gap = H - tu - td;
      if (gap <= 0) {                 // closed here: contact line splits the height by the thickness ratio
        const c = HD[k] + H * td / Math.max(1e-3, tu + td);
        T[k] = B[k] = c;
      } else {
        T[k] = HU[k] - tu; B[k] = HD[k] + td;
        if (k > 0.2 * half && k < 0.8 * half) gapA.push(gap);
      }
    }
    const mid = Math.max(1, Math.floor(0.6 * half) - 1);
    gapA.sort((p2, q) => p2 - q);
    const medGap = gapA.length >= 0.3 * mid ? gapA[gapA.length >> 1] : 0;
    // open: predicted gap clearly above noise (hysteresis), or MP clearly open
    const thr = Math.max(1.5, (cutoutActive ? 0.012 : 0.022) * lipW);
    const open = medGap > thr || ratio > (cutoutActive ? 0.07 : 0.1);
    const tgt = new Float32Array(K * 2);
    if (open) {
      for (let k = 1; k < half; k++) {
        if (T[k] - B[k] > 1) {
          const band = 0.45 * Math.min(lipModel.tU[k], lipModel.tD[k]) * scale + 1;
          T[k] += edgeAt(outer[k], HU[k], T[k], band, 1);
          B[k] += edgeAt(outer[(K - k) % K], HD[k], B[k], band, -1);
          if (T[k] < B[k]) T[k] = B[k] = (T[k] + B[k]) / 2;
        }
      }
      // smooth along the mouth (one odd column can't notch the edge)
      const sm = (A) => {
        const o = new Float32Array(A);
        for (let k = 1; k < half; k++) {
          let sw = 0, sv = 0;
          for (let d = -3; d <= 3; d++) { const j = k + d; if (j < 0 || j > half) continue; const g = Math.exp(-(d * d) / 4.5); sw += g; sv += g * A[j]; }
          o[k] = sv / sw;
        }
        return o;
      };
      const Ts = sm(T), Bs = sm(B);
      for (let k = 0; k <= half; k++) {
        // column position: the outer column's own along-mouth position
        const U = outer[k], D = outer[(K - k) % K];
        const ku = k, kl = (K - k) % K;
        tgt[2 * ku] = U[0] + upX * (Ts[k] - HU[k]); tgt[2 * ku + 1] = U[1] + upY * (Ts[k] - HU[k]);
        tgt[2 * kl] = D[0] + upX * (Bs[k] - HD[k]); tgt[2 * kl + 1] = D[1] + upY * (Bs[k] - HD[k]);
      }
    }
    return { open, tgt, openRatio: medGap / Math.max(1, lipW), openCols: gapA.length / mid };
  }

  // ── Mouth opening, found in the pixels ──
  // MediaPipe's inner-lip points lag and undershoot: a slightly parted mouth
  // often reads as closed (lipstick painted over the teeth) and a wide one
  // has its inner edge a few px off. So the opening is detected here from
  // colour: along each column of the mouth (mouth frame, works on a tilted
  // head) walk up and down from the lip-contact line through pixels that are
  // mouth interior — dark gap / shadow, or teeth (bright, low chroma) — and
  // stop where lip starts. Those stops ARE the inner lip edges. Columns
  // without an opening collapse to the contact line, so the corners close
  // naturally. Openness drives the cut (with hysteresis), not MP's gap.
  let inner = innerD;
  let openRatio = 0, openCols = 0;
  const mouthW2 = Math.hypot(innerD[CORNER_R][0] - innerD[CORNER_L][0], innerD[CORNER_R][1] - innerD[CORNER_L][1]);
  const predicted = openMode === 'predict' && gridOK && Lp ? predictInner() : null;
  if (openMode === 'pixel' && gridOK && Lp && mouthW2 > 8) {
    const sdL = Math.sqrt(Math.max(1, Lp.cov[0]));
    const darkThr = Math.min(Lp.mu[0] - 2.0 * sdL, 0.72 * Lp.mu[0]);
    const lipLmin = Lp.mu[0] - 2.2 * sdL;
    const lipC = Math.hypot(Lp.mu[1], Lp.mu[2]);
    const teethL = Math.max(Lp.mu[0] + 1.2 * sdL, S ? S.mu[0] - 4 : 0);
    let teethHits = 0;
    const interior = (x, y) => {
      const L = sampleGrid(Lb, x, y, xf);
      if (L <= 0) return false;                       // off the grid
      if (L < darkThr) return true;                   // gap / mouth shadow
      if (L > teethL) {                               // teeth: bright and colourless
        const c = Math.hypot(sampleGrid(Ac, x, y, xf), sampleGrid(Bc, x, y, xf));
        if (c < Math.max(6, 0.45 * lipC) && !(sampleGrid(Pb, x, y, xf) >= 0.6 && L >= lipLmin)) { teethHits++; return true; }
      }
      return false;
    };
    const lipAt = (x, y) => sampleGrid(Pb, x, y, xf) >= 0.5 && sampleGrid(Lb, x, y, xf) >= lipLmin;
    // mouth frame: along = corner→corner, up = toward the upper lip
    let axX = (innerD[CORNER_R][0] - innerD[CORNER_L][0]) / mouthW2, axY = (innerD[CORNER_R][1] - innerD[CORNER_L][1]) / mouthW2;
    let upX = axY, upY = -axX;
    const mid0 = [(innerD[CORNER_L][0] + innerD[CORNER_R][0]) / 2, (innerD[CORNER_L][1] + innerD[CORNER_R][1]) / 2];
    const topRef = outerD[5 * SUB];   // landmark 0 (upper lip top)
    if ((topRef[0] - mid0[0]) * upX + (topRef[1] - mid0[1]) * upY < 0) { upX = -upX; upY = -upY; }
    const half = CORNER_R;   // upper inner = 0..CORNER_R, lower = K-k
    const topS = new Float32Array(half + 1), botS = new Float32Array(half + 1), wt = new Float32Array(half + 1);
    const mids = new Array(half + 1);
    const stepO = 0.5;
    const gaps = [];
    let mpGapMax = 0, teethCols = 0;
    for (let k = 0; k <= half; k++) {
      const up = innerD[k], lo = innerD[(K - k) % K];
      const m = [(up[0] + lo[0]) / 2, (up[1] + lo[1]) / 2];
      mids[k] = m;
      const mpGap = (up[0] - lo[0]) * upX + (up[1] - lo[1]) * upY;
      if (mpGap > mpGapMax) mpGapMax = mpGap;
      if (k === 0 || k === half) continue;   // corners: contact point
      const oU = outerD[k], oL = outerD[(K - k) % K];
      const limUp = 0.85 * ((oU[0] - m[0]) * upX + (oU[1] - m[1]) * upY);
      const limDn = 0.85 * ((m[0] - oL[0]) * upX + (m[1] - oL[1]) * upY);
      if (limUp < 1 || limDn < 1) continue;
      const at = (sv) => interior(m[0] + upX * sv, m[1] + upY * sv);
      // seed: nearest interior sample to the contact line (MP's line may be off)
      const seedR = Math.min(0.6 * Math.min(limUp, limDn), 0.3 * t + Math.max(0, mpGap) / 2);
      let seed = null;
      for (let d = 0; d <= seedR && seed === null; d += stepO) {
        if (at(d)) seed = d; else if (d > 0 && at(-d)) seed = -d;
      }
      if (seed === null) continue;
      // Walk out from the seed. Mixed pixels (teeth→gap, gap→lip blur) are
      // neither class — tolerated for a few px; the walk ends where LIP
      // starts and stays lip with no interior right behind it.
      const lip = (sv) => lipAt(m[0] + upX * sv, m[1] + upY * sv);
      const walk = (dir, lim) => {
        let last = seed;
        for (let sv = seed + dir * stepO; Math.abs(sv) <= lim; sv += dir * stepO) {
          if (at(sv)) { last = sv; continue; }
          if (lip(sv) && lip(sv + dir * stepO) && lip(sv + 2 * dir * stepO)) {
            let back = false;
            for (let j = 3; j <= 6; j++) if (at(sv + dir * j * stepO)) { back = true; break; }
            if (!back) break;
          }
          if (Math.abs(sv - last) > 4) break;
        }
        return last;
      };
      const hits0 = teethHits;
      let top = walk(1, limUp) + stepO, bot = walk(-1, limDn) - stepO;   // +½ px: blurred class boundary sits inside the real edge
      if (teethHits - hits0 >= 4) teethCols++;   // ≥ 2 px of teeth in this column (not a gloss speck)
      if (top - bot < 1.2) continue;
      topS[k] = top; botS[k] = bot; wt[k] = 1;
      if (k > 0.2 * half && k < 0.8 * half) gaps.push(top - bot);
    }
    const midCols = Math.max(1, Math.floor(0.6 * half) - 1);
    openCols = gaps.length / midCols;
    gaps.sort((p2, q) => p2 - q);
    const medGap = gaps.length ? gaps[gaps.length >> 1] : 0;
    openRatio = medGap / mouthW2;
    // Closed lips have a dark contact seam a few px thick — that is not an
    // opening. Open = a gap clearly wider than a seam, or teeth showing.
    const seenTeeth = teethCols >= Math.max(3, 0.25 * midCols);
    const mpSaysOpen = ratio > (cutoutActive ? 0.03 : 0.05);   // MP's 3D gap agrees → a small gap is real
    // (sized by the 3D mouth width: a turned head foreshortens the mouth but not the seam)
    const seamMax = Math.max(3.5, (cutoutActive ? 0.022 : 0.03) * lipW);
    const minGap = seenTeeth ? 1.5 : mpSaysOpen ? Math.min(seamMax, 4) : seamMax;
    const pixOpen = openCols >= (cutoutActive ? 0.15 : 0.3) && medGap >= minGap;
    // MP alone only when the mouth is clearly open (tongue / no teeth visible)
    cutoutActive = pixOpen || ratio > (cutoutActive ? 0.07 : 0.1);   // MP's 3D gap, only when clearly open
    if (cutoutActive) {
      // Columns without a detection: MP's gap if the pixels found nothing in a
      // mouth MP calls open, else closed (contact line). Then smooth along the
      // mouth so one noisy column can't notch the edge.
      const useMP = !pixOpen;
      const T = new Float32Array(half + 1), B = new Float32Array(half + 1);
      for (let k = 0; k <= half; k++) {
        if (wt[k]) { T[k] = topS[k]; B[k] = botS[k]; continue; }
        if (useMP) {
          const up = innerD[k], lo = innerD[(K - k) % K], m = mids[k];
          T[k] = (up[0] - m[0]) * upX + (up[1] - m[1]) * upY;
          B[k] = (lo[0] - m[0]) * upX + (lo[1] - m[1]) * upY;
        } else { T[k] = 0; B[k] = 0; }
      }
      const sm = (A) => {
        const o = new Float32Array(half + 1);
        for (let k = 0; k <= half; k++) {
          if (k === 0 || k === half) { o[k] = 0; continue; }
          let sw = 0, sv = 0;
          for (let d = -3; d <= 3; d++) {
            const j = k + d; if (j < 1 || j > half - 1) continue;
            const g = Math.exp(-(d * d) / 4.5) * (wt[j] || useMP ? 1 : 0.35);
            sw += g; sv += g * A[j];
          }
          o[k] = sw ? sv / sw : A[k];
        }
        return o;
      };
      const Ts = sm(T), Bs = sm(B);
      if (!prevInner || fresh) prevInner = new Float32Array(K * 2).fill(NaN);
      const tgtIn = new Float32Array(K * 2);
      for (let k = 0; k <= half; k++) {
        const m = mids[k];
        const ku = k, kl = (K - k) % K;
        tgtIn[2 * ku] = m[0] + upX * Ts[k]; tgtIn[2 * ku + 1] = m[1] + upY * Ts[k];
        tgtIn[2 * kl] = m[0] + upX * Bs[k]; tgtIn[2 * kl + 1] = m[1] + upY * Bs[k];
      }
      cleanInner(tgtIn, outer, persp, mouthMid, outerD, innerD);
      if (Number.isNaN(prevInner[0])) prevInner.set(tgtIn);
      else trackContour(prevInner, tgtIn, K, opts.moving ? 0.35 : 0.2, 0.35 * t);
      inner = new Array(K);
      for (let k = 0; k < K; k++) inner[k] = [prevInner[2 * k], prevInner[2 * k + 1]];
      hideRuns(inner, visIn, HIDDEN);
    } else {
      prevInner = null;
    }
  } else if (predicted) {
    cutoutActive = predicted.open;
    openRatio = predicted.openRatio; openCols = predicted.openCols;
    if (cutoutActive) {
      if (!prevInner || fresh) prevInner = new Float32Array(K * 2).fill(NaN);
      cleanInner(predicted.tgt, outer, persp, mouthMid, outerD, innerD);
      if (Number.isNaN(prevInner[0])) prevInner.set(predicted.tgt);
      else trackContour(prevInner, predicted.tgt, K, opts.moving ? 0.35 : 0.2, 0.35 * t);
      inner = new Array(K);
      for (let k = 0; k < K; k++) inner[k] = [prevInner[2 * k], prevInner[2 * k + 1]];
      hideRuns(inner, visIn, HIDDEN);
    } else {
      prevInner = null;
    }
  } else {
    // Default (previous behaviour): MediaPipe's 3D gap decides open/closed,
    // the inner edge is refined from colour around MP's inner contour.
    cutoutActive = ratio > (cutoutActive ? 0.03 : 0.05);
    if (cutoutActive && conf > 0 && Lp && gridOK) {
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
      const tgtIn = new Float32Array(K * 2);
      for (let k = 0; k < K; k++) {
        tgtIn[2 * k] = innerD[k][0] + nIn[k][0] * smOff[k];
        tgtIn[2 * k + 1] = innerD[k][1] + nIn[k][1] * smOff[k];
      }
      cleanInner(tgtIn, outer, persp, mouthMid, outerD, innerD);
      if (Number.isNaN(prevInner[0])) prevInner.set(tgtIn);
      else trackContour(prevInner, tgtIn, K, opts.moving ? 0.3 : 0.15, 0.35 * t);
      inner = new Array(K);
      for (let k = 0; k < K; k++) inner[k] = [prevInner[2 * k], prevInner[2 * k + 1]];
      hideRuns(inner, visIn, HIDDEN);
    } else {
      prevInner = null;
    }
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

  const innerRefined = inner !== innerD;
  if (!innerRefined) { inner = innerD.map((p2) => [p2[0], p2[1]]); hideRuns(inner, visIn, HIDDEN); }
  const nOut = normals(outer);
  // local lip thickness: distance to the nearest mouth-line point
  const thick = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    let dmin = Infinity;
    for (let j = 0; j < K; j++) { const q = inner[j]; const dd = (q[0] - outer[k][0]) ** 2 + (q[1] - outer[k][1]) ** 2; if (dd < dmin) dmin = dd; }
    thick[k] = Math.sqrt(dmin);
  }
  const linerW = new Float32Array(K);
  for (let k = 0; k < K; k++) linerW[k] = Math.min(linerPx * persp[k], thick[k] / 3);
  const linerInner = outer.map(([x, y], k) => [x - nOut[k][0] * linerW[k], y - nOut[k][1] * linerW[k]]);
  // Liner → lipstick: the inner edge of the liner fades too (3 steps).
  const linerSteps = [[0.5, 0.3], [0.25, 0.5], [0, 1]].map(([fo, alpha]) => ({
    alpha,
    pts: untangle(linerInner.map(([x, y], k) => [x + nOut[k][0] * linerW[k] * fo, y + nOut[k][1] * linerW[k] * fo])),
  }));
  let perim = 0;
  for (let k = 0; k < K; k++) { const a2 = outer[k], b2 = outer[(k + 1) % K]; perim += Math.hypot(b2[0] - a2[0], b2[1] - a2[1]); }
  const edge = roughen(outer, nOut, t, perim, persp, thick);
  const tangled = selfIntersects(edge.base);
  let safe = null;
  if (cutoutActive) {
    let ocx = 0, ocy = 0;
    for (const [x, y] of outer) { ocx += x; ocy += y; }
    ocx /= outer.length; ocy /= outer.length;
    // Refined inner edge is trustworthy → a looser safety clamp.
    const shrink = innerRefined ? (openMode !== 'mp' ? 0.08 : 0.12) : 0.25;
    safe = outer.map(([x, y]) => [x + (ocx - x) * shrink, y + (ocy - y) * shrink]);
  }

  lastSeg = {
    outer: tangled ? untangle(edge.base) : edge.base,   // organic outline (overlays / fallback)
    // Soft lip→skin fade. Layer offsets are capped by local thickness, so they
    // only fold if the base outline already does — untangle just in that case.
    layers: edgeSoft > 0 ? (tangled ? edge.layers.map(untangle) : edge.layers) : null,
    outerSmooth: outer,                    // the regularised fit, for overlays
    linerInner: untangle(linerInner), linerSteps,
    inner: untangle(inner), safe, bbox: box, conf, dprime, version: ++version,
    // Mouth opening from pixels: open (cut active), gap / mouth width (median
    // over the middle of the mouth) and the share of columns that are open.
    open: cutoutActive, openRatio, openCols,
    t,                                     // lip thickness (px) — shaders scale their edge band by it
    _w: w, _h: h,                          // frame size the curves are in
    // Mouth corners: lipstick fades out toward the corner point (references:
    // the lips dissolve into the corners instead of ending in a hard point).
    corners: edgeSoft > 0 ? [CORNER_L, CORNER_R].filter((k) => visOut[k] >= HIDDEN).map((k) => ({
      x: outer[k][0], y: outer[k][1], r: Math.max(2, 0.6 * t * Math.min(1.5, edgeSoft) * persp[k]),
    })) : null,   // a corner turned behind the silhouette needs no fade — the silhouette is a real lip edge
    linerLayers: edgeSoft > 0 ? (tangled ? edge.linerLayers.map(untangle) : edge.linerLayers) : null,
  };
  return lastSeg;
}

/** Most recent fit (for debug overlays). */
export function getLastLipSeg() { return lastSeg; }

/** Forget temporal state (call on source change). */
export function resetLipSeg() { prevPts = null; prevBox = null; prevInner = null; lastSeg = null; cutoutActive = false; lipModel = null; }

/** Debug: the last frame's lip-probability grids (GW×GH over seg.bbox). */
export function getLipGrids() { return { Q, Pb, Lb, GW, GH }; }