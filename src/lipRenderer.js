import { LIPS_OUTER, LIPS_INNER, LOWER_LIP } from './lips.js';
import { EYE_R_LASH, EYE_L_LASH, EYE_R_V, EYE_L_V, EYE_LIFT,
         EYE_R_FULL, EYE_L_FULL, FACE_OVAL,
         CHEEK_R, CHEEK_L, FACE_SIDE_L, FACE_SIDE_R } from './regions.js';

// Masks are built at reduced resolution (cheap blur/fill) and scaled up when drawn
// — the GPU and Canvas both upsample smoothly, so the edge quality is unaffected
// but per-frame cost drops ~4×.
const MASK_SCALE = 0.5;
let MW = 0, MH = 0;

// Reused offscreen canvases (avoid per-frame allocation).
let maskCv, eyeMaskCv, faceMaskCv, lashMaskCv, blushMaskCv, colorCv, specCv, refineCv, lumaCv;
function ensure(w, h) {
  if (!maskCv) {
    maskCv = document.createElement('canvas'); eyeMaskCv = document.createElement('canvas');
    faceMaskCv = document.createElement('canvas'); lashMaskCv = document.createElement('canvas');
    blushMaskCv = document.createElement('canvas');
    colorCv = document.createElement('canvas'); specCv = document.createElement('canvas');
    refineCv = document.createElement('canvas'); lumaCv = document.createElement('canvas');
  }
  MW = Math.max(2, Math.round(w * MASK_SCALE));
  MH = Math.max(2, Math.round(h * MASK_SCALE));
  for (const c of [maskCv, eyeMaskCv, faceMaskCv, lashMaskCv, blushMaskCv, refineCv]) { if (c.width !== MW || c.height !== MH) { c.width = MW; c.height = MH; } }
  for (const c of [colorCv, specCv, lumaCv]) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }
}

