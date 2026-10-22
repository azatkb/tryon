// One guided lesson = 5 steps, each a region we render live. The effect builds up
// step by step (cumulative). Each step names a catalogue product (CATALOG) and a
// shade family; the actual colour is resolved through REESOLVE's own lookShade()
// against the catalogue + the user's undertone/skin depth — so swapping in their
// real catalogue export needs no code change.

import { CATALOG } from './catalog.js';
import { lookShade, FAMILY_HEX } from './shadeData.js';

// User profile (undertone / skin depth) — their app reads this from the face scan.
// Left null here; lookShade falls back to the family's representative shade.
export const USER_PROFILE = { undertone: null, depth: null };

export const LESSON = {
  title: 'Everyday Look',
  steps: [
    { key: 'lips',   region: 'lips',       product: 'lips',   family: 'pink-nude', finish: 'satin', intensity: 0.6,
      title: 'Start with the lips', text: 'Add lip liner close to your natural lip colour, then fill with a satin balm. Press, don’t paint.' },
    { key: 'eyes',   region: 'eyes',       product: 'eyes',   family: 'neutral',   intensity: 0.45,
      title: 'Define the eyes', text: 'Sweep a neutral taupe wash across the lid and blend into the crease to add soft depth.' },
    { key: 'lashes', region: 'lashes',     product: 'lashes', family: null,        intensity: 0.8,
      title: 'Lift the lashes', text: 'Curl and coat the lashes from the root upward, concentrating on the outer lashes to open the eye.' },
    { key: 'face',   region: 'foundation', product: 'face',   family: null,        intensity: 0.28,
      title: 'Even the skin', text: 'A light layer of skin tint from the centre of the face outward — thin layers read more like skin.' },
    { key: 'blush',  region: 'blush',      product: 'blush',  family: 'rosy',      intensity: 0.4,
      title: 'Add a flush', text: 'Place blush just above the apples of the cheeks and blend up toward the temples for a lifted glow.' },
  ],
};

// Resolve a step's product + shade through their logic. Returns { hex, shade, product }.
export function resolveStep(stepIdx, profile = USER_PROFILE) {
  const s = LESSON.steps[stepIdx];
  const row = CATALOG[s.product];
  const picked = lookShade(row, s.family, profile.undertone, null, profile.depth);
  const shade = picked.shade || (Array.isArray(row?.shades) && row.shades[0]) || null;
  const hex = shade?.hex || row?.hex || (s.family && FAMILY_HEX[s.family]) || '#000000';
  const productLabel = row ? `${row.brand} · ${row.name}${shade ? ` · ${shade.name}` : ''}` : '';
  return { hex, shade, product: productLabel };
}

// Cumulative makeup layers for steps 0..stepIdx (later steps win per region).
export function lessonLayers(stepIdx, profile = USER_PROFILE) {
  const out = {};
  for (let i = 0; i <= stepIdx && i < LESSON.steps.length; i++) {
    const s = LESSON.steps[i];
    const { hex } = resolveStep(i, profile);
    if (s.region === 'lashes') out.lashes = { intensity: s.intensity };
    else if (s.region === 'foundation') out.foundation = { color: hex, intensity: s.intensity };
    else out[s.region] = { color: hex, intensity: s.intensity, ...(s.finish ? { finish: s.finish } : {}) };
  }
  return out;
}