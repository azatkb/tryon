// bakeUV.js — turn the procedural mask builders into UV-space PNGs.
//
// The canonical face (faceMeshUV) is laid out in a virtual frame exactly at
// its UV positions (u → x, 1−v → y), so whatever a builder draws there IS the
// mask in UV space: crop the face square and save it. That gives the artists a
// starting set that matches today's look 1:1; from then on the PNGs are the
// source of truth and can be repainted freely (uvTemplate() = wireframe guide).
//
//   const maps = bakeUVMasks();            // { foundation: canvas, ... }
//   maps.foundation.toBlob(...)            // grayscale PNG, white = product

import { UV, CANON_Z, TRI, UV_COUNT } from './faceMeshUV.js';
import { UV_PRODUCTS } from './uvMasks.js';
import {
  uvBakeBegin, uvBakeEnd, CFG,
  buildFaceMask, buildBlushMask, buildContourMask, buildHighlightMask, buildUnderEyeMask,
  buildBronzerMask, buildNoseContourMask, buildEyelinerMask, buildBrowMask,
} from '../lipRenderer.js';
import { LIPS_OUTER } from '../lips.js';
import { FACE_OVAL } from '../regions.js';

const U_PER_CM = 0.0636;   // canonical model: UV units per cm (measured from the obj)

/**
 * Canonical landmarks in a virtual frame, face spanning `frac` of the width,
 * centred. 478 points (iris rings synthesised from the eye corners/lids).
 */
export function canonicalLandmarks(frac = 0.3) {
  const o = (1 - frac) / 2;
  const lm = [];
  for (let i = 0; i < UV_COUNT; i++) {
    lm.push({ x: o + frac * UV[2 * i], y: o + frac * (1 - UV[2 * i + 1]), z: -CANON_Z[i] * frac * U_PER_CM });
  }
  const iris = (a, b, top, bot) => {
    const cx = (lm[a].x + lm[b].x) / 2, cy = (lm[top].y + lm[bot].y) / 2;
    const cz = Math.min(lm[a].z, lm[b].z);
    const r = Math.abs(lm[a].x - lm[b].x) * 0.2;
    return [{ x: cx, y: cy, z: cz }, { x: cx + r, y: cy, z: cz }, { x: cx, y: cy - r, z: cz },
            { x: cx - r, y: cy, z: cz }, { x: cx, y: cy + r, z: cz }];
  };
  lm.push(...iris(33, 133, 159, 145), ...iris(263, 362, 386, 374));
  return lm;
}

const BUILDERS = {
  foundation: (w, h, l) => buildFaceMask(w, h, l, {}),
  underEye: buildUnderEyeMask,
  contour: buildContourMask,
  highlight: buildHighlightMask,
  blush: buildBlushMask,
  bronzer: buildBronzerMask,
  noseContour: buildNoseContourMask,
  eyes: null,   // drawn in UV: eyeshadowUV()
  eyeliner: buildEyelinerMask,
  brows: buildBrowMask,
};