function fillPoly(ctx, landmarks, indices, w, h) {
  ctx.beginPath();
  indices.forEach((i, k) => {
    const x = landmarks[i].x * w, y = landmarks[i].y * h;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
}

// Smooth closed outline through the landmark points (Catmull-Rom -> Bézier).
// Straight lineTo between sparse lip points gives a jagged shape whose feather
// bleeds onto skin ("smeared"); a smooth curve hugs the real lip edge.
function tracePath(ctx, landmarks, indices, w, h) {
  const pts = indices.map((i) => [landmarks[i].x * w, landmarks[i].y * h]);
  const n = pts.length;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
  }
  ctx.closePath();
}

/**
 * Build the lip mask into the shared maskCv and return it (white = lips).
 * Landmarks are the base; an ONNX segmentation mask in opts.overrideMask only
 * refines the edge, with a floor so weak segmentation can't erase the lips.
 */
export function buildLipMask(w, h, landmarks, opts = {}) {
  ensure(w, h);
  const blur = Math.max(1, MW * 0.0035);
  const m = maskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  m.fillStyle = '#fff';
  m.filter = `blur(${blur}px)`;
  tracePath(m, landmarks, LIPS_OUTER, MW, MH);
  m.fill();
  m.filter = 'none';
  const gap = Math.abs(landmarks[14].y - landmarks[13].y);
  const lipW = Math.abs(landmarks[291].x - landmarks[61].x);
  if (lipW > 0 && gap / lipW > 0.08) {
    m.globalCompositeOperation = 'destination-out';
    tracePath(m, landmarks, LIPS_INNER, MW, MH);
    m.fill();
    m.globalCompositeOperation = 'source-over';
  }
  if (opts.overrideMask) {
    const SEG_FLOOR = 0.45; // 0 = seg fully controls the edge, 1 = seg ignored
    const rf = refineCv.getContext('2d');
    rf.setTransform(1, 0, 0, 1, 0, 0);
    rf.clearRect(0, 0, MW, MH);
    rf.globalAlpha = SEG_FLOOR; rf.fillStyle = '#fff'; rf.fillRect(0, 0, MW, MH);
    rf.globalAlpha = 1; rf.drawImage(opts.overrideMask, 0, 0, MW, MH);
    m.globalCompositeOperation = 'destination-in';
    m.drawImage(refineCv, 0, 0, MW, MH);
    m.globalCompositeOperation = 'source-over';
  }
  return maskCv;
}

// Build an eyeshadow mask (both eyes) into eyeMaskCv: a soft band above each
// upper lash line, offset toward the brow by a fraction of eye height.
export function buildEyeMask(w, h, landmarks) {
  ensure(w, h);
  const m = eyeMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  m.fillStyle = '#fff';
  m.filter = `blur(${Math.max(2, MW * 0.009)}px)`; // eyeshadow is diffuse
  for (const [lash, vref] of [[EYE_R_LASH, EYE_R_V], [EYE_L_LASH, EYE_L_V]]) {
    const eyeH = Math.abs(landmarks[vref[0]].y - landmarks[vref[1]].y) * MH;
    const lift = eyeH * EYE_LIFT;
    const lo = lash.map((i) => [landmarks[i].x * MW, landmarks[i].y * MH]);
    const hi = lo.map(([x, y]) => [x, y - lift]); // upward toward brow
    const poly = lo.concat(hi.reverse());
    m.beginPath();
    m.moveTo(poly[0][0], poly[0][1]);
    for (let k = 1; k < poly.length; k++) m.lineTo(poly[k][0], poly[k][1]);
    m.closePath();
    m.fill();
  }
  m.filter = 'none';
  return eyeMaskCv;
}

// Foundation mask: the face oval minus the eyes and lips (so they stay clean).
export function buildFaceMask(w, h, landmarks) {
  ensure(w, h);
  const m = faceMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  m.globalCompositeOperation = 'source-over';
  m.fillStyle = '#fff';
  m.filter = `blur(${Math.max(2, MW * 0.012)}px)`;
  fillPoly(m, landmarks, FACE_OVAL, MW, MH);
  m.filter = 'none';
  m.globalCompositeOperation = 'destination-out';
  fillPoly(m, landmarks, EYE_R_FULL, MW, MH);
  fillPoly(m, landmarks, EYE_L_FULL, MW, MH);
  fillPoly(m, landmarks, LIPS_OUTER, MW, MH);
  m.globalCompositeOperation = 'source-over';
  return faceMaskCv;
}

// Lash mask: a thin line along the upper lash line plus a few fine flicks at the
// outer corner — delicate, like real lashes (not a thick liner).
export function buildLashMask(w, h, landmarks) {
  ensure(w, h);
  const m = lashMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  m.strokeStyle = '#fff';
  m.lineCap = 'round';
  m.lineJoin = 'round';
  m.filter = `blur(${Math.max(0.3, MW * 0.0006)}px)`;
  const thin = Math.max(0.8, MH * 0.004);

  for (const [lash, vref] of [[EYE_R_LASH, EYE_R_V], [EYE_L_LASH, EYE_L_V]]) {
    const pts = lash.map((i) => [landmarks[i].x * MW, landmarks[i].y * MH]);
    const eyeH = Math.abs(landmarks[vref[0]].y - landmarks[vref[1]].y) * MH;
    // pts[0] = outer corner, pts[last] = inner corner
    const outerDir = Math.sign(pts[0][0] - pts[pts.length - 1][0]) || 1;

    // 1. thin upper lash line
    m.lineWidth = thin;
    m.beginPath();
    pts.forEach(([x, y], k) => (k === 0 ? m.moveTo(x, y) : m.lineTo(x, y)));
    m.stroke();

    // 2. individual lash flicks along the outer half, up-and-out
    m.lineWidth = Math.max(0.7, thin * 0.9);
    const len = eyeH * 0.35;
    for (let k = 0; k < pts.length; k++) {
      const t = k / (pts.length - 1);
      if (t > 0.55) continue; // only outer ~half gets visible lashes
      const grow = 1 - t / 0.55;          // longest at the outer corner
      const [x, y] = pts[k];
      m.beginPath();
      m.moveTo(x, y);
      m.lineTo(x + outerDir * len * 0.5 * grow, y - len * grow);
      m.stroke();
    }
  }
  m.filter = 'none';
  return lashMaskCv;
}

// Blush mask: two soft radial blobs on the cheek apples.
export function buildBlushMask(w, h, landmarks) {
  ensure(w, h);
  const m = blushMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  const faceW = Math.abs(landmarks[FACE_SIDE_R].x - landmarks[FACE_SIDE_L].x) * MW;
  const r = faceW * 0.17;
  for (const ci of [CHEEK_R, CHEEK_L]) {
    const cx = landmarks[ci].x * MW, cy = landmarks[ci].y * MH;
    const g = m.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    m.fillStyle = g;
    m.beginPath();
    m.arc(cx, cy, r, 0, Math.PI * 2);
    m.fill();
  }
  return blushMaskCv;
}

// Shared compositor: recolour whatever `maskSrc` covers, preserving the region's
// own luminance/texture ('color' blend). Used by both lips and eyeshadow.
// opts: { color, intensity, finish?, lightResponse?, pigment?, gloss? }
function compositeRegion(ctx, w, h, maskSrc, opts) {
  const { color, intensity } = opts;
  const finish = opts.finish ?? 'satin';
  const lightResponse = opts.lightResponse ?? 0.5;
  const pigment = opts.pigment ?? 0.12;

  if (lightResponse > 0) {
    const lum = lumaCv.getContext('2d');
    lum.setTransform(1, 0, 0, 1, 0, 0);
    lum.clearRect(0, 0, w, h);
    lum.filter = 'grayscale(1) contrast(1.25)';
    lum.drawImage(ctx.canvas, 0, 0, w, h);
    lum.filter = 'none';
  }

  // shade shaped by the mask
  const c = colorCv.getContext('2d');
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, w, h);
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(maskSrc, 0, 0, w, h);
  c.globalCompositeOperation = 'source-over';

  ctx.save();
  ctx.globalAlpha = intensity;
  ctx.globalCompositeOperation = 'color';
  ctx.drawImage(colorCv, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = intensity * pigment;
  ctx.drawImage(colorCv, 0, 0);
  if (finish === 'satin') {
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = intensity * 0.5;
    ctx.drawImage(colorCv, 0, 0);
  }
  ctx.restore();

  if (lightResponse > 0) {
    const lum = lumaCv.getContext('2d');
    lum.globalCompositeOperation = 'destination-in';
    lum.drawImage(maskSrc, 0, 0, w, h);
    lum.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = lightResponse;
    ctx.drawImage(lumaCv, 0, 0, w, h);
    ctx.restore();
  }
}

/**
 * Recolour the lips in-place on `ctx` (which already holds the current frame).
 * opts: { color, intensity, finish:'matte'|'satin'|'gloss', lightResponse?, overrideMask? }
 */
export function renderLips(ctx, w, h, landmarks, opts) {
  if (!landmarks || landmarks.length < 468) return;
  ensure(w, h);
  buildLipMask(w, h, landmarks, opts);
  compositeRegion(ctx, w, h, maskCv, opts);

  // gloss: specular highlight on the lower lip, clipped to the mask
  if (opts.finish === 'gloss') {
    let sx = 0, sy = 0, n = 0;
    for (const i of LOWER_LIP) { sx += landmarks[i].x; sy += landmarks[i].y; n++; }
    const cx = (sx / n) * w, cy = (sy / n) * h - h * 0.012;
    const r = w * 0.05;
    const s = specCv.getContext('2d');
    s.clearRect(0, 0, w, h);
    const g = s.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    s.fillStyle = g; s.fillRect(0, 0, w, h);
    s.globalCompositeOperation = 'destination-in';
    s.drawImage(maskCv, 0, 0, w, h);
    s.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.75;
    ctx.drawImage(specCv, 0, 0);
    ctx.restore();
  }
}

/** Recolour the eyelids (eyeshadow). opts: { color, intensity, lightResponse? } */
export function renderEyes(ctx, w, h, landmarks, opts) {
  if (!landmarks || landmarks.length < 468) return;
  ensure(w, h);
  buildEyeMask(w, h, landmarks);
  compositeRegion(ctx, w, h, eyeMaskCv, { ...opts, finish: 'satin', pigment: 0.2 });
}

// Darkening composite for lashes: paint a dark colour along the mask (not a
// luminance-preserving recolour — lashes should get darker, not tinted).
function compositeDark(ctx, w, h, maskSrc, color, intensity) {
  const c = colorCv.getContext('2d');
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, w, h);
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(maskSrc, 0, 0, w, h);
  c.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalAlpha = intensity;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(colorCv, 0, 0);
  ctx.restore();
}

