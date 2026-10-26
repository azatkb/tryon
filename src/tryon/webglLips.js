// WebGL makeup renderer — the production path. One fragment-shader pass that
// lays products down in true MUA order, because what sits under what changes
// the result:
//   base    foundation → concealer        (concealer corrects ON TOP of base)
//   sculpt  contour → blush → highlight   (shadow first, then colour, glow last)
//   eyes    brows → shadow → liner → mascara
//   lips    liner → lipstick              (line first, colour over it)
// Layers also talk to each other where they physically must: contour suppresses
// blush and highlight in the hollow, since a surface can't be both a shadow and
// a high point. Luminance-preserving colour transfer keeps each region's
// texture; an auto white-balance holds the look across warm / side lighting.

import { buildLipMask, buildEyeMask, buildFaceMask, buildLashMask, buildBlushMask, buildSculptPack,
         buildLipLinerMask, buildEyelinerMask, buildBrowMask } from './lipRenderer.js';

let gl = null, canvas = null, prog = null, quadBuf = null;
let tex = {}, loc = {};
let available = null;

// Mask-upload cache. Masks depend only on landmark geometry and which regions
// are active, so these four let us detect "nothing that shapes a mask moved"
// and skip ten texture uploads — by far the most expensive work per frame.
let lastMaskKey = '', lastHairMask = null, lastLipOverride = null;
let lastGeom = null;

// Sub-pixel landmark drift doesn't change a mask that was built at half
// resolution and then blurred, so comparing by object identity alone would
// miss every chance to reuse one: the smoother hands back a fresh array each
// frame even when the face is perfectly still. Compare by content instead,
// with a threshold well under one pixel at 1080p (0.00015 ~ 0.16px).
const GEOM_EPS = 0.00015;

function geometryMoved(lms) {
  const n = lms.length;
  if (!lastGeom || lastGeom.length !== n * 2) {
    lastGeom = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { lastGeom[i * 2] = lms[i].x; lastGeom[i * 2 + 1] = lms[i].y; }
    return true;
  }
  for (let i = 0; i < n; i++) {
    if (Math.abs(lms[i].x - lastGeom[i * 2]) > GEOM_EPS) return storeGeom(lms);
    if (Math.abs(lms[i].y - lastGeom[i * 2 + 1]) > GEOM_EPS) return storeGeom(lms);
  }
  return false;
}
function storeGeom(lms) {
  for (let i = 0; i < lms.length; i++) {
    lastGeom[i * 2] = lms[i].x;
    lastGeom[i * 2 + 1] = lms[i].y;
  }
  return true;
}

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uFrame, uFnd, uBlush, uHair, uEye, uLash, uLip, uSculpt, uLipLiner, uEyeliner, uBrows;
uniform vec3 uFndShade, uBlushShade, uHairShade, uEyeShade, uLipShade, uWB, uLipLinerShade, uEyelinerShade, uBrowShade;
uniform float uFndInt, uBlushInt, uHairInt, uEyeInt, uLashInt, uLipInt;
uniform float uContourInt, uHighlightInt, uUnderEyeInt, uLipLinerInt, uEyelinerInt, uBrowInt;
uniform float uLight, uFinish, uFaceLum, uCinema;
uniform float uEyeFinish;  // 0=matte, 1=satin, 2=shimmer
uniform float uFndFinish;  // 0=powder/matte, 1=natural, 2=dewy/cream
uniform float uBlushFinish; // 0=powder, 1=cream
uniform vec2 uTexel;   // 1/w, 1/h — for multi-tap mask feathering

