import { LIPS_OUTER, LIPS_INNER, LOWER_LIP } from './lips.js';

// Reused offscreen canvases (avoid per-frame allocation).
let maskCv, colorCv, specCv;
function ensure(w, h) {
  if (!maskCv) { maskCv = document.createElement('canvas'); colorCv = document.createElement('canvas'); specCv = document.createElement('canvas'); }
  for (const c of [maskCv, colorCv, specCv]) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }
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
 * Recolour the lips in-place on `ctx`, which already holds the current frame.
 * Keeps the lips' own luminance/texture via the 'color' blend mode (hue+sat from
 * the shade, lightness from the real lips) — this is what stops it looking like a flat filter.
 *
 * opts: { color:'#rrggbb', intensity:0..1, finish:'matte'|'satin'|'gloss' }
 */
export function renderLips(ctx, w, h, landmarks, opts) {
  const { color, intensity, finish } = opts;
  if (!landmarks || landmarks.length < 468) return;
  ensure(w, h);

  const blur = Math.max(1.5, w * 0.0035); // tighter edge — less bleed onto skin

  // --- 1. feathered lip mask (outer filled, inner mouth opening cut out) ---
  const m = maskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, w, h);
  m.fillStyle = '#fff';
  m.filter = `blur(${blur}px)`;
  tracePath(m, landmarks, LIPS_OUTER, w, h);
  m.fill();
  m.filter = 'none';
  m.globalCompositeOperation = 'destination-out';
  tracePath(m, landmarks, LIPS_INNER, w, h);
  m.fill();
  m.globalCompositeOperation = 'source-over';

  // --- 2. shade shaped by the mask ---
  const c = colorCv.getContext('2d');
  c.clearRect(0, 0, w, h);
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(maskCv, 0, 0);
  c.globalCompositeOperation = 'source-over';

  // --- 3. composite onto the frame, preserving lip texture ---
  ctx.save();
  ctx.globalAlpha = intensity;
  ctx.globalCompositeOperation = 'color';      // hue+sat from shade, lightness kept
  ctx.drawImage(colorCv, 0, 0);

  // a little real pigment density so pale shades still read as product
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = intensity * 0.12;
  ctx.drawImage(colorCv, 0, 0);

  if (finish === 'satin') {
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = intensity * 0.5;
    ctx.drawImage(colorCv, 0, 0);
  }
  ctx.restore();

  // --- 4. gloss: specular highlight on the lower lip, clipped to the mask ---
  if (finish === 'gloss') {
    let sx = 0, sy = 0, n = 0;
    for (const i of LOWER_LIP) { sx += landmarks[i].x; sy += landmarks[i].y; n++; }
    const cx = (sx / n) * w, cy = (sy / n) * h - h * 0.012;
    const r = w * 0.05;
    const s = specCv.getContext('2d');
    s.clearRect(0, 0, w, h);
    const g = s.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    s.fillStyle = g;
    s.fillRect(0, 0, w, h);
    s.globalCompositeOperation = 'destination-in';
    s.drawImage(maskCv, 0, 0);
    s.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.75;
    ctx.drawImage(specCv, 0, 0);
    ctx.restore();
  }
}
