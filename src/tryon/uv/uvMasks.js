// uvMasks.js — face-product masks authored in UV space, rendered on the mesh.
//
// Every face product (foundation, concealer, contour, highlight, blush,
// bronzer, nose contour, eyeshadow, eyeliner, brows) is ONE grayscale image in
// MediaPipe's canonical UV layout (white = product). Per frame the face mesh
// (468 landmarks, 898 triangles) is drawn into a screen-space mask texture with
// those UVs — so a mask follows the face exactly (turns, tilt, expressions,
// perspective), hidden parts are removed by back-face culling + depth, and no
// mask is drawn or blurred on a 2D canvas at runtime any more.
//
// Lips stay on the colour-fitted outline (lipColorSeg): sharper at the lip
// edge than the mesh, handles the open mouth and the symmetry prior. Face
// products are cut along that same outline here, so nothing leaves a strip of
// untouched skin around the lips.
//
// Masks come from /uv-masks/<key>.png (see loadUVMasks). Missing files simply
// leave that product on the old procedural path.

import { UV, TRI, UV_COUNT } from './faceMeshUV.js';
import { LIPS_INNER } from '../lips.js';
import { FACE_OVAL } from '../regions.js';

// The mesh closes the mouth with 18 triangles between the inner-lip vertices.
// When the mouth opens they stretch over the teeth — no face product belongs
// there, so they are not drawn. (Eye-opening triangles stay: the baked masks
// already leave the eyeball empty, and eyeliner sits on that border.)
const DRAW_TRI = (() => {
  const inner = new Set(LIPS_INNER);
  const out = [];
  for (let t = 0; t < TRI.length; t += 3) {
    if (inner.has(TRI[t]) && inner.has(TRI[t + 1]) && inner.has(TRI[t + 2])) continue;
    out.push(TRI[t], TRI[t + 1], TRI[t + 2]);
  }
  return new Uint16Array(out);
})();

/** Product keys = file names in /uv-masks/ (key.png). */
export const UV_PRODUCTS = [
  'foundation', 'underEye', 'contour', 'highlight', 'blush', 'bronzer', 'noseContour',
  'eyes', 'eyeliner', 'brows', 'lipsCut',
];

const images = {};       // key -> HTMLImageElement | HTMLCanvasElement
let imgVersion = 0;
let enabled = true;

export function setUVMasksEnabled(v) { enabled = !!v; }
export function uvMasksEnabled() { return enabled; }
/** Replace one product's UV mask (an <img> or <canvas>); null removes it. */
export function setUVMaskImage(key, src) {
  if (src) images[key] = src; else delete images[key];
  imgVersion++;
}
export function getUVMaskImage(key) { return images[key] || null; }
/** True when UV masks are on and every listed product has an image. */
export function uvHas(...keys) { return enabled && keys.every((k) => !!images[k]); }

let loading = null;
const defaultBase = () => {
  let base = '/';
  try { base = import.meta.env?.BASE_URL || '/'; } catch (_) { /* not bundled by Vite */ }
  return base.replace(/\/?$/, '/') + 'uv-masks/';
};
/**
 * Load <base><key>.png for every product. Missing files are skipped (that
 * product stays procedural). Fetched with cache revalidation so a replaced
 * PNG shows up on the next page load, not whenever the browser cache expires.
 */
export function loadUVMasks(base = defaultBase()) {
  if (loading) return loading;
  loading = Promise.all(UV_PRODUCTS.map(async (key) => {
    if (typeof Image === 'undefined') return null;
    try {
      const res = await fetch(`${base}${key}.png`, { cache: 'no-cache' });
      if (!res.ok || !/image/.test(res.headers.get('content-type') || '')) return null;
      const url = URL.createObjectURL(await res.blob());
      const img = new Image();
      await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = url; });
      setUVMaskImage(key, img);
      return key;
    } catch (_) { return null; }
  })).then((keys) => {
    const got = keys.filter(Boolean);
    const miss = UV_PRODUCTS.filter((k) => !got.includes(k));
    console.info(`[uv-masks] ${got.length}/${UV_PRODUCTS.length} loaded from ${base}` + (miss.length ? ` — procedural: ${miss.join(', ')}` : ''));
    return got;
  });
  return loading;
}
/** Drop the cached load and fetch every PNG again (after replacing files). */
export function reloadUVMasks(base) {
  loading = null;
  return loadUVMasks(base);
}

// ─────────────────────────────────────────────────────────────────────────
// Per-GL-context renderer
// ─────────────────────────────────────────────────────────────────────────

const VS = `
attribute vec3 aPos;
attribute vec2 aUV;
attribute vec3 aGeo;     // facing (n·view), light response, concavity response
attribute vec3 aNrm;     // smoothed surface normal (image space, out of the face)
varying vec2 vT;
varying vec3 vGeo;
varying vec3 vNrm;
void main() { vT = aUV; vGeo = aGeo; vNrm = aNrm; gl_Position = vec4(aPos, 1.0); }`;

