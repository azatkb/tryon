/**
 * lipContourRefine.js — refine MediaPipe lip contour using sub-pixel edge detection.
 *
 * Instead of just finding the gradient peak, we find the TRANSITION ZONE
 * (where gradient is elevated) and locate the actual boundary within it
 * by finding where brightness crosses the midpoint between skin and lip.
 *
 * Pipeline per point:
 *  1. Walk along outward normal, collect brightness + gradient samples
 *  2. Find the gradient zone (contiguous region above threshold)
 *  3. Measure skin brightness (before zone) and lip brightness (after zone)
 *  4. Find where brightness = (skin + lip) / 2 — that's the true edge
 *  5. Sub-pixel interpolation between samples for precision
 *
 * Smoothing:
 *  - Temporal: EMA blending with previous frame (adaptive)
 *  - Spatial: Laplacian pass along contour to remove jaggedness
 */

import { LIPS_OUTER } from './lips.js';

// Upper lip = indices 0..10, lower = 11..18
const UPPER_COUNT = 11;

// ── Image sampling ───────────────────────────────────────────────────────

/** Fast luminance from RGBA. */
function lumRGBA(r, g, b) {
  return (r * 77 + g * 150 + b * 29) >> 8;
}

/** Sample brightness at (px, py) from ImageData, bilinear interpolation. */
function sampleBrightness(data, w, h, px, py) {
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = px - x0, fy = py - y0;
  const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0);
  const d = data.data;
  const i00 = (cy0 * w + cx0) * 4;
  const i10 = (cy0 * w + x1) * 4;
  const i01 = (y1 * w + cx0) * 4;
  const i11 = (y1 * w + x1) * 4;
  const l00 = lumRGBA(d[i00], d[i00 + 1], d[i00 + 2]);
  const l10 = lumRGBA(d[i10], d[i10 + 1], d[i10 + 2]);
  const l01 = lumRGBA(d[i01], d[i01 + 1], d[i01 + 2]);
  const l11 = lumRGBA(d[i11], d[i11 + 1], d[i11 + 2]);
  return l00 * (1 - fx) * (1 - fy) + l10 * fx * (1 - fy) +
         l01 * (1 - fx) * fy       + l11 * fx * fy;
}

// ── Sobel edge detection ─────────────────────────────────────────────────

/**
 * Build grayscale + Sobel gradient magnitude map for a sub-region.
 * Also stores the blurred grayscale for brightness lookups.
 */
