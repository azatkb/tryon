// 3D strand lashes (mascara) — GPU-instanced bezier ribbons.
//
// Every lash is modelled as a short 3D curve that grows out of the lid margin:
//   root direction = forward + up (+ outward fan at the outer corner),
//   then it curls up along its length.
// Control points are built in the head's own 3D frame (from landmarks x, y, z)
// and projected to the image, so the look adapts by itself:
//   • frontal  — lashes are foreshortened at the root and curl up above the lid;
//   • turned   — the far eye shows the lashes in profile, sweeping forward;
//   • blink / looking down — the upper lid rotates the lashes down with it;
//   • any resolution — length and thickness scale with the eye's 3D width.
// Strands are grouped into mascara clumps (roots apart, tips converging into
// spikes), with a dense dark root line and short coated lower lashes.
// All randomness is per-strand deterministic, so nothing flickers.

import { EYE_R_LASH, EYE_L_LASH } from './regions.js';
import { updateLashLine, lineOffsetAt } from './lashLineDetect.js';

const EYE_R_LOW = [33, 7, 163, 144, 145, 153, 154, 155, 133];
const EYE_L_LOW = [263, 249, 390, 373, 374, 380, 381, 382, 362];
const EAR_R = { c: [33, 133], v: [[159, 145], [158, 153], [160, 144]] };
const EAR_L = { c: [263, 362], v: [[386, 374], [385, 380], [387, 373]] };

// ── Tunable style (debug sliders / product presets) ─────────────────────────
const STYLE_DEFAULT = {
  length: 1,     // overall length multiplier
  volume: 1,     // strand thickness
  curl: 1,       // curl amount
  clump: 1,      // how much strands gather into spikes
  lower: 1,      // lower lashes opacity (0 = off)
  density: 1,    // strand count
};
const STYLE = { ...STYLE_DEFAULT };
export function setLashStyle(s = {}) {
  const prevDensity = STYLE.density;
  for (const k of Object.keys(STYLE_DEFAULT)) if (typeof s[k] === 'number' && isFinite(s[k])) STYLE[k] = s[k];
  if (STYLE.density !== prevDensity) GENES = null;
}
export function getLashStyle() { return { ...STYLE }; }
export function resetLashStyle() { setLashStyle(STYLE_DEFAULT); }

// ── Shaders ─────────────────────────────────────────────────────────────────
// Positions are in canvas pixels (y down). Coverage-based anti-aliasing:
// the ribbon is drawn a bit wider than the strand and the fragment shader
// computes how much of the pixel the strand covers (sub-pixel strands just
// get fainter instead of aliasing into a saw).

const LASH_VERT = `
precision highp float;
attribute vec2 aTS;       // x: t 0..1 along the curve, y: side -1 / +1
attribute vec4 iA;        // P0.xy, P1.xy (px)
attribute vec4 iB;        // P2.xy, P3.xy (px)
attribute vec4 iC;        // root half width, tip half width (px), alpha, sheen
attribute float iD;       // t where the tip fade starts
uniform vec2 uRes;
uniform float uSoft;
varying float vAlpha;
varying float vDist;
varying float vHW;
varying float vShade;
varying float vSoft;
void main() {
  float t = aTS.x, it = 1.0 - t;
  vec2 P0 = iA.xy, P1 = iA.zw, P2 = iB.xy, P3 = iB.zw;
  vec2 pos = it*it*it*P0 + 3.0*it*it*t*P1 + 3.0*it*t*t*P2 + t*t*t*P3;
  vec2 tang = it*it*(P1 - P0) + 2.0*it*t*(P2 - P1) + t*t*(P3 - P2);
  float tl = length(tang);
  tang = tl > 1e-5 ? tang / tl : vec2(0.0, -1.0);
  vec2 nrm = vec2(-tang.y, tang.x);
  float hw = mix(iC.y, iC.x, pow(it, 0.62));          // coated base/middle, fine tip
  float hwD = max(hw, 0.5) + 0.5 * uSoft + 0.5;       // drawn half width (AA margin)
  pos += nrm * aTS.y * hwD;
  vDist = aTS.y * hwD;
  vSoft = uSoft;
  vHW = hw;
  vShade = iC.w * (1.0 - t);
  vAlpha = iC.z * (1.0 - 0.85 * smoothstep(iD, 1.0, t));
  gl_Position = vec4(pos.x / uRes.x * 2.0 - 1.0, 1.0 - pos.y / uRes.y * 2.0, 0.0, 1.0);
}`;

