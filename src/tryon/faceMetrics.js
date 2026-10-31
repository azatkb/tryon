// Pure face-metric helpers shared by every consumer of the try-on engine.
// No React, no DOM ownership — each function takes what it needs and returns a
// value, so they're trivial to test and safe to call from any render loop.

// Landmarks that stay put relative to the skull — good anchors for a motion
// metric that ignores mouth and brow movement.
const MOTION_IDX = [1, 13, 14, 61, 291, 199];

// Nose bridge / tip / cheeks / eye corners — the patch we sample for exposure.
const LUM_IDX = [4, 94, 323, 33, 263, 1, 168];

// Symmetric landmark pairs for yaw estimation (left idx, right idx).
// Outer eye corners + outer cheek + jaw edge — widely spaced for precision.
const YAW_PAIRS = [
  [33, 263],   // outer eye corners
  [234, 454],  // outer cheek
  [127, 356],  // jaw edge
];
// Nose tip — the face centre reference.
const NOSE_TIP = 4;

/**
 * Per-frame face motion in normalised units, EMA-smoothed by the caller.
 * Returns { motion, snapshot } — pass the snapshot back in as `prev` next frame.
 */
export function faceMotion(landmarks, prev) {
  const snapshot = {};
  for (const i of MOTION_IDX) {
    const p = landmarks[i];
    if (p) snapshot[i] = { x: p.x, y: p.y };
  }
  if (!prev) return { motion: 0, snapshot };
  let d = 0, n = 0;
  for (const i of MOTION_IDX) {
    const a = landmarks[i], b = prev[i];
    if (!a || !b) continue;
    d += Math.hypot(a.x - b.x, a.y - b.y);
    n++;
  }
  return { motion: n ? d / n : 0, snapshot };
}