const FS = `
precision mediump float;
varying vec2 vT;
varying vec3 vGeo;
varying vec3 vNrm;
uniform vec3 uL;                   // key light direction (toward the light)
uniform float uAmb;                // ambient share of the estimated lighting
uniform sampler2D uT0, uT1, uT2;   // UV-space product masks (grayscale, .r)
uniform sampler2D uCutScr;         // screen-space lip mask (fitted outline), .a
uniform sampler2D uCutUV;          // UV-space lip fallback, .r
uniform float uMode;               // 0 = alpha mask, 1 = RGB pack
uniform vec3 uEn;                  // RGB pack channel enables
uniform float uCutMode;            // 0 none, 1 screen, 2 UV fallback
uniform vec2 uSize;                // target size (px)
uniform float uGraze;              // 0..1 fade toward the silhouette
uniform vec2 uShade;               // x: R *= concavity response, y: G *= light response
uniform float uW;                  // motion-blur sub-frame weight (1 = single draw)
void main() {
  float cut = 0.0;
  if (uCutMode > 1.5) cut = texture2D(uCutUV, vT).r;
  else if (uCutMode > 0.5) cut = smoothstep(0.85, 1.0, texture2D(uCutScr, gl_FragCoord.xy / uSize).a);
  // Grazing angle: where the skin turns away from the camera, less product is
  // seen (and real powder/cream reads thinner) — no "sticker" at the silhouette.
  float keep = (1.0 - cut) * mix(1.0, smoothstep(0.06, 0.55, vGeo.x), uGraze);
  // Surface turned away from the camera (smoothed normals — robust where the
  // noisy mesh flips single triangles): nothing is drawn there. E.g. the far
  // eye of a head in profile: its liner/shadow must not land on the nose.
  keep *= smoothstep(-0.08, 0.0, vGeo.x);   // only CLEARLY turned-away surface is dropped
  if (uMode > 1.5) {
    // Scene light, per pixel from the interpolated normal: R diffuse (Lambert
    // + ambient), G specular (Blinn, view = camera), B facing. Host shaders
    // use it to light the products: gloss / shimmer / dewy sit where the real
    // light reflects, matte takes the real shine down there.
    vec3 n = normalize(vNrm);
    vec3 h = normalize(uL + vec3(0.0, 0.0, -1.0));
    float lam = max(dot(n, uL), 0.0);
    float spec = pow(max(dot(n, h), 0.0), 24.0);
    gl_FragColor = vec4(clamp(uAmb + (1.0 - uAmb) * lam, 0.0, 1.0), spec, clamp(-n.z, 0.0, 1.0), 1.0);
    return;
  }
  if (uMode < 0.5) {
    gl_FragColor = vec4(vec3(uW), texture2D(uT0, vT).r * keep * uW);
  } else {
    float r = texture2D(uT0, vT).r * uEn.x * mix(1.0, vGeo.z, uShade.x);
    float g = texture2D(uT1, vT).r * uEn.y * mix(1.0, vGeo.y, uShade.y);
    float b = texture2D(uT2, vT).r * uEn.z;
    gl_FragColor = vec4(clamp(vec3(r, g, b), 0.0, 1.0) * keep * uW, uW);
  }
}`;

// ── Mesh geometry: normals → facing / light / concavity, per vertex ──
const NEIGH = (() => {
  const sets = Array.from({ length: UV_COUNT }, () => new Set());
  for (let t = 0; t < TRI.length; t += 3) {
    const a = TRI[t], b = TRI[t + 1], c = TRI[t + 2];
    sets[a].add(b); sets[a].add(c); sets[b].add(a); sets[b].add(c); sets[c].add(a); sets[c].add(b);
  }
  return sets.map((st) => Int16Array.from(st));
})();

/**
 * Per-vertex shading terms from the live mesh (pixel-isotropic space).
 *   x facing   = n·view (1 frontal … 0 silhouette)
 *   y light    = highlight response: soft Lambert + a specular lobe toward the
 *                estimated key light — the glow sits where the surface faces
 *                the light and slides across the cheekbone as the head turns
 *   z concave  = contour response: stronger in hollows, weaker on bumps
 * lightBal: −1 … 1 (key light from image left … right), from faceMetrics.
 */
const _P = new Float32Array(UV_COUNT * 3), _N = new Float32Array(UV_COUNT * 3), _S = new Float32Array(UV_COUNT * 3);

/**
 * Smoothed per-vertex normals of the live mesh, in pixel-isotropic image
 * space (x right, y down, z away from the camera), oriented OUT of the face
 * (n.z < 0 when facing the camera). Two neighbour-averaging passes: a noisy
 * mesh gives blotchy raw normals. Positions (px) are left in `pos` if given.
 */
