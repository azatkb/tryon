// Lash-line detector — helper for the 3D lashes.
//
// MediaPipe's eyelid points can sit a few pixels off the real lash line
// (on the eye white, or up on the lid skin — worse with hooded lids, looking
// down, low light). This module looks at the camera frame across the lid and
// finds the real upper lash line: a thin dark band (lash roots) with brighter
// lid skin above it and, usually, the bright eye white below it.
//
//   • per lid sample: 1D luminance profile along the lid normal → best band
//     position + confidence (contrast);
//   • across the lid: confidence-weighted Gaussian smoothing with a pull back
//     to MediaPipe (low confidence ⇒ no correction);
//   • over time: EMA per sample (offsets are relative to the landmarks, so
//     they follow the head without lag);
//   • hard clamp to a few % of the eye width — it can only nudge, never jump.
//
// Output: per eye, offset vectors (image px) at fixed arc-length samples of
// the upper lid polyline, outer corner → inner corner.

export const LINE_SAMPLES = 21;
const S0 = 0.04, S1 = 0.96;
export const lineS = (j) => S0 + (S1 - S0) * j / (LINE_SAMPLES - 1);

let enabled = true;
export function setLashLineDetect(on) { enabled = !!on; if (!on) resetLashLine(); }
export function getLashLineDetect() { return enabled; }

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ── geometry: resample a 2D polyline (Catmull-Rom) at arc-length fractions ──
function resample(pts, sList) {
  const n = pts.length, SUB = 8, dense = [];
  for (let k = 0; k < n - 1; k++) {
    const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(n - 1, k + 2)];
    for (let j = 0; j < SUB; j++) {
      const t = j / SUB, t2 = t * t, t3 = t2 * t;
      const f = (c) => 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3);
      dense.push([f(0), f(1)]);
    }
  }
  dense.push(pts[n - 1]);
  const cum = [0];
  for (let k = 1; k < dense.length; k++) cum.push(cum[k - 1] + Math.hypot(dense[k][0] - dense[k - 1][0], dense[k][1] - dense[k - 1][1]));
  const total = cum[cum.length - 1] || 1;
  return sList.map((s) => {
    const d = clamp(s, 0, 1) * total;
    let k = 1;
    while (k < cum.length - 1 && cum[k] < d) k++;
    const a = dense[k - 1], b = dense[k], f = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, tx, ty };
  });
}

/**
 * Core detector (pure — testable without a DOM).
 * @param {(x:number,y:number)=>number} lum  luminance 0..255 at image px (bilinear)
 * @param {number[][]} lid   upper lid polyline [x,y] in image px, outer → inner
 * @param {number[]} up      2D "up" direction of the head (unit, image px, y down)
 * @param {number} eyeW      eye width (px) — sets every window size
 * @returns {{off:Float32Array, conf:Float32Array, nx:Float32Array, ny:Float32Array}}
 *          raw per-sample offset along the outward normal + confidence
 */