// Landmark ranges that move independently of head motion. These regions get
// per-point adaptive alpha so a lip purse or a blink isn't dragged back by
// heavy smoothing tuned for the stable skull points.
const LIP_RANGE  = [61, 62, 63, 64, 65, 66, 67, 78, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 146, 91,
                    185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61,
                    /* inner lip */ 78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
const EYE_RANGE  = [// upper+lower lids left
                    33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
                    // upper+lower lids right
                    263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const FAST_SET = new Set([...LIP_RANGE, ...EYE_RANGE]);

// Lash landmarks need even less smoothing — thin strokes make sub-pixel lag
// visible. These points track near-raw so lashes never trail the eye.
const LASH_IDX = [// upper lid right
                  33, 246, 161, 160, 159, 158, 157, 173, 133,
                  // upper lid left
                  263, 466, 388, 387, 386, 385, 384, 398, 362];
const LASH_SET = new Set(LASH_IDX);

/**
 * EMA landmark smoother — kills per-frame jitter without adding lag when the
 * face actually moves. alpha rises with motion: still face => heavy smoothing,
 * fast turn => follow the raw detection.
 *   alpha 0 = frozen, 1 = raw.
 *
 * Lip and eye landmarks get a per-point adaptive boost: if the point itself
 * moved more than the skull did, it gets a higher alpha so lips and lashes
 * track immediately even when the head is still.
 */
export function smoothLandmarks(cur, smoothed, motion, opts = {}) {
  if (!smoothed || smoothed.length !== cur.length) return cur;
  const base = opts.alpha ?? 0.18;
  const max = opts.maxAlpha ?? 0.85;
  const gain = opts.gain ?? 120;
  const globalAlpha = Math.min(max, base + motion * gain);
  const out = new Array(cur.length);
  for (let i = 0; i < cur.length; i++) {
    const c = cur[i], s = smoothed[i];
    let alpha = globalAlpha;
    // Per-point boost for lips & eyes: compare this point's own displacement
    // against a low threshold. If it moved, raise alpha so the mask follows.
    if (FAST_SET.has(i)) {
      const pd = Math.hypot(c.x - s.x, c.y - s.y);
      // 0.002 normalised ≈ 1-2px on 1080p — meaningful lip/eye movement
      // Lash points get a higher floor (0.72) — thin strokes can't tolerate
      // even small lag without looking like they float off the lid.
      const floor = LASH_SET.has(i) ? 0.72 : 0.45;
      const localBoost = Math.min(max, floor + pd * 300);
      alpha = Math.max(alpha, localBoost);
    }
    const inv = 1 - alpha;
    out[i] = {
      x: c.x * alpha + s.x * inv,
      y: c.y * alpha + s.y * inv,
      z: (c.z || 0) * alpha + (s.z || 0) * inv,
    };
  }
  return out;
}

/**
 * Extrapolate landmarks along their velocity so the mask keeps up with motion
 * instead of trailing one detection behind. prev/cur are landmark arrays.
 */
export function predictLandmarks(cur, prev, k) {
  if (!prev || k <= 0 || prev.length !== cur.length) return cur;
  const out = new Array(cur.length);
  for (let i = 0; i < cur.length; i++) {
    const c = cur[i], p = prev[i];
    out[i] = { x: c.x + (c.x - p.x) * k, y: c.y + (c.y - p.y) * k, z: c.z };
  }
  return out;
}

/** Padded face bounding box in pixels, from normalised landmarks. */
export function faceBBox(landmarks, w, h, pad = 0.12) {
  let minx = 1, miny = 1, maxx = 0, maxy = 0;
  for (const p of landmarks) {
    if (p.x < minx) minx = p.x;
    if (p.x > maxx) maxx = p.x;
    if (p.y < miny) miny = p.y;
    if (p.y > maxy) maxy = p.y;
  }
  const pw = (maxx - minx) * pad, ph = (maxy - miny) * pad;
  const x = Math.max(0, minx - pw) * w, y = Math.max(0, miny - ph) * h;
  const x1 = Math.min(1, maxx + pw) * w, y1 = Math.min(1, maxy + ph) * h;
  return { x, y, w: x1 - x, h: y1 - y };
}

// Reusable 32x32 scratch — downsampling to a fixed tile makes the cost of a
// luminance read independent of frame size.
let lumScratch = null;
function scratch() {
  if (!lumScratch) {
    lumScratch = document.createElement('canvas');
    lumScratch.width = lumScratch.height = 32;
  }
  return lumScratch;
}

/**
 * Mean Rec.709 luminance of the central face patch, 0..1.
 * The shader uses this to normalise exposure, so makeup reads the same under
 * window light and a dim room. Returns null if the patch can't be sampled.
 */
export function estimateFaceLum(source, landmarks) {
  if (!landmarks || landmarks.length < 200) return null;
  let minX = 1, maxX = 0, minY = 1, maxY = 0, n = 0;
  for (const i of LUM_IDX) {
    const p = landmarks[i];
    if (!p) continue;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    n++;
  }
  if (n < 3 || maxX <= minX || maxY <= minY) return null;
  const vw = source.videoWidth || source.naturalWidth || source.width;
  const vh = source.videoHeight || source.naturalHeight || source.height;
  if (!vw || !vh) return null;
  const cv = scratch();
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  try {
    ctx.drawImage(source, minX * vw, minY * vh, (maxX - minX) * vw, (maxY - minY) * vh, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    let sum = 0;
    for (let p = 0; p < d.length; p += 4) {
      sum += 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
    }
    return sum / (32 * 32 * 255);
  } catch (_) {
    return null; // tainted canvas or a frame that isn't ready yet
  }
}

/**
 * Estimate face yaw (horizontal rotation) from landmarks, 0..1.
 *   0 = perfectly frontal, 1 = full profile (90°).
 * Uses the ratio of nose-to-left vs nose-to-right distances on x-axis.
 * When the face turns right, the nose moves closer to the right outline
 * and further from the left — the asymmetry maps directly to yaw.
 */
export function estimateFaceYaw(landmarks) {
  if (!landmarks || landmarks.length < 400) return null;
  const nose = landmarks[NOSE_TIP];
  if (!nose) return null;
  let sumL = 0, sumR = 0, n = 0;
  for (const [li, ri] of YAW_PAIRS) {
    const pl = landmarks[li], pr = landmarks[ri];
    if (!pl || !pr) continue;
    sumL += Math.abs(nose.x - pl.x);
    sumR += Math.abs(nose.x - pr.x);
    n++;
  }
  if (n === 0) return null;
  const dL = sumL / n, dR = sumR / n;
  const total = dL + dR;
  if (total < 0.001) return 0;
  // ratio: 0.5 = frontal, 0 or 1 = full profile
  const ratio = dR / total;
  // Map deviation from 0.5 to 0..1: abs(ratio - 0.5) * 2
  return Math.min(1, Math.abs(ratio - 0.5) * 2);
}

// Left / right cheek landmarks for directional light estimation.
// MediaPipe face mesh: 234 = left cheek outer, 50 = left cheek inner,
// 454 = right cheek outer, 280 = right cheek inner.
const CHEEK_L = [234, 50, 117, 123];   // viewer's left = face's right cheek
const CHEEK_R = [454, 280, 346, 352];  // viewer's right = face's left cheek

/**
 * Light balance: –1 = lit from the left, +1 = lit from the right, 0 = even.
 * Compares mean luminance of left-cheek patch vs right-cheek patch.
 * Returns null when landmarks are insufficient.
 */
export function estimateLightBalance(source, landmarks) {
  if (!landmarks || landmarks.length < 400) return null;
  const vw = source.videoWidth || source.naturalWidth || source.width;
  const vh = source.videoHeight || source.naturalHeight || source.height;
  if (!vw || !vh) return null;

  function patchLum(idxArr) {
    let minX = 1, maxX = 0, minY = 1, maxY = 0, n = 0;
    for (const i of idxArr) {
      const p = landmarks[i];
      if (!p) continue;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      n++;
    }
    if (n < 2 || maxX <= minX || maxY <= minY) return null;
    const cv = scratch();
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    try {
      ctx.drawImage(source, minX * vw, minY * vh, (maxX - minX) * vw, (maxY - minY) * vh, 0, 0, 16, 16);
      const d = ctx.getImageData(0, 0, 16, 16).data;
      let sum = 0;
      for (let p = 0; p < d.length; p += 4) sum += 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
      return sum / (16 * 16 * 255);
    } catch (_) { return null; }
  }

  const ll = patchLum(CHEEK_L), lr = patchLum(CHEEK_R);
  if (ll == null || lr == null) return null;
  const total = ll + lr;
  if (total < 0.01) return 0;
  // Normalise: (right - left) / (right + left). Positive = right side brighter.
  return Math.max(-1, Math.min(1, (lr - ll) / total));
}

// ── Blink detection ─────────────────────────────────────────────────────────
// MediaPipe upper/lower lid landmark pairs per eye. The vertical distance
// between them, normalised by eye width, tells us the eye-aperture ratio (EAR).
// Below a threshold the eye is blinking — we use this to gate eye makeup so
// lashes/liner/shadow don't paint on a closed lid.
const EAR_UPPER_R = [159, 158, 157]; // right eye upper lid (inner→outer)
const EAR_LOWER_R = [145, 153, 154]; // right eye lower lid
const EAR_CORNER_R = [33, 133];      // right eye outer/inner corners
const EAR_UPPER_L = [386, 385, 384]; // left eye upper lid
const EAR_LOWER_L = [374, 380, 381]; // left eye lower lid
const EAR_CORNER_L = [263, 362];     // left eye outer/inner corners

function eyeAspectRatio(landmarks, upper, lower, corners) {
  let vSum = 0;
  for (let i = 0; i < upper.length; i++) {
    const u = landmarks[upper[i]], l = landmarks[lower[i]];
    if (!u || !l) return 1; // can't measure — assume open
    vSum += Math.abs(u.y - l.y);
  }
  const vAvg = vSum / upper.length;
  const c0 = landmarks[corners[0]], c1 = landmarks[corners[1]];
  if (!c0 || !c1) return 1;
  const hDist = Math.abs(c0.x - c1.x);
  return hDist > 0.001 ? vAvg / hDist : 1;
}

/**
 * Blink detection: returns { left, right } each in 0..1.
 *   1 = eye fully open, 0 = eye fully closed (blink).
 * Smooth the output with EMA for stable fade-in/out of eye makeup.
 *
 * BLINK_CLOSE = EAR below which eye is "closed"
 * BLINK_OPEN  = EAR above which eye is "fully open"
 */
const BLINK_CLOSE = 0.06;
const BLINK_OPEN  = 0.18;

export function detectBlink(landmarks) {
  if (!landmarks || landmarks.length < 400) return { left: 1, right: 1 };
  const earR = eyeAspectRatio(landmarks, EAR_UPPER_R, EAR_LOWER_R, EAR_CORNER_R);
  const earL = eyeAspectRatio(landmarks, EAR_UPPER_L, EAR_LOWER_L, EAR_CORNER_L);
  const map = (ear) => Math.min(1, Math.max(0,
    (ear - BLINK_CLOSE) / (BLINK_OPEN - BLINK_CLOSE)));
  return { left: map(earL), right: map(earR) };
}

/** Skin depth word (for shade resolution) from a 0..1 luminance. */
export function depthFromLum(lum) {
  const v = lum * 255;
  return v > 210 ? 'fair' : v > 185 ? 'light' : v > 160 ? 'light medium'
    : v > 135 ? 'medium' : v > 110 ? 'medium tan' : v > 85 ? 'tan'
    : v > 60 ? 'deep' : 'rich';
}