export function meshNormals(landmarks, W, H, out = new Float32Array(UV_COUNT * 3), pos = _P) {
  for (let i = 0; i < UV_COUNT; i++) {
    const p = landmarks[i];
    pos[3 * i] = p.x * W; pos[3 * i + 1] = p.y * H; pos[3 * i + 2] = (p.z || 0) * W;
  }
  _N.fill(0);
  for (let t = 0; t < TRI.length; t += 3) {
    const a = 3 * TRI[t], b = 3 * TRI[t + 1], c = 3 * TRI[t + 2];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { _N[k] += nx; _N[k + 1] += ny; _N[k + 2] += nz; }
  }
  let sz = 0;
  for (let i = 0; i < UV_COUNT; i++) {
    const k = 3 * i, l = Math.hypot(_N[k], _N[k + 1], _N[k + 2]) || 1;
    _N[k] /= l; _N[k + 1] /= l; _N[k + 2] /= l; sz += _N[k + 2];
  }
  const flip = sz > 0 ? -1 : 1;
  for (let i = 0; i < UV_COUNT * 3; i++) out[i] = _N[i] * flip;
  for (let pass = 0; pass < 2; pass++) {
    _S.set(out);
    for (let i = 0; i < UV_COUNT; i++) {
      const nb = NEIGH[i], m = nb.length;
      let x = _S[3 * i], y = _S[3 * i + 1], z = _S[3 * i + 2];
      for (let j = 0; j < m; j++) { x += _S[3 * nb[j]] / m; y += _S[3 * nb[j] + 1] / m; z += _S[3 * nb[j] + 2] / m; }
      const l = Math.hypot(x, y, z) || 1;
      out[3 * i] = x / l; out[3 * i + 1] = y / l; out[3 * i + 2] = z / l;
    }
  }
  return out;
}

/** Key-light direction (toward the light, image space) from an estimate or the old L/R balance. */
export function lightDir(light, lightBal) {
  if (light && light.dir && (light.conf ?? 1) > 0.15) return light.dir;
  let lx = 0.55 * (lightBal || 0), ly = -0.45, lz = -1;
  const ll = Math.hypot(lx, ly, lz);
  return [lx / ll, ly / ll, lz / ll];
}

/**
 * Per-vertex shading terms from the live mesh.
 *   x facing   = n·view (1 frontal … 0 silhouette, < 0 turned away)
 *   y light    = highlight response: soft Lambert + a specular lobe toward the
 *                key light — the glow sits where the surface faces the light
 *   z concave  = contour response: stronger in hollows, weaker on bumps
 */
function computeGeo(landmarks, W, H, L, out, nrm) {
  meshNormals(landmarks, W, H, nrm, _P);
  const [lx, ly, lz] = L;
  let hx = lx, hy = ly, hz = lz - 1;         // half vector with view (0,0,-1)
  const hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
  for (let i = 0; i < UV_COUNT; i++) {
    const k = 3 * i;
    const nx = nrm[k], ny = nrm[k + 1], nz = nrm[k + 2];
    const facing = -nz;
    const lam = Math.max(0, nx * lx + ny * ly + nz * lz);
    const spec = Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), 10);
    const nb = NEIGH[i];
    let cx = 0, cy = 0, cz = 0, el = 0;
    for (let j = 0; j < nb.length; j++) {
      const q = 3 * nb[j];
      cx += _P[q]; cy += _P[q + 1]; cz += _P[q + 2];
      el += Math.hypot(_P[q] - _P[k], _P[q + 1] - _P[k + 1], _P[q + 2] - _P[k + 2]);
    }
    const m = nb.length || 1;
    cx = cx / m - _P[k]; cy = cy / m - _P[k + 1]; cz = cz / m - _P[k + 2];
    const conc = (cx * nx + cy * ny + cz * nz) / ((el / m) || 1);    // >0 hollow
    out[k] = facing;
    out[k + 1] = Math.min(1.4, 0.4 + 0.45 * lam + 0.75 * spec);
    out[k + 2] = Math.min(1.35, Math.max(0.55, 1 + 2.2 * conc));
  }
  return out;
}

