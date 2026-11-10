// webglMultiPass.js — Multi-pass makeup rendering pipeline.
//
// Splits the single-pass composite into 4 FBO passes:
//   Pass 1 (Base):  foundation, under-eye, contour, blush, highlight, bronzer, nose contour
//   Pass 2 (Eyes):  brows, eyeshadow, eyeliner, lashes
//   Pass 3 (Lips):  lip liner, lipstick, hair
//   Pass 4 (Post):  texture re-injection, cinema, grain, glamour
//
// Benefits over single-pass:
//   • Per-group texture re-injection — each product group gets skin pores back
//   • Fewer texture units per pass (max 6 vs 12) — wider device support
//   • Each group composites on ACTUAL result of previous group
//   • Intermediate blur between passes (foundation "settles" before sculpting)

import { initLipMesh, renderLipMesh, lipMesh3DAvailable } from './lipMesh3D.js';
import { setActiveLipSeg, buildLipMask, buildEyeMask, buildFaceMask, buildLashMask, buildBlushMask,
         buildSculptPack, buildExtraPack, buildLipLinerMask, buildEyelinerMask,
         buildBrowMask, CFG } from './lipRenderer.js';
import { lash3dAvailable, renderLashes3D } from './lashRenderer3D.js';

let gl = null, canvas = null;
let quadBuf = null;
let fboA = null, fboB = null, fboTexA = null, fboTexB = null;
let fboW = 0, fboH = 0;
// Per-pass programs and locations
let passes = {};
let texPool = {};  // reusable textures for mask uploads
let lipTexObj = null, lastLipTexSrc = null;  // lip product texture (unit 14)

// Mask cache (same logic as single-pass)
let lastMaskKey = '', lastHairMask = null, lastLipOverride = null, lastGeom = null, lastLipSegVer = -1;
const GEOM_EPS = 0.00015;

function geometryMoved(lms) {
  const n = lms.length;
  if (!lastGeom || lastGeom.length !== n * 2) {
    lastGeom = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { lastGeom[i * 2] = lms[i].x; lastGeom[i * 2 + 1] = lms[i].y; }
    return true;
  }
  for (let i = 0; i < n; i++) {
    if (Math.abs(lms[i].x - lastGeom[i * 2]) > GEOM_EPS ||
        Math.abs(lms[i].y - lastGeom[i * 2 + 1]) > GEOM_EPS) {
      for (let j = 0; j < n; j++) { lastGeom[j * 2] = lms[j].x; lastGeom[j * 2 + 1] = lms[j].y; }
      return true;
    }
  }
  return false;
}

// ── Shared vertex shader ──────────────────────────────────────────────────
const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// ── Common GLSL functions shared across all passes ────────────────────────
const GLSL_COMMON = `
precision highp float;
varying vec2 vUv;
uniform vec2 uTexel;
uniform float uFaceLum;

float lumv(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float percL(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 clipColor(vec3 c){
  float l = lumv(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}
vec3 setLum(vec3 c, float l){ return clipColor(c + (l - lumv(c))); }
vec3 softLight(vec3 base, vec3 top){ return base * base * (1.0 - 2.0 * top) + 2.0 * base * top; }
vec3 blendColor(vec3 base, vec3 top){ return setLum(top, lumv(base)); }
vec3 blendMultiply(vec3 base, vec3 top){ return base * top; }
vec3 blendScreen(vec3 base, vec3 top){ return 1.0 - (1.0 - base) * (1.0 - top); }
float hash21(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float feather(float a){ a = clamp(a, 0.0, 1.0); return a * a * (3.0 - 2.0 * a); }

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
float aaA(sampler2D s, vec2 uv){
  vec2 o = uTexel * 0.8;
  float a  = texture2D(s, uv).a * 2.0;
  a += texture2D(s, uv + vec2( o.x, o.y)).a;
  a += texture2D(s, uv + vec2(-o.x, o.y)).a;
  a += texture2D(s, uv + vec2( o.x,-o.y)).a;
  a += texture2D(s, uv + vec2(-o.x,-o.y)).a;
  return a / 6.0;
}

vec3 recolour(vec3 base, vec3 shade){
  float lum = clamp(percL(base) + (0.5 - uFaceLum) * 0.35, 0.0, 1.0);
  vec3 mk = setLum(shade, lum);
  float boosted = clamp(0.5 + (lum - 0.5) * 1.55, 0.0, 1.0);
  float depth = smoothstep(0.55, 0.20, uFaceLum);
  mk = mix(mk, mk * vec3(1.04, 1.00, 0.94), depth * 0.3);
  return mk;
}
vec3 sssBlend(vec3 base, vec3 pigment, float strength){
  float lum = percL(base);
  float sssFactor = 4.0 * lum * (1.0 - lum);
  vec3 col  = blendColor(base, pigment);
  vec3 soft = softLight(base, pigment);
  return mix(base, mix(col, soft, sssFactor * 0.5), strength);
}

// Per-pass texture re-injection: high-pass original frame, blend into result
// proportional to how much the pixel changed. Lighter than final post pass.
vec3 injectTexture(vec3 result, vec3 origSample, vec3 origBlur, float strength){
  vec3 detail = origSample - origBlur;
  float delta = clamp(length(result - origSample) * 5.0, 0.0, 1.0);
  return result + detail * delta * strength;
}
`;

