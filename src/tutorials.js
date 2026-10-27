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

// ── Lesson 2: Coral Summer — warm bright coral lip, peachy glow ──────────
const CORAL_SUMMER = {
  title: 'Coral Summer',
  steps: [
    { key: 'foundation', region: 'foundation', product: 'foundation', family: null,        finish: 'dewy', intensity: 0.22, edge: 0.18,
      title: 'Dewy base',         text: 'A light dewy base — sun-kissed, not covered. Let freckles and texture show through.' },
    { key: 'underEye',  region: 'underEye',   product: 'concealer',  family: null,        intensity: 0.45, edge: 0.65,
      title: 'Quick brighten',    text: 'Just a tap under each eye — barely there, keep it fresh.' },
    { key: 'blush',     region: 'blush',      product: 'blush',      family: 'peach',     finish: 'cream', intensity: 0.60, edge: 0.40,
      title: 'Warm peach flush',  text: 'A generous peach cream blush — think sun-warmed cheeks. Blend up toward the temples.' },
    { key: 'highlight', region: 'highlight',  product: null,         family: 'champagne', intensity: 0.60, edge: 0.40,
      title: 'Golden glow',       text: 'Champagne highlight on the cheekbones, nose bridge and cupid\'s bow — catch every ray.' },
    { key: 'brows',     region: 'brows',      product: 'brows',      family: 'brow',      intensity: 0.45,
      title: 'Soft brows',        text: 'Light strokes to groom — keep it effortless, not sculpted.' },
    { key: 'eyes',      region: 'eyes',       product: 'eyeshadow',  family: 'bronze',    finish: 'shimmer', intensity: 0.55, edge: 0.30,
      title: 'Bronze shimmer',    text: 'Warm bronze shimmer across the lid — like the sun hitting your lids at golden hour.' },
    { key: 'lashes',    region: 'lashes',     product: 'mascara',    family: null,        intensity: 0.75,
      title: 'Lash lift',         text: 'One good coat from root to tip — open and fresh.' },
    { key: 'lipLiner',  region: 'lipLiner',   product: 'lip-liner',  family: 'peach',     intensity: 0.70,
      title: 'Warm lip line',     text: 'A warm brick liner to frame the coral — blend the edge so it melts in.' },
    { key: 'lips',      region: 'lips',       product: 'lipstick',   family: 'peach',     finish: 'gloss', intensity: 0.70,
      title: 'Bright coral lip',  text: 'A juicy coral gloss — the pop of colour that makes the whole look. Press and smile.' },
  ],
};

// ── Lesson 3: Plum Smoke — dramatic plum eye, berry everything ───────────
const PLUM_SMOKE = {
  title: 'Plum Smoke',
  steps: [
    { key: 'foundation', region: 'foundation', product: 'foundation', family: null,        finish: 'matte', intensity: 0.30, edge: 0.22,
      title: 'Matte canvas',      text: 'A smooth matte base — this look is dramatic, the skin needs to be flawless underneath.' },
    { key: 'underEye',  region: 'underEye',   product: 'concealer',  family: null,        intensity: 0.60, edge: 0.60,
      title: 'Conceal and set',   text: 'Bright under-eyes are critical here — the dark shadow above needs contrast below.' },
    { key: 'contour',   region: 'contour',    product: null,         family: 'contour',   intensity: 0.25, edge: 0.45,
      title: 'Sharp sculpt',      text: 'Defined contour in the hollows and along the jawline — add structure for the drama.' },
    { key: 'blush',     region: 'blush',      product: 'blush',      family: 'berry',     intensity: 0.55, edge: 0.45,
      title: 'Berry blush',       text: 'A punchy berry blush on the cheekbones — monochrome with the eyes and lips.' },
    { key: 'highlight', region: 'highlight',  product: null,         family: 'champagne', intensity: 0.55, edge: 0.40,
      title: 'Highlight peaks',   text: 'A sharp champagne highlight on the very tops of the cheekbones — counterpoint to the dark tones.' },
    { key: 'brows',     region: 'brows',      product: 'brows',      family: 'brow',      intensity: 0.65,
      title: 'Bold brows',        text: 'Strong defined brows — this look demands a frame. Fill and shape with intention.' },
    { key: 'eyes',      region: 'eyes',       product: 'eyeshadow',  family: 'berry',     finish: 'shimmer', intensity: 0.70, edge: 0.30,
      title: 'Plum shimmer lid',  text: 'Rich plum shimmer packed onto the lid and blended into the crease — the star of the show.' },
    { key: 'eyeliner',  region: 'eyeliner',   product: 'eyeliner',   family: null,        intensity: 0.90,
      title: 'Smoky wing',        text: 'A thick smudged black line — winged out and diffused at the edges for smoke, not precision.' },
    { key: 'lashes',    region: 'lashes',     product: 'mascara',    family: null,        intensity: 0.90,
      title: 'Maximum lashes',    text: 'Layer it on — three coats, wiggle the wand. These lashes need to match the eye drama.' },
    { key: 'lipLiner',  region: 'lipLiner',   product: 'lip-liner',  family: 'berry',     intensity: 0.80,
      title: 'Berry lip line',    text: 'Deep berry liner slightly overdrawing the natural edge — build the plum story down to the lips.' },
    { key: 'lips',      region: 'lips',       product: 'lipstick',   family: 'berry',     finish: 'satin', intensity: 0.75,
      title: 'Deep berry lip',    text: 'A rich berry satin pressed on in layers — dark, moody, and deliberately imperfect at the centre.' },
  ],
};