export function detectLidRaw(lum, lid, up, eyeW, dbg = null) {
  const M = LINE_SAMPLES;
  const sList = Array.from({ length: M }, (_, j) => lineS(j));
  const smp = resample(lid, sList);
  const off = new Float32Array(M), conf = new Float32Array(M), nx = new Float32Array(M), ny = new Float32Array(M);
  const px = new Float32Array(M), py = new Float32Array(M);
  const A = 0.055 * eyeW;                 // search into the eye
  const B = 0.065 * eyeW;                 // search up onto the lid
  const band = Math.max(1.5, 0.022 * eyeW);
  const skin = Math.max(2, 0.04 * eyeW);
  const below = Math.max(1.5, 0.025 * eyeW);
  const step = Math.max(0.5, eyeW / 220);
  const across = 0.014 * eyeW;
  const T0 = -A - below, T1 = B + band + skin;
  const NP = Math.ceil((T1 - T0) / step) + 1;
  const prof = new Float32Array(NP), cs = new Float32Array(NP + 1);
  const NS = Math.ceil((A + B) / step) + 2, SC = new Float32Array(NS), TT = new Float32Array(NS);
  const at = (t) => clamp(Math.round((t - T0) / step), 0, NP - 1);
  const mean = (t0, t1) => { const a = at(t0), b = Math.max(a + 1, at(t1)); return (cs[b] - cs[a]) / (b - a); };

  for (let j = 0; j < M; j++) {
    const p = smp[j];
    let nX = -p.ty, nY = p.tx;                       // normal; make it point "up" (onto the lid)
    if (nX * up[0] + nY * up[1] < 0) { nX = -nX; nY = -nY; }
    nx[j] = nX; ny[j] = nY; px[j] = p.x; py[j] = p.y;
    for (let i = 0; i < NP; i++) {
      const t = T0 + i * step;
      const cx = p.x + nX * t, cy = p.y + nY * t;
      prof[i] = (lum(cx, cy) * 2 + lum(cx - p.tx * across, cy - p.ty * across) + lum(cx + p.tx * across, cy + p.ty * across)) / 4;
    }
    cs[0] = 0;
    for (let i = 0; i < NP; i++) cs[i + 1] = cs[i] + prof[i];

    // score: dark band [t, t+band] with bright skin above and (bonus) bright eye below
    let nS = 0;
    for (let t = -A; t <= B + 1e-6; t += step) {
      const lb = mean(t, t + band);
      const ls = mean(t + band, t + band + skin);
      const le = mean(t - below, t);
      const prior = 10 * (t / (t < 0 ? A : B)) ** 2;     // prefer MediaPipe when unsure
      SC[nS] = (ls - lb) + 0.85 * Math.max(0, le - lb) - prior;   // eye-white edge is the surest anchor
      TT[nS++] = t;
    }
    let best = -1e9, bestI = 0;
    for (let i = 0; i < nS; i++) if (SC[i] > best) { best = SC[i]; bestI = i; }
    // Thick real lashes / mascara give a second peak at the TOP of the dark
    // mass. The lid margin is the lowest edge → among near-equal local maxima
    // take the one closest to the eye.
    for (let i = 0; i < bestI; i++) {
      if (SC[i] >= 0.85 * best && SC[i] >= (SC[i - 1] ?? -1e9) && SC[i] >= SC[i + 1]) { bestI = i; break; }
    }
    let bestT = TT[bestI]; best = SC[bestI];
    // Thick dark mass (dense lashes): slide down through it to the eye-white
    // edge — that lower edge is the lid margin. Over the iris (dark below as
    // well) the walk hits the thickness limit and the candidate is kept.
    let ambiguous = false;
    {
      const lb = mean(bestT, bestT + band), ls = mean(bestT + band, bestT + band + skin);
      const thr = lb + 0.4 * Math.max(0, ls - lb);
      let t = bestT;
      const tMin = Math.max(-A, bestT - 0.07 * eyeW);
      while (t - step >= tMin && mean(t - step, t) < thr) t -= step;
      if (t < bestT - 0.5 * step && mean(t - below, t) > thr + 0.1 * Math.max(0, ls - lb)) bestT = t;
      // dark continues far below and never reaches the eye white (iris under
      // dense lashes): the margin can't be told from luminance → low trust
      else if (bestT - t > 1.5 * band) ambiguous = true;
    }
    if (dbg && dbg.j === j) { dbg.t = Array.from(TT.subarray(0, nS)); dbg.sc = Array.from(SC.subarray(0, nS)); dbg.prof = Array.from(prof); dbg.T0 = T0; dbg.step = step; }
    let second = -1e9;
    for (let i = 0; i < nS; i++) if (Math.abs(TT[i] - bestT) > band * 1.5 && SC[i] > second && SC[i] >= (SC[i - 1] ?? -1e9) && SC[i] >= (SC[i + 1] ?? -1e9)) second = SC[i];
    // confidence: enough contrast, not ambiguous, not at the window edge
    let c = ss(6, 26, best);
    if (second > -1e8) c *= 1 - 0.7 * ss(0.75, 1.0, second / Math.max(best, 1e-3));
    c *= 1 - ss(0.85, 1.0, Math.abs(bestT) / (bestT < 0 ? A : B));
    c *= ss(0.0, 0.08, lineS(j)) * ss(1.0, 0.9, lineS(j));          // corners: normals unreliable
    if (ambiguous) c *= 0.3;
    off[j] = bestT;
    conf[j] = c;
  }
  return { off, conf, nx, ny, px, py };
}