// ── PASS 1: BASE ──────────────────────────────────────────────────────────
// Foundation, under-eye concealer, contour, blush, highlight, bronzer, nose contour
const FRAG_BASE = GLSL_COMMON + `
uniform sampler2D uFrame, uFnd, uSculpt, uBlush, uExtra;
uniform vec3 uFndShade, uBlushShade, uBronzerShade, uUnderEyeShade, uWB;
uniform float uFndInt, uBlushInt, uContourInt, uHighlightInt, uBronzerInt;
uniform float uNoseContourInt, uUnderEyeInt;
uniform float uFndFinish, uBlushFinish;
uniform float uLight, uLightBal, uFaceYaw;

void main(){
  vec3 outc = clamp(texture2D(uFrame, vUv).rgb * uWB, 0.0, 1.0);
  float skinL = percL(outc);
  float expOff = uFaceLum - 0.5;
  float expI = clamp(1.0 + expOff * 0.7, 0.55, 1.25);
  float skinGate = smoothstep(
    clamp(0.05 + expOff * 0.10, 0.01, 0.10),
    clamp(0.24 + expOff * 0.30, 0.10, 0.40), skinL);

  // Sculpt + extra packs
  vec3 sc = softRGB(uSculpt, vUv, 4.0) * skinGate;
  vec3 ex = softRGB(uExtra, vUv, 4.0) * skinGate;
  float hiBloom = softRGB(uSculpt, vUv, 22.0).g * skinGate;

  // ── Foundation ──
  float mf = feather(texture2D(uFnd, vUv).a) * uFndInt * skinGate * expI;
  if (mf > 0.001) {
    vec3 tinted = blendColor(outc, uFndShade);
    vec3 texd = softLight(outc, uFndShade * 0.5 + 0.25);
    float coverage = smoothstep(0.0, 0.6, mf);
    outc = mix(outc, mix(texd, tinted, coverage * 0.7), mf);
    if (uFndFinish > 1.5) {
      float dewAmt = (uFndFinish - 1.0) * 0.5;
      float highPt = smoothstep(0.40, 0.75, skinL);
      outc += highPt * dewAmt * mf * vec3(0.06, 0.05, 0.03);
    } else if (uFndFinish > 0.5) {
      float sheen = smoothstep(0.55, 0.85, skinL) * 0.03;
      outc += sheen * mf * vec3(1.0, 0.97, 0.92);
    } else {
      outc = mix(outc, vec3(percL(outc)), smoothstep(0.65, 0.90, skinL) * 0.08 * mf);
    }
  }

  // ── Under-eye concealer ──
  float mu = sc.b * uUnderEyeInt * expI;
  if (mu > 0.001) {
    vec3 ueShade = (uUnderEyeShade.r + uUnderEyeShade.g + uUnderEyeShade.b < 0.01)
                   ? vec3(0.98, 0.94, 0.88) : uUnderEyeShade;
    vec3 warmShift = outc + (ueShade - vec3(0.5)) * 0.12 * mu;
    vec3 lifted = blendScreen(warmShift, ueShade * 0.22 * mu);
    outc = mix(outc, lifted, mu * 0.85);
  }

  // ── Contour ──
  float contourD = sc.r * uContourInt;
  float yawFade = 1.0 - smoothstep(0.05, 0.35, uFaceYaw);
  contourD *= yawFade;
  float side = sign(vUv.x - 0.5);
  float sameAsLight = max(0.0, side * uLightBal);
  contourD *= 1.0 - sameAsLight * 0.75;
  float mc = contourD * smoothstep(0.03 + expOff * 0.06, 0.16 + expOff * 0.20, percL(outc)) * expI;
  if (mc > 0.001) {
    float lum = percL(outc);
    vec3 shadow = blendMultiply(outc, vec3(0.52, 0.53, 0.60));
    shadow = mix(shadow, vec3(lum * 0.58), 0.22);
    outc = mix(outc, shadow, mc);
  }

  // ── Blush ──
  float mb = texture2D(uBlush, vUv).a * uBlushInt * skinGate;
  mb *= 1.0 - contourD * 0.5;
  if (mb > 0.001) {
    float redness = smoothstep(0.02, 0.30, outc.r - (outc.g + outc.b) * 0.5);
    mb *= (1.0 - redness * 0.25) * expI;
    if (uBlushFinish > 0.5) {
      outc = sssBlend(outc, uBlushShade, min(mb * 0.85, 1.0));
      float creamSheen = smoothstep(0.45, 0.80, skinL) * 0.04 * mb;
      outc += creamSheen * vec3(1.0, 0.95, 0.88);
    } else {
      outc = sssBlend(outc, uBlushShade, min(mb, 1.0));
      outc = mix(outc, vec3(percL(outc)), smoothstep(0.70, 0.92, skinL) * 0.05 * mb);
    }
  }

  // ── Highlight ──
  float mhi = sc.g * uHighlightInt * (1.0 - contourD * 0.8) * expI;
  if (mhi > 0.001 || hiBloom > 0.001) {
    float lum = percL(outc);
    float warmGate = smoothstep(0.12, 0.72, lum);
    float specGate = smoothstep(0.48, 0.96, lum);
    vec3 warmGlow = outc + mhi * warmGate * vec3(0.12, 0.09, 0.04) * 0.9;
    vec3 specPeak = warmGlow + mhi * specGate * vec3(0.22, 0.20, 0.16) * 0.9;
    specPeak += hiBloom * uHighlightInt * warmGate * vec3(0.05, 0.04, 0.02) * expI;
    outc = clamp(specPeak, 0.0, 1.0);
  }

  // ── Bronzer ──
  float mbz = ex.r * uBronzerInt * expI;
  mbz *= 1.0 - contourD * 0.6;
  if (mbz > 0.001) {
    vec3 bronzeColour = recolour(outc, uBronzerShade);
    vec3 warmed = softLight(outc, bronzeColour);
    float depth = smoothstep(0.55, 0.20, uFaceLum);
    outc = mix(outc, mix(warmed, bronzeColour, depth * 0.3), mbz * 0.85);
    outc += mbz * vec3(0.03, 0.015, -0.01) * (1.0 - depth * 0.5);
  }

  // ── Nose contour ──
  float mnc = ex.g * uNoseContourInt * expI;
  mnc *= yawFade;
  if (mnc > 0.001) {
    float lum = percL(outc);
    vec3 shadow = blendMultiply(outc, vec3(0.55, 0.54, 0.58));
    shadow = mix(shadow, vec3(lum * 0.60), 0.18);
    outc = mix(outc, shadow, mnc);
  }

  // ── Intermediate texture re-injection ──
  // Foundation + sculpt "settled" into skin — re-inject pores before color layers
  vec3 origSample = clamp(texture2D(uFrame, vUv).rgb * uWB, 0.0, 1.0);
  vec3 origBlur = clamp(softRGB(uFrame, vUv, 3.0) * uWB, 0.0, 1.0);
  outc = injectTexture(outc, origSample, origBlur, 0.45);

  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

// ── PASS 2: EYES ──────────────────────────────────────────────────────────
const FRAG_EYES = GLSL_COMMON + `
uniform sampler2D uPrev, uFrame, uEye, uEyeliner, uBrows, uLash;
uniform vec3 uEyeShade, uEyeCreaseShade, uEyeHighlightShade, uEyelinerShade, uBrowShade, uWB;
uniform float uEyeInt, uEyelinerInt, uBrowInt, uLashInt;
uniform float uEyeFinish, uEyeCreaseFinish, uEyeHighlightFinish, uCutCrease;