// ── Lesson 4: Bold Red Lip — classic statement, bright red ───────────────
const BOLD_RED = {
  title: 'Bold Red Lip',
  steps: [
    { key: 'foundation', region: 'foundation', product: 'foundation', family: null,        finish: 'matte', intensity: 0.30, edge: 0.22,
      title: 'Flawless matte base', text: 'A matte medium base — the lip is the star, the skin just needs to be even.' },
    { key: 'underEye',  region: 'underEye',   product: 'concealer',  family: null,        intensity: 0.55, edge: 0.60,
      title: 'Clean under-eye',   text: 'Conceal and set — nothing should compete with the lip.' },
    { key: 'contour',   region: 'contour',    product: null,         family: 'contour',   intensity: 0.20, edge: 0.50,
      title: 'Subtle structure',   text: 'Light contour under the cheekbone — define the face without overpowering the lip.' },
    { key: 'blush',     region: 'blush',      product: 'blush',      family: 'rosy',      intensity: 0.35, edge: 0.40,
      title: 'Rose blush',        text: 'A visible rose blush high on the cheeks — warm enough to complement the red, not fight it.' },
    { key: 'highlight', region: 'highlight',  product: null,         family: 'champagne', intensity: 0.50, edge: 0.40,
      title: 'Gentle glow',       text: 'Champagne highlighter on the high points to balance the matte base.' },
    { key: 'brows',     region: 'brows',      product: 'brows',      family: 'brow',      intensity: 0.60,
      title: 'Defined brows',     text: 'Slightly stronger brows to frame the face and balance the statement lip.' },
    { key: 'eyes',      region: 'eyes',       product: 'eyeshadow',  family: 'bronze',    intensity: 0.45, edge: 0.25,
      title: 'Warm bronze wash',  text: 'A warm cocoa wash — enough to add depth and warmth without stealing from the lip.' },
    { key: 'eyeliner',  region: 'eyeliner',   product: 'eyeliner',   family: null,        intensity: 0.85,
      title: 'Clean wing',        text: 'A precise black line along the upper lashes — thin, sharp, classic.' },
    { key: 'lashes',    region: 'lashes',     product: 'mascara',    family: null,        intensity: 0.85,
      title: 'Defined lashes',    text: 'Two coats to frame the eye — let them dry between coats to separate.' },
    { key: 'lipLiner',  region: 'lipLiner',   product: 'lip-liner',  family: 'red',       intensity: 0.90,
      title: 'Red lip line',      text: 'Precise red liner at the natural edge — this is the architecture of the look.' },
    { key: 'lips',      region: 'lips',       product: 'lipstick',   family: 'red',       finish: 'matte', intensity: 0.85,
      title: 'Statement red',     text: 'Full-coverage matte red — apply, blot, reapply. Two layers for a rich, vivid stain.' },
  ],
};