const LASH_FRAG = `
precision mediump float;
varying float vAlpha;
varying float vDist;
varying float vHW;
varying float vShade;
varying float vSoft;
uniform vec3 uColor;
void main() {
  float hwE = max(vHW, 0.5);
  float d = abs(vDist);
  float cov = 1.0 - smoothstep(hwE - 0.5 * vSoft, hwE + 0.5 * vSoft, d);
  cov *= vHW / hwE;                                   // thinner than a pixel → fainter
  float a = vAlpha * cov;
  if (a < 0.004) discard;
  float core = clamp(1.0 - d / hwE, 0.0, 1.0);
  vec3 col = uColor + vec3(0.11, 0.11, 0.12) * vShade * core * core;   // wet mascara sheen
  gl_FragColor = vec4(col, a);
}`;

// ── GL state ────────────────────────────────────────────────────────────────
let lashProg = null;
let ext = null;
let stripBuf = null;
let instBuf = null;
let lashLoc = {};
const SEGMENTS = 14;
let stripVerts = 0;
let _available = null;

const INST_FLOATS = 13;   // P0..P3 (8) + rootW, tipW, alpha, sheen, fade
const ATTRS = [['iA', 4], ['iB', 4], ['iC', 4], ['iD', 1]];   // 5 attributes total (WebGL1 min is 8)

export function lash3dAvailable() {
  if (_available !== null) return _available;
  try {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl') || c.getContext('experimental-webgl');
    _available = !!(g && g.getExtension('ANGLE_instanced_arrays'));
  } catch (_) { _available = false; }
  return _available;
}

function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('lash3d shader:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function initLash3d(gl) {
  if (lashProg) return true;
  ext = gl.getExtension('ANGLE_instanced_arrays');
  if (!ext) return false;
  const vs = compileShader(gl, gl.VERTEX_SHADER, LASH_VERT);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, LASH_FRAG);
  if (!vs || !fs) return false;
  lashProg = gl.createProgram();
  gl.attachShader(lashProg, vs);
  gl.attachShader(lashProg, fs);
  gl.linkProgram(lashProg);
  if (!gl.getProgramParameter(lashProg, gl.LINK_STATUS)) {
    console.error('lash3d link:', gl.getProgramInfoLog(lashProg));
    lashProg = null;
    return false;
  }
  lashLoc = {
    aTS: gl.getAttribLocation(lashProg, 'aTS'),
    uColor: gl.getUniformLocation(lashProg, 'uColor'),
    uRes: gl.getUniformLocation(lashProg, 'uRes'),
    uSoft: gl.getUniformLocation(lashProg, 'uSoft'),
  };
  for (const [n] of ATTRS) lashLoc[n] = gl.getAttribLocation(lashProg, n);

  const verts = [];
  for (let i = 0; i <= SEGMENTS; i++) { const t = i / SEGMENTS; verts.push(t, -1, t, 1); }
  stripVerts = verts.length / 2;
  stripBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, stripBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  instBuf = gl.createBuffer();
  return true;
}

// ── Small math helpers ──────────────────────────────────────────────────────
const D2R = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Strand "genes": fixed per-strand randomness (built once) ────────────────
let GENES = null;

function clumpify(strands, r, sizes, freeShare) {
  const clumps = [];
  let i = 0;
  while (i < strands.length) {
    const free = r() < freeShare;
    const k = free ? 1 : sizes[0] + Math.floor(r() * (sizes[1] - sizes[0] + 1));
    const members = strands.slice(i, i + k);
    const sC = members.reduce((a, m) => a + m.s, 0) / members.length;
    const c = {
      s: sC, len: 0.84 + 0.3 * r(), a0: (r() - 0.5) * 12 * D2R, beta: (r() - 0.5) * 10 * D2R,
      curl: 0.85 + 0.3 * r(), w: free ? 0 : 0.75 + 0.25 * r(),
    };
    for (const m of members) m.clump = clumps.length;
    clumps.push(c);
    i += k;
  }
  return clumps;
}

