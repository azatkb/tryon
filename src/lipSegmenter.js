// Lip segmentation via onnxruntime-web (runs fully in the browser).
// Expects a BiSeNet face-parsing model (CelebAMask-HQ, 19 classes) at MODEL_URL.
// Lip classes in that labelling: 12 = upper lip, 13 = lower lip (11 = inner mouth, excluded).
// See SEGMENTATION.md for how to produce the .onnx file.

// Let Vite serve the ort runtime as proper assets (hashed URLs), not /public
// files — ort's loader dynamic-imports the .mjs glue, which Vite forbids from
// /public. These two ?url imports are just strings; the 11 MB .wasm is fetched
// only when the model is first loaded.
import ortWasmUrl from './ort/ort-wasm-simd-threaded.jsep.wasm?url';
import ortMjsUrl from './ort/ort-wasm-simd-threaded.jsep.mjs?url';

const MODEL_URL = '/models/face_parse.onnx';
const SIZE = 512;                       // MUST match the model's fixed input (export used 512×512)
const MEAN = [0.485, 0.456, 0.406];     // ImageNet normalisation
const STD = [0.229, 0.224, 0.225];
const LIP_CLASSES = new Set([12, 13]);  // u_lip, l_lip
const HAIR_CLASSES = new Set([17]);     // hair
const EMA = 0.6;                        // temporal smoothing of the mask (0..1, higher = steadier)

let ort = null;
let session = null;
let initPromise = null;
let inName = null, outName = null;

// scratch canvases
let cropCv;
// per-target state (own output canvas + EMA buffer), so lips and hair don't clash
const lipState = { prevAlpha: null, outCv: null, maskCv: null };
const hairState = { prevAlpha: null, outCv: null, maskCv: null };

export function initSegmenter() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Plain wasm entry (NOT the /webgpu subpath): it statically bundles its JS glue
    // and only fetches the .wasm binary, so Vite doesn't choke on a dynamic import
    // from /public. wasm-SIMD single-thread needs no cross-origin isolation.
    ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl }; // Vite-served assets
    // WebGPU runs on the GPU and off the main thread (no frame stutter); wasm is the
    // fallback. The jsep runtime we ship supports both.
    session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['webgpu', 'wasm'],
      graphOptimizationLevel: 'all',
    });
    inName = session.inputNames[0];
    outName = session.outputNames[0];
    cropCv = document.createElement('canvas'); cropCv.width = SIZE; cropCv.height = SIZE;
  })();
  return initPromise;
}

export function segmenterReady() { return !!session; }

// Core runner: segment `source` within `bbox` for the given class set, with per-target
// state (own EMA + output canvas). Returns a mask canvas sized w×h (white = class).
async function runSeg(source, bbox, w, h, classes, st, ema) {
  if (!session) return null;
  const bx = bbox ? bbox.x : 0, by = bbox ? bbox.y : 0;
  const bw = bbox ? bbox.w : w, bh = bbox ? bbox.h : h;

  const cctx = cropCv.getContext('2d', { willReadFrequently: true });
  cctx.drawImage(source, bx, by, bw, bh, 0, 0, SIZE, SIZE);
  const img = cctx.getImageData(0, 0, SIZE, SIZE).data;

  const n = SIZE * SIZE;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const r = img[i * 4] / 255, g = img[i * 4 + 1] / 255, b = img[i * 4 + 2] / 255;
    input[i] = (r - MEAN[0]) / STD[0];
    input[n + i] = (g - MEAN[1]) / STD[1];
    input[2 * n + i] = (b - MEAN[2]) / STD[2];
  }

  const tensor = new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]);
  const out = await session.run({ [inName]: tensor });
  const o = out[outName];
  const C = o.dims[1], H = o.dims[2], W = o.dims[3];
  const data = o.data, HW = H * W;

  const alpha = st.prevAlpha && st.prevAlpha.length === n ? st.prevAlpha : new Float32Array(n);
  const hadPrev = !!st.prevAlpha;
  for (let p = 0; p < n; p++) {
    const mx = (p % SIZE) * W / SIZE | 0;
    const my = (p / SIZE | 0) * H / SIZE | 0;
    const idx = my * W + mx;
    let best = 0, bestV = data[idx];
    for (let c = 1; c < C; c++) { const v = data[c * HW + idx]; if (v > bestV) { bestV = v; best = c; } }
    const cur = classes.has(best) ? 1 : 0;
    alpha[p] = hadPrev ? alpha[p] * ema + cur * (1 - ema) : cur;
  }
  st.prevAlpha = alpha;

  if (!st.maskCv) st.maskCv = document.createElement('canvas');
  st.maskCv.width = SIZE; st.maskCv.height = SIZE;
  const mctx = st.maskCv.getContext('2d');
  const md = mctx.createImageData(SIZE, SIZE);
  for (let p = 0; p < n; p++) {
    md.data[p * 4] = 255; md.data[p * 4 + 1] = 255; md.data[p * 4 + 2] = 255;
    md.data[p * 4 + 3] = (alpha[p] * 255) | 0;
  }
  mctx.putImageData(md, 0, 0);

  if (!st.outCv) st.outCv = document.createElement('canvas');
  if (st.outCv.width !== w || st.outCv.height !== h) { st.outCv.width = w; st.outCv.height = h; }
  const octx = st.outCv.getContext('2d');
  octx.clearRect(0, 0, w, h);
  octx.imageSmoothingEnabled = true;
  octx.drawImage(st.maskCv, 0, 0, SIZE, SIZE, bx, by, bw, bh);
  return st.outCv;
}

/** Lip mask — tight face crop, steadier EMA. */
export function segmentLips(source, bbox, w, h) {
  return runSeg(source, bbox, w, h, LIP_CLASSES, lipState, EMA);
}

/** Hair mask — whole frame (hair sits outside the face mesh), lighter EMA. */
export function segmentHair(source, w, h) {
  return runSeg(source, null, w, h, HAIR_CLASSES, hairState, 0.5);
}

export function resetSegmenter() { lipState.prevAlpha = null; hairState.prevAlpha = null; }