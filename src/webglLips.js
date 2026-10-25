// WebGL makeup renderer — the production path. One fragment-shader pass, MUA order:
// foundation, under-eye brighten, contour, blush, highlight, hair, eyeshadow,
// lashes, lips. Luminance-preserving colour transfer keeps each region's texture;
// an auto white-balance keeps the look consistent across warm / side lighting.

import { buildLipMask, buildEyeMask, buildFaceMask, buildLashMask, buildBlushMask, buildSculptPack,
         buildLipLinerMask, buildEyelinerMask, buildBrowMask } from './lipRenderer.js';

let gl = null, canvas = null, prog = null, quadBuf = null;
let tex = {}, loc = {};
let available = null;

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
uniform float uLight, uFinish, uFaceLum;
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

// Exposure-normalised recolour: makeup colour at the skin's own luminance
vec3 recolour(vec3 base, vec3 shade){
  float lum = clamp(percL(base) + (0.5 - uFaceLum) * 0.35, 0.0, 1.0);
  vec3 mk = setLum(shade, lum);
  float boosted = clamp(0.5 + (lum - 0.5) * 1.55, 0.0, 1.0);
  return setLum(mk, mix(lum, boosted, uLight * 0.7));
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
  float skinL = percL(outc);
  // Guard: never let soft makeup spill onto hair, nostrils or deep shadow —
  // that boundary is where a hard edge would otherwise show.
  float skinGate = smoothstep(0.05, 0.24, skinL);

  // Sculpt pack feathered wide: r=contour g=highlight b=under-eye
  vec3 sc = softRGB(uSculpt, vUv, 9.0);
  sc = vec3(feather(sc.r), feather(sc.g), feather(sc.b)) * skinGate;

  // ── FOUNDATION: match skin tone, preserve micro-texture via soft-light ──────
  float mf = feather(softA(uFnd, vUv, 7.0)) * uFndInt * skinGate;
  if (mf > 0.001) {
    vec3 tinted = blendColor(outc, uFndShade); // hue+sat from shade, luma stays
    vec3 texd   = softLight(outc, uFndShade * 0.5 + 0.25); // texture-preserving lift
    outc = mix(outc, mix(tinted, texd, 0.35), mf);
  }

  // ── UNDER-EYE CONCEALER: warm lift, kills blue-grey cast ────────────────────
  float mu = sc.b * uUnderEyeInt;
  if (mu > 0.001) {
    float lum = percL(outc);
    // Kill cool cast first (blue-grey under-eye circles have low R, high B)
    vec3 warmShift = outc + vec3(0.04, 0.02, -0.03) * mu;
    // Then lift darkness via screen with warm ivory
    vec3 lifted = blendScreen(warmShift, vec3(0.98, 0.94, 0.88) * 0.22 * mu);
    outc = mix(outc, lifted, mu * 0.85);
  }

  // ── CONTOUR: skin-relative darkening — multiply + desaturate, no cast ───────
  // Fades out in already-dark skin so it can't crush shadows into a hard patch.
  float mc = sc.r * uContourInt * smoothstep(0.10, 0.38, percL(outc));
  if (mc > 0.001) {
    float lum = percL(outc);
    // Darken by multiplying with a neutral desaturated version → cool shadow
    vec3 shadow = blendMultiply(outc, vec3(0.72, 0.70, 0.74));
    // Slight desaturation pull to look more like a real matte powder
    vec3 desat  = vec3(lum);
    shadow = mix(shadow, desat * 0.85, 0.15);
    outc = mix(outc, shadow, mc);
  }

  // ── BLUSH: SSS warm flush, reduces where skin is already red ────────────────
  float mb = feather(softA(uBlush, vUv, 9.0)) * uBlushInt * skinGate;
  if (mb > 0.001) {
    // Already-pink skin gets less blush — smoothstep, not clamp, so the
    // roll-off across the cheek has no visible contour line
    float redness = smoothstep(0.02, 0.30, outc.r - (outc.g + outc.b) * 0.5);
    mb *= 1.0 - redness * 0.45;
    outc = sssBlend(outc, uBlushShade, mb);
  }

  // ── HIGHLIGHT: specular + luminance gate — only bright zones catch light ─────
  float mhi = sc.g * uHighlightInt;
  if (mhi > 0.001) {
    float lum = percL(outc);
    // Wide gates: a narrow smoothstep over face luminance shows up as a banding
    // ring on the cheekbone, so both ramps are stretched well past the data.
    float warmGate  = smoothstep(0.12, 0.72, lum);   // warm glow in mid-bright
    float specGate  = smoothstep(0.48, 0.96, lum);   // specular only where very bright
    // Warm champagne base glow
    vec3 warmGlow  = outc + mhi * warmGate  * vec3(0.12, 0.09, 0.04) * 0.9;
    // Specular peak: near-white shimmer at the brightest points
    vec3 specPeak  = warmGlow + mhi * specGate * specGate * vec3(0.22, 0.20, 0.16) * 0.8;
    outc = clamp(specPeak, 0.0, 1.0);
  }

  // ── HAIR ────────────────────────────────────────────────────────────────────
  float mh = feather(softA(uHair, vUv, 4.0)) * uHairInt;
  if (mh > 0.001) outc = mix(outc, recolour(outc, uHairShade), mh);

  // ── BROWS: tint with texture preservation ───────────────────────────────────
  float mbr = aaA(uBrows, vUv) * uBrowInt;
  if (mbr > 0.001) {
    vec3 tinted = blendColor(outc, uBrowShade);
    // darken softly in addition to colour (brows have depth)
    vec3 deepened = mix(tinted, blendMultiply(outc, uBrowShade * 1.2), 0.4);
    outc = mix(outc, deepened, mbr);
  }

  // ── EYESHADOW: colour blend + soft-light warmth for pigment depth ────────────
  float me = feather(softA(uEye, vUv, 6.0)) * uEyeInt;
  if (me > 0.001) {
    vec3 col  = blendColor(outc, uEyeShade);
    vec3 soft = softLight(outc, uEyeShade);
    // heavier shadows need more multiply depth
    float lum = percL(uEyeShade);
    vec3 deep = blendMultiply(outc, uEyeShade + 0.1);
    outc = mix(outc, mix(mix(col, soft, 0.4), deep, smoothstep(0.48, 0.12, lum) * 0.5), me);
  }

  // ── EYELINER: near-black, slight texture absorption ─────────────────────────
  float mel = aaA(uEyeliner, vUv) * uEyelinerInt;
  if (mel > 0.001) {
    // multiply then push toward liner colour — keeps a hint of skin texture
    vec3 liner = blendMultiply(outc, uEyelinerShade * 0.4);
    liner = mix(liner, uEyelinerShade, 0.85);
    outc = mix(outc, liner, mel);
  }

  // ── MASCARA LASHES: pure black overlay, feathered alpha ─────────────────────
  float ml2 = aaA(uLash, vUv) * uLashInt;
  if (ml2 > 0.001) {
    // Tiny desaturated version of underlying skin leaked through for anti-aliasing
    vec3 lashCol = mix(vec3(0.04, 0.03, 0.04), outc * 0.08, 0.12);
    outc = mix(outc, lashCol, ml2);
  }

  // ── LIPS: finish-aware colour with ombre edge and SSS ───────────────────────
  float lipA = feather(softA(uLip, vUv, 2.5));
  float ml = lipA * uLipInt;
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

  // ── LIP LINER: crisp inner ring, slightly deeper than lip colour ─────────────
  float mll = aaA(uLipLiner, vUv) * uLipLinerInt;
  if (mll > 0.001) {
    vec3 liner = blendColor(outc, uLipLinerShade);
    liner = mix(liner, blendMultiply(outc, uLipLinerShade * 0.9), 0.3);
    outc = mix(outc, liner, mll);
  }

  // ── DITHER: ±0.5/255 of noise. The soft regions are wide, shallow gradients;
  // at 8 bit they quantise into visible contour rings. This dissolves them.
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
                   'uLight','uFinish','uFaceLum','uTexel']) {
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

  const fndMask = foundation ? buildFaceMask(w, h, landmarks) : blank();
  const blushMask = blush ? buildBlushMask(w, h, landmarks) : blank();
  const eyeMask = eyes ? buildEyeMask(w, h, landmarks) : blank();
  const lashMask = lashes ? buildLashMask(w, h, landmarks) : blank();
  const lipMask = lips ? buildLipMask(w, h, landmarks, lips) : blank();
  const hairMask = (hair && hair.mask) ? hair.mask : blank();
  const lipLinerMask = lipLiner ? buildLipLinerMask(w, h, landmarks) : blank();
  const eyelinerMask = eyeliner ? buildEyelinerMask(w, h, landmarks) : blank();
  const browMask = brows ? buildBrowMask(w, h, landmarks) : blank();
  const sculptOn = !!(contour || highlight || underEye);
  const sculptMask = sculptOn ? buildSculptPack(w, h, landmarks, { contour: !!contour, highlight: !!highlight, underEye: !!underEye }) : blank();

  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h);
  gl.useProgram(prog);

  upload(0, tex.frame, source);
  upload(1, tex.fnd, fndMask);
  upload(2, tex.blush, blushMask);
  upload(3, tex.hair, hairMask);
  upload(4, tex.eye, eyeMask);
  upload(5, tex.lash, lashMask);
  upload(6, tex.lip, lipMask);
  upload(7, tex.sculpt, sculptMask);
  upload(8, tex.lipLiner, lipLinerMask);
  upload(9, tex.eyeliner, eyelinerMask);
  upload(10, tex.brows, browMask);

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
  gl.uniform2f(loc.uTexel, 1 / w, 1 / h);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas;
}