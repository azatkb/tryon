// Pure face-metric helpers shared by every consumer of the try-on engine.
// No React, no DOM ownership — each function takes what it needs and returns a
// value, so they're trivial to test and safe to call from any render loop.

// Landmarks that stay put relative to the skull — good anchors for a motion
// metric that ignores mouth and brow movement.
const MOTION_IDX = [1, 13, 14, 61, 291, 199];

// Nose bridge / tip / cheeks / eye corners — the patch we sample for exposure.
const LUM_IDX = [4, 94, 323, 33, 263, 1, 168];

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

/**
 * EMA landmark smoother — kills per-frame jitter without adding lag when the
 * face actually moves. alpha rises with motion: still face => heavy smoothing,
 * fast turn => follow the raw detection.
 *   alpha 0 = frozen, 1 = raw.
 */
export function smoothLandmarks(cur, smoothed, motion, opts = {}) {
  if (!smoothed || smoothed.length !== cur.length) return cur;
  const base = opts.alpha ?? 0.18;
  const max = opts.maxAlpha ?? 0.85;
  const gain = opts.gain ?? 120;
  const alpha = Math.min(max, base + motion * gain);
  const inv = 1 - alpha;
  const out = new Array(cur.length);
  for (let i = 0; i < cur.length; i++) {
    const c = cur[i], s = smoothed[i];
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

/** Skin depth word (for shade resolution) from a 0..1 luminance. */
export function depthFromLum(lum) {
  const v = lum * 255;
  return v > 210 ? 'fair' : v > 185 ? 'light' : v > 160 ? 'light medium'
    : v > 135 ? 'medium' : v > 110 ? 'medium tan' : v > 85 ? 'tan'
    : v > 60 ? 'deep' : 'rich';
}