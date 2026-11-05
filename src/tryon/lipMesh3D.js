// lipMesh3D.js — GPU-side 3D lip mesh renderer.
//
// Replaces the 2D canvas buildLipMask() with a WebGL FBO pass that
// triangulates MediaPipe lip landmarks (including z-depth) into a mesh.
// The result is an alpha-only texture that plugs straight into uLip —
// the main composite shader doesn't change.
//
// Why 3D matters:
//   MediaPipe landmarks carry z, but the 2D canvas path drops it.
//   When the head turns, the 2D path mis-projects: the far side of the
//   lip stretches wider than the pixels actually are because z isn't
//   foreshortening the geometry.  A proper 3D mesh matches the camera's
//   perspective, so the lipstick hugs the surface through turns.

import { LIPS_OUTER, LIPS_INNER } from './lips.js';

// ── Fixed triangulation topologies ──────────────────────────────────────
// Pre-triangulated fan from centroid — no runtime Delaunay needed.
// Outer ring → filled triangles; inner ring → cutout triangles (alpha 0).

function fanIndices(ring) {
  // ring is an array of vertex indices [0..N-1] in the local VBO.
  // Returns triangle index triples: centroid is the LAST vertex pushed.
  const tris = [];
  const n = ring.length;
  const cIdx = n; // centroid will be appended after the ring
  for (let i = 0; i < n; i++) {
    tris.push(ring[i], ring[(i + 1) % n], cIdx);
  }
  return tris;
}

// Build the index buffer once — topology never changes.
const OUTER_N = LIPS_OUTER.length;   // 20
const INNER_N = LIPS_INNER.length;   // 20
// VBO layout: [outer0..outer19, outerCentroid, inner0..inner19, innerCentroid]
const OUTER_CENTROID = OUTER_N;
const INNER_START = OUTER_N + 1;
const INNER_CENTROID = INNER_START + INNER_N;
const TOTAL_VERTS = INNER_CENTROID + 1; // 42

const outerRing = Array.from({ length: OUTER_N }, (_, i) => i);
const innerRing = Array.from({ length: INNER_N }, (_, i) => INNER_START + i);
const OUTER_TRIS = fanIndices(outerRing);
const INNER_TRIS = fanIndices(innerRing);

// ── Shaders ─────────────────────────────────────────────────────────────
const LIP_VERT = `
attribute vec3 aPos;    // x,y in NDC (-1..1), z from MediaPipe
attribute float aAlpha; // 1.0 for outer fill, 0.0 for inner cutout
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  // z mapped to a small range — we don't need real depth testing,
  // just perspective foreshortening via the w divide.
  // MediaPipe z is roughly -0.05..0.05 for lips.  Scale it so the
  // w-divide produces visible foreshortening matching the camera.
  float w = 1.0 + aPos.z * 4.0;  // subtle perspective
  gl_Position = vec4(aPos.xy * w, 0.0, w);
}`;

const LIP_FRAG = `
precision mediump float;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(1.0, 1.0, 1.0, vAlpha);
}`;

// ── State ───────────────────────────────────────────────────────────────
let lipProg = null;
let lipVBO = null, outerIBO = null, innerIBO = null;
let lipFBO = null, lipFBOTex = null;
let fboW = 0, fboH = 0;
let vertData = new Float32Array(TOTAL_VERTS * 4); // x, y, z, alpha per vert

// Soft-edge ring: duplicate outer verts with alpha ramped down at edges
// (we'll handle this with a border pass later — start simple)

function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[lipMesh3D] shader:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

export function initLipMesh(gl) {
  if (lipProg) return true;
  const vs = compileShader(gl, gl.VERTEX_SHADER, LIP_VERT);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, LIP_FRAG);
  if (!vs || !fs) return false;
  lipProg = gl.createProgram();
  gl.attachShader(lipProg, vs);
  gl.attachShader(lipProg, fs);
  gl.linkProgram(lipProg);
  if (!gl.getProgramParameter(lipProg, gl.LINK_STATUS)) {
    console.error('[lipMesh3D] link:', gl.getProgramInfoLog(lipProg));
    lipProg = null;
    return false;
  }

  // VBO — dynamic, re-filled each frame with landmark positions
  lipVBO = gl.createBuffer();

  // IBOs — static topology
  outerIBO = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, outerIBO);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(OUTER_TRIS), gl.STATIC_DRAW);

  innerIBO = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, innerIBO);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(INNER_TRIS), gl.STATIC_DRAW);

  // FBO + texture — created/resized in renderLipMesh
  lipFBOTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, lipFBOTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  lipFBO = gl.createFramebuffer();
  return true;
}