// ── Skirt: the mesh ends at MediaPipe's face oval, which sits INSIDE the real
// face edge (jaw, cheek silhouette on a turn, hairline). Base makeup must
// reach the real edge, so a ring is extruded outward from the oval in screen
// space; it carries the foundation outward with a fade and is gated by skin
// colour (sampled from the frame next to the face), so it stops at the
// background / hair instead of painting them.
const SKIRT_VS = `
attribute vec2 aPos;
attribute vec2 aUV;
attribute float aS;          // 0 at the oval … 1 at the outer rim
varying vec2 vT;
varying float vS;
void main() { vT = aUV; vS = aS; gl_Position = vec4(aPos, 0.0, 1.0); }`;
const SKIRT_FS = `
precision mediump float;
varying vec2 vT;
varying float vS;
uniform sampler2D uT0;       // UV mask
uniform sampler2D uFrame;    // camera frame (screen space)
uniform vec2 uSize;
uniform vec2 uRef[4];        // skin reference points (0..1 screen, y up)
float chromaDist(vec3 a, vec3 b) {
  vec2 ca = a.rg / max(dot(a, vec3(1.0)), 1e-3), cb = b.rg / max(dot(b, vec3(1.0)), 1e-3);
  return length(ca - cb);
}
void main() {
  vec3 ref = vec3(0.0);
  for (int i = 0; i < 4; i++) ref += texture2D(uFrame, uRef[i]).rgb;
  ref *= 0.25;
  vec3 c = texture2D(uFrame, gl_FragCoord.xy / uSize).rgb;
  float lr = dot(c, vec3(0.299, 0.587, 0.114)) / max(dot(ref, vec3(0.299, 0.587, 0.114)), 1e-3);
  float gate = (1.0 - smoothstep(0.03, 0.07, chromaDist(c, ref)))
             * smoothstep(0.35, 0.55, lr) * (1.0 - smoothstep(1.7, 2.2, lr));
  float a = texture2D(uT0, vT).r * (1.0 - smoothstep(0.55, 1.0, vS)) * gate;   // the skin gate makes the real edge
  gl_FragColor = vec4(vec3(a), a);
}`;
const OVAL_N = FACE_OVAL.length;
const SKIRT_IDX = (() => {
  const out = [];
  for (let i = 0; i < OVAL_N; i++) {
    const j = (i + 1) % OVAL_N;
    out.push(i, j, OVAL_N + j, i, OVAL_N + j, OVAL_N + i);
  }
  return new Uint16Array(out);
})();
const SKIRT_REF = [50, 280, 151, 199];   // cheeks, mid-forehead, chin — skin

const renderers = new WeakMap();

/** The UV mask renderer for this WebGL context (created on first use). */
export function uvRenderer(gl) {
  let r = renderers.get(gl);
  if (!r) { r = createRenderer(gl); renderers.set(gl, r); }
  return r;
}