// ── MASK FEATHERING ─────────────────────────────────────────────────────────
// Masks arrive half-res with a canvas blur, but a linear alpha ramp still reads
// as having a visible start/end line. These do a true 3x3 Gaussian in texture
// space, then a smoothstep so the falloff is C1-continuous at both ends —
// that's what removes the perceived edge.
float softA(sampler2D s, vec2 uv, float r){
  vec2 o = uTexel * r;
  float a  = texture2D(s, uv).a * 4.0;
  a += texture2D(s, uv + vec2( o.x, 0.0)).a * 2.0;
  a += texture2D(s, uv + vec2(-o.x, 0.0)).a * 2.0;
  a += texture2D(s, uv + vec2( 0.0, o.y)).a * 2.0;
  a += texture2D(s, uv + vec2( 0.0,-o.y)).a * 2.0;
  a += texture2D(s, uv + vec2( o.x, o.y)).a;
  a += texture2D(s, uv + vec2(-o.x, o.y)).a;
  a += texture2D(s, uv + vec2( o.x,-o.y)).a;
  a += texture2D(s, uv + vec2(-o.x,-o.y)).a;
  return a * 0.0625;
}
vec3 softRGB(sampler2D s, vec2 uv, float r){
  vec2 o = uTexel * r;
  vec3 a  = texture2D(s, uv).rgb * 4.0;
  a += texture2D(s, uv + vec2( o.x, 0.0)).rgb * 2.0;
  a += texture2D(s, uv + vec2(-o.x, 0.0)).rgb * 2.0;
  a += texture2D(s, uv + vec2( 0.0, o.y)).rgb * 2.0;
  a += texture2D(s, uv + vec2( 0.0,-o.y)).rgb * 2.0;
  a += texture2D(s, uv + vec2( o.x, o.y)).rgb;
  a += texture2D(s, uv + vec2(-o.x, o.y)).rgb;
  a += texture2D(s, uv + vec2( o.x,-o.y)).rgb;
  a += texture2D(s, uv + vec2(-o.x,-o.y)).rgb;
  return a * 0.0625;
}
// Cheap 5-tap AA for thin features that must stay crisp (liner, lashes, brows)
float aaA(sampler2D s, vec2 uv){
  vec2 o = uTexel * 0.8;
  float a  = texture2D(s, uv).a * 2.0;
  a += texture2D(s, uv + vec2( o.x, o.y)).a;
  a += texture2D(s, uv + vec2(-o.x, o.y)).a;
  a += texture2D(s, uv + vec2( o.x,-o.y)).a;
  a += texture2D(s, uv + vec2(-o.x,-o.y)).a;
  return a / 6.0;
}
// Perceptual feather: flat derivative at 0 and 1 => no visible onset or plateau line
float feather(float a){ a = clamp(a, 0.0, 1.0); return a * a * (3.0 - 2.0 * a); }