// ── Lesson 5: Warm Bronze — golden-hour warmth, sun-kissed everything ────
const WARM_BRONZE = {
  title: 'Warm Bronze',
  steps: [
    { key: 'foundation', region: 'foundation', product: 'foundation', family: null,        finish: 'dewy', intensity: 0.20, edge: 0.18,
      title: 'Glowing base',      text: 'A sheer dewy layer — the warmth comes from the products, not the base.' },
    { key: 'underEye',  region: 'underEye',   product: 'concealer',  family: null,        intensity: 0.50, edge: 0.65,
      title: 'Brighten',          text: 'Just enough concealer to lift the under-eye — keep it luminous.' },
    { key: 'contour',   region: 'contour',    product: null,         family: 'contour',   intensity: 0.30, edge: 0.40,
      title: 'Warm sculpt',       text: 'A warm bronzy contour — this is sunlight carving shadows, not cool-toned chiselling.' },
    { key: 'blush',     region: 'blush',      product: 'blush',      family: 'peach',     finish: 'cream', intensity: 0.50, edge: 0.40,
      title: 'Sun-kissed peach',  text: 'Peach cream blush swept across the cheeks and nose bridge — like you just came in from outside.' },
    { key: 'highlight', region: 'highlight',  product: null,         family: 'champagne', intensity: 0.70, edge: 0.35,
      title: 'Maximum glow',      text: 'Generous champagne highlight everywhere the sun would hit — cheekbones, nose, brow bone, temples.' },
    { key: 'brows',     region: 'brows',      product: 'brows',      family: 'brow',      intensity: 0.50,
      title: 'Soft brows',        text: 'Groomed and natural — the brow stays soft in a warm look.' },
    { key: 'eyes',      region: 'eyes',       product: 'eyeshadow',  family: 'bronze',    finish: 'shimmer', intensity: 0.65, edge: 0.30,
      title: 'Molten bronze lid', text: 'Rich bronze shimmer packed on the lid — this is the golden-hour eye. Blend warm into the crease.' },
    { key: 'eyeliner',  region: 'eyeliner',   product: 'eyeliner',   family: null,        intensity: 0.65,
      title: 'Soft brown line',   text: 'A warm brown line smudged along the upper lashes — defined but not harsh.' },
    { key: 'lashes',    region: 'lashes',     product: 'mascara',    family: null,        intensity: 0.80,
      title: 'Full lashes',       text: 'Two coats for definition — let the bronze eye show through full, separated lashes.' },
    { key: 'lipLiner',  region: 'lipLiner',   product: 'lip-liner',  family: 'pink-nude', intensity: 0.70,
      title: 'Nude lip line',     text: 'A warm nude liner to frame the lip — just structure, no distraction from the eyes.' },
    { key: 'lips',      region: 'lips',       product: 'lipstick',   family: 'peach',     finish: 'gloss', intensity: 0.55,
      title: 'Peachy gloss',      text: 'A warm coral-nude gloss — juicy and bright but letting the bronze eye lead.' },
  ],
};