/** Confidence-weighted smoothing along the lid, pulled toward 0 (MediaPipe). */
export function smoothLid(raw, eyeW, prior = 0.35, sigma = 0.11) {
  const M = LINE_SAMPLES, out = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    let num = 0, den = 0, kw = 0;
    for (let j = 0; j < M; j++) {
      const d = (lineS(i) - lineS(j)) / sigma, k = Math.exp(-0.5 * d * d);
      num += k * raw.conf[j] * raw.off[j]; den += k * raw.conf[j]; kw += k;
    }
    out[i] = clamp(num / (den + prior * kw / M * 3 + 1e-6), -0.045 * eyeW, 0.05 * eyeW);
  }
  return out;
}

// ── frame access: small grayscale crop around each eye ──────────────────────
let cv = null, cx = null;
function grabLum(frame, fw, fh, W, H, box, targetEyeW, eyeW) {
  const sc = clamp(targetEyeW / Math.max(eyeW, 1), 0.2, 1);
  const gw = Math.max(8, Math.round(box.w * sc)), gh = Math.max(8, Math.round(box.h * sc));
  if (!cv) {
    // OffscreenCanvas 2D is missing on Safari < 16.4 → fall back to a DOM canvas
    try { if (typeof OffscreenCanvas !== 'undefined') { cv = new OffscreenCanvas(gw, gh); cx = cv.getContext('2d', { willReadFrequently: true }); } } catch (_) { cx = null; }
    if (!cx) { cv = document.createElement('canvas'); cv.width = gw; cv.height = gh; cx = cv.getContext('2d', { willReadFrequently: true }); }
  }
  if (cv.width < gw) cv.width = gw;
  if (cv.height < gh) cv.height = gh;
  const kx = fw / W, ky = fh / H;
  cx.drawImage(frame, box.x * kx, box.y * ky, box.w * kx, box.h * ky, 0, 0, gw, gh);
  const d = cx.getImageData(0, 0, gw, gh).data;
  const L = new Float32Array(gw * gh);
  for (let i = 0, o = 0; i < L.length; i++, o += 4) L[i] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  const gx = gw / box.w, gy = gh / box.h;
  return (x, y) => {
    const u = clamp((x - box.x) * gx - 0.5, 0, gw - 1.001), v = clamp((y - box.y) * gy - 0.5, 0, gh - 1.001);
    const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, i = y0 * gw + x0;
    return (L[i] * (1 - fx) + L[i + 1] * fx) * (1 - fy) + (L[i + gw] * (1 - fx) + L[i + gw + 1] * fx) * fy;
  };
}

function frameSize(f) {
  return [f.videoWidth || f.naturalWidth || f.displayWidth || f.codedWidth || f.width || 0,
          f.videoHeight || f.naturalHeight || f.displayHeight || f.codedHeight || f.height || 0];
}

// ── temporal state ──────────────────────────────────────────────────────────
const STATE = { R: null, L: null };
let _tick = 0;
let _last = null;
export function resetLashLine() { STATE.R = STATE.L = null; _last = null; }
export function getLastLashLine() { return _last; }

/**
 * Update the lash-line correction for both eyes from the current frame.
 * @param frame  video / canvas / image (the raw camera frame)
 * @param W,H    landmark pixel space (canvas size)
 * @param eyes   { R: {lid:[[x,y]...], up:[ux,uy], eyeW, open}, L: {...} }
 * @returns { R: {dx,dy}|null, L: ... } — per-sample offset vectors (image px)
 */