// Hash dither — breaks up 8-bit banding in the wide soft gradients
float hash21(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

float lumv(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

// Rec.709 perceptual lightness (closer to how eyes see brightness)
float percL(vec3 c){
  vec3 l = vec3(0.2126, 0.7152, 0.0722);
  return dot(c, l);
}

vec3 clipColor(vec3 c){
  float l = lumv(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}
vec3 setLum(vec3 c, float l){ return clipColor(c + (l - lumv(c))); }

// Soft-light blend (Pegtop formula) — preserves texture under pigment
vec3 softLight(vec3 base, vec3 top){
  return base * base * (1.0 - 2.0 * top) + 2.0 * base * top;
}

// Photoshop-style 'Color' blend: take hue+sat from top, luma from base
vec3 blendColor(vec3 base, vec3 top){
  return setLum(top, lumv(base));
}

// Multiply: darken only (for contour/shadow)
vec3 blendMultiply(vec3 base, vec3 top){ return base * top; }

// Screen: lighten only (for highlight/concealer)
vec3 blendScreen(vec3 base, vec3 top){ return 1.0 - (1.0 - base) * (1.0 - top); }

// Exposure-normalised recolour: makeup colour at the skin's own luminance.
// Also adapts to skin depth — on darker skin, pigments need a warmer shift
// and slightly more saturation to read true to the physical product.
vec3 recolour(vec3 base, vec3 shade){
  float lum = clamp(percL(base) + (0.5 - uFaceLum) * 0.35, 0.0, 1.0);
  vec3 mk = setLum(shade, lum);
  float boosted = clamp(0.5 + (lum - 0.5) * 1.55, 0.0, 1.0);
  mk = setLum(mk, mix(lum, boosted, uLight * 0.7));
  // Skin-depth adaptation: darker skin absorbs cool wavelengths more,
  // so pigments read slightly warmer and need a saturation push.
  float depth = smoothstep(0.55, 0.20, uFaceLum); // 0 on light, ~1 on deep
  mk = mix(mk, mk * vec3(1.04, 1.00, 0.94), depth * 0.3); // warm shift
  return mk;
}

// Subsurface-scatter approximation for blush: warm transmission in mid-tones
vec3 sssBlend(vec3 base, vec3 pigment, float strength){
  float lum = percL(base);
  // SSS is strongest in mid-tones (skin is semi-translucent, not a mirror or cave)
  float sssFactor = 4.0 * lum * (1.0 - lum); // peaks at lum=0.5
  // Blend: color layer + soft-light warmth to simulate subsurface glow
  vec3 col  = blendColor(base, pigment);
  vec3 soft = softLight(base, pigment);
  return mix(base, mix(col, soft, sssFactor * 0.5), strength);
}

void main(){
  vec3 outc = clamp(texture2D(uFrame, vUv).rgb * uWB, 0.0, 1.0);
  vec3 orig = outc;          // preserved for post-processing texture re-injection
  float skinL = percL(outc);

  // ── Exposure normalisation ──────────────────────────────────────────────
  // uFaceLum = EMA mean luminance of the central face patch (0..1).
  // Every makeup layer scales so the look reads consistently from bright
  // daylight to a dim room: less pigment in shadow (contrast shrinks on
  // dark skin), a touch more in hard light (pigment washes out otherwise).
  float expOff = uFaceLum - 0.5;
  float expI   = clamp(1.0 + expOff * 0.7, 0.55, 1.25);

  // Skin / non-skin gate: thresholds track face brightness so that dim
  // skin still passes and bright nostrils are still excluded.
  float skinGate = smoothstep(
    clamp(0.05 + expOff * 0.10, 0.01, 0.10),
    clamp(0.24 + expOff * 0.30, 0.10, 0.40),
    skinL
  );

  // Sculpt pack: r=contour g=highlight b=under-eye.
  // These masks are built from blurred gradients — they have no hard edge to
  // soften, so feather() here would only eat amplitude (it maps 0.44 -> 0.40
  // and worse further down). A small extra tap is enough; the canvas blur has
  // already done the feathering.
  vec3 sc = softRGB(uSculpt, vUv, 4.0) * skinGate;

  // Wide secondary tap on the highlight channel — real specular on skin glows
  // a little past its own edge (eye and lens scatter), and that halo is most of
  // what sells "catching the light".
  float hiBloom = softRGB(uSculpt, vUv, 22.0).g * skinGate;

  // ── FOUNDATION: coverage-aware blend, finish-dependent surface ──────────────
  // Intensity drives coverage:  low (0.1-0.2) = sheer tint — lets almost all
  // skin through; mid (0.25-0.4) = medium — evens tone, pores still visible;
  // high (0.5+) = full — covers blemishes, only the deepest texture survives.
  float mf = feather(softA(uFnd, vUv, 7.0)) * uFndInt * skinGate * expI;
  if (mf > 0.001) {
    vec3 tinted = blendColor(outc, uFndShade);
    vec3 texd   = softLight(outc, uFndShade * 0.5 + 0.25);
    // Coverage ramp: sheer → full. Low intensity keeps mostly soft-light
    // (transparent tint), high intensity shifts toward opaque colour transfer.
    float coverage = smoothstep(0.0, 0.6, mf);
    outc = mix(outc, mix(texd, tinted, coverage * 0.7), mf);

    // Dewy finish: luminosity on face high-points (brow bone, nose bridge,
    // cheekbone) simulating light bouncing off a hydrated, cream-textured base.
    if (uFndFinish > 1.5) {
      float dewAmt = (uFndFinish - 1.0) * 0.5;  // 0..0.5
      float highPt = smoothstep(0.40, 0.75, skinL);
      outc += highPt * dewAmt * mf * vec3(0.06, 0.05, 0.03);
    }
    // Natural finish: the tiniest specular lift in highlights
    else if (uFndFinish > 0.5) {
      float sheen = smoothstep(0.55, 0.85, skinL) * 0.03;
      outc += sheen * mf * vec3(1.0, 0.97, 0.92);
    }
    // Matte/powder: flatten specular slightly
    else {
      outc = mix(outc, vec3(percL(outc)), smoothstep(0.65, 0.90, skinL) * 0.08 * mf);
    }
  }

  // ── UNDER-EYE CONCEALER: warm lift, kills blue-grey cast ────────────────────
  float mu = sc.b * uUnderEyeInt * expI;
  if (mu > 0.001) {
    float lum = percL(outc);
    // Kill cool cast first (blue-grey under-eye circles have low R, high B)
    vec3 warmShift = outc + vec3(0.04, 0.02, -0.03) * mu;
    // Then lift darkness via screen with warm ivory
    vec3 lifted = blendScreen(warmShift, vec3(0.98, 0.94, 0.88) * 0.22 * mu);
    outc = mix(outc, lifted, mu * 0.85);
  }

  // ── CONTOUR: a real shadow, not a tint ──────────────────────────────────────
  // Shadowed skin is darker, cooler and less saturated than lit skin: direct
  // warm light is blocked, so what fills the hollow is ambient skylight. The
  // multiply target is therefore well below neutral and biased to blue.
  float contourD = sc.r * uContourInt;   // raw density, reused by blush/highlight
  // The gate exists only to spare true black (hair, nostril, deep shadow) —
  // not to fade contour inside its own hollow, which is where it belongs.
  float mc = contourD * smoothstep(0.03 + expOff * 0.06, 0.16 + expOff * 0.20, percL(outc)) * expI;
  if (mc > 0.001) {
    float lum = percL(outc);
    vec3 shadow = blendMultiply(outc, vec3(0.52, 0.53, 0.60));
    // Pull toward grey — shadow on skin loses chroma as well as light
    shadow = mix(shadow, vec3(lum * 0.58), 0.22);
    outc = mix(outc, shadow, mc);
  }

  // ── BLUSH: SSS warm flush, powder vs cream, reduces where skin is red ───────
  float mb = softA(uBlush, vUv, 9.0) * uBlushInt * skinGate;
  mb *= 1.0 - contourD * 0.5;
  if (mb > 0.001) {
    float redness = smoothstep(0.02, 0.30, outc.r - (outc.g + outc.b) * 0.5);
    mb *= (1.0 - redness * 0.25) * expI;
    if (uBlushFinish > 0.5) {
      // CREAM BLUSH: more translucent, sits INTO the skin, subtle dewy sheen.
      // Cream pigments are more transparent and let more light through from
      // within — heavier SSS, less opaque colour overlay.
      outc = sssBlend(outc, uBlushShade, min(mb * 0.85, 1.0));
      // Gentle luminosity where cream catches light
      float creamSheen = smoothstep(0.45, 0.80, skinL) * 0.04 * mb;
      outc += creamSheen * vec3(1.0, 0.95, 0.88);
    } else {
      // POWDER BLUSH: sits ON skin, more matte deposit, original SSS blend.
      outc = sssBlend(outc, uBlushShade, min(mb, 1.0));
      // Powder absorbs a touch of specular on bright zones
      outc = mix(outc, vec3(percL(outc)), smoothstep(0.70, 0.92, skinL) * 0.05 * mb);
    }
  }

  // ── HIGHLIGHT: specular + luminance gate — only bright zones catch light ─────
  // A surface is either a high point catching light or a hollow in shadow — it
  // cannot be both, so contour cancels highlight where they overlap.
  float mhi = sc.g * uHighlightInt * (1.0 - contourD * 0.8) * expI;
  if (mhi > 0.001 || hiBloom > 0.001) {
    float lum = percL(outc);
    // Wide gates: a narrow smoothstep over face luminance shows up as a banding
    // ring on the cheekbone, so both ramps are stretched well past the data.
    float warmGate  = smoothstep(0.12, 0.72, lum);   // warm glow in mid-bright
    float specGate  = smoothstep(0.48, 0.96, lum);   // specular only where very bright
    // Warm champagne base glow
    vec3 warmGlow  = outc + mhi * warmGate * vec3(0.12, 0.09, 0.04) * 0.9;
    // Specular peak: near-white shimmer at the brightest points
    vec3 specPeak  = warmGlow + mhi * specGate * vec3(0.22, 0.20, 0.16) * 0.9;
    // Bloom: a faint warm lift spreading past the mask, gated to lit skin only
    specPeak += hiBloom * uHighlightInt * warmGate * vec3(0.05, 0.04, 0.02) * expI;
    outc = clamp(specPeak, 0.0, 1.0);
  }

  // ── HAIR ────────────────────────────────────────────────────────────────────
  float mh = feather(softA(uHair, vUv, 4.0)) * uHairInt * expI;
  if (mh > 0.001) outc = mix(outc, recolour(outc, uHairShade), mh);

  // ── BROWS: tint with texture preservation ───────────────────────────────────
  float mbr = aaA(uBrows, vUv) * uBrowInt * expI;
  if (mbr > 0.001) {
    vec3 tinted = blendColor(outc, uBrowShade);
    // darken softly in addition to colour (brows have depth)
    vec3 deepened = mix(tinted, blendMultiply(outc, uBrowShade * 1.2), 0.4);
    outc = mix(outc, deepened, mbr);
  }

  // ── EYESHADOW: colour blend + finish-aware surface (matte/satin/shimmer) ────
  float me = softA(uEye, vUv, 6.0) * uEyeInt * expI;
  if (me > 0.001) {
    float shadeL = percL(uEyeShade);
    vec3 col  = blendColor(outc, uEyeShade);
    vec3 soft = softLight(outc, uEyeShade);
    vec3 deep = blendMultiply(outc, uEyeShade * 1.35 + 0.08);

    float depth = smoothstep(0.78, 0.25, shadeL);
    vec3 pigment = mix(mix(col, soft, 0.30), deep, depth * 0.92);
    outc = mix(outc, pigment, me);

    // Finish-specific surface response for eyeshadow
    if (uEyeFinish > 1.5) {
      // SHIMMER: fine reflective particles catching light. Not a flat overlay —
      // noise-based sparkle that shifts with face luminance so particles
      // appear to glint as the head moves (seed changes each frame).
      float sparkle = hash21(vUv * 420.0 + fract(uFaceLum * 211.0));
      float sparkleMask = smoothstep(0.72, 0.95, sparkle);
      // Gate to lit zones: shimmer only catches where light hits the lid
      float litGate = smoothstep(0.25, 0.65, skinL);
      vec3 shimmerCol = mix(vec3(1.0, 0.98, 0.92), uEyeShade * 1.5 + 0.5, 0.3);
      outc += sparkleMask * litGate * me * shimmerCol * 0.35;
      // Broad satin base underneath the sparkle points
      float sheen = smoothstep(0.35, 0.75, skinL) * 0.08;
      outc += sheen * me * vec3(1.0, 0.97, 0.93);
    } else if (uEyeFinish > 0.5) {
      // SATIN: soft luminous sheen, no individual sparkle points
      float sheen = smoothstep(0.35, 0.78, skinL) * 0.06;
      outc += sheen * me * vec3(1.0, 0.97, 0.93);
    }
    // else MATTE: the base pigment deposit is already matte — no additions.
  }

  // ── EYELINER: near-black, slight texture absorption ─────────────────────────
  float mel = aaA(uEyeliner, vUv) * uEyelinerInt * expI;
  if (mel > 0.001) {
    // multiply then push toward liner colour — keeps a hint of skin texture
    vec3 liner = blendMultiply(outc, uEyelinerShade * 0.4);
    liner = mix(liner, uEyelinerShade, 0.85);
    outc = mix(outc, liner, mel);
  }

  // ── MASCARA LASHES: enhance, not obliterate ─────────────────────────────────
  // Real mascara coats individual lashes, darkening and thickening them while
  // still letting skin show between. A solid black block reads as eyeliner —
  // so we reduce opacity in thinner mask areas and let more skin texture bleed
  // through, creating the perception of separated, coated lashes.
  float ml2 = aaA(uLash, vUv) * uLashInt * expI;
  if (ml2 > 0.001) {
    // Mask density shapes the effect: dense centre (lash root) → near-opaque;
    // thin edges (lash tips) → translucent darkening only.
    float rawA = texture2D(uLash, vUv).a;
    float tipFade = smoothstep(0.10, 0.55, rawA); // tips stay sheer
    float lashStr = ml2 * mix(0.45, 1.0, tipFade);
    // Not pure black — a very dark version of the underlying pixel,
    // so skin texture is darkened rather than replaced.
    vec3 lashCol = outc * 0.08;
    outc = mix(outc, lashCol, lashStr);
  }

  // ── LIP LINER: goes down BEFORE the lipstick ────────────────────────────────
  // Lining first is the actual sequence, and it matters: the lipstick below
  // recolours whatever is already here, so the liner reads as a deeper edge
  // *through* the colour instead of a ring drawn on top of it.
  float mll = aaA(uLipLiner, vUv) * uLipLinerInt * expI;
  if (mll > 0.001) {
    vec3 liner = blendColor(outc, uLipLinerShade);
    liner = mix(liner, blendMultiply(outc, uLipLinerShade * 0.9), 0.3);
    outc = mix(outc, liner, mll);
  }

  // ── LIPS: finish-aware colour with ombre edge and SSS ───────────────────────
  float lipA = feather(softA(uLip, vUv, 2.5));
  float ml = lipA * uLipInt * expI;
  if (ml > 0.001) {
    float lum = percL(outc);
    vec3 mk = recolour(outc, uLipShade);

    // Ombre: edges are slightly deeper/cooler than centre (natural lip anatomy)
    float edgeFactor = 1.0 - smoothstep(0.04, 0.82, lipA);
    vec3 deepShade = blendMultiply(mk, uLipShade * 0.85 + 0.05);
    mk = mix(mk, deepShade, edgeFactor * 0.38);

    // Finish-specific surface response
    if (uFinish < 0.5) {
      // MATTE: flatten specular, slightly desaturate highlights
      mk = setLum(mk, clamp(0.45 + (lum - 0.5) * 0.65, 0.0, 1.0));
      mk = mix(mk, vec3(percL(mk)), smoothstep(0.6, 0.9, lum) * 0.2);
    } else if (uFinish < 1.5) {
      // SATIN: soft-light warmth lifts mid-tones, subtle sheen
      float sheen = smoothstep(0.5, 0.85, lum) * 0.22;
      mk = mix(mk, mk + sheen, 0.6);
    } else {
      // GLOSS: strong specular + SSS warmth at the cupid's bow
      float gloss = smoothstep(0.55, 0.95, lum);
      mk += gloss * gloss * vec3(0.55, 0.50, 0.45);
      // SSS warmth through the lip body
      mk = mix(mk, sssBlend(mk, uLipShade * 1.1, 0.3), 0.25);
    }
    outc = mix(outc, mk, ml);
  }

  // ── POST-PROCESSING: unify synthetic masks with camera texture ──────────
  // Makeup gradients are clean and synthetic; the camera feed has sensor
  // grain, pore texture and micro-contrast.  Without reconciliation the
  // made-up areas read as airbrushed against the untouched skin.

  // 1. Skin micro-texture re-injection
  //    High-pass the original frame (3×3 Gaussian blur subtracted from the
  //    raw sample) to isolate pores, grain and fine wrinkles.  Lay it back
  //    on top of the makeup, proportional to how much the pixel actually
  //    changed — untouched skin gets zero extra, heavy makeup gets full
  //    texture so it never looks plastic.
  //    Lip region gets stronger injection so lip lines remain visible through
  //    product — real lipstick sits in the creases, it doesn't erase them.
  vec3 origLow = clamp(softRGB(uFrame, vUv, 3.0) * uWB, 0.0, 1.0);
  vec3 detail  = orig - origLow;
  float delta  = clamp(length(outc - orig) * 5.0, 0.0, 1.0);
  float lipZone = feather(softA(uLip, vUv, 2.5)) * uLipInt;
  float texStr  = mix(0.7, 1.1, lipZone);  // lips get 1.1× texture vs 0.7× elsewhere
  outc += detail * delta * texStr;

  // 2. Cinematic look (uCinema 0..1 — off to full)
  //    Lift-gamma-gain colour grade, S-curve contrast, soft bloom on
  //    bright skin, vignette. All one pass, no extra textures.
  if (uCinema > 0.001) {
    float ci = uCinema;

    // ── Lift / Gamma / Gain ──
    // Warm shadows (lift), neutral mids (gamma), cool-warm highlights (gain).
    vec3 lifted = outc + vec3(0.020, 0.012, 0.005) * ci;       // warm amber lift
    vec3 gained = lifted * (1.0 + vec3(0.03, 0.01, -0.02) * ci); // gain: warm highs
    // Gamma nudge — push midtones slightly warm
    outc = pow(max(gained, 0.0), vec3(1.0 - 0.04 * ci, 1.0 - 0.02 * ci, 1.0 + 0.01 * ci));

    // ── S-curve contrast ──
    // Pegtop soft-light of the image on itself = classic S-curve.  Blend is
    // subtle so skin tones stay natural and shadow detail isn't crushed.
    vec3 sCurve = 2.0 * outc * outc * (3.0 - 2.0 * outc);  // smoothstep polynomial
    outc = mix(outc, sCurve, 0.22 * ci);

    // ── Soft bloom on bright zones ──
    // A wide Gaussian of the original frame gives the glow; gated to bright
    // pixels so it reads as lens diffusion, not fog.
    vec3 bloom = clamp(softRGB(uFrame, vUv, 18.0) * uWB, 0.0, 1.0);
    float bloomGate = smoothstep(0.50, 0.85, percL(bloom));
    outc += bloom * bloomGate * 0.08 * ci;

    // ── Vignette ──
    // Darkens corners, keeps the face centred.  Elliptical so it works on
    // both portrait and landscape aspect ratios.
    vec2 vc = vUv - 0.5;
    float vignette = 1.0 - smoothstep(0.35, 0.95, length(vc * vec2(1.1, 1.0)));
    outc *= mix(1.0, vignette, 0.35 * ci);
  }

  // 3. Camera-matched grain
  //    Sensor noise is heavier in shadows (high ISO / low-light regions).
  //    The hash seed includes uFaceLum, which shifts slightly each frame,
  //    so the grain pattern never freezes into a static texture.
  //    With cinema on, grain is scaled up toward a 35mm film look.
  float grain    = hash21(vUv * 768.0 + fract(uFaceLum * 137.0)) - 0.5;
  float grainBase = mix(0.010, 0.003, clamp(skinL * 1.5, 0.0, 1.0));
  float grainAmt  = grainBase * (1.0 + uCinema * 1.2);   // heavier grain in cinema mode
  outc += grain * grainAmt;

  // 4. Anti-banding dither (targets gradient quantisation steps, not film
  //    grain — the two operate at different spatial frequencies).
  float d = (hash21(vUv * 1024.0 + fract(uFaceLum * 97.0)) - 0.5) * 0.0039;
  gl_FragColor = vec4(clamp(outc + d, 0.0, 1.0), 1.0);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
  return s;
}

export function glAvailable() {
  if (available !== null) return available;
  try {
    const c = document.createElement('canvas');
    available = !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch (_) { available = false; }
  return available;
}

function makeTex() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

function initGL() {
  if (gl) return true;
  canvas = document.createElement('canvas');
  gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true })
     || canvas.getContext('experimental-webgl');
  if (!gl) return false;
  prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  gl.useProgram(prog);

  quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const ap = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(ap);
  gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);

  for (const u of ['uFrame','uFnd','uBlush','uHair','uEye','uLash','uLip','uSculpt','uLipLiner','uEyeliner','uBrows',
                   'uFndShade','uBlushShade','uHairShade','uEyeShade','uLipShade','uWB','uLipLinerShade','uEyelinerShade','uBrowShade',
                   'uFndInt','uBlushInt','uHairInt','uEyeInt','uLashInt','uLipInt',
                   'uContourInt','uHighlightInt','uUnderEyeInt','uLipLinerInt','uEyelinerInt','uBrowInt',
                   'uLight','uFinish','uFaceLum','uCinema','uEyeFinish','uFndFinish','uBlushFinish','uTexel']) {
    loc[u] = gl.getUniformLocation(prog, u);
  }
  tex = { frame: makeTex(), fnd: makeTex(), blush: makeTex(), hair: makeTex(), eye: makeTex(), lash: makeTex(), lip: makeTex(), sculpt: makeTex(), lipLiner: makeTex(), eyeliner: makeTex(), brows: makeTex() };
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  return true;
}

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
const FINISH_CODE = { matte: 0, satin: 1, gloss: 2 };

let blankCv;
function blank() {
  if (!blankCv) { blankCv = document.createElement('canvas'); blankCv.width = blankCv.height = 1; }
  return blankCv;
}
function upload(unit, t, src) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
}