function buildGenes() {
  const dens = clamp(STYLE.density, 0.4, 2);
  const make = (seed) => {
    const r = mulberry32(seed);
    // upper lashes — denser at the outer half, sparser toward the inner corner
    const NU = Math.round(92 * dens);
    const upper = [];
    for (let i = 0; i < NU; i++) {
      const u = clamp((i + 0.5 + (r() - 0.5) * 0.8) / NU, 0, 1);
      upper.push({
        s: 0.955 * Math.pow(u, 1.2),
        len: 0.8 + 0.32 * r(),
        a0: (r() - 0.5) * 14 * D2R,
        beta: (r() - 0.5) * 9 * D2R,
        curl: 0.8 + 0.4 * r(),
        w: 0.72 + 0.5 * r(),
        alpha: 0.86 + 0.14 * r(),
        shade: r(),
      });
    }
    for (const g of upper) if (r() < 0.07) { g.beta += (r() < 0.5 ? -1 : 1) * (10 + 9 * r()) * D2R; g.cross = true; }
    const upperClumps = clumpify(upper, r, [2, 6], 0.14);
    // short dense strands at the root → dark, full lash line
    const NF = Math.round(60 * dens);
    const fill = [];
    for (let i = 0; i < NF; i++) {
      const u = clamp((i + 0.5 + (r() - 0.5) * 0.9) / NF, 0, 1);
      fill.push({ s: 0.93 * u, len: 0.045 + 0.05 * r(), a0: (25 + 20 * r()) * D2R, beta: (r() - 0.5) * 24 * D2R, w: 1.0 + 0.45 * r(), alpha: 0.75 + 0.25 * r() });
    }
    // lower lashes — short, sparse, mostly outer two thirds
    const NL = Math.round(26 * dens);
    const lower = [];
    for (let i = 0; i < NL; i++) {
      const u = clamp((i + 0.5 + (r() - 0.5) * 0.9) / NL, 0, 1);
      lower.push({
        s: 0.04 + 0.72 * Math.pow(u, 1.1),
        len: 0.7 + 0.45 * r(),
        a0: (r() - 0.5) * 16 * D2R,
        beta: (r() - 0.5) * 16 * D2R,
        curl: 0.7 + 0.6 * r(),
        w: 0.7 + 0.5 * r(),
        alpha: 0.7 + 0.3 * r(),
      });
    }
    const lowerClumps = clumpify(lower, r, [2, 2], 0.55);
    return { upper, upperClumps, fill, lower, lowerClumps };
  };
  // mirror-ish but not identical eyes
  GENES = { R: make(1337), L: make(7331) };
}

// ── Head frame & lid curves from landmarks (pixel space, y down) ────────────
const P3 = (lm, i, W, H) => [lm[i].x * W, lm[i].y * H, (lm[i].z || 0) * W];