function createRenderer(gl) {
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('uvMasks shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('uvMasks link: ' + gl.getProgramInfoLog(prog));
  const loc = {};
  for (const n of ['uT0', 'uT1', 'uT2', 'uCutScr', 'uCutUV', 'uMode', 'uEn', 'uCutMode', 'uSize', 'uGraze', 'uShade', 'uW', 'uL', 'uAmb']) loc[n] = gl.getUniformLocation(prog, n);
  const aPos = gl.getAttribLocation(prog, 'aPos'), aUV = gl.getAttribLocation(prog, 'aUV'), aGeo = gl.getAttribLocation(prog, 'aGeo'), aNrm = gl.getAttribLocation(prog, 'aNrm');
  const sprog = gl.createProgram();
  gl.attachShader(sprog, sh(gl.VERTEX_SHADER, SKIRT_VS));
  gl.attachShader(sprog, sh(gl.FRAGMENT_SHADER, SKIRT_FS));
  gl.linkProgram(sprog);
  if (!gl.getProgramParameter(sprog, gl.LINK_STATUS)) throw new Error('uvMasks skirt link: ' + gl.getProgramInfoLog(sprog));
  const sloc = { uT0: gl.getUniformLocation(sprog, 'uT0'), uFrame: gl.getUniformLocation(sprog, 'uFrame'), uSize: gl.getUniformLocation(sprog, 'uSize'), uRef: gl.getUniformLocation(sprog, 'uRef') };
  const sPos = gl.getAttribLocation(sprog, 'aPos'), sUV = gl.getAttribLocation(sprog, 'aUV'), sS = gl.getAttribLocation(sprog, 'aS');
  const skirtPos = new Float32Array(OVAL_N * 2 * 2), skirtUV = new Float32Array(OVAL_N * 2 * 2), skirtS = new Float32Array(OVAL_N * 2);
  for (let i = 0; i < OVAL_N; i++) {
    const v = FACE_OVAL[i];
    // UV a touch inside the oval (the baked mask is defined there)
    const u = UV[2 * v], w = UV[2 * v + 1];
    const iu = 0.5 + (u - 0.5) * 0.985, iw = 0.47 + (w - 0.47) * 0.985;
    skirtUV[2 * i] = iu; skirtUV[2 * i + 1] = iw; skirtUV[2 * (OVAL_N + i)] = iu; skirtUV[2 * (OVAL_N + i) + 1] = iw;
    skirtS[i] = 0; skirtS[OVAL_N + i] = 1;
  }
  const sPosBuf = gl.createBuffer(), sUVBuf = gl.createBuffer(), sSBuf = gl.createBuffer(), sIdxBuf = gl.createBuffer();

  const prevAB = gl.getParameter(gl.ARRAY_BUFFER_BINDING), prevEB = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING);
  const uvBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, UV, gl.STATIC_DRAW);
  const posBuf = gl.createBuffer();
  const pos = new Float32Array(UV_COUNT * 3);
  const prevPos = new Float32Array(UV_COUNT * 3), subPos = new Float32Array(UV_COUNT * 3);
  let prevT = -1;
  const geoBuf = gl.createBuffer(), nrmBuf = gl.createBuffer();
  const geo = new Float32Array(UV_COUNT * 3), nrm = new Float32Array(UV_COUNT * 3);
  const state = { blurred: false };
  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, DRAW_TRI, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, sUVBuf); gl.bufferData(gl.ARRAY_BUFFER, skirtUV, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, sSBuf); gl.bufferData(gl.ARRAY_BUFFER, skirtS, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sIdxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, SKIRT_IDX, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, prevAB);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, prevEB);

  const fbo = gl.createFramebuffer();
  const depth = gl.createRenderbuffer();
  let depthW = 0, depthH = 0;

  const mkTex = () => {
    const t = gl.createTexture();
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, prev);   // never disturb the host's binding
    return t;
  };
  const dummy = mkTex();
  {
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, dummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.bindTexture(gl.TEXTURE_2D, prev);
  }
  const SCRATCH = 1;   // scratch units 1..5 (saved and restored around render)
  const srcTex = {}, srcVer = {};
  const uvTexture = (key) => {
    const img = key ? images[key] : null;
    if (!img) return null;
    if (!srcTex[key]) srcTex[key] = mkTex();
    if (srcVer[key] !== img) {
      gl.activeTexture(gl.TEXTURE0 + SCRATCH);
      gl.bindTexture(gl.TEXTURE_2D, srcTex[key]);
      // UV v points up: image row 0 (top) must land at v = 1.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      srcVer[key] = img;
    }
    return srcTex[key];
  };
  const targets = {};
  const target = (name, w, h) => {
    let t = targets[name];
    if (!t) { t = { tex: mkTex(), w: 0, h: 0 }; targets[name] = t; }
    if (t.w !== w || t.h !== h) {
      gl.activeTexture(gl.TEXTURE0 + SCRATCH);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      t.w = w; t.h = h;
    }
    return t.tex;
  };

  /**
   * Render jobs into screen-space mask textures.
   * @param landmarks  MediaPipe landmarks (normalised x, y, z)
   * @param W, H       output size (the renderer's mask resolution)
   * @param jobs       [{ name, mode: 'alpha'|'rgb', keys: [k0, k1?, k2?], en?: [1,1,1], cut?: bool }]
   * @param cutTex     screen-space lip mask texture (fitted outline) or null
   * @returns {Object<string, WebGLTexture>} name -> texture (jobs whose images are missing are skipped)
   */
  // Extrude the face oval outward (screen space) and draw the gated fade ring.
  // Leaves the main program state to the caller's next job (re-bound below).
  function drawSkirt(landmarks, W, H, maskTex, frameUnit) {
    let cx = 0, cy = 0, x0 = Infinity, x1 = -Infinity;
    for (const v of FACE_OVAL) { const p = landmarks[v]; cx += p.x * W; cy += p.y * H; x0 = Math.min(x0, p.x * W); x1 = Math.max(x1, p.x * W); }
    cx /= OVAL_N; cy /= OVAL_N;
    const D = 0.10 * (x1 - x0);
    for (let i = 0; i < OVAL_N; i++) {
      const p = landmarks[FACE_OVAL[i]];
      const px = p.x * W, py = p.y * H;
      let dx = px - cx, dy = py - cy; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      skirtPos[2 * i] = px / W * 2 - 1; skirtPos[2 * i + 1] = 1 - py / H * 2;
      skirtPos[2 * (OVAL_N + i)] = (px + dx * D) / W * 2 - 1; skirtPos[2 * (OVAL_N + i) + 1] = 1 - (py + dy * D) / H * 2;
    }
    gl.useProgram(sprog);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disableVertexAttribArray(aGeo); gl.disableVertexAttribArray(aNrm);
    gl.bindBuffer(gl.ARRAY_BUFFER, sPosBuf); gl.bufferData(gl.ARRAY_BUFFER, skirtPos, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(sPos); gl.vertexAttribPointer(sPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, sUVBuf);
    gl.enableVertexAttribArray(sUV); gl.vertexAttribPointer(sUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, sSBuf);
    gl.enableVertexAttribArray(sS); gl.vertexAttribPointer(sS, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sIdxBuf);
    gl.activeTexture(gl.TEXTURE0 + SCRATCH); gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.uniform1i(sloc.uT0, SCRATCH); gl.uniform1i(sloc.uFrame, frameUnit);
    gl.uniform2f(sloc.uSize, W, H);
    const ref = new Float32Array(8);
    SKIRT_REF.forEach((v, i) => { ref[2 * i] = landmarks[v].x; ref[2 * i + 1] = 1 - landmarks[v].y; });
    gl.uniform2fv(sloc.uRef, ref);
    gl.drawElements(gl.TRIANGLES, SKIRT_IDX.length, gl.UNSIGNED_SHORT, 0);
    gl.disableVertexAttribArray(sS);
    // back to the mesh program for the next job
    gl.useProgram(prog);
    gl.enable(gl.DEPTH_TEST);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf); gl.enableVertexAttribArray(aUV); gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, geoBuf); gl.enableVertexAttribArray(aGeo); gl.vertexAttribPointer(aGeo, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf); gl.enableVertexAttribArray(aNrm); gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    if (blendK > 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); } else gl.disable(gl.BLEND);
  }
  let blendK = 1;

  function render(landmarks, W, H, jobs, cutTex, opt = {}) {
    const saved = saveState();
    for (let i = 0; i < UV_COUNT; i++) {
      const p = landmarks[i];
      pos[3 * i] = p.x * 2 - 1;
      pos[3 * i + 1] = 1 - p.y * 2;                       // image top → clip +1 (matches flipY'd uploads)
      pos[3 * i + 2] = Math.max(-0.99, Math.min(0.99, (p.z || 0) * 4));   // smaller z = closer
    }
    const L = lightDir(opt.light, opt.lightBal);
    computeGeo(landmarks, W, H, L, geo, nrm);
    gl.bindBuffer(gl.ARRAY_BUFFER, geoBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geo, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.DYNAMIC_DRAW);

    // Motion blur: the camera smears a moving face over its exposure; a mask
    // drawn at one instant stays razor sharp and floats on top. Draw the mesh
    // at K positions across the last half frame and average them.
    const now = opt.time ?? (typeof performance !== 'undefined' ? performance.now() : 0);
    let K = 1;
    if (opt.motionBlur !== false && prevT >= 0 && now - prevT > 0 && now - prevT < 120) {
      let d = 0;
      for (let i = 0; i < UV_COUNT; i++) d += Math.hypot((pos[3 * i] - prevPos[3 * i]) * W, (pos[3 * i + 1] - prevPos[3 * i + 1]) * H);
      const px = 0.5 * d / UV_COUNT * 0.5;   // clip→px (×0.5), half-frame shutter (×0.5)
      if (px > 1.0) K = Math.min(6, 1 + Math.ceil(px / 1.5));
    }
    state.blurred = K > 1; blendK = K;
    const subs = [];
    for (let k = 0; k < K; k++) subs.push(K === 1 ? 1 : 1 - 0.5 * (k / (K - 1)));
    const upload = (t) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      if (t >= 1) { gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW); return; }
      for (let i = 0; i < pos.length; i++) subPos[i] = prevPos[i] + (pos[i] - prevPos[i]) * t;
      gl.bufferData(gl.ARRAY_BUFFER, subPos, gl.DYNAMIC_DRAW);
    };
    upload(1);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    if (depthW !== W || depthH !== H) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, W, H);
      depthW = W; depthH = H;
    }
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.viewport(0, 0, W, H);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, geoBuf);
    gl.enableVertexAttribArray(aGeo);
    gl.vertexAttribPointer(aGeo, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
    gl.enableVertexAttribArray(aNrm);
    gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0);
    gl.uniform3f(loc.uL, L[0], L[1], L[2]);
    gl.uniform1f(loc.uAmb, Math.min(0.9, Math.max(0.2, opt.light?.ambientShare ?? 0.5)));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
    // No back-face culling: landmark noise flips small triangles (nose sides,
    // under the eyes, near the silhouette) and culling punched holes in the
    // mask there — bare skin flickering through. The depth test alone hides
    // what is behind.
    gl.disable(gl.CULL_FACE);
    if (K > 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); } else gl.disable(gl.BLEND);
    gl.uniform2f(loc.uSize, W, H);
    gl.uniform1f(loc.uW, 1 / K);

    const out = {};
    const lipsUV = uvTexture('lipsCut');
    for (const job of jobs) {
      const srcs = job.keys.map((k) => (k ? uvTexture(k) : null));
      if (job.mode !== 'light' && !srcs[0] && !srcs[1] && !srcs[2]) continue;
      const tex = target(job.name, W, H);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (job.mode === 'rgb') gl.clearColor(0, 0, 0, 1); else if (job.mode === 'light') gl.clearColor(0.6, 0, 1, 1); else gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      for (let s = 0; s < 3; s++) {
        gl.activeTexture(gl.TEXTURE0 + SCRATCH + s);
        gl.bindTexture(gl.TEXTURE_2D, srcs[s] || srcs[0] || srcs[1] || srcs[2] || dummy);
      }
      gl.uniform1i(loc.uT0, SCRATCH); gl.uniform1i(loc.uT1, SCRATCH + 1); gl.uniform1i(loc.uT2, SCRATCH + 2);
      const en = job.en || [1, 1, 1];
      gl.uniform3f(loc.uEn, srcs[0] ? en[0] : 0, srcs[1] ? en[1] : 0, srcs[2] ? en[2] : 0);
      gl.uniform1f(loc.uMode, job.mode === 'light' ? 2 : job.mode === 'rgb' ? 1 : 0);
      // Units 4/5 may still hold one of OUR targets from the host's last frame
      // (sampling the texture being rendered = feedback loop) — park a dummy.
      gl.activeTexture(gl.TEXTURE0 + SCRATCH + 3); gl.bindTexture(gl.TEXTURE_2D, dummy);
      gl.activeTexture(gl.TEXTURE0 + SCRATCH + 4); gl.bindTexture(gl.TEXTURE_2D, dummy);
      let cutMode = 0;
      if (job.cut && cutTex) {
        cutMode = 1;
        gl.activeTexture(gl.TEXTURE0 + SCRATCH + 3); gl.bindTexture(gl.TEXTURE_2D, cutTex);
      } else if (job.cut && lipsUV) {
        cutMode = 2;
        gl.activeTexture(gl.TEXTURE0 + SCRATCH + 4); gl.bindTexture(gl.TEXTURE_2D, lipsUV);
      }
      gl.uniform1i(loc.uCutScr, SCRATCH + 3); gl.uniform1i(loc.uCutUV, SCRATCH + 4);
      gl.uniform1f(loc.uCutMode, cutMode);
      gl.uniform1f(loc.uGraze, job.graze ?? 0);
      gl.uniform2f(loc.uShade, job.shade ? job.shade[0] : 0, job.shade ? job.shade[1] : 0);
      if (K === 1 || job.mode === 'light') {
        if (K > 1) { gl.disable(gl.BLEND); upload(1); gl.uniform1f(loc.uW, 1); }
        gl.drawElements(gl.TRIANGLES, DRAW_TRI.length, gl.UNSIGNED_SHORT, 0);
        if (K > 1) { gl.enable(gl.BLEND); gl.uniform1f(loc.uW, 1 / K); }
      } else {
        if (job.mode === 'rgb') { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
        for (const t of subs) {
          upload(t);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          gl.drawElements(gl.TRIANGLES, DRAW_TRI.length, gl.UNSIGNED_SHORT, 0);
        }
      }
      if (job.skirt && opt.frameUnit != null) drawSkirt(landmarks, W, H, srcs[0], opt.frameUnit);
      out[job.name] = tex;
    }
    prevPos.set(pos); prevT = now;

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    restoreState(saved);
    return out;
  }

  // The host renderer keeps its program, quad buffer, attribute pointer and
  // mask textures bound across calls — put every piece of state we touch back.
  const UNITS = [SCRATCH, SCRATCH + 1, SCRATCH + 2, SCRATCH + 3, SCRATCH + 4];
  function saveState() {
    const st = {
      prog: gl.getParameter(gl.CURRENT_PROGRAM),
      fb: gl.getParameter(gl.FRAMEBUFFER_BINDING),
      ab: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
      eb: gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING),
      vp: gl.getParameter(gl.VIEWPORT),
      cc: gl.getParameter(gl.COLOR_CLEAR_VALUE),
      unit: gl.getParameter(gl.ACTIVE_TEXTURE),
      depth: gl.isEnabled(gl.DEPTH_TEST), cull: gl.isEnabled(gl.CULL_FACE), blend: gl.isEnabled(gl.BLEND),
      bf: [gl.getParameter(gl.BLEND_SRC_RGB), gl.getParameter(gl.BLEND_DST_RGB), gl.getParameter(gl.BLEND_SRC_ALPHA), gl.getParameter(gl.BLEND_DST_ALPHA)],
      flip: gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL),
      tex: [], attr: [],
    };
    for (const u of UNITS) { gl.activeTexture(gl.TEXTURE0 + u); st.tex.push(gl.getParameter(gl.TEXTURE_BINDING_2D)); }
    for (const a of [aPos, aUV, aGeo, aNrm, sPos, sUV, sS]) {
      if (a < 0) { st.attr.push(null); continue; }
      st.attr.push({
        a, on: gl.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_ENABLED),
        buf: gl.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),
        size: gl.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_SIZE),
        type: gl.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_TYPE),
        norm: gl.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED),
        stride: gl.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_STRIDE),
        off: gl.getVertexAttribOffset(a, gl.VERTEX_ATTRIB_ARRAY_POINTER),
      });
    }
    return st;
  }
  function restoreState(st) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.fb);
    for (const at of st.attr) {
      if (!at) continue;
      if (at.buf) {
        gl.bindBuffer(gl.ARRAY_BUFFER, at.buf);
        gl.vertexAttribPointer(at.a, at.size, at.type, at.norm, at.stride, at.off);
      }
      if (at.on) gl.enableVertexAttribArray(at.a); else gl.disableVertexAttribArray(at.a);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, st.ab);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, st.eb);
    gl.useProgram(st.prog);
    gl.viewport(st.vp[0], st.vp[1], st.vp[2], st.vp[3]);
    gl.clearColor(st.cc[0], st.cc[1], st.cc[2], st.cc[3]);
    UNITS.forEach((u, i) => { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, st.tex[i]); });
    gl.activeTexture(st.unit);
    if (!st.depth) gl.disable(gl.DEPTH_TEST);
    if (!st.cull) gl.disable(gl.CULL_FACE);
    if (st.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    gl.blendFuncSeparate(st.bf[0], st.bf[1], st.bf[2], st.bf[3]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, st.flip);
  }

  return { render, imgVersion: () => imgVersion, get lastBlurred() { return state.blurred; } };
}