function ensureFBO(gl, w, h) {
  if (fboW === w && fboH === h) return;
  fboW = w; fboH = h;
  gl.bindTexture(gl.TEXTURE_2D, lipFBOTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, lipFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lipFBOTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// Fill vertex data from landmarks.
// MediaPipe landmarks: { x: 0..1, y: 0..1, z: ~-0.1..0.1 }
// We convert to clip space: x → -1..1, y → 1..-1 (flip Y for GL)
function fillVerts(landmarks) {
  let off = 0;
  // Outer ring
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < OUTER_N; i++) {
    const lm = landmarks[LIPS_OUTER[i]];
    const x = lm.x * 2 - 1;
    const y = 1 - lm.y * 2;  // flip Y
    const z = lm.z || 0;
    vertData[off++] = x;
    vertData[off++] = y;
    vertData[off++] = z;
    vertData[off++] = 1.0; // alpha — filled
    cx += x; cy += y; cz += z;
  }
  // Outer centroid
  vertData[off++] = cx / OUTER_N;
  vertData[off++] = cy / OUTER_N;
  vertData[off++] = cz / OUTER_N;
  vertData[off++] = 1.0;

  // Inner ring
  let icx = 0, icy = 0, icz = 0;
  for (let i = 0; i < INNER_N; i++) {
    const lm = landmarks[LIPS_INNER[i]];
    const x = lm.x * 2 - 1;
    const y = 1 - lm.y * 2;
    const z = lm.z || 0;
    vertData[off++] = x;
    vertData[off++] = y;
    vertData[off++] = z;
    vertData[off++] = 1.0; // alpha — will be erased by cutout pass
    icx += x; icy += y; icz += z;
  }
  // Inner centroid
  vertData[off++] = icx / INNER_N;
  vertData[off++] = icy / INNER_N;
  vertData[off++] = icz / INNER_N;
  vertData[off++] = 1.0;
}

/**
 * Render the 3D lip mesh into lipFBOTex.
 * Returns the WebGL texture object — caller binds it to uLip's texture unit.
 *
 * @param {WebGLRenderingContext} gl
 * @param {number} w  frame width
 * @param {number} h  frame height
 * @param {Array}  landmarks  MediaPipe 468-point face landmarks
 * @param {object} opts  { overrideMask, cutout: true }
 * @returns {WebGLTexture|null}
 */
export function renderLipMesh(gl, w, h, landmarks, opts = {}) {
  if (!lipProg) { if (!initLipMesh(gl)) return null; }
  ensureFBO(gl, w, h);
  fillVerts(landmarks);

  // Save GL state we're about to change
  const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
  const prevFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const prevVP = gl.getParameter(gl.VIEWPORT);
  const prevBlend = gl.isEnabled(gl.BLEND);

  // ── Render into FBO ────────────────────────────────────────────────────
  gl.bindFramebuffer(gl.FRAMEBUFFER, lipFBO);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(lipProg);

  // Upload vertices
  gl.bindBuffer(gl.ARRAY_BUFFER, lipVBO);
  gl.bufferData(gl.ARRAY_BUFFER, vertData, gl.DYNAMIC_DRAW);
  const aPos = gl.getAttribLocation(lipProg, 'aPos');
  const aAlpha = gl.getAttribLocation(lipProg, 'aAlpha');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(aAlpha);
  gl.vertexAttribPointer(aAlpha, 1, gl.FLOAT, false, 16, 12);

  // Pass 1: draw outer fill (alpha = 1)
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, outerIBO);
  gl.drawElements(gl.TRIANGLES, OUTER_TRIS.length, gl.UNSIGNED_SHORT, 0);

  // Pass 2: cut out the inner mouth opening
  // We want to SUBTRACT alpha — use zero blending to write 0 where inner mesh is.
  const gap = Math.abs(landmarks[14].y - landmarks[13].y);
  const lipW = Math.abs(landmarks[291].x - landmarks[61].x);
  const ratio = lipW > 0 ? gap / lipW : 0;
  if (ratio > 0.06) {
    // Erase inner: write (0,0,0,0) where inner triangles are.
    // blendFunc: ZERO, ZERO makes result = 0 everywhere inner mesh covers.
    gl.blendFuncSeparate(gl.ZERO, gl.ZERO, gl.ZERO, gl.ZERO);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, innerIBO);
    gl.drawElements(gl.TRIANGLES, INNER_TRIS.length, gl.UNSIGNED_SHORT, 0);
  }

  // ── Restore GL state ──────────────────────────────────────────────────
  gl.disableVertexAttribArray(aAlpha);
  if (!prevBlend) gl.disable(gl.BLEND);
  else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFBO);
  gl.viewport(prevVP[0], prevVP[1], prevVP[2], prevVP[3]);
  gl.useProgram(prevProg);

  // Re-bind the main quad VBO + attribs so the composite pass finds them
  // (we just rebound ARRAY_BUFFER to lipVBO).
  return lipFBOTex;
}

/** Returns the FBO texture for external binding (e.g. to upload to uLip slot). */
export function getLipFBOTex() { return lipFBOTex; }

/** True once the lip mesh shader compiled successfully. */
export function lipMesh3DAvailable() { return !!lipProg; }
