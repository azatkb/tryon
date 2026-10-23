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

float lumv(vec3 c){ return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c){
  float l = lumv(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}
vec3 setLum(vec3 c, float l){ return clipColor(c + (l - lumv(c))); }
vec3 recolour(vec3 base, vec3 shade){
  // normalise the makeup's lightness by the face's exposure so the look stays
  // consistent whether the face is bright, dim or warm-lit (0.4 = gentle).
  float lum = clamp(lumv(base) + (0.5 - uFaceLum) * 0.4, 0.0, 1.0);
  vec3 mk = setLum(shade, lum);
  float boosted = clamp(0.5 + (lum - 0.5) * 1.6, 0.0, 1.0);
  return setLum(mk, mix(lum, boosted, uLight));
}

void main(){
  vec3 outc = clamp(texture2D(uFrame, vUv).rgb * uWB, 0.0, 1.0); // auto white-balance
  vec3 sc = texture2D(uSculpt, vUv).rgb; // r=contour, g=highlight, b=under-eye

  float mf = texture2D(uFnd, vUv).a * uFndInt;
  if (mf > 0.001) outc = mix(outc, setLum(uFndShade, lumv(outc)), mf);

  float mu = sc.b * uUnderEyeInt;         // under-eye: lift darkness, keep texture (no white patch)
  if (mu > 0.001) outc = mix(outc, outc + (1.0 - outc) * 0.35, mu);

  float mc = sc.r * uContourInt;          // contour: soft neutral cool shadow (no bruise/cast)
  if (mc > 0.001) { vec3 sh = mix(outc * 0.82, vec3(lumv(outc) * 0.82), 0.25); outc = mix(outc, sh, mc); }

  float mb = texture2D(uBlush, vUv).a * uBlushInt;
  if (mb > 0.001) {
    float redness = clamp((outc.r - (outc.g + outc.b) * 0.5) * 2.2, 0.0, 1.0);
    mb *= 1.0 - redness * 0.6;
    outc = mix(outc, recolour(outc, uBlushShade), mb);
  }

  float mhi = sc.g * uHighlightInt;       // highlight: champagne glow on the bone
  if (mhi > 0.001) outc = clamp(outc + mhi * vec3(0.95, 0.9, 0.76) * 0.5, 0.0, 1.0);

  float mh = texture2D(uHair, vUv).a * uHairInt;
  if (mh > 0.001) outc = mix(outc, recolour(outc, uHairShade), mh);

  float mbr = texture2D(uBrows, vUv).a * uBrowInt;   // brows: tint / fill
  if (mbr > 0.001) outc = mix(outc, recolour(outc, uBrowShade), mbr);

  float me = texture2D(uEye, vUv).a * uEyeInt;
  if (me > 0.001) outc = mix(outc, recolour(outc, uEyeShade), me);

  float mel = texture2D(uEyeliner, vUv).a * uEyelinerInt; // eyeliner line
  if (mel > 0.001) outc = mix(outc, uEyelinerShade, mel);

  float ml2 = texture2D(uLash, vUv).a * uLashInt;    // mascara strands
  if (ml2 > 0.001) outc = mix(outc, vec3(0.0), ml2);

  float lipA = texture2D(uLip, vUv).a;
  float ml = lipA * uLipInt;
  if (ml > 0.001) {
    float lum = lumv(outc);
    vec3 mk = recolour(outc, uLipShade);
    float edge = 1.0 - smoothstep(0.12, 0.7, lipA);  // ombre liner
    mk *= 1.0 - edge * 0.3;
    if (uFinish < 0.5) mk = setLum(mk, clamp(0.5 + (lum - 0.5) * 0.75, 0.0, 1.0));
    else if (uFinish < 1.5) mk += smoothstep(0.55, 0.9, lum) * 0.25;
    else { float s = smoothstep(0.6, 0.97, lum); mk += s * s * 0.7; }
    outc = mix(outc, mk, ml);
  }

  float mll = texture2D(uLipLiner, vUv).a * uLipLinerInt; // lip liner ring (on top, defines the edge)
  if (mll > 0.001) outc = mix(outc, recolour(outc, uLipLinerShade), mll);

  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
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
                   'uLight','uFinish','uFaceLum']) {
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

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas;
}