// faceLight.js — where the light comes from, estimated from the face itself.
//
// The face mesh gives a normal at each of its 468 vertices; the frame gives
// how bright the skin is there. Skin is close to Lambertian, so
//     I(v) ≈ a0 + a·n(v)
// a0 = ambient (+ the average of the key light), a = key light direction ×
// strength. A robust least-squares fit over the skin vertices (eyes, brows,
// lips, nostrils and the face border excluded; specular highlights and cast
// shadows down-weighted) gives the light direction in image space (x right,
// y down, z away from the camera — so a light near the camera has z < 0),
// its contrast vs ambient, and a confidence (fit quality, normal spread).
//
//   const track = createLightTracker();
//   const light = track(srcCanvasOrVideo, landmarks);   // every frame (it throttles itself)
//   // → { dir:[x,y,z], ambientShare, contrast, conf, azimuth, elevation }

import { UV, UV_COUNT } from './faceMeshUV.js';
import { meshNormals } from './uvMasks.js';
import { FACE_OVAL } from '../regions.js';

// Skin vertices: by canonical UV position (layout is a frontal projection).
const SKIN = (() => {
  const oval = new Set(FACE_OVAL);
  const m = new Uint8Array(UV_COUNT);
  for (let i = 0; i < UV_COUNT; i++) {
    const u = UV[2 * i], v = UV[2 * i + 1], du = Math.abs(u - 0.5);
    let skin = !oval.has(i);
    if (du < 0.14 && v > 0.23 && v < 0.375) skin = false;                                   // lips
    for (const cu of [0.35, 0.65]) if (((u - cu) / 0.095) ** 2 + ((v - 0.625) / 0.055) ** 2 < 1) skin = false;   // eyes
    if (v > 0.66 && v < 0.79 && du > 0.05 && du < 0.3) skin = false;                         // brows
    if (du > 0.015 && du < 0.085 && v > 0.395 && v < 0.465) skin = false;                    // nostrils
    m[i] = skin ? 1 : 0;
  }
  return m;
})();

const S = 96;   // face crop resolution for sampling
let cropCv = null;
const nrm = new Float32Array(UV_COUNT * 3);
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LIN = new Float32Array(256); for (let i = 0; i < 256; i++) LIN[i] = lin(i);