/**
 * Which masks come from UV this frame, given the renderer's product options.
 * Packs (sculpt, extra) switch to UV only when every product they carry this
 * frame has a UV image — a half-procedural pack is not worth the complexity.
 * Products touching the mouth (foundation, blush, sculpt, extra) are cut along
 * the lip outline; eye products are not.
 */
export function uvJobs(o) {
  const jobs = [];
  if (!enabled || !o) return jobs;
  // graze: how much the product thins toward the silhouette (0 = not at all)
  const A = (name, on, key, cut, graze) => { if (on && images[key]) jobs.push({ name, mode: 'alpha', keys: [key], cut, graze, skirt: key === 'foundation' }); };
  A('fnd', o.foundation, 'foundation', true, 0);   // base covers the whole face, up to its real edge
  A('blush', o.blush, 'blush', true, 0.8);
  A('eye', o.eyes, 'eyes', false, 0.5);
  A('eyeliner', o.eyeliner, 'eyeliner', false, 0.2);
  A('brows', o.brows, 'brows', false, 0.2);
  const P = (name, flags, keys, graze, shade) => {
    const want = flags.map(Boolean);
    if (!want.some(Boolean)) return;
    if (keys.some((k, i) => want[i] && !images[k])) return;
    jobs.push({ name, mode: 'rgb', keys: keys.map((k, i) => (want[i] ? k : null)), en: want.map((x) => (x ? 1 : 0)), cut: true, graze, shade });
  };
  // sculpt: R contour follows hollows, G highlight follows the light
  P('sculpt', [o.contour, o.highlight, o.underEye], ['contour', 'highlight', 'underEye'], 0.8, [1, 1]);
  P('extra', [o.bronzer, o.noseContour, false], ['bronzer', 'noseContour', null], 0.7, [0, 0]);
  // scene light (diffuse / specular / facing) for the host shaders
  const anyProduct = ['foundation', 'blush', 'eyes', 'eyeliner', 'brows', 'contour', 'highlight', 'underEye', 'bronzer', 'noseContour', 'lips', 'lipLiner']
    .some((k) => o[k]);
  if (anyProduct) jobs.push({ name: 'light', mode: 'light', keys: [], cut: false });
  return jobs;
}