function sobelRegion(imgData, w, h, bbox) {
  const { x0, y0, x1, y1 } = bbox;
  const rw = x1 - x0;
  const rh = y1 - y0;
  const src = imgData.data;

  const pw = rw + 2, ph = rh + 2;
  const gray = new Float32Array(pw * ph);
  for (let ry = 0; ry < ph; ry++) {
    const sy = Math.max(0, Math.min(h - 1, y0 - 1 + ry));
    for (let rx = 0; rx < pw; rx++) {
      const sx = Math.max(0, Math.min(w - 1, x0 - 1 + rx));
      const off = (sy * w + sx) * 4;
      gray[ry * pw + rx] = lumRGBA(src[off], src[off + 1], src[off + 2]);
    }
  }

  // 3x3 Gaussian blur
  const blurred = new Float32Array(pw * ph);
  for (let ry = 1; ry < ph - 1; ry++) {
    for (let rx = 1; rx < pw - 1; rx++) {
      const i = ry * pw + rx;
      blurred[i] = (
        gray[i - pw - 1] + gray[i - pw] * 2 + gray[i - pw + 1] +
        gray[i - 1] * 2  + gray[i] * 4      + gray[i + 1] * 2 +
        gray[i + pw - 1] + gray[i + pw] * 2 + gray[i + pw + 1]
      ) / 16;
    }
  }

  // Sobel 3x3 → gradient magnitude
  const grad = new Float32Array(rw * rh);
  for (let ry = 0; ry < rh; ry++) {
    for (let rx = 0; rx < rw; rx++) {
      const i = (ry + 1) * pw + (rx + 1);
      const gx = -blurred[i - pw - 1] + blurred[i - pw + 1]
               - blurred[i - 1] * 2   + blurred[i + 1] * 2
               - blurred[i + pw - 1]  + blurred[i + pw + 1];
      const gy = -blurred[i - pw - 1] - blurred[i - pw] * 2 - blurred[i - pw + 1]
               + blurred[i + pw - 1]  + blurred[i + pw] * 2 + blurred[i + pw + 1];
      grad[ry * rw + rx] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  return { grad, blurred, pw, rw, rh, ox: x0, oy: y0 };
}

function sampleGrad(sob, px, py) {
  const lx = Math.round(px - sob.ox);
  const ly = Math.round(py - sob.oy);
  if (lx < 0 || lx >= sob.rw || ly < 0 || ly >= sob.rh) return 0;
  return sob.grad[ly * sob.rw + lx];
}

// ── spatial smoothing ────────────────────────────────────────────────────

function spatialSmooth(pts, strength = 0.3) {
  const out = pts.map(p => ({ x: p.x, y: p.y }));
  // Smooth upper lip (pin corners 0 and 10)
  for (let i = 1; i < UPPER_COUNT - 1; i++) {
    const prev = pts[i - 1], next = pts[i + 1], cur = pts[i];
    out[i].x = cur.x + ((prev.x + next.x) / 2 - cur.x) * strength;
    out[i].y = cur.y + ((prev.y + next.y) / 2 - cur.y) * strength;
  }
  // Smooth lower lip (pin first and last which connect to corners)
  const N = pts.length;
  for (let i = UPPER_COUNT + 1; i < N - 1; i++) {
    const prev = pts[i - 1], next = pts[i + 1], cur = pts[i];
    out[i].x = cur.x + ((prev.x + next.x) / 2 - cur.x) * strength;
    out[i].y = cur.y + ((prev.y + next.y) / 2 - cur.y) * strength;
  }
  return out;
}

// ── per-point edge finding ───────────────────────────────────────────────

/**
 * Find the true lip boundary along a ray by locating the transition zone
 * and finding the brightness crossover within it.
 *
 * @param {ImageData} imgData - source frame
 * @param {object} sob - Sobel region data
 * @param {number} w, h - frame dimensions
 * @param {number} px, py - start point (MP landmark in pixels)
 * @param {number} nx, ny - outward normal (unit vector, pointing away from lip center)
 * @param {number} searchPx - how far to walk
 * @returns {{ dist: number, confidence: number }} — distance along normal, 0 = keep MP point
 */
function findEdgeAlongRay(imgData, sob, w, h, px, py, nx, ny, searchPx, gradThresh = 18, brightThresh = 8) {
  const STEP = 0.5;
  const GRAD_THRESH = gradThresh;

  // Collect samples along the ray: d = distance from MP point
  // Negative d = outward (skin side), positive d = inward (lip side)
  const samples = [];
  for (let d = -searchPx; d <= searchPx; d += STEP) {
    const sx = px + nx * d;
    const sy = py + ny * d;
    const grad = sampleGrad(sob, sx, sy);
    const bright = sampleBrightness(imgData, w, h, sx, sy);
    samples.push({ d, grad, bright });
  }

  if (samples.length < 4) return { dist: 0, confidence: 0 };

  // ── Strategy 1: find gradient peak (simple, robust) ──────────────────
  // The peak gradient is always at the steepest brightness change — the
  // centre of the skin→lip transition. This alone is a useful refinement.
  let peakI = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].grad > samples[peakI].grad) peakI = i;
  }

  if (samples[peakI].grad < GRAD_THRESH) {
    // No significant edge at all — keep the MP landmark
    return { dist: 0, confidence: 0 };
  }

  // ── Strategy 2: find transition zone & brightness crossover ──────────
  // Walk outward from peak to find where the gradient drops below threshold
  // on each side — that defines the transition zone.
  let zStart = peakI, zEnd = peakI;
  while (zStart > 0 && samples[zStart - 1].grad >= GRAD_THRESH) zStart--;
  while (zEnd < samples.length - 1 && samples[zEnd + 1].grad >= GRAD_THRESH) zEnd++;

  // Measure skin brightness (before zone) and lip brightness (after zone)
  let skinSum = 0, skinN = 0;
  for (let i = Math.max(0, zStart - 4); i < zStart; i++) {
    skinSum += samples[i].bright; skinN++;
  }
  if (skinN === 0) { skinSum = samples[zStart].bright; skinN = 1; }
  const skinB = skinSum / skinN;

  let lipSum = 0, lipN = 0;
  for (let i = zEnd + 1; i <= Math.min(samples.length - 1, zEnd + 4); i++) {
    lipSum += samples[i].bright; lipN++;
  }
  if (lipN === 0) { lipSum = samples[zEnd].bright; lipN = 1; }
  const lipB = lipSum / lipN;

  const brightDiff = Math.abs(skinB - lipB);
  const peakGrad = samples[peakI].grad;

  // If brightness difference is large enough, find the crossover for
  // sub-pixel precision. Otherwise just use gradient peak.
  if (brightDiff >= brightThresh) {
    // Threshold weighted toward skin side — the visible lip edge is at
    // the ONSET of the transition, not the centre
    const threshold = skinB * 0.55 + lipB * 0.45;
    const skinBrighter = skinB > lipB;

    // Search within the zone for the brightness crossover
    for (let i = zStart; i < zEnd; i++) {
      const b0 = samples[i].bright, b1 = samples[i + 1].bright;
      const crosses = skinBrighter
        ? (b0 >= threshold && b1 < threshold)
        : (b0 <= threshold && b1 > threshold);
      if (crosses) {
        const range = Math.abs(b1 - b0);
        const t = range > 0.1 ? Math.abs(threshold - b0) / range : 0.5;
        const conf = Math.min(1, (peakGrad / 30) * (brightDiff / 15));
        return { dist: samples[i].d + t * STEP, confidence: conf };
      }
    }
  }

  // Fallback: use gradient peak position, lower confidence
  return { dist: samples[peakI].d, confidence: Math.min(1, peakGrad / 40) };
}