/**
 * Full makeup pass (Canvas). Layer order: foundation, hair, eyeshadow, lashes, lips.
 * opts: { foundation, hair, eyes, lashes, lips } — each region optional.
 *   hair: { color, intensity, mask } (mask = segmentation canvas, full frame)
 *   lashes: { intensity } (colour fixed dark)
 */
export function renderMakeup(ctx, w, h, landmarks, opts) {
  if (!landmarks || landmarks.length < 468) return;
  if (opts.foundation) {
    buildFaceMask(w, h, landmarks);
    compositeRegion(ctx, w, h, faceMaskCv, { ...opts.foundation, finish: 'none', pigment: 0.1, lightResponse: 0 });
  }
  if (opts.blush) {
    buildBlushMask(w, h, landmarks);
    compositeRegion(ctx, w, h, blushMaskCv, { ...opts.blush, finish: 'none', pigment: 0.15 });
  }
  if (opts.hair && opts.hair.mask) {
    compositeRegion(ctx, w, h, opts.hair.mask, { ...opts.hair, finish: 'none', pigment: 0.15 });
  }
  if (opts.eyes) renderEyes(ctx, w, h, landmarks, opts.eyes);
  if (opts.lashes) {
    buildLashMask(w, h, landmarks);
    compositeDark(ctx, w, h, lashMaskCv, '#000000', opts.lashes.intensity ?? 0.8);
  }
  if (opts.lips) renderLips(ctx, w, h, landmarks, opts.lips);
}