/** Signature of a job list + loaded images — re-render when it changes. */
export function uvJobsSig(jobs) {
  return jobs.map((j) => j.name + (j.en ? j.en.join('') : '')).join(',') + '|' + imgVersion;
}

/** Mask render size for a w×h frame (masks are soft; ≤1280 px is plenty). */
export function uvTargetSize(w, h) {
  const s = Math.min(1, 1280 / Math.max(w, h));
  return [Math.max(2, Math.round(w * s)), Math.max(2, Math.round(h * s))];
}

// ── Overlay helper (Debug borders): the mask exactly as the renderer uses it ──
let ovl = null;
/**
 * Render one UV product on the face mesh into a 2D canvas (white + alpha),
 * w×h-sized via the mask target size. Returns null when that product has no
 * UV image (caller falls back to its procedural builder).
 */
export function uvMaskCanvas(key, landmarks, w, h) {
  if (!enabled || !images[key] || !landmarks || landmarks.length < UV_COUNT) return null;
  if (!ovl) {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl', { premultipliedAlpha: false });
    if (!g) return null;
    ovl = { g, fb: g.createFramebuffer(), out: document.createElement('canvas'), buf: null };
  }
  const { g } = ovl;
  const [W, H] = uvTargetSize(w, h);
  const tex = uvRenderer(g).render(landmarks, W, H, [{ name: 'ovl', mode: 'alpha', keys: [key], cut: false }], null, { motionBlur: false }).ovl;
  if (!tex) return null;
  g.bindFramebuffer(g.FRAMEBUFFER, ovl.fb);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
  if (!ovl.buf || ovl.buf.length !== W * H * 4) ovl.buf = new Uint8Array(W * H * 4);
  g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, ovl.buf);
  g.bindFramebuffer(g.FRAMEBUFFER, null);
  const o = ovl.out;
  if (o.width !== W || o.height !== H) { o.width = W; o.height = H; }
  const ctx = o.getContext('2d'), img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) img.data.set(ovl.buf.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  ctx.putImageData(img, 0, 0);
  return o;
}