/** One-shot estimate (no smoothing). Returns null if it can't be measured. */
export function estimateFaceLight(src, landmarks) {
  if (!src || !landmarks || landmarks.length < UV_COUNT) return null;
  const vw = src.videoWidth || src.naturalWidth || src.width, vh = src.videoHeight || src.naturalHeight || src.height;
  if (!vw || !vh) return null;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const i of FACE_OVAL) { const p = landmarks[i]; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1);
  const bw = (x1 - x0) * vw, bh = (y1 - y0) * vh;
  if (bw < 24 || bh < 24) return null;
  if (!cropCv) { cropCv = document.createElement('canvas'); cropCv.width = cropCv.height = S; cropCv._ctx = cropCv.getContext('2d', { willReadFrequently: true }); }
  const cx = cropCv._ctx;
  let px;
  try { cx.drawImage(src, x0 * vw, y0 * vh, bw, bh, 0, 0, S, S); px = cx.getImageData(0, 0, S, S).data; } catch (_) { return null; }
  meshNormals(landmarks, vw, vh, nrm);

  // samples: luminance (linear) around each skin vertex that faces the camera
  const X = [], Y = [];
  for (let i = 0; i < UV_COUNT; i++) {
    if (!SKIN[i]) continue;
    const nz = nrm[3 * i + 2];
    if (-nz < 0.2) continue;
    const gx = (landmarks[i].x - x0) / (x1 - x0) * S, gy = (landmarks[i].y - y0) / (y1 - y0) * S;
    if (gx < 1 || gy < 1 || gx > S - 2 || gy > S - 2) continue;
    let sum = 0, n = 0, sat = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const o = (((gy | 0) + dy) * S + ((gx | 0) + dx)) * 4;
      if (px[o] > 250 || px[o + 1] > 250) sat = true;
      sum += 0.2126 * LIN[px[o]] + 0.7152 * LIN[px[o + 1]] + 0.0722 * LIN[px[o + 2]]; n++;
    }
    if (sat) continue;
    X.push([1, nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]]); Y.push(sum / n);
  }
  if (Y.length < 60) return null;

  // robust least squares (IRLS, Cauchy weights): highlights & cast shadows are outliers
  const w = new Float64Array(Y.length).fill(1);
  let beta = null;
  for (let it = 0; it < 4; it++) {
    const A = new Float64Array(16), b = new Float64Array(4);
    for (let k = 0; k < Y.length; k++) {
      const x = X[k], wk = w[k];
      for (let r = 0; r < 4; r++) { b[r] += wk * x[r] * Y[k]; for (let c = 0; c < 4; c++) A[r * 4 + c] += wk * x[r] * x[c]; }
    }
    for (let r = 1; r < 4; r++) A[r * 4 + r] += 1e-4 * A[0];   // tiny ridge: a frontal face has little normal spread in z
    beta = solve4(A, b);
    if (!beta) return null;
    const res = Y.map((y, k) => y - (beta[0] + beta[1] * X[k][1] + beta[2] * X[k][2] + beta[3] * X[k][3]));
    const ab = res.map(Math.abs).sort((p, q) => p - q);
    const sc = Math.max(1e-4, 1.4826 * ab[ab.length >> 1]);
    // attached shadow (surface turned from the light): the linear model
    // doesn't hold there (it's clamped at 0) — leave those samples out
    const am = Math.hypot(beta[1], beta[2], beta[3]) || 1;
    for (let k = 0; k < Y.length; k++) {
      const e = res[k] / (2.5 * sc);
      const nl = (beta[1] * X[k][1] + beta[2] * X[k][2] + beta[3] * X[k][3]) / am;
      w[k] = (1 / (1 + e * e)) * (it > 0 ? Math.min(1, Math.max(0, (nl - 0.02) / 0.15)) : 1);
    }
  }
  let ax = beta[1], ay = beta[2], az = beta[3];
  const amag = Math.hypot(ax, ay, az);
  if (amag < 1e-5) return null;
  let dir = [ax / amag, ay / amag, az / amag];
  // A light behind the head can't light the face we see: keep it in front.
  if (dir[2] > -0.15) { dir[2] = -0.15; const l = Math.hypot(...dir); dir = dir.map((c) => c / l); }
  // fit quality (weighted R²) and how well the normals constrain the fit
  let mean = 0, sw = 0; for (let k = 0; k < Y.length; k++) { mean += w[k] * Y[k]; sw += w[k]; } mean /= sw;
  let ssr = 0, sst = 0;
  for (let k = 0; k < Y.length; k++) {
    const f = beta[0] + beta[1] * X[k][1] + beta[2] * X[k][2] + beta[3] * X[k][3];
    ssr += w[k] * (Y[k] - f) ** 2; sst += w[k] * (Y[k] - mean) ** 2;
  }
  const r2 = sst > 0 ? 1 - ssr / sst : 0;
  const peak = beta[0] + amag;                 // brightness facing the light
  const ambientShare = Math.max(0, Math.min(1, (peak - amag) / Math.max(1e-4, peak)));
  return {
    dir, ambientShare,
    contrast: Math.max(0, Math.min(1, amag / Math.max(1e-4, peak))),
    conf: Math.max(0, Math.min(1, (r2 - 0.15) / 0.5)),
    level: peak,
  };
}

/** Throttled, temporally smoothed tracker (direction eased on the sphere). */
export function createLightTracker({ every = 2, ease = 0.15 } = {}) {
  let n = 0, state = null;
  function track(src, landmarks) {
    if (n++ % every === 0) {
      const e = estimateFaceLight(src, landmarks);
      if (e) {
        if (!state) state = { ...e, dir: [...e.dir] };
        else {
          const k = ease * (0.3 + 0.7 * e.conf);
          const d = state.dir.map((c, i) => c + (e.dir[i] - c) * k);
          const l = Math.hypot(...d) || 1;
          state.dir = d.map((c) => c / l);
          for (const key of ['ambientShare', 'contrast', 'conf', 'level']) state[key] += (e[key] - state[key]) * k;
        }
      }
    }
    if (!state) return null;
    const [x, y, z] = state.dir;
    return {
      ...state,
      azimuth: Math.atan2(x, -z) * 180 / Math.PI,     // + = light from image right
      elevation: Math.atan2(-y, Math.hypot(x, z)) * 180 / Math.PI,   // + = from above
    };
  }
  track.reset = () => { state = null; n = 0; };
  return track;
}

function solve4(A, b) {
  const M = [0, 1, 2, 3].map((r) => [A[r * 4], A[r * 4 + 1], A[r * 4 + 2], A[r * 4 + 3], b[r]]);
  for (let c = 0; c < 4; c++) {
    let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 4; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 5; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[4] / row[i]);
}