function headFrame(lm, W, H) {
  const a = P3(lm, 33, W, H), b = P3(lm, 263, W, H), t = P3(lm, 10, W, H), c = P3(lm, 152, W, H);
  const X = norm(sub(b, a));
  let Y = sub(t, c);
  const d = dot(Y, X);
  Y = norm([Y[0] - d * X[0], Y[1] - d * X[1], Y[2] - d * X[2]]);   // head up (−y in image)
  let F = cross(X, Y);
  // forward = toward the nose tip. (The sign of F.z alone is unreliable in
  // near-profile views where F lies almost in the image plane.)
  const nose = P3(lm, 1, W, H);
  const toNose = sub(nose, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  if (dot(F, toNose) < 0) F = [-F[0], -F[1], -F[2]];
  return { X, Y, F, oc: len3(sub(b, a)) };
}

// Catmull-Rom resampled lid curve with an arc-length lookup (flat buffers,
// no per-frame allocations in the hot path).
const LID_SUBS = 6;
function makeLid(n) {
  const m = (n - 1) * LID_SUBS + 1;
  return { n, m, p: new Float64Array(n * 3), pts: new Float64Array(m * 3), cum: new Float64Array(m), total: 1, pts2: Array.from({ length: n }, () => [0, 0]) };
}
const LIDS = { RU: makeLid(9), RL: makeLid(9), LU: makeLid(9), LL: makeLid(9) };

function lidCurve(L, lm, ids, W, H) {
  const { n, p, pts, cum } = L;
  for (let k = 0; k < n; k++) {
    const q = lm[ids[k]];
    p[3 * k] = q.x * W; p[3 * k + 1] = q.y * H; p[3 * k + 2] = (q.z || 0) * W;
    L.pts2[k][0] = p[3 * k]; L.pts2[k][1] = p[3 * k + 1];
  }
  let o = 0;
  for (let k = 0; k < n - 1; k++) {
    const i0 = 3 * Math.max(0, k - 1), i1 = 3 * k, i2 = 3 * (k + 1), i3 = 3 * Math.min(n - 1, k + 2);
    for (let j = 0; j < LID_SUBS; j++, o += 3) {
      const t = j / LID_SUBS, t2 = t * t, t3 = t2 * t;
      for (let c = 0; c < 3; c++) {
        const p0 = p[i0 + c], p1 = p[i1 + c], p2 = p[i2 + c], p3 = p[i3 + c];
        pts[o + c] = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      }
    }
  }
  pts[o] = p[3 * (n - 1)]; pts[o + 1] = p[3 * (n - 1) + 1]; pts[o + 2] = p[3 * (n - 1) + 2];
  cum[0] = 0;
  for (let k = 1; k < L.m; k++) {
    cum[k] = cum[k - 1] + Math.hypot(pts[3 * k] - pts[3 * k - 3], pts[3 * k + 1] - pts[3 * k - 2], pts[3 * k + 2] - pts[3 * k - 1]);
  }
  L.total = cum[L.m - 1] || 1;
  return L;
}
// point at arc-length fraction s (+ offset along dir·amt) → out[0..2]
const _corr = [0, 0];
function lidAt(L, s, dir, amt, out, corr = null) {
  const d = clamp(s, 0, 1) * L.total, cum = L.cum, pts = L.pts;
  let k = 1;
  while (k < L.m - 1 && cum[k] < d) k++;
  const f = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
  const a = 3 * (k - 1), b = 3 * k;
  out[0] = pts[a] + (pts[b] - pts[a]) * f + dir[0] * amt;
  out[1] = pts[a + 1] + (pts[b + 1] - pts[a + 1]) * f + dir[1] * amt;
  out[2] = pts[a + 2] + (pts[b + 2] - pts[a + 2]) * f + dir[2] * amt;
  if (corr) {                       // detected lash line (image-space nudge)
    lineOffsetAt(corr, s, _corr);
    out[0] += _corr[0]; out[1] += _corr[1];
  }
  return out;
}

function eyeOpenness(lm, W, H, E) {
  const w = len3(sub(P3(lm, E.c[0], W, H), P3(lm, E.c[1], W, H))) || 1;
  let v = 0;
  for (const [a, b] of E.v) v += len3(sub(P3(lm, a, W, H), P3(lm, b, W, H)));
  return ss(0.07, 0.24, v / E.v.length / w);
}

// Least-squares cubic bezier through a 2D polyline (end points fixed).
function fitBezier(q) {
  const n = q.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]));
  const T = cum[n - 1] || 1;
  const P0 = q[0], P3_ = q[n - 1];
  let a11 = 0, a12 = 0, a22 = 0; const r1 = [0, 0], r2 = [0, 0];
  for (let i = 0; i < n; i++) {
    const t = cum[i] / T, it = 1 - t;
    const b0 = it * it * it, b1 = 3 * it * it * t, b2 = 3 * it * t * t, b3 = t * t * t;
    a11 += b1 * b1; a12 += b1 * b2; a22 += b2 * b2;
    for (let c = 0; c < 2; c++) {
      const r = q[i][c] - b0 * P0[c] - b3 * P3_[c];
      r1[c] += b1 * r; r2[c] += b2 * r;
    }
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-9) return [P0, P0, P3_, P3_];
  const P1 = [0, 0], P2 = [0, 0];
  for (let c = 0; c < 2; c++) {
    P1[c] = (r1[c] * a22 - r2[c] * a12) / det;
    P2[c] = (a11 * r2[c] - a12 * r1[c]) / det;
  }
  return [P0, P1, P2, P3_];
}

