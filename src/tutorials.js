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
    //
    // Two knobs per step:
    //   intensity  0..1  how much pigment reaches the skin
    //   edge       0..1  how tight the region's edge is: 0 = softest wash,
    //                    1 = hardest. Only the regions whose mask is a blurred
    //                    sweep take it (foundation, underEye, contour, blush,
    //                    highlight, eyes) — on a liner or a lash it would do
    //                    nothing. Each region's actual blur range lives in
    //                    EDGE_RANGE in tryon/lipRenderer.js.
    { key: 'foundation', region: 'foundation', product: 'foundation', family: null,        intensity: 0.26, edge: 0.19,
      title: 'Even the skin',     text: 'A light layer of skin tint from the centre outward — thin layers read more like skin.' },
    { key: 'underEye',  region: 'underEye',   product: 'concealer',  family: null,        intensity: 0.55, edge: 0.64,
      title: 'Brighten under-eye', text: 'Tap a touch-lighter concealer under the eye in a triangle shape, blended down.' },
    { key: 'contour',   region: 'contour',    product: null,         family: 'contour',   intensity: 0.15, edge: 0.50,
      title: 'Sculpt the face',   text: 'A cool shadow along the hollow under the cheekbone — shadow, not a stripe. Blend well.' },
    { key: 'blush',     region: 'blush',      product: 'blush',      family: 'rosy',      intensity: 0.50, edge: 0.50,
      title: 'Add a flush',       text: 'Blush high on the cheekbone, just above the contour — swept toward the temple for a lifted glow.' },
    { key: 'highlight', region: 'highlight',  product: null,         family: 'highlight', intensity: 0.55, edge: 0.45,
      title: 'Catch the light',   text: 'Champagne glow on the high points, last of the cheek products — it sits on top of the blush, never under it.' },
    { key: 'brows',     region: 'brows',      product: 'brows',      family: 'brow',      intensity: 0.55,
      title: 'Frame the eyes',    text: 'Fill sparse spots with light feathery strokes, following the natural brow arch.' },
    // 'bronze' resolves to Cocoa in the palette. The old 'neutral' pick was
    // Taupe (#8A7466) at 0.45 — a grey-beige at skin luminance, which on skin
    // barely registered however the shader treated it.
    { key: 'eyes',      region: 'eyes',       product: 'eyeshadow',  family: 'bronze',    intensity: 0.50, edge: 0.25,
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

// ── Lesson 2: Soft Glam — evening warmth, berry lip, shimmer eye ─────────
const SOFT_GLAM = {
  title: 'Soft Glam',
  steps: [
    { key: 'foundation', region: 'foundation', product: 'foundation', family: null,        finish: 'dewy', intensity: 0.30, edge: 0.20,
      title: 'Build the base',    text: 'A dewy medium-coverage base for a luminous, hydrated canvas — blend outward from the centre.' },
    { key: 'underEye',  region: 'underEye',   product: 'concealer',  family: null,        intensity: 0.60, edge: 0.60,
      title: 'Conceal and lift',  text: 'Brighten under-eyes and blend down in a V shape for a lifted look.' },
    { key: 'contour',   region: 'contour',    product: null,         family: 'contour',   intensity: 0.25, edge: 0.45,
      title: 'Warm sculpt',       text: 'Sculpt the hollows and jawline — build slowly, this look is warm not chiselled.' },
    { key: 'blush',     region: 'blush',      product: 'blush',      family: 'peach',     finish: 'cream', intensity: 0.55, edge: 0.45,
      title: 'Peachy flush',      text: 'A cream blush in peach on the apples and up toward the temples — melt it into the skin.' },
    { key: 'highlight', region: 'highlight',  product: null,         family: 'champagne', intensity: 0.65, edge: 0.40,
      title: 'Champagne glow',    text: 'Generous highlighter on the high points — brow bone, nose bridge, cupid\'s bow.' },
    { key: 'brows',     region: 'brows',      product: 'brows',      family: 'brow',      intensity: 0.50,
      title: 'Soft brows',        text: 'Fill lightly — a groomed brow, not a carved one.' },
    { key: 'eyes',      region: 'eyes',       product: 'eyeshadow',  family: 'champagne', finish: 'shimmer', intensity: 0.65, edge: 0.30,
      title: 'Shimmer lid',       text: 'Champagne shimmer across the lid, concentrated at the centre for a foil effect.' },
    { key: 'eyeliner',  region: 'eyeliner',   product: 'eyeliner',   family: null,        intensity: 0.70,
      title: 'Soft wing',         text: 'A thin brown-black line with a gentle flick — keeping it smudged, not graphic.' },
    { key: 'lashes',    region: 'lashes',     product: 'mascara',    family: null,        intensity: 0.85,
      title: 'Full lashes',       text: 'Two coats on the upper lashes, one on the lower outer corner for drama.' },
    { key: 'lipLiner',  region: 'lipLiner',   product: 'lip-liner',  family: 'berry',     intensity: 0.75,
      title: 'Berry lip line',    text: 'Overdraw just slightly at the cupid\'s bow, then fill inward to anchor the colour.' },
    { key: 'lips',      region: 'lips',       product: 'lipstick',   family: 'berry',     finish: 'satin', intensity: 0.70,
      title: 'Berry satin lip',   text: 'A rich berry satin — press and blot for depth, build up from one layer.' },
  ],
};

// ── Lesson 3: No-Makeup Makeup — invisible perfection ────────────────────
const NO_MAKEUP = {
  title: 'No-Makeup Makeup',
  steps: [
    { key: 'foundation', region: 'foundation', product: 'foundation', family: null,        finish: 'natural', intensity: 0.15, edge: 0.15,
      title: 'Skin tint',         text: 'The sheeerest layer — just enough to even redness. Skip blemish-free zones entirely.' },
    { key: 'underEye',  region: 'underEye',   product: 'concealer',  family: null,        intensity: 0.40, edge: 0.70,
      title: 'Touch of light',    text: 'A tiny dab of concealer only on dark circles, patted (never rubbed) in.' },
    { key: 'blush',     region: 'blush',      product: 'blush',      family: 'peach',     finish: 'cream', intensity: 0.30, edge: 0.35,
      title: 'Healthy flush',     text: 'A whisper of peach cream blush — just enough to look like you slept eight hours.' },
    { key: 'highlight', region: 'highlight',  product: null,         family: 'champagne', intensity: 0.30, edge: 0.35,
      title: 'Lit from within',   text: 'A hint of champagne on the cheekbone peaks only — nobody should see product.' },
    { key: 'brows',     region: 'brows',      product: 'brows',      family: 'brow',      intensity: 0.35,
      title: 'Brush and set',     text: 'Feathery strokes to fill sparse spots — the brow should look groomed, not drawn.' },
    { key: 'lashes',    region: 'lashes',     product: 'mascara',    family: null,        intensity: 0.50,
      title: 'One light coat',    text: 'A single coat on upper lashes from root to tip — just enough definition to open the eye.' },
    { key: 'lips',      region: 'lips',       product: 'lipstick',   family: 'pink-nude', finish: 'satin', intensity: 0.35,
      title: 'Your-lips-but-better', text: 'A nude satin barely darker than your natural lip — smoothed on with a finger.' },
  ],
};

// ── Lesson 4: Bold Red Lip — classic statement look ──────────────────────
const BOLD_RED = {
  title: 'Bold Red Lip',
  steps: [
    { key: 'foundation', region: 'foundation', product: 'foundation', family: null,        finish: 'matte', intensity: 0.30, edge: 0.22,
      title: 'Flawless matte base', text: 'A matte medium base — the lip is the star, the skin just needs to be even.' },
    { key: 'underEye',  region: 'underEye',   product: 'concealer',  family: null,        intensity: 0.55, edge: 0.60,
      title: 'Clean under-eye',   text: 'Conceal and set — nothing should compete with the lip.' },
    { key: 'contour',   region: 'contour',    product: null,         family: 'contour',   intensity: 0.20, edge: 0.50,
      title: 'Subtle structure',   text: 'Light contour under the cheekbone — define the face without overpowering the lip.' },
    { key: 'blush',     region: 'blush',      product: 'blush',      family: 'rosy',      intensity: 0.25, edge: 0.40,
      title: 'Soft rose blush',   text: 'Barely-there rose blush high on the cheek — the lip does the heavy lifting.' },
    { key: 'highlight', region: 'highlight',  product: null,         family: 'champagne', intensity: 0.45, edge: 0.40,
      title: 'Gentle glow',       text: 'Champagne highlighter on the high points to balance the matte base.' },
    { key: 'brows',     region: 'brows',      product: 'brows',      family: 'brow',      intensity: 0.60,
      title: 'Defined brows',     text: 'Slightly stronger brows to frame the face and balance the statement lip.' },
    { key: 'eyes',      region: 'eyes',       product: 'eyeshadow',  family: 'neutral',   intensity: 0.30, edge: 0.25,
      title: 'Neutral wash',      text: 'A whisper of taupe on the lid — just enough to add depth without competing.' },
    { key: 'eyeliner',  region: 'eyeliner',   product: 'eyeliner',   family: null,        intensity: 0.80,
      title: 'Clean line',        text: 'A precise black line along the upper lashes — thin, sharp, classic.' },
    { key: 'lashes',    region: 'lashes',     product: 'mascara',    family: null,        intensity: 0.80,
      title: 'Defined lashes',    text: 'Two coats to frame the eye — let them dry between coats to separate.' },
    { key: 'lipLiner',  region: 'lipLiner',   product: 'lip-liner',  family: 'red',       intensity: 0.85,
      title: 'Red lip line',      text: 'Precise red liner just outside the natural edge — this is the architecture of the look.' },
    { key: 'lips',      region: 'lips',       product: 'lipstick',   family: 'red',       finish: 'matte', intensity: 0.80,
      title: 'Statement red',     text: 'A full-coverage matte red — apply, blot, reapply. Two layers for a rich, lasting stain.' },
  ],
};

// All lessons in order. LESSON stays as the default (backwards compat).
export const LESSONS = [LESSON, SOFT_GLAM, NO_MAKEUP, BOLD_RED];

export function resolveStep(stepIdx, profile = USER_PROFILE, lesson = LESSON) {
  const s = lesson.steps[stepIdx];
  const row = s.product ? CATALOG[s.product] : null;
  const picked = lookShade(row, s.family, profile.undertone, null, profile.depth);
  const shade = picked.shade || (Array.isArray(row?.shades) && row.shades[0]) || null;
  const hex = shade?.hex || row?.hex || (s.family && FAMILY_HEX[s.family]) || '#000000';
  const productLabel = row ? `${row.brand} · ${row.name}${shade && s.family ? ` · ${shade.name}` : ''}` : '';
  return { hex, shade, product: productLabel };
}

// Regions that are pure effects (no tint colour needed, intensity only).
const EFFECT_ONLY = new Set(['underEye', 'contour', 'highlight', 'lashes']);

export function lessonLayers(stepIdx, profile = USER_PROFILE, lesson = LESSON) {
  const out = {};
  for (let i = 0; i <= stepIdx && i < lesson.steps.length; i++) {
    const s = lesson.steps[i];
    if (EFFECT_ONLY.has(s.region)) {
      out[s.region] = { intensity: s.intensity };
    } else {
      const { hex } = resolveStep(i, profile, lesson);
      out[s.region] = {
        color: hex,
        intensity: s.intensity,
        ...(s.finish ? { finish: s.finish } : {}),
      };
    }
  }
  return out;
}