/**
 * Render frame + makeup. opts: { foundation, underEye, contour, blush, highlight,
 * hair, eyes, lashes, lips, wb:[r,g,b] } — each region optional.
 */
export function renderMakeupGL(source, w, h, landmarks, opts) {
  if (!glAvailable() || !initGL()) return null;
  if (!landmarks || landmarks.length < 468) return null;
  const { foundation, underEye, contour, blush, highlight, hair, eyes, lashes, lips, lipLiner, eyeliner, brows, wb } = opts;

  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h);
  gl.useProgram(prog);

  // The frame itself always changes, so it always goes up.
  upload(0, tex.frame, source);

  // Masks are pure geometry: same landmarks + same active regions => byte-identical
  // textures. Re-uploading them is the single most expensive thing this function
  // does (a 1080p texture upload measured ~200x the cost of building the mask
  // that fills it), so skip it whenever nothing that shapes them has moved.
  // Colour, finish and intensity are uniforms, not masks — changing a shade
  // never invalidates this cache.
  const key = `${w}x${h}|${!!foundation}${!!blush}${!!eyes}${!!lashes}${!!lips}`
            + `${!!(hair && hair.mask)}${!!lipLiner}${!!eyeliner}${!!brows}`
            + `${!!contour}${!!highlight}${!!underEye}`;
  const lipOverride = lips?.overrideMask || null;

  // Evaluate the geometry check first, not inside an || chain — it also
  // refreshes the stored snapshot, and short-circuiting past it would leave
  // that snapshot stale.
  const moved = geometryMoved(landmarks);
  const changed = moved
    || key !== lastMaskKey
    || hair?.mask !== lastHairMask
    || lipOverride !== lastLipOverride;

  if (changed) {
    const sculptOn = !!(contour || highlight || underEye);
    upload(1, tex.fnd, foundation ? buildFaceMask(w, h, landmarks) : blank());
    upload(2, tex.blush, blush ? buildBlushMask(w, h, landmarks) : blank());
    upload(3, tex.hair, (hair && hair.mask) ? hair.mask : blank());
    upload(4, tex.eye, eyes ? buildEyeMask(w, h, landmarks) : blank());
    upload(5, tex.lash, lashes ? buildLashMask(w, h, landmarks) : blank());
    upload(6, tex.lip, lips ? buildLipMask(w, h, landmarks, lips) : blank());
    upload(7, tex.sculpt, sculptOn
      ? buildSculptPack(w, h, landmarks, { contour: !!contour, highlight: !!highlight, underEye: !!underEye })
      : blank());
    upload(8, tex.lipLiner, lipLiner ? buildLipLinerMask(w, h, landmarks) : blank());
    upload(9, tex.eyeliner, eyeliner ? buildEyelinerMask(w, h, landmarks) : blank());
    upload(10, tex.brows, brows ? buildBrowMask(w, h, landmarks) : blank());
    lastMaskKey = key;
    lastHairMask = hair?.mask || null;
    lastLipOverride = lipOverride;
  }

  gl.uniform1i(loc.uFrame, 0); gl.uniform1i(loc.uFnd, 1); gl.uniform1i(loc.uBlush, 2);
  gl.uniform1i(loc.uHair, 3); gl.uniform1i(loc.uEye, 4); gl.uniform1i(loc.uLash, 5);
  gl.uniform1i(loc.uLip, 6); gl.uniform1i(loc.uSculpt, 7);
  gl.uniform1i(loc.uLipLiner, 8); gl.uniform1i(loc.uEyeliner, 9); gl.uniform1i(loc.uBrows, 10);

  gl.uniform3fv(loc.uFndShade, hexToRgb(foundation ? foundation.color : '#000000'));
  gl.uniform3fv(loc.uBlushShade, hexToRgb(blush ? blush.color : '#000000'));
  gl.uniform3fv(loc.uHairShade, hexToRgb(hair ? hair.color : '#000000'));
  gl.uniform3fv(loc.uEyeShade, hexToRgb(eyes ? eyes.color : '#000000'));
  gl.uniform3fv(loc.uLipShade, hexToRgb(lips ? lips.color : '#000000'));
  gl.uniform3fv(loc.uLipLinerShade, hexToRgb(lipLiner ? lipLiner.color : '#000000'));
  gl.uniform3fv(loc.uEyelinerShade, hexToRgb(eyeliner ? eyeliner.color : '#0a0a0a'));
  gl.uniform3fv(loc.uBrowShade, hexToRgb(brows ? brows.color : '#000000'));
  gl.uniform3fv(loc.uWB, wb && wb.length === 3 ? wb : [1, 1, 1]);

  gl.uniform1f(loc.uFndInt, foundation ? (foundation.intensity ?? 0.25) : 0);
  gl.uniform1f(loc.uBlushInt, blush ? (blush.intensity ?? 0.4) : 0);
  gl.uniform1f(loc.uHairInt, (hair && hair.mask) ? (hair.intensity ?? 0.7) : 0);
  gl.uniform1f(loc.uEyeInt, eyes ? (eyes.intensity ?? 0.5) : 0);
  gl.uniform1f(loc.uLashInt, lashes ? (lashes.intensity ?? 0.8) : 0);
  gl.uniform1f(loc.uLipInt, lips ? (lips.intensity ?? 0.7) : 0);
  gl.uniform1f(loc.uContourInt, contour ? (contour.intensity ?? 0.35) : 0);
  gl.uniform1f(loc.uHighlightInt, highlight ? (highlight.intensity ?? 0.5) : 0);
  gl.uniform1f(loc.uUnderEyeInt, underEye ? (underEye.intensity ?? 0.4) : 0);
  gl.uniform1f(loc.uLipLinerInt, lipLiner ? (lipLiner.intensity ?? 0.8) : 0);
  gl.uniform1f(loc.uEyelinerInt, eyeliner ? (eyeliner.intensity ?? 0.9) : 0);
  gl.uniform1f(loc.uBrowInt, brows ? (brows.intensity ?? 0.6) : 0);

  gl.uniform1f(loc.uLight, (lips?.lightResponse ?? eyes?.lightResponse ?? 0.5));
  gl.uniform1f(loc.uFinish, FINISH_CODE[lips?.finish] ?? 1);
  gl.uniform1f(loc.uFaceLum, typeof opts.faceLum === 'number' ? opts.faceLum : 0.5);
  gl.uniform1f(loc.uCinema, typeof opts.cinema === 'number' ? opts.cinema : 0);

  // Per-region finish codes: 0=matte/powder, 1=satin/natural, 2=shimmer/dewy/cream
  const EYE_FINISH = { matte: 0, satin: 1, shimmer: 2 };
  const FND_FINISH = { matte: 0, powder: 0, natural: 1, satin: 1, dewy: 2, cream: 2 };
  const BLUSH_FINISH = { powder: 0, matte: 0, cream: 1 };
  gl.uniform1f(loc.uEyeFinish, EYE_FINISH[eyes?.finish] ?? 0);
  gl.uniform1f(loc.uFndFinish, FND_FINISH[foundation?.finish] ?? 1);
  gl.uniform1f(loc.uBlushFinish, BLUSH_FINISH[blush?.finish] ?? 0);

  gl.uniform2f(loc.uTexel, 1 / w, 1 / h);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas;
}