// ── Instance building ───────────────────────────────────────────────────────
let _inst = new Float32Array(INST_FLOATS * 1024);
let _n = 0;
function grow() {
  if ((_n + 1) * INST_FLOATS > _inst.length) { const b = new Float32Array(_inst.length * 2); b.set(_inst); _inst = b; }
}
function push(p0, p1, p2, p3, rootW, tipW, alpha, shade, fade) {
  if (alpha < 0.01) return;
  grow();
  const o = _n * INST_FLOATS;
  _inst[o] = p0[0]; _inst[o + 1] = p0[1]; _inst[o + 2] = p1[0]; _inst[o + 3] = p1[1];
  _inst[o + 4] = p2[0]; _inst[o + 5] = p2[1]; _inst[o + 6] = p3[0]; _inst[o + 7] = p3[1];
  _inst[o + 8] = rootW; _inst[o + 9] = tipW; _inst[o + 10] = alpha; _inst[o + 11] = shade; _inst[o + 12] = fade;
  _n++;
}
// strand S (12 numbers at so) pulled toward clump C (at co) by w1..w3, projected (drop z)
function pushStrand(S, so, C, co, w1, w2, w3, rootW, tipW, alpha, shade, fade) {
  if (alpha < 0.01) return;
  grow();
  const o = _n * INST_FLOATS;
  _inst[o] = S[so]; _inst[o + 1] = S[so + 1];
  if (C) {
    _inst[o + 2] = S[so + 3] + (C[co + 3] - S[so + 3]) * w1; _inst[o + 3] = S[so + 4] + (C[co + 4] - S[so + 4]) * w1;
    _inst[o + 4] = S[so + 6] + (C[co + 6] - S[so + 6]) * w2; _inst[o + 5] = S[so + 7] + (C[co + 7] - S[so + 7]) * w2;
    _inst[o + 6] = S[so + 9] + (C[co + 9] - S[so + 9]) * w3; _inst[o + 7] = S[so + 10] + (C[co + 10] - S[so + 10]) * w3;
  } else {
    _inst[o + 2] = S[so + 3]; _inst[o + 3] = S[so + 4]; _inst[o + 4] = S[so + 6];
    _inst[o + 5] = S[so + 7]; _inst[o + 6] = S[so + 9]; _inst[o + 7] = S[so + 10];
  }
  _inst[o + 8] = rootW; _inst[o + 9] = tipW; _inst[o + 10] = alpha; _inst[o + 11] = shade; _inst[o + 12] = fade;
  _n++;
}

// 3D control polygon of one strand → out[o..o+11]: root + three segments whose
// elevation grows by the curl → a smooth upward curl once drawn as a bezier.
// Elevation is measured from the face-forward direction toward head-up; beta
// turns the lash sideways (toward the outer corner when positive).
function strandCPs(root, L, a0, curl, beta, fr, out, o) {
  const { F, Y, E } = fr;
  const cb = Math.cos(beta), sb = Math.sin(beta);
  const hx = cb * F[0] + sb * E[0], hy = cb * F[1] + sb * E[1], hz = cb * F[2] + sb * E[2];
  let px = root[0], py = root[1], pz = root[2];
  out[o] = px; out[o + 1] = py; out[o + 2] = pz;
  const l = L / 3;
  for (let k = 0; k < 3; k++) {
    const a = a0 + curl * k * 0.5, ca = Math.cos(a) * l, sa = Math.sin(a) * l;
    px += ca * hx + sa * Y[0]; py += ca * hy + sa * Y[1]; pz += ca * hz + sa * Y[2];
    const q = o + 3 * (k + 1);
    out[q] = px; out[q + 1] = py; out[q + 2] = pz;
  }
}

let _clumpBuf = new Float64Array(12 * 64);
const _sBuf = new Float64Array(12);
const _root = [0, 0, 0];

