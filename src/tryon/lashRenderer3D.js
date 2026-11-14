// 3D instanced lash renderer — replaces Canvas2D stroke-based lash mask
// with GPU-instanced quad strips. Each lash is a cubic bezier curve rendered
// as a tapered ribbon in the vertex shader; all lashes per eye in one draw call.
//
// Shares the WebGL context from webglLips.js — called AFTER the main composite
// pass, rendering directly into the same canvas with alpha blending.
//
// Performance: 2 draw calls (one per eye, or 4 with shadow) vs ~720 stroke()
// calls on Canvas2D. GPU parallelises all lashes simultaneously.

import { EYE_R_LASH, EYE_L_LASH, EYE_R_V, EYE_L_V } from './regions.js';

// ── Instant blink from landmarks (no EMA — zero lag) ────────────────────────
// Same Eye Aspect Ratio as faceMetrics.js but computed here to skip the
// smoothed blinkL/blinkR that useTryOn passes through opts.
const EAR_UPPER_R = [159, 160], EAR_LOWER_R = [145, 144], EAR_CORNER_R = [33, 133];
const EAR_UPPER_L = [386, 385], EAR_LOWER_L = [374, 373], EAR_CORNER_L = [263, 362];
const BLINK_CLOSE = 0.06, BLINK_OPEN = 0.18;

function earFromLandmarks(lms, upper, lower, corners) {
  let vDist = 0;
  for (let i = 0; i < upper.length; i++) {
    const dy = lms[upper[i]].y - lms[lower[i]].y;
    const dx = lms[upper[i]].x - lms[lower[i]].x;
    vDist += Math.sqrt(dx * dx + dy * dy);
  }
  vDist /= upper.length;
  const dx = lms[corners[0]].x - lms[corners[1]].x;
  const dy = lms[corners[0]].y - lms[corners[1]].y;
  const hDist = Math.sqrt(dx * dx + dy * dy);
  return hDist > 0.0001 ? vDist / hDist : 0;
}

function instantBlink(landmarks) {
  const earR = earFromLandmarks(landmarks, EAR_UPPER_R, EAR_LOWER_R, EAR_CORNER_R);
  const earL = earFromLandmarks(landmarks, EAR_UPPER_L, EAR_LOWER_L, EAR_CORNER_L);
  const map = (ear) => Math.min(1, Math.max(0, (ear - BLINK_CLOSE) / (BLINK_OPEN - BLINK_CLOSE)));
  return { right: map(earR), left: map(earL) };
}

// ── Shaders ─────────────────────────────────────────────────────────────────

const LASH_VERT = `
precision highp float;

// Per-vertex: position along the curve (t: 0→1) and side (-1 or +1)
attribute float aT;       // 0..1 along bezier
attribute float aSide;    // -1 = left edge, +1 = right edge

// Per-instance: bezier control points + style
attribute vec2 iP0;       // root position (NDC)
attribute vec2 iP1;       // control point 1
attribute vec2 iP2;       // control point 2
attribute vec2 iP3;       // tip position
attribute float iRootW;   // root half-width in PIXELS
attribute float iTipW;    // tip half-width in PIXELS
attribute float iAlpha;   // overall opacity
attribute float iShadow;  // 0 = main lash, 1 = shadow pass

uniform vec2 uPixel;      // vec2(2.0/canvasWidth, 2.0/canvasHeight) — pixel→NDC

varying float vAlpha;
varying float vT;
varying float vSide;

void main() {
  float t = aT;
  float it = 1.0 - t;

  // Cubic bezier: B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
  vec2 pos = it*it*it * iP0
           + 3.0*it*it*t * iP1
           + 3.0*it*t*t * iP2
           + t*t*t * iP3;

  // Tangent: B'(t) = 3[(1-t)²(P1-P0) + 2(1-t)t(P2-P1) + t²(P3-P2)]
  vec2 tang = 3.0 * (it*it * (iP1 - iP0)
            + 2.0*it*t * (iP2 - iP1)
            + t*t * (iP3 - iP2));
  float tLen = length(tang);
  if (tLen < 0.0001) tang = vec2(0.0, -1.0);
  else tang /= tLen;

  // Normal = perpendicular to tangent
  vec2 norm = vec2(-tang.y, tang.x);

  // Tapered width: lerp root→tip (in pixels)
  float hwPx = mix(iRootW, iTipW, t);

  // Shadow is slightly wider
  if (iShadow > 0.5) {
    hwPx *= 1.6;
  }

  // Convert pixel width to NDC offset: norm is in NDC space, so scale
  // the offset by uPixel to get proper pixel-sized width on screen.
  pos += norm * aSide * hwPx * uPixel;

  // Alpha: taper off at tip
  // No edge softening — aSide is only ±1 (two-edge ribbon), so abs(aSide)
  // is always 1.0 and a smoothstep fade there zeros everything out.
  // At 1-2px width the ribbon is thin enough that AA handles edges.
  float tipFade = 1.0 - smoothstep(0.7, 1.0, t);
  float shadowFade = iShadow > 0.5 ? 0.3 : 1.0;

  vAlpha = iAlpha * tipFade * shadowFade;
  vT = t;
  vSide = aSide;

  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const LASH_FRAG = `
