// lipEdgeDetect.js — pixel-based lip contour refinement.
//
// MediaPipe lip landmarks approximate the lip boundary, but they can be
// off by several pixels — especially at the lower lip edge and corners.
// This module samples the actual camera frame around each landmark and
// marches along the skin→lip gradient to find the true edge.
//
// The refined contour is returned as an array of {x, y} points in
// normalised coordinates (0..1), same format as MediaPipe landmarks.
// A debug function draws the result as a green polyline over the frame.

import { LIPS_OUTER, LIPS_INNER } from './lips.js';

// ── Colour helpers ──────────────────────────────────────────────────────

// sRGB → linear
function lin(c) { return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }

// sRGB → CIE LAB (simplified, D65)
function rgbToLab(r, g, b) {
  // to linear
  const rl = lin(r / 255), gl = lin(g / 255), bl = lin(b / 255);
  // to XYZ (D65)
  let x = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl;
  let y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl;
  let z = 0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl;
  // normalise to D65 white
  x /= 0.95047; z /= 1.08883;
  const f = (t) => t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labDist(a, b) {
  const dL = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

// ── Sampling ────────────────────────────────────────────────────────────

let sampleCv = null;

/**
 * Get ImageData for the lip region from the source frame.
 * Caches a canvas to avoid repeated allocation.
 */
function getPixels(source, w, h) {
  if (!sampleCv) sampleCv = document.createElement('canvas');
  if (sampleCv.width !== w || sampleCv.height !== h) {
    sampleCv.width = w; sampleCv.height = h;
  }
  const ctx = sampleCv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function sampleLab(imgData, px, py) {
  const { data, width } = imgData;
  const x = Math.round(px), y = Math.round(py);
  if (x < 0 || x >= width || y < 0 || y >= imgData.height) return null;
  const i = (y * width + x) * 4;
  return rgbToLab(data[i], data[i + 1], data[i + 2]);
}

// Average LAB colour in a small radius around a point
function sampleArea(imgData, px, py, radius) {
  const { data, width, height } = imgData;
  let sumL = 0, sumA = 0, sumB = 0, count = 0;
  const r = Math.round(radius);
  const cx = Math.round(px), cy = Math.round(py);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const i = (y * width + x) * 4;
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      sumL += lab[0]; sumA += lab[1]; sumB += lab[2];
      count++;
    }
  }
  if (count === 0) return [50, 0, 0];
  return [sumL / count, sumA / count, sumB / count];
}

// ── Edge marching ───────────────────────────────────────────────────────

/**
 * From a landmark point, march outward (away from lip centroid) to find
 * where the colour transitions from lip to skin. Returns the refined
 * edge point in pixel coordinates.
 *
 * Strategy:
 *   1. Sample "lip colour" at the landmark (inside the lip)
 *   2. March outward in small steps
 *   3. At each step, compare to lip colour
 *   4. When delta exceeds threshold → that's the edge
 *   5. Binary-search between last two steps for sub-pixel precision
 */
/**
 * Compute outward normal for a point on a polygon.
 * prev/next are neighbour indices, cx/cy is interior centroid.
 */
function contourNormal(pts, i, cx, cy) {
  const prev = pts[(i - 1 + pts.length) % pts.length];
  const next = pts[(i + 1) % pts.length];
  // tangent along the contour
  let tx = next.x - prev.x, ty = next.y - prev.y;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl; ty /= tl;
  // normal (perpendicular) — pick the one pointing away from centroid
  let nx = -ty, ny = tx;
  const cur = pts[i];
  if ((cur.x + nx - cx) * nx + (cur.y + ny - cy) * ny < 0) { nx = -nx; ny = -ny; }
  return { x: nx, y: ny };
}

function marchToEdge(imgData, lmPx, lmPy, dirX, dirY, lipLab, searchPx) {
  const step = 0.75; // sub-pixel steps for precision
  const maxSteps = Math.round(searchPx / step);

  // Find max gradient (steepest colour change) along the march direction.
  // This is more robust than a fixed threshold — it finds where the
  // transition is sharpest, which is the true edge.
  let bestGrad = 0, bestT = 0;
  let prevD = 0;

  // Also track threshold-based fallback
  const skinLab = sampleLab(imgData, lmPx + dirX * searchPx * 2.0, lmPy + dirY * searchPx * 2.0);
  const maxDelta = skinLab ? labDist(lipLab, skinLab) : 25;
  const threshold = maxDelta * 0.40;

  for (let i = 1; i <= maxSteps; i++) {
    const t = i * step;
    const sx = lmPx + dirX * t;
    const sy = lmPy + dirY * t;
    const lab = sampleLab(imgData, sx, sy);
    if (!lab) break;
    const d = labDist(lipLab, lab);
    // gradient = change per step
    const grad = (d - prevD) / step;
    if (grad > bestGrad && d > threshold * 0.5) {
      bestGrad = grad;
      bestT = t - step * 0.5; // midpoint of steepest transition
    }
    prevD = d;
  }

  if (bestT > 0) {
    // Binary-search around the best gradient for sub-pixel edge
    let lo = Math.max(0, bestT - step * 2), hi = Math.min(searchPx, bestT + step * 2);
    for (let j = 0; j < 5; j++) {
      const mid = (lo + hi) / 2;
      const mx = lmPx + dirX * mid, my = lmPy + dirY * mid;
      const ml = sampleLab(imgData, mx, my);
      if (ml && labDist(lipLab, ml) > threshold) hi = mid; else lo = mid;
    }
    const finalT = (lo + hi) / 2;
    return { x: lmPx + dirX * finalT, y: lmPy + dirY * finalT };
  }
  return { x: lmPx, y: lmPy };
}

// ── Smoothing helpers ───────────────────────────────────────────────────

/** Clamp refined point so it can't jump more than maxPx from the landmark */
function clampDisplacement(refined, orig, maxPx) {
  const dx = refined.x - orig.x, dy = refined.y - orig.y;
  const d = Math.hypot(dx, dy);
  if (d <= maxPx) return refined;
  return { x: orig.x + dx / d * maxPx, y: orig.y + dy / d * maxPx };
}

/** Laplacian smoothing pass on a closed polygon (normalised coords) */
function smoothContour(pts, alpha) {
  const n = pts.length;
  return pts.map((p, i) => {
    const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    return {
      x: p.x + alpha * ((prev.x + next.x) * 0.5 - p.x),
      y: p.y + alpha * ((prev.y + next.y) * 0.5 - p.y),
    };
  });
}

/** Temporal EMA blend between previous and current contour */
let prevOuter = null, prevInner = null;
const EMA = 0.45; // lower = more smoothing (0.45 = blend 45% new + 55% old)

function temporalSmooth(cur, prev) {
  if (!prev || prev.length !== cur.length) return cur;
  return cur.map((p, i) => ({
    x: p.x * EMA + prev[i].x * (1 - EMA),
    y: p.y * EMA + prev[i].y * (1 - EMA),
  }));
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Detect the actual lip contour from pixel data.
 *
 * @param {CanvasImageSource} source  camera frame (video, canvas or image)
 * @param {number} w  frame width in pixels
 * @param {number} h  frame height in pixels
 * @param {Array} landmarks  MediaPipe 468+ landmarks (normalised 0..1)
 * @returns {{ outer: Array<{x,y}>, inner: Array<{x,y}>, lipLab: number[] }}
 *   Refined contour points in normalised coordinates (0..1).
 */
export function detectLipEdge(source, w, h, landmarks) {
  const imgData = getPixels(source, w, h);

  // Lip centroid (in pixels)
  let cx = 0, cy = 0;
  for (const idx of LIPS_OUTER) {
    cx += landmarks[idx].x * w;
    cy += landmarks[idx].y * h;
  }
  cx /= LIPS_OUTER.length;
  cy /= LIPS_OUTER.length;

  // Sample lip colour from multiple interior points for robustness
  const sampleR = Math.max(3, w * 0.008);
  // Sample at centroid + 4 offset points (upper/lower/left/right of centroid, inside the lip)
  const lipW = Math.abs(landmarks[291].x - landmarks[61].x) * w;
  const lipH = Math.abs(landmarks[0].y - landmarks[17].y) * h;
  const off = Math.max(3, lipW * 0.08);
  const samples = [
    sampleArea(imgData, cx, cy, sampleR),
    sampleArea(imgData, cx - off, cy, sampleR),
    sampleArea(imgData, cx + off, cy, sampleR),
    sampleArea(imgData, cx, cy - off * 0.5, sampleR),
    sampleArea(imgData, cx, cy + off * 0.5, sampleR),
  ];
  // Average all samples
  const lipLab = [0, 0, 0];
  for (const s of samples) { lipLab[0] += s[0]; lipLab[1] += s[1]; lipLab[2] += s[2]; }
  lipLab[0] /= samples.length; lipLab[1] /= samples.length; lipLab[2] /= samples.length;

  // Search radius: bigger for better detection
  const searchPx = Math.max(6, lipW * 0.20);

  // Build pixel-space outer contour for normal computation
  const outerPts = LIPS_OUTER.map(idx => ({
    x: landmarks[idx].x * w, y: landmarks[idx].y * h
  }));

  // How far to step INSIDE the lip before marching outward
  const insetPx = Math.max(4, lipW * 0.10);
  // Max displacement from original landmark
  const maxDisp = searchPx * 0.6;

  // Refine each outer landmark: start INSIDE lip, march outward
  let outer = LIPS_OUTER.map((idx, i) => {
    const lx = outerPts[i].x, ly = outerPts[i].y;
    const n = contourNormal(outerPts, i, cx, cy);
    // Start from inside the lip (offset inward from landmark)
    const startX = lx - n.x * insetPx;
    const startY = ly - n.y * insetPx;
    const raw = marchToEdge(imgData, startX, startY, n.x, n.y, lipLab, searchPx + insetPx);
    const clamped = clampDisplacement(raw, { x: lx, y: ly }, maxDisp);
    return { x: clamped.x / w, y: clamped.y / h };
  });
  // Spatial smoothing (2 passes)
  outer = smoothContour(outer, 0.35);
  outer = smoothContour(outer, 0.25);
  // Temporal smoothing
  outer = temporalSmooth(outer, prevOuter);
  prevOuter = outer;

  // Build pixel-space inner contour
  const innerPts = LIPS_INNER.map(idx => ({
    x: landmarks[idx].x * w, y: landmarks[idx].y * h
  }));

  // Inner centroid (mouth opening centre)
  let icx = 0, icy = 0;
  for (const p of innerPts) { icx += p.x; icy += p.y; }
  icx /= innerPts.length; icy /= innerPts.length;

  // Refine inner landmarks — start inside lip, march toward mouth opening
  let inner = LIPS_INNER.map((idx, i) => {
    const lx = innerPts[i].x, ly = innerPts[i].y;
    const n = contourNormal(innerPts, i, cx, cy);
    // Inward direction (toward mouth opening)
    const dx = -n.x, dy = -n.y;
    // Start from inside the lip (offset outward from inner landmark, toward lip body)
    const startX = lx + n.x * insetPx * 0.6;
    const startY = ly + n.y * insetPx * 0.6;
    const raw = marchToEdge(imgData, startX, startY, dx, dy, lipLab, searchPx * 0.6 + insetPx * 0.6);
    const clamped = clampDisplacement(raw, { x: lx, y: ly }, maxDisp * 0.7);
    return { x: clamped.x / w, y: clamped.y / h };
  });
  inner = smoothContour(inner, 0.35);
  inner = smoothContour(inner, 0.25);
  inner = temporalSmooth(inner, prevInner);
  prevInner = inner;

  return { outer, inner, lipLab };
}

// ── Debug drawing ───────────────────────────────────────────────────────

/**
 * Draw the detected lip contour as a green polyline over the frame.
 * Call after detectLipEdge to visualise the refinement.
 */
export function drawLipEdgeDebug(ctx, w, h, edgeResult) {
  if (!edgeResult) return;
  const { outer, inner } = edgeResult;
  ctx.save();

  // Outer contour — thin green line
  ctx.strokeStyle = '#00ff44';
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < outer.length; i++) {
    const p = outer[i];
    if (i === 0) ctx.moveTo(p.x * w, p.y * h);
    else ctx.lineTo(p.x * w, p.y * h);
  }
  ctx.closePath();
  ctx.stroke();

  // Inner contour — thin lighter green line
  ctx.strokeStyle = '#44ff88';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < inner.length; i++) {
    const p = inner[i];
    if (i === 0) ctx.moveTo(p.x * w, p.y * h);
    else ctx.lineTo(p.x * w, p.y * h);
  }
  ctx.closePath();
  ctx.stroke();

  ctx.restore();
}