// ── Lesson 6: Emerald Night — jewel-toned green eye, burgundy lip ────────
const EMERALD_NIGHT = {
  title: 'Emerald Night',
  steps: [
    { key: 'foundation', region: 'foundation', product: 'foundation', family: null,        finish: 'natural', intensity: 0.28, edge: 0.20,
      title: 'Even base',         text: 'A natural satin base — clean canvas for the colour work ahead.' },
    { key: 'underEye',  region: 'underEye',   product: 'concealer',  family: null,        intensity: 0.55, edge: 0.60,
      title: 'Conceal',           text: 'Bright under-eyes — the dark green needs contrast underneath to pop.' },
    { key: 'contour',   region: 'contour',    product: null,         family: 'contour',   intensity: 0.20, edge: 0.45,
      title: 'Light sculpt',      text: 'Gentle contour to add dimension — the eyes are doing the heavy lifting here.' },
    { key: 'blush',     region: 'blush',      product: 'blush',      family: 'rosy',      intensity: 0.35, edge: 0.45,
      title: 'Cool rose blush',   text: 'A cool rose flush — keeps the palette in the jewel-tone family.' },
    { key: 'highlight', region: 'highlight',  product: null,         family: 'champagne', intensity: 0.55, edge: 0.40,
      title: 'Champagne glow',    text: 'Golden champagne on the high points — complements the green beautifully.' },
    { key: 'brows',     region: 'brows',      product: 'brows',      family: 'brow',      intensity: 0.60,
      title: 'Defined brows',     text: 'Strong brows to anchor the look — fill with clean, sharp strokes.' },
    { key: 'eyes',      region: 'eyes',       product: 'eyeshadow',  family: 'emerald',   finish: 'shimmer', intensity: 0.70, edge: 0.28,
      title: 'Emerald shimmer',   text: 'Rich emerald green packed onto the lid — the jewel of the look. Blend just past the crease.' },
    { key: 'eyeliner',  region: 'eyeliner',   product: 'eyeliner',   family: null,        intensity: 0.85,
      title: 'Black wing',        text: 'A sharp black wing — clean lines make the green look intentional, not accidental.' },
    { key: 'lashes',    region: 'lashes',     product: 'mascara',    family: null,        intensity: 0.85,
      title: 'Full lashes',       text: 'Two thick coats — lush lashes frame the emerald lid.' },
    { key: 'lipLiner',  region: 'lipLiner',   product: 'lip-liner',  family: 'berry',     intensity: 0.80,
      title: 'Deep lip line',     text: 'A deep berry-burgundy liner — the darkest shade to keep the lips rich but not competing.' },
    { key: 'lips',      region: 'lips',       product: 'lipstick',   family: 'burgundy',  finish: 'satin', intensity: 0.70,
      title: 'Burgundy lip',      text: 'A deep burgundy satin — luxurious and dark, letting the emerald eye remain the star.' },
  ],
};

// ── Lesson 7: Copper Sunset — fiery copper eye, coral lip ────────────────
const COPPER_SUNSET = {
  title: 'Copper Sunset',
  steps: [
    { key: 'foundation', region: 'foundation', product: 'foundation', family: null,        finish: 'dewy', intensity: 0.22, edge: 0.18,
      title: 'Dewy glow base',    text: 'A sheer dewy base — let the warmth come from the copper, not coverage.' },
    { key: 'underEye',  region: 'underEye',   product: 'concealer',  family: null,        intensity: 0.50, edge: 0.65,
      title: 'Quick brighten',    text: 'A dab under each eye — keep it light and warm.' },
    { key: 'contour',   region: 'contour',    product: null,         family: 'contour',   intensity: 0.22, edge: 0.42,
      title: 'Warm sculpt',       text: 'Bronzy contour in the hollows — warm shadows to match the copper story.' },
    { key: 'blush',     region: 'blush',      product: 'blush',      family: 'peach',     finish: 'cream', intensity: 0.55, edge: 0.40,
      title: 'Peach flush',       text: 'A warm peach cream blush swept across the cheeks and lightly over the nose bridge.' },
    { key: 'highlight', region: 'highlight',  product: null,         family: 'champagne', intensity: 0.65, edge: 0.38,
      title: 'Golden highlight',  text: 'Generous champagne-gold on every high point — this look is all about the glow.' },
    { key: 'brows',     region: 'brows',      product: 'brows',      family: 'brow',      intensity: 0.50,
      title: 'Soft brows',        text: 'Groomed and warm — don\'t overpower the eye with heavy brows.' },
    { key: 'eyes',      region: 'eyes',       product: 'eyeshadow',  family: 'copper',    finish: 'shimmer', intensity: 0.70, edge: 0.28,
      title: 'Copper fire lid',   text: 'Metallic copper shimmer pressed onto the lid — vivid, molten, and unapologetic. Blend warm into the crease.' },
    { key: 'eyeliner',  region: 'eyeliner',   product: 'eyeliner',   family: null,        intensity: 0.75,
      title: 'Smudged line',      text: 'A warm smudged line along the upper lashes — soft heat, not sharp edges.' },
    { key: 'lashes',    region: 'lashes',     product: 'mascara',    family: null,        intensity: 0.80,
      title: 'Full lashes',       text: 'Two coats — let the copper shimmer peek through separated lashes.' },
    { key: 'lipLiner',  region: 'lipLiner',   product: 'lip-liner',  family: 'peach',     intensity: 0.70,
      title: 'Warm lip line',     text: 'A warm brick-peach liner to frame without darkening the lip.' },
    { key: 'lips',      region: 'lips',       product: 'lipstick',   family: 'peach',     finish: 'gloss', intensity: 0.60,
      title: 'Coral gloss',       text: 'A juicy coral gloss — bright and warm, the perfect pairing with copper lids.' },
  ],
};