function buildEye(lm, W, H, hf, side, eyeW, open, A, hasEyeliner, corr) {
  const G = GENES[side];
  const up = lidCurve(side === 'R' ? LIDS.RU : LIDS.LU, lm, side === 'R' ? EYE_R_LASH : EYE_L_LASH, W, H);
  const lo = lidCurve(side === 'R' ? LIDS.RL : LIDS.LL, lm, side === 'R' ? EYE_R_LOW : EYE_L_LOW, W, H);
  const outerId = side === 'R' ? 33 : 263, innerId = side === 'R' ? 133 : 362;
  const sgn = Math.sign(dot(sub(P3(lm, outerId, W, H), P3(lm, innerId, W, H)), hf.X)) || (side === 'R' ? -1 : 1);
  const fr = { F: hf.F, Y: hf.Y, E: [hf.X[0] * sgn, hf.X[1] * sgn, hf.X[2] * sgn] };
  // How much this eye faces the camera (its region looks forward + outward).
  // The far eye on a strong turn hides behind the nose bridge → fade it out.
  const nz = (hf.F[2] + 0.6 * fr.E[2]) / 1.166;
  const vis = ss(0.13, 0.3, -nz);   // MediaPipe under-reports yaw near profile
  if (vis < 0.01) return;
  // Far eye on a turn: near the nose the lid drops steeply in perspective and
  // its lashes would hang along it like a tail → shorten, bend down, fade.
  const far = ss(0.85, 0.4, -nz);                   // 0 frontal / near eye → 1 clearly turned away
  const innerCut = (s) => far * ss(0.38, 0.85, s);

  const k = clamp(A, 0, 1);
  const lenMul = STYLE.length * (0.82 + 0.28 * k);
  const thick = STYLE.volume * (0.7 + 0.5 * k);
  const clumpK = clamp(STYLE.clump * (0.55 + 0.4 * k), 0, 1);
  const curlMul = STYLE.curl;
  const alphaU = (0.5 + 0.5 * k) * vis;
  const lidRot = (1 - open) * 88 * D2R;            // lid closing rotates lashes down
  const hw0 = eyeW * 0.0036 * thick;               // root half width (px)
  const tipW = Math.min(0.22, hw0 * 0.1);
  const Y = hf.Y, liftU = eyeW * 0.008, dropL = -eyeW * 0.007;
  const nC = Math.max(G.upperClumps.length, G.lowerClumps.length);
  if (_clumpBuf.length < nC * 12) _clumpBuf = new Float64Array(nC * 12);
  const CB = _clumpBuf, S = _sBuf;

  // upper profiles along the lid (s: 0 outer corner → 1 inner corner)
  const lenProf = (s) => (0.74 + 0.26 * ss(0, 0.17, s)) * (1 - 0.72 * ss(0.3, 0.97, s));   // shorter toward the nose
  const betaProf = (s) => (s < 0.55 ? 64 * Math.pow(1 - s / 0.55, 1.45) : -20 * Math.pow((s - 0.55) / 0.45, 1.2)) * D2R;
  const a0Prof = (s) => (10 + 16 * ss(0, 0.3, s)) * D2R;          // flatter sweep at the outer corner
  const curlProf = (s) => (48 + 34 * ss(0.02, 0.35, s)) * D2R;    // tips curl up, less at the corner
  const Lbase = eyeW * 0.37 * lenMul;

  // lash-line ribbon (under the strands)
  if (!hasEyeliner) {
    const lift = eyeW * 0.004;
    const q = up.pts2.map((p, i) => {
      if (corr) lineOffsetAt(corr, up.cum[i * LID_SUBS] / up.total, _corr); else _corr[0] = _corr[1] = 0;
      return [p[0] + Y[0] * lift + _corr[0], p[1] + Y[1] * lift + _corr[1]];
    });
    // two halves from the thickest point (outer third) so both ends taper
    const m = 3, aL = 0.66 * alphaU * ss(0.25, 0.7, open), rw = eyeW * 0.011 * thick;
    const bo = fitBezier(q.slice(0, m + 1).reverse());
    const bi = fitBezier(q.slice(m));
    push(bo[0], bo[1], bo[2], bo[3], rw, eyeW * 0.002, aL, 0, 0.55);
    push(bi[0], bi[1], bi[2], bi[3], rw * (1 - 0.35 * far), eyeW * 0.002, aL * (1 - 0.3 * far), 0, 0.45 - 0.35 * far);
  }

  // lower lashes — short, coated, fanning down and out, small spiky clumps
  const lowVis = STYLE.lower * ss(0.25, 0.6, open);
  if (lowVis > 0.01) {
    const lowProf = (s) => (0.6 + 0.4 * ss(0, 0.12, s)) * (1 - 0.7 * ss(0.25, 0.8, s));
    const lowBeta = (s) => (72 * Math.pow(1 - s, 1.2) - 6) * D2R;
    const Ll = eyeW * 0.1 * lenMul;
    G.lowerClumps.forEach((c, ci) => strandCPs(lidAt(lo, c.s, Y, dropL, _root), Ll * lowProf(c.s) * c.len,
      -27 * D2R + c.a0, -16 * D2R * curlMul * c.curl, lowBeta(c.s) + c.beta, fr, CB, 12 * ci));
    for (const g of G.lower) {
      strandCPs(lidAt(lo, g.s, Y, dropL, _root), Ll * lowProf(g.s) * g.len, -27 * D2R + g.a0, -16 * D2R * curlMul * g.curl, lowBeta(g.s) + g.beta, fr, S, 0);
      const w = G.lowerClumps[g.clump].w * clumpK;
      const aIn = 1 - 0.6 * far * ss(0.35, 0.75, g.s);
      pushStrand(S, 0, CB, 12 * g.clump, w * 0.1, w * 0.3, w * 0.55, hw0 * 0.5 * g.w, tipW * 0.7, g.alpha * alphaU * 0.72 * lowVis * aIn, 0.2, 0.55);
    }
  }

  // root fill
  for (const g of G.fill) {
    const ic = innerCut(g.s);
    const L = eyeW * g.len * lenMul * (1 - 0.5 * ss(0.6, 1, g.s)) * (1 - 0.6 * ic);
    strandCPs(lidAt(up, g.s, Y, liftU, _root, corr), L, g.a0 - lidRot - 25 * D2R * ic, 20 * D2R, betaProf(g.s) * 0.6 + g.beta, fr, S, 0);
    pushStrand(S, 0, null, 0, 0, 0, 0, hw0 * 1.15 * g.w * (1 - 0.3 * ic), hw0 * 0.45, g.alpha * alphaU * (1 - 0.6 * ss(0.75, 1, g.s)) * (1 - far * ss(0.5, 0.88, g.s)), 0.2, 0.55);
  }

  // upper lashes: clump centres first, then strands pulled toward them
  // (far eye: inner lashes shorter, bent down toward the lid, thinner, fainter)
  const upLen = (s) => Lbase * lenProf(s) * (1 - 0.72 * innerCut(s));
  const upA0 = (s) => a0Prof(s) - lidRot - 30 * D2R * innerCut(s);
  const upCurl = (s) => curlProf(s) * curlMul * (1 - 0.55 * innerCut(s));
  const upBeta = (s) => betaProf(s) * (1 - innerCut(s));
  G.upperClumps.forEach((c, ci) => strandCPs(lidAt(up, c.s, Y, liftU, _root, corr), upLen(c.s) * c.len,
    upA0(c.s) + c.a0, upCurl(c.s) * c.curl, upBeta(c.s) + c.beta, fr, CB, 12 * ci));
  for (const g of G.upper) {
    strandCPs(lidAt(up, g.s, Y, liftU, _root, corr), upLen(g.s) * g.len, upA0(g.s) + g.a0,
      upCurl(g.s) * g.curl, upBeta(g.s) + g.beta, fr, S, 0);
    const w = G.upperClumps[g.clump].w * clumpK * (g.cross ? 0.2 : 1);
    const edge = ss(0, 0.04, g.s) * 0.4 + 0.6;
    const ic = innerCut(g.s);
    const inner = (1 - 0.45 * ss(0.7, 1, g.s)) * (1 - 0.35 * ic);
    const aFar = 1 - far * ss(0.5, 0.88, g.s);
    pushStrand(S, 0, CB, 12 * g.clump, w * 0.3, w * 0.7, w * 0.93, hw0 * g.w * edge * inner, tipW, g.alpha * alphaU * aFar, 0.55 * g.shade, 0.78);
  }
}