const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Eyeshadow drawn directly in UV (not baked from the 2D builder). The 2D
// builder blurs by a fraction of the FRAME, so on a normal-size face the
// shadow melts into a flat pill that never reaches full density — and the
// shader's lid / crease / brow-bone zones (driven by mask level) collapse
// into one block. Here the mask is laid out in the eye's own coordinates:
//   s: 0 = outer corner … 1 = inner corner,  h: 0 = upper lash line … 1 = brow
// Dense on the lid, ~0.4 in the crease, sheer on the brow bone. Past the
// outer corner a long wing sweeps up toward the brow tail, its band narrowing
// smoothly to a point; at the inner corner it runs slightly past the eye and
// fades out (reference: classic cut-out/smoky wing).
const EYE_SETS = [
  { lash: [33, 246, 161, 160, 159, 158, 157, 173, 133], brow: [46, 53, 52, 65, 55] },
  { lash: [263, 466, 388, 387, 386, 385, 384, 398, 362], brow: [276, 283, 282, 295, 285] },
];
function eyeshadowUV(S) {
  const val = new Float32Array(S * S);
  const gate = new Float32Array(S * S).fill(1);   // eye opening → 0
  for (const { lash, brow } of EYE_SETS) {
    const uo = UV[2 * lash[0]], ui = UV[2 * lash[lash.length - 1]];
    const sOf = (u) => (u - uo) / (ui - uo);
    const curve = (idx) => idx.map((i) => [sOf(UV[2 * i]), UV[2 * i + 1]]).sort((a, b) => a[0] - b[0]);
    const L = curve(lash), B = curve(brow);
    // Brow: extrapolated past the outer end along its own direction (clamping
    // put a corner into the shadow there). Lash: handled below.
    const at = (c, x) => {
      if (x <= c[0][0]) return c === B ? c[0][1] + (x - c[0][0]) * (c[1][1] - c[0][1]) / (c[1][0] - c[0][0]) : c[0][1];
      for (let k = 1; k < c.length; k++) if (x <= c[k][0]) { const t = (x - c[k - 1][0]) / (c[k][0] - c[k - 1][0]); return c[k - 1][1] + t * (c[k][1] - c[k - 1][1]); }
      return c[c.length - 1][1];
    };
    const eyeW = Math.abs(ui - uo);
    const u0 = Math.min(uo, ui) - 0.75 * eyeW, u1 = Math.max(uo, ui) + 0.75 * eyeW;
    const WING = 0.8, INNER = 1.2;           // wing reach / inner reach (eye widths)
    for (let py = Math.floor(S * (1 - 0.8)); py < Math.ceil(S * (1 - 0.55)); py++) {
      const v = 1 - (py + 0.5) / S;
      for (let px = Math.max(0, Math.floor(u0 * S)); px < Math.min(S, Math.ceil(u1 * S)); px++) {
        const s = sOf((px + 0.5) / S);
        if (s < -WING - 0.05 || s > INNER) continue;
        const e = Math.max(0, -s);           // distance past the outer corner
        // Upper edge: under the brow; past the eye corner it follows the brow
        // gently down while the lower edge rises — they close in a long point.
        const bv = s >= 0 ? at(B, s) : at(B, 0) - 0.045 * e;
        // Lower edge: the lash line; past the corner it keeps the lash line's
        // direction for a moment, then curves up like a liner wing.
        const lo = s >= 0 ? at(L, s) : L[0][1] + 0.03 * e + 0.05 * e * e;
        // Band height: lash→brow, closing naturally where the two lines meet.
        const band = Math.max(1e-3, bv - lo);
        let h = (v - lo) / band;
        if (s >= 0 && s <= 1 && h < 0) gate[py * S + px] = Math.min(gate[py * S + px], sm(-0.08, 0, h));
        h *= 1 + 1.0 * sm(0.7, 1.15, s);     // inner corner: lower, narrower
        let a = (1 - sm(WING * 0.7, WING, e)) * sm(-0.02, 0.08, band / eyeW) * (1 - sm(0.95, INNER, s));
        a *= sm(-(0.06 + 1.2 * e), 0, h);    // crisp at the lash line, soft lower edge on the wing
        let lvl = h < 0.3 ? 1 : h < 0.6 ? 1 - 0.58 * sm(0.3, 0.6, h)
                : h < 0.9 ? 0.42 - 0.3 * sm(0.6, 0.9, h) : 0.12 * (1 - sm(0.9, 1.05, h));
        lvl *= 1 - 0.35 * sm(0.0, 0.4, e);   // the wing reads as crease colour, not lid
        val[py * S + px] = Math.max(val[py * S + px], a * lvl);
      }
    }
  }
  const c = mk(S), x = c.getContext('2d'), img = x.createImageData(S, S);
  for (let i = 0; i < S * S; i++) { const g = Math.round(255 * val[i]); img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = g; img.data[4 * i + 3] = 255; }
  x.putImageData(img, 0, 0);
  const o = mk(S), ox = o.getContext('2d');
  // Feather relative to the eye (~3% of its width), then put the lash line
  // back crisp so no shadow leaks onto the eyeball when the lid opens.
  ox.filter = `blur(${Math.max(1, S * 0.0045)}px)`; ox.drawImage(c, 0, 0);
  ox.filter = 'none';
  const im = ox.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) { const g = Math.round(im.data[4 * i] * gate[i]); im.data[4 * i] = im.data[4 * i + 1] = im.data[4 * i + 2] = g; im.data[4 * i + 3] = 255; }
  ox.putImageData(im, 0, 0);
  return o;
}