// ── Lesson 8: Sapphire Glam — bold blue eye, nude-pink lip ──────────────
const SAPPHIRE_GLAM = {
  title: 'Sapphire Glam',
  steps: [
    { key: 'foundation', region: 'foundation', product: 'foundation', family: null,        finish: 'matte', intensity: 0.28, edge: 0.20,
      title: 'Clean matte base',  text: 'A smooth matte base — the sapphire eye needs a clean canvas to shine.' },
    { key: 'underEye',  region: 'underEye',   product: 'concealer',  family: null,        intensity: 0.55, edge: 0.60,
      title: 'Bright under-eye',  text: 'Crisp concealer under the eyes — maximum contrast for the blue above.' },
    { key: 'contour',   region: 'contour',    product: null,         family: 'contour',   intensity: 0.18, edge: 0.48,
      title: 'Gentle contour',    text: 'Just enough to add structure — the eyes dominate this look.' },
    { key: 'blush',     region: 'blush',      product: 'blush',      family: 'rosy',      intensity: 0.35, edge: 0.45,
      title: 'Soft rose blush',   text: 'A cool-toned rose blush — keeps the palette cohesive with the blue.' },
    { key: 'highlight', region: 'highlight',  product: null,         family: 'champagne', intensity: 0.50, edge: 0.40,
      title: 'Silver-champagne',  text: 'Cool champagne highlight on the cheekbones and brow bone.' },
    { key: 'brows',     region: 'brows',      product: 'brows',      family: 'brow',      intensity: 0.60,
      title: 'Strong brows',      text: 'Bold, clean brows — the frame for a statement eye needs to match.' },
    { key: 'eyes',      region: 'eyes',       product: 'eyeshadow',  family: 'sapphire',  finish: 'shimmer', intensity: 0.70, edge: 0.28,
      title: 'Sapphire shimmer',  text: 'Deep sapphire blue packed on the lid with shimmer — intense, electric, and deliberately bold.' },
    { key: 'eyeliner',  region: 'eyeliner',   product: 'eyeliner',   family: null,        intensity: 0.90,
      title: 'Sharp black wing',  text: 'A dramatic black wing — graphic and precise to frame the blue.' },
    { key: 'lashes',    region: 'lashes',     product: 'mascara',    family: null,        intensity: 0.90,
      title: 'Maximum lashes',    text: 'Three coats, dramatic — lashes as bold as the eye colour.' },
    { key: 'lipLiner',  region: 'lipLiner',   product: 'lip-liner',  family: 'pink-nude', intensity: 0.70,
      title: 'Nude lip line',     text: 'A nude-pink liner — the lip stays quiet so the sapphire speaks.' },
    { key: 'lips',      region: 'lips',       product: 'lipstick',   family: 'pink-nude', finish: 'satin', intensity: 0.50,
      title: 'Soft nude lip',     text: 'A barely-there nude satin — all the attention goes to the eyes.' },
  ],
};

// All lessons in order. LESSON stays as the default (backwards compat).
export const LESSONS = [LESSON, CORAL_SUMMER, PLUM_SMOKE, BOLD_RED, WARM_BRONZE, EMERALD_NIGHT, COPPER_SUNSET, SAPPHIRE_GLAM];

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