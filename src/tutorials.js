// One guided lesson. Steps run in proper MUA order and each applies its region
// live on the user's face (cumulative). Colours resolve through REESOLVE's
// lookShade() against the catalogue + the user's skin depth.

import { CATALOG } from './catalog.js';
import { lookShade, FAMILY_HEX } from './shadeData.js';

export const USER_PROFILE = { undertone: null, depth: null };

export const LESSON = {
  title: 'Everyday Look',
  steps: [
    // True MUA order, and the renderer lays the layers down in this same order:
    // base (foundation → concealer) → sculpt (contour → blush → highlight)
    // → eyes (brows → shadow → liner → mascara) → lips (liner → lipstick).
    { key: 'foundation', region: 'foundation', product: 'foundation', family: null,        intensity: 0.26,
      title: 'Even the skin',     text: 'A light layer of skin tint from the centre outward — thin layers read more like skin.' },
    { key: 'underEye',  region: 'underEye',   product: 'concealer',  family: null,        intensity: 0.55,
      title: 'Brighten under-eye', text: 'Tap a touch-lighter concealer under the eye in a triangle shape, blended down.' },
    { key: 'contour',   region: 'contour',    product: null,         family: 'contour',   intensity: 0.55,
      title: 'Sculpt the face',   text: 'A cool shadow along the hollow under the cheekbone — shadow, not a stripe. Blend well.' },
    { key: 'blush',     region: 'blush',      product: 'blush',      family: 'rosy',      intensity: 0.38,
      title: 'Add a flush',       text: 'Blush high on the cheekbone, just above the contour — swept toward the temple for a lifted glow.' },
    { key: 'highlight', region: 'highlight',  product: null,         family: 'highlight', intensity: 0.55,
      title: 'Catch the light',   text: 'Champagne glow on the high points, last of the cheek products — it sits on top of the blush, never under it.' },
    { key: 'brows',     region: 'brows',      product: 'brows',      family: 'brow',      intensity: 0.55,
      title: 'Frame the eyes',    text: 'Fill sparse spots with light feathery strokes, following the natural brow arch.' },
    // 'bronze' resolves to Cocoa in the palette. The old 'neutral' pick was
    // Taupe (#8A7466) at 0.45 — a grey-beige at skin luminance, which on skin
    // barely registered however the shader treated it.
    { key: 'eyes',      region: 'eyes',       product: 'eyeshadow',  family: 'bronze',    intensity: 0.9,
      title: 'Define the lids',   text: 'A warm cocoa wash across the lid, blended up into the crease and out past the outer corner.' },
    { key: 'eyeliner',  region: 'eyeliner',   product: 'eyeliner',   family: null,        intensity: 0.85,
      title: 'Line the eyes',     text: 'A thin line along the upper lash line — thicker at the outer corner for a subtle wing.' },
    { key: 'lashes',    region: 'lashes',     product: 'mascara',    family: null,        intensity: 0.80,
      title: 'Lift the lashes',   text: 'Coat from the root upward in a zigzag, concentrating on the outer lashes to open the eye.' },
    { key: 'lipLiner',  region: 'lipLiner',   product: 'lip-liner',  family: 'pink-nude', intensity: 0.80,
      title: 'Define the lips',   text: 'Line just inside your natural lip edge to keep the shape precise, then blend inward.' },
    { key: 'lips',      region: 'lips',       product: 'lipstick',   family: 'pink-nude', finish: 'satin', intensity: 0.60,
      title: 'Finish the lips',   text: 'Press a satin colour over the liner, blotting the centre for a soft ombre finish.' },
  ],
};

export function resolveStep(stepIdx, profile = USER_PROFILE) {
  const s = LESSON.steps[stepIdx];
  const row = s.product ? CATALOG[s.product] : null;
  const picked = lookShade(row, s.family, profile.undertone, null, profile.depth);
  const shade = picked.shade || (Array.isArray(row?.shades) && row.shades[0]) || null;
  const hex = shade?.hex || row?.hex || (s.family && FAMILY_HEX[s.family]) || '#000000';
  const productLabel = row ? `${row.brand} · ${row.name}${shade && s.family ? ` · ${shade.name}` : ''}` : '';
  return { hex, shade, product: productLabel };
}

// Regions that are pure effects (no tint colour needed, intensity only).
const EFFECT_ONLY = new Set(['underEye', 'contour', 'highlight', 'lashes']);

export function lessonLayers(stepIdx, profile = USER_PROFILE) {
  const out = {};
  for (let i = 0; i <= stepIdx && i < LESSON.steps.length; i++) {
    const s = LESSON.steps[i];
    if (EFFECT_ONLY.has(s.region)) {
      out[s.region] = { intensity: s.intensity };
    } else {
      const { hex } = resolveStep(i, profile);
      out[s.region] = {
        color: hex,
        intensity: s.intensity,
        ...(s.finish ? { finish: s.finish } : {}),
      };
    }
  }
  return out;
}