precision highp float;

varying float vAlpha;
varying float vT;
varying float vSide;

uniform vec3 uColor;

void main() {
  if (vAlpha < 0.003) discard;
  gl_FragColor = vec4(uColor, vAlpha);
}`;

// ── State ───────────────────────────────────────────────────────────────────

let lashProg = null;
let ext = null;          // ANGLE_instanced_arrays extension
let stripBuf = null;     // per-vertex (aT, aSide) — shared across all draws
let instBuf = null;      // per-instance data — rebuilt each frame
let lashLoc = {};
let SEGMENTS = 8;        // bezier segments per lash (vertices = (SEGMENTS+1) * 2)
let stripVerts = 0;
let _available = null;

// Instance data cache — rebuilt every frame for perfect sync with landmarks.
// The cost is ~0.3ms per frame (trivial JS, no GPU stall).
let _cachedInstData = null;
let _cachedW = 0, _cachedH = 0;

// Deterministic hash for jitter (same as lipRenderer.js)
const hash = (seed) => {
  let h = seed * 2654435761 >>> 0;
  h = ((h >>> 16) ^ h) * 45679 >>> 0;
  return (h & 0xffff) / 0xffff;
};

// ── Configuration (mirrors lipRenderer.js CFG.lashes) ───────────────────────

const CFG = {
  width: 0.0022,          // visible individual lashes
  count: 32,
  len: 0.52,              // longer lashes like mascara (was 0.38)
  reachT: 0.62,
  curl: 0.38,             // strong C-curl (was 0.22)
  depth3d: true,
  depth3dMinW: 800,
  clusters: 16,           // fewer clusters → better separation between lashes
  shadowOffset: 0.10,
  shadowAlpha: 0.30,
  taperEnd: 0.12,         // fine tips
  crossFreq: 0.10,        // some crossing for natural look
  fanSpread: 0.55,        // strong natural fan toward corners
  color: [0.02, 0.02, 0.02],
};

// Instance stride: P0(2) + P1(2) + P2(2) + P3(2) + rootW(1) + tipW(1) + alpha(1) + shadow(1) = 12 floats
const INST_FLOATS = 12;

// ── Init ────────────────────────────────────────────────────────────────────

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

  // Locations
  lashLoc = {
    aT: gl.getAttribLocation(lashProg, 'aT'),
    aSide: gl.getAttribLocation(lashProg, 'aSide'),
    iP0: gl.getAttribLocation(lashProg, 'iP0'),
    iP1: gl.getAttribLocation(lashProg, 'iP1'),
    iP2: gl.getAttribLocation(lashProg, 'iP2'),
    iP3: gl.getAttribLocation(lashProg, 'iP3'),
    iRootW: gl.getAttribLocation(lashProg, 'iRootW'),
    iTipW: gl.getAttribLocation(lashProg, 'iTipW'),
    iAlpha: gl.getAttribLocation(lashProg, 'iAlpha'),
    iShadow: gl.getAttribLocation(lashProg, 'iShadow'),
    uColor: gl.getUniformLocation(lashProg, 'uColor'),
    uPixel: gl.getUniformLocation(lashProg, 'uPixel'),
  };

  // Build strip geometry: (SEGMENTS+1) points × 2 sides = triangle strip
  const verts = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    verts.push(t, -1);  // left edge
    verts.push(t,  1);  // right edge
  }
  stripVerts = verts.length / 2;

  stripBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, stripBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

  instBuf = gl.createBuffer();

  return true;
}

// ── Eye perspective (simplified from lipRenderer.js) ────────────────────────

function eyePerspective(landmarks) {
  const rOuter = landmarks[33], rInner = landmarks[133];
  const lOuter = landmarks[263], lInner = landmarks[362];
  const rW = Math.abs(rOuter.x - rInner.x);
  const lW = Math.abs(lOuter.x - lInner.x);

  // Frontal reference: use nose bridge to eye distance for scale-independent ratio
  const noseBridge = landmarks[168];  // top of nose bridge
  const noseTip = landmarks[1];       // nose tip
  const faceW = Math.abs(landmarks[234].x - landmarks[454].x) || 0.01; // ear-to-ear width

  // Yaw from z-depth difference between eyes
  const rZ = (rOuter.z + rInner.z) / 2;
  const lZ = (lOuter.z + lInner.z) / 2;
  const zDiff = rZ - lZ;  // positive = right eye closer to camera

  // Width ratio: compare each eye's width to frontal estimate
  // Frontal eye width ≈ faceW * 0.23 (anatomical average)
  const frontalEyeW = faceW * 0.23;
  const rRatio = Math.min(1, rW / Math.max(frontalEyeW, 0.001));
  const lRatio = Math.min(1, lW / Math.max(frontalEyeW, 0.001));

  // Combine width ratio with z-depth for stronger perspective effect
  // Eye farther from camera (larger z) gets more foreshortening
  const zScale = 2.5;  // how much z affects perspective
  const rPersp = Math.max(0.15, rRatio - Math.max(0, zDiff) * zScale);
  const lPersp = Math.max(0.15, lRatio - Math.max(0, -zDiff) * zScale);

  return [rPersp, lPersp];
}

// ── Build instance data for one eye ─────────────────────────────────────────

function buildEyeInstances(landmarks, lashPts, vrefPts, persp, outerDir, w, h, doShadow, blinkRatio) {
  const pts = lashPts.map(i => [landmarks[i].x, landmarks[i].y]);
  const n = pts.length;
  const eyeH = Math.abs(landmarks[vrefPts[0]].y - landmarks[vrefPts[1]].y);

  // Blink is handled at draw time (binary skip when eye not fully open),
  // so no length scaling needed here.
  const blinkLenScale = 1;

  // Perspective tuck
  const tuck = Math.max(0, 1 - persp) * 1.2;
  if (tuck > 0.01) {
    const cx = (pts[0][0] + pts[n - 1][0]) / 2;
    const cy = (pts[0][1] + pts[n - 1][1]) / 2;
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1);
      const pull = t > 0.45 ? (t - 0.45) / 0.55 * tuck : 0;
      if (pull > 0) {
        pts[k][0] += (cx - pts[k][0]) * pull * 0.45;
        pts[k][1] += (cy - pts[k][1]) * pull * 0.28;
      }
    }
  }

  // Arc-length sampler
  const seg = []; let total = 0;
  for (let k = 1; k < n; k++) {
    const d = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    seg.push(d); total += d;
  }
  const at = (u) => {
    let d = u * total, k = 0;
    while (k < seg.length && d > seg[k]) { d -= seg[k]; k++; }
    if (k >= seg.length) return pts[n - 1];
    const f = seg[k] ? d / seg[k] : 0;
    return [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f];
  };

  const baseCurl = CFG.curl;
  const baseLen = eyeH * CFG.len;
  // Width in PIXELS (not normalised) — the shader converts to NDC via uPixel.
  // Canvas2D uses: Math.max(1.0, canvasH * CFG.width) ≈ 2.4px at 1080p.
  const thin = Math.max(1.0, h * CFG.width);
  // persp: 1 = frontal, 0 = fully turned away
  const isFarEye = persp < 0.7;
  const perspShorten = isFarEye ? Math.max(0.2, persp * 0.6) : Math.max(0.4, persp);
  const perspCurlFlip = Math.max(0, (1 - persp) * 0.8);
  // Far eye: lashes appear thicker (seen from side profile)
  const perspWidthMul = isFarEye ? 1.0 + (1 - persp) * 1.5 : 1.0;
  // Far eye: reduce alpha — lashes partially hidden by lid angle
  const perspAlpha = isFarEye ? Math.max(0.3, persp) : 1.0;
  // Far eye: fewer clusters (many lashes overlap into a single mass)
  const isSmall = w < (CFG.depth3dMinW ?? 800);
  const baseClusters = isSmall ? 10 : (CFG.clusters ?? 12);
  const CLUSTERS = isFarEye ? Math.max(6, Math.round(baseClusters * persp)) : baseClusters;
  const clusterSpacing = CFG.reachT / CLUSTERS;
  const taperEnd = CFG.taperEnd;
  const crossFreq = CFG.crossFreq;
  const shadowOffFrac = CFG.shadowOffset;

  const instances = [];

  const addPass = (isShadow) => {
    const offYFrac = isShadow ? baseLen * shadowOffFrac : 0;
    const offXFrac = isShadow ? baseLen * shadowOffFrac * outerDir * 0.3 : 0;
    const widthScale = isShadow ? 1.8 : 1;
    const lenScale = isShadow ? 0.85 : 1;
    const alphaScale = isShadow ? CFG.shadowAlpha : 1;

    for (let ci = 0; ci < CLUSTERS; ci++) {
      const clusterU = (ci + 0.5) * clusterSpacing;
      if (clusterU > CFG.reachT) continue;
      const clusterSize = ci < 4 ? 3 : (hash(ci * 97) > 0.5 ? 3 : 2);
      const spreadFactor = (1 - clusterU / CFG.reachT) * 0.6 + 0.4;
      const clusterSpread = clusterSpacing * 0.35 * spreadFactor;

      for (let li = 0; li < clusterSize; li++) {
        const lashOffset = (li - (clusterSize - 1) / 2) * clusterSpread / clusterSize;
        const u = Math.max(0, Math.min(CFG.reachT, clusterU + lashOffset));
        const seed = ci * 31 + li * 7;

        // Length envelope
        const bellPeak = 0.18, bellWidth = 0.55;
        const bellDist = (u - bellPeak) / bellWidth;
        const envelope = Math.exp(-bellDist * bellDist * 2.5);
        const envClamp = 0.25 + envelope * 0.75;
        const lenJitter = 0.85 + 0.30 * hash(seed + 1);  // tighter length range
        const innerPerspScale = 1 - (1 - perspShorten) * u;

        // Position along lash line: 0 = outer corner, 1 = inner corner
        const posNorm = u / CFG.reachT;

        // Edge length taper: shorter at both corners for smooth falloff
        const edgeLenOuter = Math.min(1, posNorm / 0.10);        // ramp up from outer
        const edgeLenInner = Math.min(1, (1 - posNorm) / 0.15);  // ramp down to inner
        const edgeLenScale = 0.3 + 0.7 * edgeLenOuter * edgeLenInner;
        const lashLen = baseLen * envClamp * lenJitter * innerPerspScale * lenScale * blinkLenScale * edgeLenScale;
        if (lashLen < 0.001) continue;

        // Thickness
        const thickEnv = 0.55 + 0.45 * (1 - posNorm);
        const thickJitter = 0.75 + 0.50 * hash(seed + 2);
        const rootWidth = thin * 0.70 * thickEnv * thickJitter * widthScale * perspWidthMul;

        // Curl — consistent upward curve, slightly stronger at outer corner
        const curlType = hash(seed + 10);
        const curlPos = baseCurl * (0.85 + 0.30 * (1 - posNorm));
        const curlJitter = 0.82 + 0.36 * hash(seed + 3);  // tighter range
        const curl = curlPos * curlJitter;

        // Fan angle — natural lashes fan outward from the eye center:
        // outer corner leans away from nose, inner corner leans toward nose.
        // outerDir encodes which side is "outer" so both eyes fan correctly.
        let fanAngle = (0.5 - posNorm) * CFG.fanSpread * outerDir;
        // Edge fan boost: last ~4-5 lashes on each side fan out more strongly
        // Outer corner (posNorm < 0.12) and inner corner (posNorm > 0.88)
        const edgeBoostOuter = Math.max(0, 1 - posNorm / 0.12);   // 1→0 over first 12%
        const edgeBoostInner = Math.max(0, 1 - (1 - posNorm) / 0.12); // 0→1 over last 12%
        const edgeBoost = Math.max(edgeBoostOuter, edgeBoostInner);
        // Smoothly add extra fan AWAY from nose at both edges
        fanAngle += edgeBoost * edgeBoost * 0.45 * outerDir;
        // Tiny per-lash jitter (±2°) for organic feel without messiness
        fanAngle += (hash(seed + 4) - 0.5) * 0.07;
        const doCross = !isShadow && hash(seed + 20) < crossFreq;
        if (doCross) {
          const crossDir = hash(seed + 21) > 0.5 ? 1 : -1;
          fanAngle += crossDir * (0.08 + hash(seed + 22) * 0.06);
        }

        const [px, py] = at(u);
        const flipAmount = perspCurlFlip * u;
        const effectiveOuterDir = outerDir * (1 - flipAmount * 2);

        // Inner-corner fade
        const fadeFactor = tuck > 0.05
          ? 1 - Math.max(0, (u - 0.55) / 0.45) * Math.min(1, tuck * 0.9)
          : 1;
        if (fadeFactor < 0.02) continue;

        // Bezier control points (in normalised 0..1 coords)
        const baseAngle = -Math.PI / 2;
        const lashAngle = baseAngle + fanAngle;
        const cosA = Math.cos(lashAngle), sinA = Math.sin(lashAngle);
        const bx = px + offXFrac, by = py + offYFrac;
        // Far eye: tip bends toward camera (more horizontal, less vertical)
        const horizBend = isFarEye ? (1 - persp) * 0.5 : 0;
        const tipX = bx + cosA * lashLen + effectiveOuterDir * lashLen * (curl * 0.28 + horizBend);
        const tipY = by + sinA * lashLen * (1 - horizBend * 0.6);

        // Bezier handle positions — three subtle curl shapes (J/C/L) that
        // are close enough to look uniform but with organic micro-variation
        let c1t, c1curl, c2t, c2curl;
        if (curlType < 0.33) {
          // J-curl: gentle base, strong tip lift
          c1t = 0.30; c1curl = 0.12;
          c2t = 0.65; c2curl = 0.40;
        } else if (curlType < 0.66) {
          // C-curl: dramatic even arc (like mascara reference)
          c1t = 0.30; c1curl = 0.25;
          c2t = 0.65; c2curl = 0.35;
        } else {
          // L-curl: sharp lift from mid-point
          c1t = 0.25; c1curl = 0.30;
          c2t = 0.55; c2curl = 0.22;
        }
        const cp1x = bx + cosA * lashLen * c1t + effectiveOuterDir * lashLen * curl * c1curl;
        const cp1y = by + sinA * lashLen * (c1t + curl * 0.45);
        const cp2x = bx + cosA * lashLen * c2t + effectiveOuterDir * lashLen * curl * c2curl;
        const cp2y = by + sinA * lashLen * (c2t + curl * 0.35);

        // Smooth fade at both edges of the lash line:
        // outer corner (posNorm near 0) and inner corner (posNorm near 1)
        const edgeFadeOuter = Math.min(1, posNorm / 0.12);        // 0→1 over first 12%
        const edgeFadeInner = Math.min(1, (1 - posNorm) / 0.18);  // 1→0 over last 18%
        const edgeFade = edgeFadeOuter * edgeFadeInner;
        const alpha = fadeFactor * alphaScale * perspAlpha * edgeFade;

        // Convert to NDC (-1..1): x: (coord * 2 - 1), y: -(coord * 2 - 1) (flip Y)
        // Width in NDC: normalized width * 2 (since NDC spans 2 units)
        const toNDCx = (v) => v * 2 - 1;
        const toNDCy = (v) => -(v * 2 - 1);  // flip Y for GL

        // rootW / tipW now in PIXELS — the shader converts via uPixel uniform
        instances.push(
          toNDCx(bx), toNDCy(by),           // P0
          toNDCx(cp1x), toNDCy(cp1y),       // P1
          toNDCx(cp2x), toNDCy(cp2y),       // P2
          toNDCx(tipX), toNDCy(tipY),        // P3
          Math.max(0.5, rootWidth),                    // rootW (px)
          Math.max(0.25, rootWidth * taperEnd),        // tipW  (px)
          alpha,                              // alpha
          isShadow ? 1 : 0                    // shadow flag
        );
      }
    }
  };

  // Shadow pass first (if enabled), then main
  if (doShadow && !isSmall) addPass(true);
  addPass(false);

  return new Float32Array(instances);
}

// ── Main render ─────────────────────────────────────────────────────────────

/**
 * Render 3D instanced lashes into the current GL canvas.
 * Call AFTER the main webglLips composite pass (same GL context).
 *
 * @param {WebGLRenderingContext} gl - shared GL context from webglLips
 * @param {number} w - canvas width
 * @param {number} h - canvas height
 * @param {Array} landmarks - 468-point face landmarks
 * @param {Object} opts - { intensity, color, blinkL, blinkR, motion }
 * @returns {boolean} true if rendered
 */
export function renderLashes3D(gl, w, h, landmarks, opts = {}) {
  if (!gl || !landmarks || landmarks.length < 468) return false;
  if (!initLash3d(gl)) return false;

  const intensity = opts.intensity ?? 0.8;
  if (intensity < 0.01) return false;

  // No motion fade: lashes stay on during fast head turns (rebuilt per frame).
  const motionFade = 1;

  // Per-eye blink: compute directly from landmarks, no EMA smoothing.
  // This gives instant response — lashes fold the same frame the eye closes.
  const blink = instantBlink(landmarks);
  const blinkL = blink.left;
  const blinkR = blink.right;
  const finalAlpha = intensity * motionFade;
  if (finalAlpha < 0.01) return false;

  // Rebuild instance data every frame for perfect landmark sync.
  // Cost: ~0.3ms JS (no GPU stall) — worth it for zero-lag tracking.
  {
    const [perspR, perspL] = eyePerspective(landmarks);
    const rPts = EYE_R_LASH;
    const lPts = EYE_L_LASH;
    const outerDirR = Math.sign(landmarks[rPts[0]].x - landmarks[rPts[rPts.length - 1]].x) || 1;
    const outerDirL = Math.sign(landmarks[lPts[0]].x - landmarks[lPts[lPts.length - 1]].x) || 1;
    const doShadow = CFG.depth3d;

    const rightData = buildEyeInstances(landmarks, rPts, EYE_R_V, perspR, outerDirR, w, h, doShadow, blinkR);
    const leftData = buildEyeInstances(landmarks, lPts, EYE_L_V, perspL, outerDirL, w, h, doShadow, blinkL);

    _cachedInstData = {
      right: rightData, left: leftData,
      rCount: rightData.length / INST_FLOATS,
      lCount: leftData.length / INST_FLOATS,
    };
    _cachedW = w;
    _cachedH = h;
  }

  if (!_cachedInstData) return false;

  // ── GL state ──
  // Save the main program's state — we'll switch programs and restore after
  gl.useProgram(lashProg);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);

  // Color uniform (apply intensity as alpha multiplier)
  const color = opts.color ? hexToRgb3(opts.color) : CFG.color;
  gl.uniform3f(lashLoc.uColor, color[0], color[1], color[2]);

  // Pixel→NDC conversion: the shader multiplies pixel widths by this
  gl.uniform2f(lashLoc.uPixel, 2 / w, 2 / h);

  // Draw each eye with per-eye blink alpha
  const eyeEntries = [
    { data: _cachedInstData.right, blink: blinkR },
    { data: _cachedInstData.left,  blink: blinkL },
  ];
  for (const { data, blink } of eyeEntries) {
    const count = data.length / INST_FLOATS;
    if (count === 0) continue;

    // Binary blink: hide lashes instantly when eye starts closing,
    // show only when fully open — no gradual fade.
    if (blink < 0.95) continue;
    const eyeAlpha = finalAlpha;

    // Upload instance data
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const scaled = new Float32Array(data.length);
    scaled.set(data);
    for (let i = 0; i < count; i++) {
      scaled[i * INST_FLOATS + 10] *= eyeAlpha; // alpha field
    }
    gl.bufferData(gl.ARRAY_BUFFER, scaled, gl.DYNAMIC_DRAW);

    // Set up instance attributes
    const stride = INST_FLOATS * 4;
    const setInst = (loc, size, offset) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
      ext.vertexAttribDivisorANGLE(loc, 1);
    };
    setInst(lashLoc.iP0, 2, 0);
    setInst(lashLoc.iP1, 2, 2);
    setInst(lashLoc.iP2, 2, 4);
    setInst(lashLoc.iP3, 2, 6);
    setInst(lashLoc.iRootW, 1, 8);
    setInst(lashLoc.iTipW, 1, 9);
    setInst(lashLoc.iAlpha, 1, 10);
    setInst(lashLoc.iShadow, 1, 11);

    // Set up strip geometry (per-vertex, divisor 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, stripBuf);
    gl.enableVertexAttribArray(lashLoc.aT);
    gl.vertexAttribPointer(lashLoc.aT, 1, gl.FLOAT, false, 8, 0);
    ext.vertexAttribDivisorANGLE(lashLoc.aT, 0);
    gl.enableVertexAttribArray(lashLoc.aSide);
    gl.vertexAttribPointer(lashLoc.aSide, 1, gl.FLOAT, false, 8, 4);
    ext.vertexAttribDivisorANGLE(lashLoc.aSide, 0);

    // Draw!
    ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, stripVerts, count);
  }

  // ── Lash-line darkening along roots (only when no eyeliner) ──
  if (!opts.hasEyeliner) {
    // Draw a thin dark line along the lash root points using GL_LINE_STRIP
    // This mimics the natural darkening where lashes meet the eyelid
    const lineColor = opts.color ? hexToRgb3(opts.color) : CFG.color;
    const lineAlpha = finalAlpha * 0.55;

    // Simple line shader — reuse a minimal approach with gl.LINE_STRIP
    // We'll draw directly in NDC using the lash root positions
    const eyePtsArr = [EYE_R_LASH, EYE_L_LASH];
    const eyeBlinks = [blinkR, blinkL];
    for (let ei = 0; ei < 2; ei++) {
      if (eyeBlinks[ei] < 0.95) continue;
      const pts = eyePtsArr[ei];
      const lineVerts = [];
      for (let pi = 0; pi < pts.length; pi++) {
        const lm = landmarks[pts[pi]];
        // Convert to NDC: x * 2 - 1, -(y * 2 - 1)
        lineVerts.push(lm.x * 2 - 1, -(lm.y * 2 - 1));
      }
      const lineBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineVerts), gl.DYNAMIC_DRAW);

      // Use the lash shader with a zero-length bezier (root=tip) and wide width
      // Actually simpler: draw as flat instances where P0=P3=point, width=lineWidth
      // For simplicity, create tiny instances along the lash line
      const lineInstances = [];
      const totalSegs = pts.length - 1;
      // Only draw the outer ~60% of the lash line, fading out toward inner corner
      const fadeStart = 0.4;  // start fading at 40% from outer
      for (let pi = 0; pi < totalSegs; pi++) {
        const t = pi / totalSegs;  // 0 = outer corner, 1 = inner corner
        // Fade out: full at outer, zero past ~65%
        const fade = t < fadeStart ? 1.0
          : Math.max(0, 1.0 - (t - fadeStart) / (1.0 - fadeStart));
        if (fade < 0.02) continue;  // skip invisible inner segments

        const a = landmarks[pts[pi]], b = landmarks[pts[pi + 1]];
        const ax = a.x * 2 - 1, ay = -(a.y * 2 - 1);
        const bx = b.x * 2 - 1, by = -(b.y * 2 - 1);
        const mx1 = ax + (bx - ax) * 0.33, my1 = ay + (by - ay) * 0.33;
        const mx2 = ax + (bx - ax) * 0.66, my2 = ay + (by - ay) * 0.66;
        const segW = Math.max(1.2, h * 0.0018) * fade;
        lineInstances.push(
          ax, ay, mx1, my1, mx2, my2, bx, by,
          segW, segW * 0.5,
          lineAlpha * fade,    // alpha fades toward inner corner
          0
        );
      }
      if (lineInstances.length > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineInstances), gl.DYNAMIC_DRAW);

        const stride = INST_FLOATS * 4;
        const setInst = (loc, size, offset) => {
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
          ext.vertexAttribDivisorANGLE(loc, 1);
        };
        setInst(lashLoc.iP0, 2, 0);
        setInst(lashLoc.iP1, 2, 2);
        setInst(lashLoc.iP2, 2, 4);
        setInst(lashLoc.iP3, 2, 6);
        setInst(lashLoc.iRootW, 1, 8);
        setInst(lashLoc.iTipW, 1, 9);
        setInst(lashLoc.iAlpha, 1, 10);
        setInst(lashLoc.iShadow, 1, 11);

        gl.bindBuffer(gl.ARRAY_BUFFER, stripBuf);
        gl.vertexAttribPointer(lashLoc.aT, 1, gl.FLOAT, false, 8, 0);
        ext.vertexAttribDivisorANGLE(lashLoc.aT, 0);
        gl.vertexAttribPointer(lashLoc.aSide, 1, gl.FLOAT, false, 8, 4);
        ext.vertexAttribDivisorANGLE(lashLoc.aSide, 0);

        const segCount = lineInstances.length / INST_FLOATS;
        ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, stripVerts, segCount);
      }
      gl.deleteBuffer(lineBuf);

      // Second pass: soft shadow below lash line (wider, more transparent)
      const shadowInstances = [];
      const shadowOffset = h * 0.0015; // shift down slightly in NDC
      for (let pi = 0; pi < totalSegs; pi++) {
        const t = pi / totalSegs;
        const fade = t < fadeStart ? 1.0
          : Math.max(0, 1.0 - (t - fadeStart) / (1.0 - fadeStart));
        if (fade < 0.02) continue;

        const a = landmarks[pts[pi]], b = landmarks[pts[pi + 1]];
        const ax = a.x * 2 - 1, ay = -(a.y * 2 - 1) - shadowOffset;
        const bx = b.x * 2 - 1, by = -(b.y * 2 - 1) - shadowOffset;
        const mx1 = ax + (bx - ax) * 0.33, my1 = ay + (by - ay) * 0.33;
        const mx2 = ax + (bx - ax) * 0.66, my2 = ay + (by - ay) * 0.66;
        const sW = Math.max(2.0, h * 0.003) * fade;
        shadowInstances.push(
          ax, ay, mx1, my1, mx2, my2, bx, by,
          sW, sW * 0.3,
          lineAlpha * fade * 0.35,  // soft transparent shadow
          0
        );
      }
      if (shadowInstances.length > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(shadowInstances), gl.DYNAMIC_DRAW);
        const shadowCount = shadowInstances.length / INST_FLOATS;
        ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, stripVerts, shadowCount);
      }
    }
  }

  // ── Restore GL state for webglLips ──
  // Reset instance divisors so they don't affect the main program
  for (const loc of [lashLoc.iP0, lashLoc.iP1, lashLoc.iP2, lashLoc.iP3,
                      lashLoc.iRootW, lashLoc.iTipW, lashLoc.iAlpha, lashLoc.iShadow]) {
    ext.vertexAttribDivisorANGLE(loc, 0);
    gl.disableVertexAttribArray(loc);
  }

  return true;
}

function hexToRgb3(h) {
  if (Array.isArray(h)) return h;
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/**
 * Reset cached state — call when GL context is lost/recreated.
 */
export function resetLash3d() {
  lashProg = null;
  ext = null;
  stripBuf = null;
  instBuf = null;
  _cachedInstData = null;
  _cachedW = 0; _cachedH = 0;
  _available = null;
}