// ── Main render ─────────────────────────────────────────────────────────────
/**
 * Render 3D strand lashes into the current GL canvas, after the composite pass.
 * @param {WebGLRenderingContext} gl
 * @param {number} w canvas width   @param {number} h canvas height
 * @param {Array} landmarks 468+ face landmarks (normalised x, y, z)
 * @param {Object} opts { intensity, color, hasEyeliner }
 */
export function renderLashes3D(gl, w, h, landmarks, opts = {}) {
  if (!gl || !landmarks || landmarks.length < 468) return false;
  if (!initLash3d(gl)) return false;
  const intensity = opts.intensity ?? 0.8;
  if (intensity < 0.01) return false;
  if (!GENES) buildGenes();

  const hf = headFrame(landmarks, w, h);
  const eyeR = len3(sub(P3(landmarks, 33, w, h), P3(landmarks, 133, w, h)));
  const eyeL = len3(sub(P3(landmarks, 263, w, h), P3(landmarks, 362, w, h)));
  // eye width in 3D px: blend per-eye widths with the corner-to-corner ratio
  const eyeW = 0.5 * (0.5 * (eyeR + eyeL)) + 0.5 * (0.3 * hf.oc);
  if (!(eyeW > 4)) return false;

  _n = 0;
  const hasEyeliner = !!opts.hasEyeliner;
  const openR = eyeOpenness(landmarks, w, h, EAR_R), openL = eyeOpenness(landmarks, w, h, EAR_L);
  // helper: find the real lash line in the camera frame and nudge the roots onto it
  let corr = null;
  if (opts.frame) {
    const up2 = [hf.Y[0], hf.Y[1]], ul = Math.hypot(up2[0], up2[1]) || 1;
    up2[0] /= ul; up2[1] /= ul;
    const lid = (ids) => ids.map((i) => [landmarks[i].x * w, landmarks[i].y * h]);
    corr = updateLashLine(opts.frame, w, h, {
      R: { lid: lid(EYE_R_LASH), up: up2, eyeW, open: openR },
      L: { lid: lid(EYE_L_LASH), up: up2, eyeW, open: openL },
    });
  }
  buildEye(landmarks, w, h, hf, 'R', eyeW, openR, intensity, hasEyeliner, corr && corr.R);
  buildEye(landmarks, w, h, hf, 'L', eyeW, openL, intensity, hasEyeliner, corr && corr.L);
  if (_n === 0) return false;

  gl.useProgram(lashProg);
  gl.enable(gl.BLEND);
  // colour: normal 'over'; alpha: keep the destination opaque (a canvas with
  // alpha < 1 would let the page show through the lashes → grey halos)
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);
  const color = opts.color ? hexToRgb3(opts.color) : [0.02, 0.02, 0.02];
  gl.uniform3f(lashLoc.uColor, color[0], color[1], color[2]);
  gl.uniform2f(lashLoc.uRes, w, h);
  gl.uniform1f(lashLoc.uSoft, clamp(eyeW * 0.004, 0.8, 2.0));   // match camera softness

  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, _inst.subarray(0, _n * INST_FLOATS), gl.DYNAMIC_DRAW);
  const stride = INST_FLOATS * 4;
  let off = 0;
  for (const [name, size] of ATTRS) {
    const loc = lashLoc[name];
    if (loc >= 0) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
      ext.vertexAttribDivisorANGLE(loc, 1);
    }
    off += size;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, stripBuf);
  gl.enableVertexAttribArray(lashLoc.aTS);
  gl.vertexAttribPointer(lashLoc.aTS, 2, gl.FLOAT, false, 8, 0);
  ext.vertexAttribDivisorANGLE(lashLoc.aTS, 0);

  ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, stripVerts, _n);

  // restore: instance divisors must not leak into the main programs
  for (const [name] of ATTRS) {
    const loc = lashLoc[name];
    if (loc >= 0) { ext.vertexAttribDivisorANGLE(loc, 0); gl.disableVertexAttribArray(loc); }
  }
  return true;
}

function hexToRgb3(h) {
  if (Array.isArray(h)) return h;
  const n = parseInt(String(h).replace('#', ''), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/** Reset cached GL state — call when the GL context is lost/recreated. */
export function resetLash3d() {
  lashProg = null;
  ext = null;
  stripBuf = null;
  instBuf = null;
  _available = null;
}