// ── main ─────────────────────────────────────────────────────────────────

/**
 * @param {ImageData} imageData
 * @param {Array} landmarks — MediaPipe normalised landmarks
 * @param {number} w — frame width
 * @param {number} h — frame height
 * @param {object} [opts]
 * @param {number}  [opts.searchPx=8]
 * @param {number}  [opts.maxShift=5]
 * @param {number}  [opts.margin=20]
 * @param {Array}   [opts.frameBuffer] — ring buffer array (mutated), pass same array each frame
 * @param {number}  [opts.bufferSize=3] — how many frames to average
 * @param {number}  [opts.spatialStr=0.4]
 */
export function refineLipContour(imageData, landmarks, w, h, opts = {}) {
  const {
    searchPx = 6, maxShift = 3, margin = 20,
    frameBuffer = null, bufferSize = 3, spatialStr = 0.4,
  } = opts;
  const N = LIPS_OUTER.length;

  const pts = LIPS_OUTER.map(i => ({
    x: landmarks[i].x * w,
    y: landmarks[i].y * h,
  }));

  // Bounding box + margin
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bbox = {
    x0: Math.max(0, Math.floor(minX - margin)),
    y0: Math.max(0, Math.floor(minY - margin)),
    x1: Math.min(w, Math.ceil(maxX + margin)),
    y1: Math.min(h, Math.ceil(maxY + margin)),
  };

  const sob = sobelRegion(imageData, w, h, bbox);

  // Midline between lip corners
  const cornerL = pts[0];
  const cornerR = pts[UPPER_COUNT - 1];
  function midlineY(x) {
    if (Math.abs(cornerR.x - cornerL.x) < 1) return (cornerL.y + cornerR.y) / 2;
    const t = (x - cornerL.x) / (cornerR.x - cornerL.x);
    return cornerL.y + t * (cornerR.y - cornerL.y);
  }

  // Centroid for normal direction
  const cx = pts.reduce((s, p) => s + p.x, 0) / N;
  const cy = pts.reduce((s, p) => s + p.y, 0) / N;

  const raw = [];

  for (let i = 0; i < N; i++) {
    const isUpper = i < UPPER_COUNT;
    const prev = pts[(i - 1 + N) % N];
    const next = pts[(i + 1) % N];
    const p = pts[i];

    // Outward normal
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const tLen = Math.sqrt(tx * tx + ty * ty) || 1;
    tx /= tLen; ty /= tLen;
    let nx = -ty, ny = tx;
    if (nx * (cx - p.x) + ny * (cy - p.y) > 0) { nx = -nx; ny = -ny; }

    // Find the true edge using transition zone analysis
    // Lower lip has softer skin→lip transition — use lower thresholds
    const { dist, confidence } = findEdgeAlongRay(
      imageData, sob, w, h, p.x, p.y, nx, ny, searchPx,
      isUpper ? 18 : 10,  // gradThresh: stricter for upper, looser for lower
      isUpper ? 8  : 4,   // brightThresh: same idea
    );

    let rx = p.x, ry = p.y;

    // Lower lip needs lower confidence to accept — the edge is subtler
    const confThresh = isUpper ? 0.3 : 0.15;
    if (confidence > confThresh) {
      rx = p.x + nx * dist;
      ry = p.y + ny * dist;

      // Constraint: max displacement
      const dx = rx - p.x, dy = ry - p.y;
      const dd = Math.sqrt(dx * dx + dy * dy);
      if (dd > maxShift) {
        rx = p.x + dx * (maxShift / dd);
        ry = p.y + dy * (maxShift / dd);
      }

      // Constraint: don't cross midline
      const midY = midlineY(rx);
      if (isUpper && ry > midY) ry = midY;
      if (!isUpper && ry < midY) ry = midY;
    }

    raw.push({ x: rx, y: ry, confidence });
  }

  // ── Temporal smoothing: ring buffer of last N frames, median filter ────
  // Median kills outliers much better than EMA — no drift, no sausaging.
  let temporalBlended = raw;
  if (frameBuffer) {
    // Push current raw frame into ring buffer
    frameBuffer.push(raw.map(p => ({ x: p.x, y: p.y })));
    // Keep only last `bufferSize` frames
    while (frameBuffer.length > bufferSize) frameBuffer.shift();

    if (frameBuffer.length >= 2) {
      // Per-point median across buffered frames
      temporalBlended = raw.map((_, i) => {
        const xs = frameBuffer.map(f => f[i].x).sort((a, b) => a - b);
        const ys = frameBuffer.map(f => f[i].y).sort((a, b) => a - b);
        const mid = Math.floor(xs.length / 2);
        // True median for odd count, average of middle two for even
        const mx = xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
        const my = ys.length % 2 === 1 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2;
        return { x: mx, y: my };
      });
    }
  }

  // ── Spatial smoothing (Laplacian) ──────────────────────────────────────
  let result = temporalBlended;
  if (spatialStr > 0) {
    result = spatialSmooth(temporalBlended, spatialStr);
  }

  return result.map(p => ({ x: p.x, y: p.y }));
}

/**
 * Draw the refined contour for debugging.
 */
export function drawRefinedContour(ctx, points, { color = '#0f0', lineWidth = 1.5, dots = true } = {}) {
  if (!points || points.length < 3) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.stroke();
  if (dots) {
    ctx.fillStyle = color;
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}