// ---- Debug overlay: tint the ONNX segmentation mask so you can see what it predicts ----
let dbgCv;
export function drawSegMask(ctx, w, h, mask, alpha = 0.5) {
  if (!mask) return;
  if (!dbgCv) dbgCv = document.createElement('canvas');
  if (dbgCv.width !== w || dbgCv.height !== h) { dbgCv.width = w; dbgCv.height = h; }
  const t = dbgCv.getContext('2d');
  t.clearRect(0, 0, w, h);
  t.drawImage(mask, 0, 0, w, h);      // white where lips, alpha = confidence
  t.globalCompositeOperation = 'source-in';
  t.fillStyle = '#00e5a0';            // recolour the mask green
  t.fillRect(0, 0, w, h);
  t.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(dbgCv, 0, 0, w, h);
  ctx.restore();
}

// ---- Debug overlay: draw the raw MediaPipe landmarks so you can see tracking ----
const LIP_SET = new Set([...LIPS_OUTER, ...LIPS_INNER]);

export function drawLandmarks(ctx, w, h, landmarks) {
  if (!landmarks) return;
  ctx.save();
  // all mesh points (faint)
  ctx.fillStyle = 'rgba(110,210,255,0.5)';
  const sz = Math.max(1, w * 0.0016);
  for (let i = 0; i < landmarks.length; i++) {
    if (LIP_SET.has(i)) continue;
    const p = landmarks[i];
    ctx.fillRect(p.x * w - sz / 2, p.y * h - sz / 2, sz, sz);
  }
  // lip outline the mask is built from
  ctx.strokeStyle = 'rgba(255,90,160,0.95)';
  ctx.lineWidth = Math.max(1, w * 0.002);
  tracePath(ctx, landmarks, LIPS_OUTER, w, h); ctx.stroke();
  tracePath(ctx, landmarks, LIPS_INNER, w, h); ctx.stroke();
  // lip points (bigger)
  ctx.fillStyle = '#ff5aa0';
  const lr = Math.max(1.5, w * 0.004);
  for (const i of LIP_SET) {
    const p = landmarks[i];
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, lr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}