void main(){
  vec3 outc = texture2D(uPrev, vUv).rgb;
  float skinL = percL(outc);
  float expOff = uFaceLum - 0.5;
  float expI = clamp(1.0 + expOff * 0.7, 0.55, 1.25);

  // ── Brows ──
  float mbr = aaA(uBrows, vUv) * uBrowInt * expI;
  if (mbr > 0.001) {
    vec3 tinted = blendColor(outc, uBrowShade);
    vec3 deepened = mix(tinted, blendMultiply(outc, uBrowShade * 1.2), 0.4);
    outc = mix(outc, deepened, mbr);
  }

  // ── Eyeshadow: multi-zone ──
  float rawEyeA = texture2D(uEye, vUv).a;
  float me = rawEyeA * uEyeInt * expI;
  if (me > 0.001) {
    float cc = uCutCrease;
    float lidLo = mix(0.55, 0.65, cc), lidHi = mix(0.78, 0.71, cc);
    float crLo = mix(0.25, 0.35, cc), crHi = mix(0.45, 0.42, cc);
    float crTop = mix(0.85, 0.76, cc), crTopI = mix(0.65, 0.70, cc);
    float wLid = smoothstep(lidLo, lidHi, rawEyeA);
    float wCrease = smoothstep(crLo, crHi, rawEyeA) * smoothstep(crTop, crTopI, rawEyeA);
    float wHigh = smoothstep(0.40, 0.18, rawEyeA);
    float cutLine = 0.0;
    if (cc > 0.01) {
      float cutWidth = mix(0.15, 0.04, cc);
      cutLine = exp(-pow((rawEyeA - 0.68) / cutWidth, 2.0)) * cc;
    }
    float wTotal = wLid + wCrease + wHigh + 0.001;
    wLid /= wTotal; wCrease /= wTotal; wHigh /= wTotal;
    vec3 creaseCol = (uEyeCreaseShade.r + uEyeCreaseShade.g + uEyeCreaseShade.b > 0.01)
                     ? uEyeCreaseShade : uEyeShade;
    vec3 highCol = (uEyeHighlightShade.r + uEyeHighlightShade.g + uEyeHighlightShade.b > 0.01)
                   ? uEyeHighlightShade : uEyeShade;
    vec3 zoneShade = uEyeShade * wLid + creaseCol * wCrease + highCol * wHigh;
    if (cutLine > 0.01) zoneShade = mix(zoneShade, outc, cutLine * 0.75);
    float zoneFin = uEyeFinish * wLid + uEyeCreaseFinish * wCrease + uEyeHighlightFinish * wHigh;
    float shadeL = percL(zoneShade);
    vec3 col = blendColor(outc, zoneShade);
    vec3 soft = softLight(outc, zoneShade);
    vec3 deep = blendMultiply(outc, zoneShade * 1.35 + 0.08);
    float depth = smoothstep(0.78, 0.25, shadeL);
    vec3 pigment = mix(mix(col, soft, 0.30), deep, depth * 0.92);
    float texPreserve = 0.92 + depth * 0.06;
    outc = mix(outc, pigment, me * texPreserve);
    if (zoneFin > 1.5) {
      float sparkle = hash21(vUv * 420.0 + fract(uFaceLum * 211.0));
      float sparkleMask = smoothstep(0.72, 0.95, sparkle);
      float litGate = smoothstep(0.25, 0.65, skinL);
      vec3 shimmerCol = mix(vec3(1.0, 0.98, 0.92), zoneShade * 1.5 + 0.5, 0.3);
      outc += sparkleMask * litGate * me * shimmerCol * 0.30;
      float sheen = smoothstep(0.35, 0.75, skinL) * 0.07;
      outc += sheen * me * vec3(1.0, 0.97, 0.93);
    } else if (zoneFin > 0.5) {
      float sheen = smoothstep(0.35, 0.78, skinL) * 0.05;
      outc += sheen * me * vec3(1.0, 0.97, 0.93);
    }
  }

  // ── Eyeliner ──
  float mel = aaA(uEyeliner, vUv) * uEyelinerInt * expI;
  if (mel > 0.001) {
    float melSoft = mel * smoothstep(0.0, 0.35, mel);
    vec3 liner = mix(uEyelinerShade, blendMultiply(outc, uEyelinerShade * 0.5), 0.10);
    outc = mix(outc, liner, melSoft);
  }

  // ── Lashes ──
  float ml2 = aaA(uLash, vUv) * uLashInt * expI;
  if (ml2 > 0.001) {
    float rawA = texture2D(uLash, vUv).a;
    float tipFade = smoothstep(0.08, 0.50, rawA);
    float lashStr = ml2 * mix(0.30, 0.92, tipFade);
    vec3 lashCol = outc * 0.06 + vec3(0.012, 0.006, 0.002);
    float tipBlend = 1.0 - tipFade;
    vec3 tipDark = outc * (0.35 + 0.25 * tipBlend);
    vec3 finalLash = mix(lashCol, tipDark, tipBlend * 0.7);
    outc = mix(outc, finalLash, lashStr);
  }

  // ── Texture re-injection for eye area ──
  vec3 origSample = clamp(texture2D(uFrame, vUv).rgb * uWB, 0.0, 1.0);
  vec3 origBlur = clamp(softRGB(uFrame, vUv, 3.0) * uWB, 0.0, 1.0);
  // Eye zone: stronger injection so eyelid pores show through shadow
  float eyeZone = clamp(me * uEyeInt, 0.0, 1.0);
  float str = mix(0.3, 0.65, eyeZone);
  outc = injectTexture(outc, origSample, origBlur, str);

  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

// ── PASS 3: LIPS ──────────────────────────────────────────────────────────
const FRAG_LIPS = GLSL_COMMON + `
uniform sampler2D uPrev, uFrame, uLipLiner, uLip, uHair;
uniform vec3 uLipShade, uLipLinerShade, uHairShade, uWB;
uniform float uLipInt, uLipLinerInt, uHairInt, uLipPx, uLipCover;
uniform sampler2D uLipTex;
uniform float uLipTexOn, uLipTexMix, uLipTexScale;
uniform vec2 uLipO, uLipAx, uLipAy;

uniform float uFinish, uLight;

void main(){
  vec3 outc = texture2D(uPrev, vUv).rgb;
  float expOff = uFaceLum - 0.5;
  float expI = clamp(1.0 + expOff * 0.7, 0.55, 1.25);

  // ── Hair ──
  float mh = feather(texture2D(uHair, vUv).a) * uHairInt * expI;
  if (mh > 0.001) outc = mix(outc, recolour(outc, uHairShade), mh);

  // ── Lip-edge band (~6 px inside the outline), BEFORE liner and lipstick ──
  // The vermilion border carries a light "white roll". Liner and lipstick
  // both transfer colour while keeping luminance, so that ridge survived as
  // a light seam between liner and lipstick. Real pigment covers it: remove
  // bright ridges (frame detail above its local blur) in that band only;
  // dark creases are untouched.
  float lipCov = max(texture2D(uLip, vUv).a, texture2D(uLipLiner, vUv).a);
  // Band width ∝ lip thickness (uLipPx): on a small, far-away mouth a fixed
  // 6 px band would cover the whole lip.
  float bandR = clamp(0.3 * uLipPx, 1.5, 6.0);
  // Only where the product actually covers (≥ ~50 %): the roll lies on the
  // lip. On the soft fade over SKIN this pulled the much brighter skin down to
  // lip brightness — that was the dark line above the upper lip.
  float edgeBand = (1.0 - smoothstep(0.8, 0.99, softA(uLip, vUv, bandR))) * smoothstep(0.5, 0.95, lipCov);
  if (edgeBand > 0.001) {
    // The ridge runs ALONG the edge, so compare ACROSS it: step inward (up
    // the lip-mask gradient) and use the lip's own brightness 5–8 px in as
    // the reference. Anything brighter than that in the band is the roll.
    vec2 t6 = uTexel * bandR;
    vec2 g = vec2(texture2D(uLip, vUv + vec2(t6.x, 0.0)).a - texture2D(uLip, vUv - vec2(t6.x, 0.0)).a,
                  texture2D(uLip, vUv + vec2(0.0, t6.y)).a - texture2D(uLip, vUv - vec2(0.0, t6.y)).a);
    float gl = length(g);
    if (gl > 1e-3) {
      vec2 n = (g / gl) * uTexel;                       // inward, one pixel
      float fL = percL(texture2D(uFrame, vUv).rgb);
      float r1 = clamp(0.25 * uLipPx, 1.5, 5.0), r2 = clamp(0.4 * uLipPx, 2.5, 8.0);
      float ref = 0.5 * (percL(texture2D(uFrame, vUv + n * r1).rgb) + percL(texture2D(uFrame, vUv + n * r2).rgb));
      float ridge = max(0.0, fL - ref - 0.01) * edgeBand;
      outc = setLum(outc, clamp(percL(outc) - ridge, 0.0, 1.0));
    }
  }

  // ── Lip liner (before lipstick) ──
  float mll = aaA(uLipLiner, vUv) * uLipLinerInt * expI;
  if (mll > 0.001) {
    vec3 liner = blendColor(outc, uLipLinerShade);
    liner = mix(liner, blendMultiply(outc, uLipLinerShade * 0.9), 0.3);
    outc = mix(outc, liner, mll);
  }

  // ── Lipstick ──
  float lipA = feather(texture2D(uLip, vUv).a);
  // Coverage also raises opacity inside the lip (the soft edge stays soft).
  float ml = min(1.0, lipA * mix(uLipInt, 1.0, 0.85 * max(uLipCover, uLipTexMix * uLipTexOn)) * expI);
  if (ml > 0.001) {
    float lum = percL(outc);
    vec3 colorLayer = blendColor(outc, uLipShade);
    vec3 multiLayer = blendMultiply(outc, uLipShade + 0.3);
    vec3 mk = mix(multiLayer, colorLayer, 0.6);
    float targetLum = clamp(lum + (0.5 - uFaceLum) * 0.25, 0.0, 1.0);
    mk = setLum(mk, mix(percL(mk), targetLum, 0.5));
    // ── Coverage (uLipCover 0..1) ──
    // Sheer (0): colour transferred at the lip's own luminance — the natural
    // lip, its pale patches and darker rim show through like a tint.
    // Opaque (1): the lipstick's OWN colour, lit only by the lip's large-scale
    // lighting (volume, the shaded side) and carrying its fine relief (lip
    // lines) — the lip's colour and blotches no longer show through.
    if (uLipCover > 0.001) {
      float lumF = percL(texture2D(uFrame, vUv).rgb);
      float lumB = percL(softRGB(uFrame, vUv, 5.0));
      float relief = clamp(lumF / max(lumB, 0.04), 0.7, 1.3);
      relief = mix(relief, min(relief, 1.0), edgeBand);     // no white-roll ridge
      // Large-scale lighting only (6 + 14 px blur — natural blotches are
      // smaller than the lip's volume shading), relative to the face's
      // exposure (lips sit ~15 % darker than skin), with its contrast eased so
      // leftover blotches fade while the volume stays.
      float lumBig = 0.5 * (percL(softRGB(uFrame, vUv, 6.0)) + percL(softRGB(uFrame, vUv, 14.0)));
      float light = clamp(1.0 + 0.65 * (lumBig / max(0.85 * uFaceLum, 0.08) - 1.0), 0.5, 1.25);
      vec3 pig = clamp(uLipShade * light * relief, 0.0, 1.0);
      mk = mix(mk, pig, uLipCover);
    }
    // ── Product texture (glitter, metallic, cream…) anchored to the LIPS ──
    // Coordinates live in the mouth's own frame (corner→corner axis, scaled
    // by mouth width), so the pattern moves / turns / scales with the lips.
    // The texture gives colour and pattern; lighting comes from the lip
    // itself — large-scale volume and fine relief (lip lines) — so the lips'
    // relief stays visible through it.
    if (uLipTexOn > 0.5) {
      vec2 pI = vec2(vUv.x / uTexel.x, (1.0 - vUv.y) / uTexel.y);   // image px, y down
      vec2 dd = pI - uLipO;
      vec2 st = vec2(dot(dd, uLipAx) / max(dot(uLipAx, uLipAx), 1.0),
                     dot(dd, uLipAy) / max(dot(uLipAy, uLipAy), 1.0));
      vec2 tc = fract(st * uLipTexScale + 0.5);
      vec3 tcol = texture2D(uLipTex, vec2(tc.x, 1.0 - tc.y)).rgb;
      float tF = percL(texture2D(uFrame, vUv).rgb);
      float tB = percL(softRGB(uFrame, vUv, 5.0));
      float tRel = clamp(tF / max(tB, 0.04), 0.65, 1.35);           // lip lines
      tRel = mix(tRel, min(tRel, 1.0), edgeBand);
      float tBig = 0.5 * (percL(softRGB(uFrame, vUv, 6.0)) + percL(softRGB(uFrame, vUv, 14.0)));
      float tLight = clamp(1.0 + 0.65 * (tBig / max(0.85 * uFaceLum, 0.08) - 1.0), 0.5, 1.25); // volume
      vec3 texLit = clamp(tcol * tLight * tRel, 0.0, 1.0);
      mk = mix(mk, texLit, uLipTexMix);
    }
    // Deeper tone just INSIDE the lip edge only. With a soft lip→skin fade the
    // low-alpha zone lies on the skin; darkening it drew a dark halo above the
    // upper lip.
    float edgeFactor = (1.0 - smoothstep(0.6, 0.95, lipA)) * smoothstep(0.4, 0.62, lipA);
    vec3 deepShade = blendMultiply(mk, uLipShade * 0.85 + 0.05);
    mk = mix(mk, deepShade, edgeFactor * 0.38);
    if (uFinish < 0.5) {
      mk = setLum(mk, clamp(percL(mk) + (lum - 0.5) * 0.15, 0.0, 1.0));
      mk = mix(mk, vec3(percL(mk)), smoothstep(0.6, 0.9, lum) * 0.15);
    } else if (uFinish < 1.5) {
      float sheen = smoothstep(0.5, 0.85, lum) * 0.18;
      mk = mix(mk, mk + sheen, 0.5);
    } else {
      float gloss = smoothstep(0.55, 0.95, lum);
      mk += gloss * gloss * vec3(0.40, 0.36, 0.30);
      mk = mix(mk, sssBlend(mk, uLipShade * 1.1, 0.3), 0.25);
    }
    outc = mix(outc, mk, ml);
  }

  // ── Texture re-injection for lips ──
  vec3 origSample = clamp(texture2D(uFrame, vUv).rgb * uWB, 0.0, 1.0);
  vec3 origBlur = clamp(softRGB(uFrame, vUv, 3.0) * uWB, 0.0, 1.0);
  float lipZone = clamp(lipA * uLipInt, 0.0, 1.0);
  float str = mix(0.3, 0.6, lipZone);  // lips get strong injection (lip lines)
  // Liner band (+~2px): the real lip border has a bright "white roll" right
  // there. Re-injecting it drew a light seam between liner and lipstick.
  // Keep the dark creases, drop the bright detail in that band.
  float linZ = max(clamp(softA(uLipLiner, vUv, 2.0) * 1.8, 0.0, 1.0) * step(0.001, uLipLinerInt), edgeBand);
  vec3 origNoRoll = mix(origSample, min(origSample, origBlur), linZ);
  outc = injectTexture(outc, origNoRoll, origBlur, str);

  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

// ── PASS 4: POST ──────────────────────────────────────────────────────────
const FRAG_POST = GLSL_COMMON + `
uniform sampler2D uPrev, uFrame;
uniform vec3 uWB;
uniform float uCinema, uGrain, uGlamour;

void main(){
  vec3 outc = texture2D(uPrev, vUv).rgb;
  vec3 orig = clamp(texture2D(uFrame, vUv).rgb * uWB, 0.0, 1.0);
  float skinL = percL(outc);

  // ── Final texture re-injection ──
  vec3 origLow = clamp(softRGB(uFrame, vUv, 3.0) * uWB, 0.0, 1.0);
  vec3 detail = orig - origLow;
  float delta = clamp(length(outc - orig) * 5.0, 0.0, 1.0);
  outc += detail * delta * 0.35;  // lighter final pass (per-group already injected)

  // ── Cinema ──
  if (uCinema > 0.001) {
    float ci = uCinema;
    vec3 lifted = outc + vec3(0.020, 0.012, 0.005) * ci;
    vec3 gained = lifted * (1.0 + vec3(0.03, 0.01, -0.02) * ci);
    outc = pow(max(gained, 0.0), vec3(1.0 - 0.04 * ci, 1.0 - 0.02 * ci, 1.0 + 0.01 * ci));
    vec3 sCurve = 2.0 * outc * outc * (3.0 - 2.0 * outc);
    outc = mix(outc, sCurve, 0.22 * ci);
    vec3 bloom = clamp(softRGB(uFrame, vUv, 18.0) * uWB, 0.0, 1.0);
    float bloomGate = smoothstep(0.50, 0.85, percL(bloom));
    outc += bloom * bloomGate * 0.08 * ci;
    vec2 vc = vUv - 0.5;
    float vignette = 1.0 - smoothstep(0.35, 0.95, length(vc * vec2(1.1, 1.0)));
    outc *= mix(1.0, vignette, 0.35 * ci);
  }

  // ── Grain ──
  float grain = hash21(vUv * 768.0 + fract(uFaceLum * 137.0)) - 0.5;
  float grainBase = mix(0.010, 0.003, clamp(skinL * 1.5, 0.0, 1.0));
  outc += grain * grainBase * (1.0 + uCinema * 1.2);
  if (uGrain > 0.001) {
    float g2 = hash21(vUv * 1400.0 + fract(uFaceLum * 211.0)) - 0.5;
    float lumGate = mix(1.3, 0.5, clamp(percL(outc) * 1.8, 0.0, 1.0));
    float mkGate = 1.0 + delta * 1.5;
    outc += g2 * uGrain * 0.12 * lumGate * mkGate;
  }

  // ── Glamour ──
  if (uGlamour > 0.5) {
    vec3 glow = clamp(softRGB(uFrame, vUv, 24.0) * uWB, 0.0, 1.0);
    float glowGate = smoothstep(0.35, 0.75, percL(glow));
    outc = 1.0 - (1.0 - outc) * (1.0 - glow * glowGate * 0.35);
    outc = outc * 0.975 + 0.025;
    float pL = percL(outc);
    outc *= mix(vec3(1.0), vec3(1.02, 0.98, 0.92), smoothstep(0.45, 0.85, pL) * 0.6);
    outc *= mix(vec3(1.0), vec3(0.95, 0.97, 1.04), (1.0 - smoothstep(0.20, 0.55, pL)) * 0.4);
    vec3 curved = outc * outc * (3.0 - 2.0 * outc);
    outc = mix(outc, curved, 0.3);
    float gray = percL(outc);
    float midGate = 1.0 - abs(gray - 0.5) * 2.0;
    outc = mix(vec3(gray), outc, 1.0 + 0.15 * midGate);
  }

  // ── Dither ──
  float d = (hash21(vUv * 1024.0 + fract(uFaceLum * 97.0)) - 0.5) * 0.0039;
  gl_FragColor = vec4(clamp(outc + d, 0.0, 1.0), 1.0);
}`;

// ── GL SETUP ──────────────────────────────────────────────────────────────

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[MP] shader:', gl.getShaderInfoLog(s));
    throw new Error('shader compile');
  }
  return s;
}

function buildPass(fragSrc, uniformNames) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[MP] link:', gl.getProgramInfoLog(prog));
    throw new Error('program link');
  }
  const loc = {};
  for (const u of uniformNames) loc[u] = gl.getUniformLocation(prog, u);
  return { prog, loc };
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

function ensureFBOs(w, h) {
  if (fboW === w && fboH === h) return;
  fboW = w; fboH = h;
  for (const [fbo, tex] of [[fboA, fboTexA], [fboB, fboTexB]]) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

let blankCv;
function blank() {
  if (!blankCv) { blankCv = document.createElement('canvas'); blankCv.width = blankCv.height = 1; }
  return blankCv;
}
function upload(unit, texObj, src) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texObj);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
}

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

let inited = false;
function initMP() {
  if (inited) return true;
  canvas = document.createElement('canvas');
  gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true })
     || canvas.getContext('experimental-webgl');
  if (!gl) return false;

  try {
    // Build all 4 pass programs
    passes.base = buildPass(FRAG_BASE, [
      'uFrame','uFnd','uSculpt','uBlush','uExtra',
      'uFndShade','uBlushShade','uBronzerShade','uUnderEyeShade','uWB',
      'uFndInt','uBlushInt','uContourInt','uHighlightInt','uBronzerInt',
      'uNoseContourInt','uUnderEyeInt','uFndFinish','uBlushFinish',
      'uLight','uLightBal','uFaceYaw','uFaceLum','uTexel'
    ]);
    passes.eyes = buildPass(FRAG_EYES, [
      'uPrev','uFrame','uEye','uEyeliner','uBrows','uLash',
      'uEyeShade','uEyeCreaseShade','uEyeHighlightShade','uEyelinerShade','uBrowShade','uWB',
      'uEyeInt','uEyelinerInt','uBrowInt','uLashInt',
      'uEyeFinish','uEyeCreaseFinish','uEyeHighlightFinish','uCutCrease',
      'uFaceLum','uTexel'
    ]);
    passes.lips = buildPass(FRAG_LIPS, [
      'uPrev','uFrame','uLipLiner','uLip','uHair',
      'uLipShade','uLipLinerShade','uHairShade','uWB',
      'uLipInt','uLipLinerInt','uHairInt','uLipPx','uLipCover','uLipTex','uLipTexOn','uLipTexMix','uLipTexScale','uLipO','uLipAx','uLipAy',
      'uFinish','uLight','uFaceLum','uTexel'
    ]);
    passes.post = buildPass(FRAG_POST, [
      'uPrev','uFrame','uWB',
      'uCinema','uGrain','uGlamour','uFaceLum','uTexel'
    ]);
  } catch (e) {
    console.error('[MP] Failed to build passes:', e);
    gl = null; canvas = null; passes = {};
    return false;
  }

  // Fullscreen quad
  quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  // FBOs (ping-pong)
  fboTexA = makeTex(); fboTexB = makeTex();
  fboA = gl.createFramebuffer(); fboB = gl.createFramebuffer();

  // Mask textures (12, same as single-pass)
  texPool = {
    frame: makeTex(), fnd: makeTex(), sculpt: makeTex(), blush: makeTex(), extra: makeTex(),
    eye: makeTex(), eyeliner: makeTex(), brows: makeTex(), lash: makeTex(),
    lipLiner: makeTex(), lip: makeTex(), hair: makeTex()
  };

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  initLipMesh(gl);
  inited = true;
  return true;
}

function usePass(pass) {
  gl.useProgram(pass.prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  const ap = gl.getAttribLocation(pass.prog, 'aPos');
  gl.enableVertexAttribArray(ap);
  gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
}

// ── MAIN RENDER FUNCTION ──────────────────────────────────────────────────
const FINISH_CODE = { matte: 0, satin: 1, gloss: 2 };
const EYE_FINISH = { matte: 0, satin: 1, shimmer: 2 };
const FND_FINISH = { matte: 0, powder: 0, natural: 1, satin: 1, dewy: 2, cream: 2 };
const BLUSH_FINISH = { powder: 0, matte: 0, cream: 1 };

export function renderMakeupMultiPass(source, w, h, landmarks, opts) {
  setActiveLipSeg(opts && opts.lipSeg);   // masks cut the lips along the lipstick's own outline
  if (!initMP()) return null;
  if (!landmarks || landmarks.length < 468) return null;

  const { foundation, underEye, contour, blush, highlight, bronzer, noseContour,
          hair, eyes, lashes, lips, lipLiner, eyeliner, brows, wb, refinedOuter, lipSeg } = opts;

  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ensureFBOs(w, h);

  const texel = [1 / w, 1 / h];
  const faceLum = typeof opts.faceLum === 'number' ? opts.faceLum : 0.5;
  const wbArr = wb && wb.length === 3 ? wb : [1, 1, 1];

  // ── Upload masks (cached, same as single-pass) ──
  const key = `${w}x${h}|${!!foundation}${!!blush}${!!eyes}${!!lashes}${!!lips}`
            + `${!!(hair && hair.mask)}${!!lipLiner}${!!eyeliner}${!!brows}`
            + `${!!contour}${!!highlight}${!!underEye}${!!bronzer}${!!noseContour}`;
  const lipOverride = lips?.overrideMask || null;
  const moved = geometryMoved(landmarks);
  const changed = moved || key !== lastMaskKey
    || hair?.mask !== lastHairMask || lipOverride !== lastLipOverride;

  if (changed) {
    const sculptOn = !!(contour || highlight || underEye);
    upload(0, texPool.frame, source);
    upload(1, texPool.fnd, foundation ? buildFaceMask(w, h, landmarks, { lipSeg }) : blank());
    upload(2, texPool.sculpt, sculptOn
      ? buildSculptPack(w, h, landmarks, { contour: !!contour, highlight: !!highlight, underEye: !!underEye })
      : blank());
    upload(3, texPool.blush, blush ? buildBlushMask(w, h, landmarks) : blank());
    upload(4, texPool.extra, !!(bronzer || noseContour)
      ? buildExtraPack(w, h, landmarks, { bronzer: !!bronzer, noseContour: !!noseContour })
      : blank());
    upload(5, texPool.eye, eyes ? buildEyeMask(w, h, landmarks) : blank());
    upload(6, texPool.eyeliner, eyeliner ? buildEyelinerMask(w, h, landmarks) : blank());
    upload(7, texPool.brows, brows ? buildBrowMask(w, h, landmarks) : blank());
    const lashMot = opts.motion ?? 0;
    const use3dLash = lashes && lash3dAvailable();
    upload(8, texPool.lash, (lashes && !use3dLash && lashMot < 0.008) ? buildLashMask(w, h, landmarks) : blank());
    upload(9, texPool.lipLiner, lipLiner ? buildLipLinerMask(w, h, landmarks, { refinedOuter, lipSeg }) : blank());
    // Lip mask (3D mesh or 2D)
    // Colour segmentation wins over the 3D mesh — liner and lipstick must
    // come from the same mask or their edges drift apart.
    if (lips && !lipSeg && lipMesh3DAvailable()) {
      const lipTex = renderLipMesh(gl, w, h, landmarks, lips);
      if (lipTex) {
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.activeTexture(gl.TEXTURE0 + 10);
        gl.bindTexture(gl.TEXTURE_2D, lipTex);
      } else {
        upload(10, texPool.lip, buildLipMask(w, h, landmarks, { ...lips, refinedOuter, lipSeg }));
      }
    } else {
      upload(10, texPool.lip, lips ? buildLipMask(w, h, landmarks, { ...lips, refinedOuter, lipSeg }) : blank());
    }
    upload(11, texPool.hair, (hair && hair.mask) ? hair.mask : blank());
    lastMaskKey = key; lastHairMask = hair?.mask || null; lastLipOverride = lipOverride;
    lastLipSegVer = lipSeg ? lipSeg.version : -1;
  } else {
    // Frame always updates
    upload(0, texPool.frame, source);
    // Lip segmentation refines every frame even when the head is still.
    if (lipSeg && lipSeg.version !== lastLipSegVer) {
      if (lipLiner) upload(9, texPool.lipLiner, buildLipLinerMask(w, h, landmarks, { lipSeg }));
      if (lips) upload(10, texPool.lip, buildLipMask(w, h, landmarks, { ...lips, lipSeg }));
      lastLipSegVer = lipSeg.version;
    }
  }

  const blinkGate = Math.min(opts.blinkL ?? 1, opts.blinkR ?? 1);
  const lashMotion = opts.motion ?? 0;
  const lashFade = lashMotion <= 0.003 ? 1 : lashMotion >= 0.008 ? 0
    : 1 - (lashMotion - 0.003) / (0.008 - 0.003);
  const use3dLash = lashes && lash3dAvailable();

  // ════════════════════════════════════════════════════════════════════════
  // PASS 1: BASE → FBO A
  // ════════════════════════════════════════════════════════════════════════
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
  gl.viewport(0, 0, w, h);
  usePass(passes.base);
  const bl = passes.base.loc;

  gl.uniform1i(bl.uFrame, 0); gl.uniform1i(bl.uFnd, 1);
  gl.uniform1i(bl.uSculpt, 2); gl.uniform1i(bl.uBlush, 3); gl.uniform1i(bl.uExtra, 4);

  gl.uniform3fv(bl.uFndShade, hexToRgb(foundation ? foundation.color : '#000000'));
  gl.uniform3fv(bl.uBlushShade, hexToRgb(blush ? blush.color : '#000000'));
  gl.uniform3fv(bl.uBronzerShade, hexToRgb(bronzer ? bronzer.color : '#000000'));
  gl.uniform3fv(bl.uUnderEyeShade, hexToRgb((underEye && underEye.color) || '#000000'));
  gl.uniform3fv(bl.uWB, wbArr);

  gl.uniform1f(bl.uFndInt, foundation ? (foundation.intensity ?? 0.25) : 0);
  gl.uniform1f(bl.uBlushInt, blush ? (blush.intensity ?? 0.4) : 0);
  gl.uniform1f(bl.uContourInt, contour ? (contour.intensity ?? 0.35) : 0);
  gl.uniform1f(bl.uHighlightInt, highlight ? (highlight.intensity ?? 0.5) : 0);
  gl.uniform1f(bl.uBronzerInt, bronzer ? (bronzer.intensity ?? 0.45) : 0);
  gl.uniform1f(bl.uNoseContourInt, noseContour ? (noseContour.intensity ?? 0.5) : 0);
  gl.uniform1f(bl.uUnderEyeInt, underEye ? (underEye.intensity ?? 0.4) : 0);
  gl.uniform1f(bl.uFndFinish, FND_FINISH[foundation?.finish] ?? 1);
  gl.uniform1f(bl.uBlushFinish, BLUSH_FINISH[blush?.finish] ?? 0);
  gl.uniform1f(bl.uLight, lips?.lightResponse ?? eyes?.lightResponse ?? 0.5);
  gl.uniform1f(bl.uLightBal, typeof opts.lightBal === 'number' ? opts.lightBal : 0);
  gl.uniform1f(bl.uFaceYaw, typeof opts.faceYaw === 'number' ? opts.faceYaw : 0);
  gl.uniform1f(bl.uFaceLum, faceLum);
  gl.uniform2fv(bl.uTexel, texel);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // ════════════════════════════════════════════════════════════════════════
  // PASS 2: EYES → FBO B (reads FBO A)
  // ════════════════════════════════════════════════════════════════════════
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
  usePass(passes.eyes);
  const el = passes.eyes.loc;

  // Bind FBO A result as uPrev on a free unit (use unit 12 — we have at least 16)
  gl.activeTexture(gl.TEXTURE0 + 12);
  gl.bindTexture(gl.TEXTURE_2D, fboTexA);
  gl.uniform1i(el.uPrev, 12);
  gl.uniform1i(el.uFrame, 0);
  gl.uniform1i(el.uEye, 5); gl.uniform1i(el.uEyeliner, 6);
  gl.uniform1i(el.uBrows, 7); gl.uniform1i(el.uLash, 8);

  gl.uniform3fv(el.uEyeShade, hexToRgb(eyes ? eyes.color : '#000000'));
  gl.uniform3fv(el.uEyeCreaseShade, hexToRgb(eyes?.creaseColor || '#000000'));
  gl.uniform3fv(el.uEyeHighlightShade, hexToRgb(eyes?.highlightColor || '#000000'));
  gl.uniform3fv(el.uEyelinerShade, hexToRgb(eyeliner ? eyeliner.color : '#0a0a0a'));
  gl.uniform3fv(el.uBrowShade, hexToRgb(brows ? brows.color : '#000000'));
  gl.uniform3fv(el.uWB, wbArr);

  gl.uniform1f(el.uEyeInt, eyes ? (eyes.intensity ?? 0.5) * blinkGate : 0);
  gl.uniform1f(el.uEyelinerInt, eyeliner ? (eyeliner.intensity ?? 0.9) * blinkGate : 0);
  gl.uniform1f(el.uBrowInt, brows ? (brows.intensity ?? 0.6) : 0);
  gl.uniform1f(el.uLashInt, (lashes && !use3dLash) ? (lashes.intensity ?? 0.8) * lashFade * blinkGate : 0);
  gl.uniform1f(el.uEyeFinish, EYE_FINISH[eyes?.finish] ?? 0);
  gl.uniform1f(el.uEyeCreaseFinish, EYE_FINISH[eyes?.creaseFinish ?? eyes?.finish] ?? 0);
  gl.uniform1f(el.uEyeHighlightFinish, EYE_FINISH[eyes?.highlightFinish ?? 'shimmer'] ?? 2);
  gl.uniform1f(el.uCutCrease, eyes?.cutCrease ? 1.0 : 0.0);
  gl.uniform1f(el.uFaceLum, faceLum);
  gl.uniform2fv(el.uTexel, texel);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // ════════════════════════════════════════════════════════════════════════
  // PASS 3: LIPS → FBO A (reads FBO B)
  // ════════════════════════════════════════════════════════════════════════
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
  usePass(passes.lips);
  const ll = passes.lips.loc;

  gl.activeTexture(gl.TEXTURE0 + 13);
  gl.bindTexture(gl.TEXTURE_2D, fboTexB);
  gl.uniform1i(ll.uPrev, 13);
  gl.uniform1i(ll.uFrame, 0);
  gl.uniform1i(ll.uLipLiner, 9); gl.uniform1i(ll.uLip, 10); gl.uniform1i(ll.uHair, 11);
  // Lip product texture (anchored to the mouth frame; see shader).
  const lt = lips && lips.texture;
  const ltReady = !!(lt && (lt.naturalWidth || lt.videoWidth || lt.width) && lt.complete !== false);
  if (ltReady) {
    // makeTex binds on the ACTIVE unit — select ours first, or it would
    // replace whatever is bound there (e.g. the camera frame on unit 0).
    if (!lipTexObj) { gl.activeTexture(gl.TEXTURE0 + 14); lipTexObj = makeTex(); }
    if (lt !== lastLipTexSrc) {
      gl.activeTexture(gl.TEXTURE0 + 14);
      gl.bindTexture(gl.TEXTURE_2D, lipTexObj);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lt);
      lastLipTexSrc = lt;
    }
    gl.activeTexture(gl.TEXTURE0 + 14);
    gl.bindTexture(gl.TEXTURE_2D, lipTexObj);
    const La = landmarks[61], Ra = landmarks[291];
    const ox = (La.x + Ra.x) / 2 * w, oy = (La.y + Ra.y) / 2 * h;
    const ax = (Ra.x - La.x) * w, ay = (Ra.y - La.y) * h;
    gl.uniform2f(ll.uLipO, ox, oy);
    gl.uniform2f(ll.uLipAx, ax, ay);
    gl.uniform2f(ll.uLipAy, -ay, ax);
  }
  gl.uniform1i(ll.uLipTex, 14);
  gl.uniform1f(ll.uLipTexOn, ltReady ? 1 : 0);
  gl.uniform1f(ll.uLipTexMix, ltReady ? Math.max(0, Math.min(1, lips.textureMix ?? 0.7)) : 0);
  gl.uniform1f(ll.uLipTexScale, ltReady ? Math.max(0.2, lips.textureScale ?? 2.0) : 1);


  gl.uniform3fv(ll.uLipShade, hexToRgb(lips ? lips.color : '#000000'));
  gl.uniform3fv(ll.uLipLinerShade, hexToRgb(lipLiner ? lipLiner.color : '#000000'));
  gl.uniform3fv(ll.uHairShade, hexToRgb(hair ? hair.color : '#000000'));
  gl.uniform3fv(ll.uWB, wbArr);

  gl.uniform1f(ll.uLipInt, lips ? (lips.intensity ?? 0.7) : 0);
  gl.uniform1f(ll.uLipLinerInt, lipLiner ? (lipLiner.intensity ?? 0.8) : 0);
  gl.uniform1f(ll.uLipPx, lipSeg && lipSeg.t ? lipSeg.t : 20.0);
  gl.uniform1f(ll.uLipCover, lips ? Math.max(0, Math.min(1, lips.coverage ?? 0.6)) : 0);
  gl.uniform1f(ll.uHairInt, (hair && hair.mask) ? (hair.intensity ?? 0.7) : 0);
  gl.uniform1f(ll.uFinish, FINISH_CODE[lips?.finish] ?? 1);
  gl.uniform1f(ll.uLight, lips?.lightResponse ?? 0.5);
  gl.uniform1f(ll.uFaceLum, faceLum);
  gl.uniform2fv(ll.uTexel, texel);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // ════════════════════════════════════════════════════════════════════════
  // PASS 4: POST → screen (reads FBO A)
  // ════════════════════════════════════════════════════════════════════════
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  usePass(passes.post);
  const pl = passes.post.loc;

  gl.activeTexture(gl.TEXTURE0 + 12);
  gl.bindTexture(gl.TEXTURE_2D, fboTexA);
  gl.uniform1i(pl.uPrev, 12);
  gl.uniform1i(pl.uFrame, 0);
  gl.uniform3fv(pl.uWB, wbArr);

  gl.uniform1f(pl.uCinema, typeof opts.cinema === 'number' ? opts.cinema : 0);
  gl.uniform1f(pl.uGrain, typeof opts.grain === 'number' ? opts.grain : CFG.grain.intensity);
  gl.uniform1f(pl.uGlamour, opts.glamour ? 1.0 : 0.0);
  gl.uniform1f(pl.uFaceLum, faceLum);
  gl.uniform2fv(pl.uTexel, texel);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // ── 3D lashes (after all passes, same as single-pass) ──
  if (lashes && lash3dAvailable()) {
    renderLashes3D(gl, w, h, landmarks, {
      intensity: lashes.intensity ?? 0.8,
      color: lashes.color || '#0a0a0a',
      blinkL: opts.blinkL,
      blinkR: opts.blinkR,
      motion: opts.motion,
      hasEyeliner: !!eyeliner,
    });
  }

  return canvas;
}

export function multiPassAvailable() {
  if (inited) return true;
  try {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!g) return false;
    // Need at least 14 texture units for ping-pong FBO bindings
    return g.getParameter(g.MAX_TEXTURE_IMAGE_UNITS) >= 14;
  } catch (_) { return false; }
}