export function updateLashLine(frame, W, H, eyes) {
  if (!enabled || !frame) return null;
  const [fw, fh] = frameSize(frame);
  if (!fw || !fh) return null;
  const run = (_tick++ & 1) === 0 || !STATE.R;          // detect every 2nd frame, EMA bridges
  const res = {};
  for (const side of ['R', 'L']) {
    const e = eyes[side];
    if (!e) { STATE[side] = null; res[side] = null; continue; }
    let st = STATE[side];
    if (!st || Math.abs(st.eyeW - e.eyeW) > 0.35 * st.eyeW) {
      st = STATE[side] = { off: new Float32Array(LINE_SAMPLES), nx: new Float32Array(LINE_SAMPLES), ny: new Float32Array(LINE_SAMPLES), eyeW: e.eyeW, init: false, conf: new Float32Array(LINE_SAMPLES), px: new Float32Array(LINE_SAMPLES), py: new Float32Array(LINE_SAMPLES) };
    }
    st.eyeW = e.eyeW;
    if (run) {
      try {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of e.lid) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        const m = 0.16 * e.eyeW;
        const box = { x: Math.max(0, x0 - m), y: Math.max(0, y0 - m), w: 0, h: 0 };
        box.w = Math.min(W, x1 + m) - box.x; box.h = Math.min(H, y1 + m) - box.y;
        if (box.w > 4 && box.h > 4) {
          const lum = grabLum(frame, fw, fh, W, H, box, 140, e.eyeW);
          const raw = detectLidRaw(lum, e.lid, e.up, e.eyeW);
          const sm = smoothLid(raw, e.eyeW);
          // trust fades as the eye closes (no lash line to see)
          const trust = ss(0.45, 0.8, e.open);
          const k = st.init ? 0.45 : 1;
          for (let j = 0; j < LINE_SAMPLES; j++) {
            st.off[j] += (sm[j] * trust - st.off[j]) * k;
            st.nx[j] = raw.nx[j]; st.ny[j] = raw.ny[j]; st.conf[j] = raw.conf[j];
            st.px[j] = raw.px[j]; st.py[j] = raw.py[j];
          }
          st.init = true;
        }
      } catch (_) { /* tainted canvas / detached frame: keep last */ }
    }
    if (!st.init) { res[side] = null; continue; }
    const dx = new Float32Array(LINE_SAMPLES), dy = new Float32Array(LINE_SAMPLES);
    for (let j = 0; j < LINE_SAMPLES; j++) { dx[j] = st.nx[j] * st.off[j]; dy[j] = st.ny[j] * st.off[j]; }
    res[side] = { dx, dy, conf: st.conf, off: st.off, px: st.px, py: st.py };
  }
  _last = res;
  return res;
}

/** Offset vector at arc-length fraction s (linear between samples, 0 beyond). */
export function lineOffsetAt(o, s, out) {
  if (!o) { out[0] = out[1] = 0; return out; }
  const u = (s - S0) / (S1 - S0) * (LINE_SAMPLES - 1);
  if (u <= 0) { const f = clamp(1 + u / 1.5, 0, 1); out[0] = o.dx[0] * f; out[1] = o.dy[0] * f; return out; }
  if (u >= LINE_SAMPLES - 1) { const f = clamp(1 - (u - LINE_SAMPLES + 1) / 1.5, 0, 1); out[0] = o.dx[LINE_SAMPLES - 1] * f; out[1] = o.dy[LINE_SAMPLES - 1] * f; return out; }
  const i = u | 0, f = u - i;
  out[0] = o.dx[i] + (o.dx[i + 1] - o.dx[i]) * f;
  out[1] = o.dy[i] + (o.dy[i + 1] - o.dy[i]) * f;
  return out;
}

/** Debug overlay: MediaPipe lid (blue), detected lash line (green), confidence dots. */
export function drawLashLine(ctx) {
  const r = _last;
  if (!r) return;
  ctx.save();
  ctx.lineWidth = Math.max(1, ctx.canvas.width / 900);
  for (const side of ['R', 'L']) {
    const o = r[side];
    if (!o) continue;
    ctx.strokeStyle = 'rgba(40,140,255,0.9)'; ctx.beginPath();
    for (let j = 0; j < LINE_SAMPLES; j++) ctx[j ? 'lineTo' : 'moveTo'](o.px[j], o.py[j]);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,255,90,0.95)'; ctx.beginPath();
    for (let j = 0; j < LINE_SAMPLES; j++) ctx[j ? 'lineTo' : 'moveTo'](o.px[j] + o.dx[j], o.py[j] + o.dy[j]);
    ctx.stroke();
    for (let j = 0; j < LINE_SAMPLES; j++) {
      const c = o.conf[j];
      ctx.fillStyle = `rgb(${Math.round(255 * (1 - c))},${Math.round(255 * c)},0)`;
      ctx.fillRect(o.px[j] + o.dx[j] - 1.5, o.py[j] + o.dy[j] - 1.5, 3, 3);
    }
  }
  ctx.restore();
}