const mk = (S) => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
const uvPt = (i, S) => [UV[2 * i] * S, (1 - UV[2 * i + 1]) * S];
function poly(ctx, idx, S) {
  ctx.beginPath();
  idx.forEach((i, k) => { const [x, y] = uvPt(i, S); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.closePath();
}

/** Soft fade to 0 at the mesh border (alpha 0..1 per pixel, S×S). */
function hullFade(S) {
  const c = mk(S), x = c.getContext('2d');
  x.filter = `blur(${Math.max(1, S * 0.012)}px)`;
  x.fillStyle = '#fff'; poly(x, FACE_OVAL, S); x.fill();
  const d = x.getImageData(0, 0, S, S).data, f = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    const t = Math.min(1, Math.max(0, (d[4 * i + 3] / 255 - 0.5) / 0.5));
    f[i] = t * t * (3 - 2 * t);
  }
  return f;
}

/** alpha mask canvas region → opaque grayscale canvas (×fade). */
function toGray(src, sx, sy, sw, sh, S, fade) {
  const c = mk(S), x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, sx, sy, sw, sh, 0, 0, S, S);
  const img = x.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < S * S; i++) {
    const v = Math.round(d[4 * i + 3] * (fade ? fade[i] : 1));
    d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = v; d[4 * i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

/**
 * Bake every UV product. Returns { key: canvas(S×S, grayscale, opaque) }.
 * @param {object} [o]
 * @param {number} [o.size=512]   UV map size
 * @param {number} [o.frac=0.3]  face width / frame width in the virtual frame
 *        (≈ a selfie; the builders' blur radii are relative to the frame)
 */
export function bakeUVMasks({ size = 512, frac = 0.3 } = {}) {
  const S = size;
  const MW = Math.round(S / frac);
  const W = Math.round(MW / CFG.maskScale);
  const lm = canonicalLandmarks(frac);
  const o = (1 - frac) / 2;
  const fade = hullFade(S);
  const out = {};
  uvBakeBegin();
  try {
    for (const key of UV_PRODUCTS) {
      const b = BUILDERS[key];
      if (!b) continue;
      const cv = b(W, W, lm);
      const mw = cv.width;   // builders' canvases are MW×MW
      if (key === 'foundation') {
        // Base makeup is FULL right up to the oval (the renderer's skirt carries
        // it past the oval to the real face edge, gated by skin colour). The
        // builder's own edge blur would leave a half-strength band at the edge
        // where the real skin showed through on a turned head.
        const g = toGray(cv, o * mw, o * mw, frac * mw, frac * mw, S, null);
        const gx = g.getContext('2d'), im = gx.getImageData(0, 0, S, S), d = im.data;
        for (let i = 0; i < S * S; i++) { const v = Math.min(255, d[4 * i] * 2); d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = v; }
        gx.putImageData(im, 0, 0);
        out[key] = g;
      } else {
        out[key] = toGray(cv, o * mw, o * mw, frac * mw, frac * mw, S, fade);
      }
    }
  } finally {
    uvBakeEnd();
  }
  out.eyes = eyeshadowUV(S);
  // Lip area (outer outline) — fallback cut when the fitted lip mask is off.
  const lc = mk(S), lx = lc.getContext('2d');
  lx.fillStyle = '#000'; lx.fillRect(0, 0, S, S);
  lx.filter = 'blur(1px)'; lx.fillStyle = '#fff'; poly(lx, LIPS_OUTER, S); lx.fill();
  out.lipsCut = lc;
  return out;
}

/** Wireframe of the UV layout (for painting masks in an image editor). */
export function uvTemplate(size = 1024) {
  const c = mk(size), x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, size, size);
  x.strokeStyle = 'rgba(255,255,255,0.35)'; x.lineWidth = Math.max(0.5, size / 2048);
  x.beginPath();
  for (let t = 0; t < TRI.length; t += 3) {
    const [a, b, cc] = [uvPt(TRI[t], size), uvPt(TRI[t + 1], size), uvPt(TRI[t + 2], size)];
    x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.lineTo(cc[0], cc[1]); x.closePath();
  }
  x.stroke();
  x.strokeStyle = 'rgba(255,80,80,0.9)'; x.lineWidth = Math.max(1, size / 700);
  poly(x, FACE_OVAL, size); x.stroke();
  poly(x, LIPS_OUTER, size); x.stroke();
  return c;
}

export function canvasToPngBlob(c) {
  return new Promise((r) => c.toBlob(r, 'image/png'));
}