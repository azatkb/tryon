import { useEffect, useRef, useState, useCallback } from 'react';
import { useFaceLandmarker } from './useFaceLandmarker.js';
import { renderMakeup, drawLandmarks, drawSegMask } from './lipRenderer.js';
import { renderMakeupGL, glAvailable } from './webglLips.js';
import { initSegmenter, segmentLips, segmentHair, segmenterReady, resetSegmenter } from './lipSegmenter.js';
import { PRODUCTS, EYE_SHADES, FOUNDATION_SHADES, BLUSH_SHADES, HAIR_SHADES } from './products.js';
import { LESSON, lessonLayers, resolveStep } from './tutorials.js';

const FINISHES = ['matte', 'satin', 'gloss'];
const MOVE_THRESH = 0.0015; // per-frame face motion above this = "moving": drop the ONNX edge, follow landmarks
const PREDICT = 1.0;        // landmark extrapolation (frames) to cancel detection latency; 0 = off

// Extrapolate landmarks along their velocity so the mask keeps up with motion
// instead of trailing one detection behind. prev/cur are landmark arrays.
function predictLandmarks(cur, prev, k) {
  if (!prev || k <= 0 || prev.length !== cur.length) return cur;
  const out = new Array(cur.length);
  for (let i = 0; i < cur.length; i++) {
    const c = cur[i], p = prev[i];
    out[i] = { x: c.x + (c.x - p.x) * k, y: c.y + (c.y - p.y) * k, z: c.z };
  }
  return out;
}

// Estimate the user's skin depth from cheek luminance -> a word depthLevel() reads.
function estimateDepth(source, lms, w, h, scratch) {
  const x = scratch.getContext('2d', { willReadFrequently: true });
  const faceW = Math.abs(lms[454].x - lms[234].x) * w;
  const box = Math.max(4, faceW * 0.05);
  let lum = 0, nn = 0;
  for (const ci of [205, 425]) {
    const px = lms[ci].x * w, py = lms[ci].y * h;
    try {
      x.drawImage(source, px - box / 2, py - box / 2, box, box, 0, 0, 1, 1);
      const d = x.getImageData(0, 0, 1, 1).data;
      lum += 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]; nn++;
    } catch (_) { /* ignore */ }
  }
  if (!nn) return null;
  lum /= nn;
  return lum > 210 ? 'fair' : lum > 185 ? 'light' : lum > 160 ? 'light medium'
    : lum > 135 ? 'medium' : lum > 110 ? 'medium tan' : lum > 85 ? 'tan'
    : lum > 60 ? 'deep' : 'rich';
}

// Tight-ish face box from all landmarks (normalised) -> pixel rect, with padding.
function faceBBox(lms, w, h, pad = 0.12) {
  let minx = 1, miny = 1, maxx = 0, maxy = 0;
  for (const p of lms) {
    if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
    if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
  }
  const pw = (maxx - minx) * pad, ph = (maxy - miny) * pad;
  const x = Math.max(0, minx - pw) * w, y = Math.max(0, miny - ph) * h;
  const x1 = Math.min(1, maxx + pw) * w, y1 = Math.min(1, maxy + ph) * h;
  return { x, y, w: x1 - x, h: y1 - y };
}

export default function App() {
  const { landmarkerRef, ready, error } = useFaceLandmarker();

  const [mode, setMode] = useState('camera'); // 'camera' | 'photo'
  const [target, setTarget] = useState('lips'); // which region the controls edit
  // lips
  const [sel, setSel] = useState(0);
  const [intensity, setIntensity] = useState(0.7);
  const [finish, setFinish] = useState('satin');
  // eyeshadow
  const [eyeSel, setEyeSel] = useState(0);
  const [eyeOn, setEyeOn] = useState(false);
  const [eyeIntensity, setEyeIntensity] = useState(0.5);
  // lashes
  const [lashOn, setLashOn] = useState(false);
  const [lashIntensity, setLashIntensity] = useState(0.8);
  // foundation
  const [fndSel, setFndSel] = useState(2);
  const [fndOn, setFndOn] = useState(false);
  const [fndIntensity, setFndIntensity] = useState(0.3);
  // blush
  const [blushSel, setBlushSel] = useState(0);
  const [blushOn, setBlushOn] = useState(false);
  const [blushIntensity, setBlushIntensity] = useState(0.4);
  // hair (needs segmentation)
  const [hairSel, setHairSel] = useState(1);
  const [hairOn, setHairOn] = useState(false);
  const [hairIntensity, setHairIntensity] = useState(0.7);

  // lesson mode (single 5-step guided look) — this is the whole app
  const [lessonOn] = useState(true);
  const [step, setStep] = useState(0);
  const [skinDepth, setSkinDepth] = useState(''); // auto-estimated for deep-skin-aware shades

  const [lightResponse, setLightResponse] = useState(0.5);
  const [compare, setCompare] = useState(false);
  const [showPoints, setShowPoints] = useState(false);
  const [useGL, setUseGL] = useState(glAvailable());
  const [useSeg, setUseSeg] = useState(false); // ONNX lip-edge refine — off by default (heavier)
  const [segReady, setSegReady] = useState(false);
  const [segErr, setSegErr] = useState(null);
  const [segDebug, setSegDebug] = useState(false);
  const [segHasMask, setSegHasMask] = useState(false);
  const [faceSeen, setFaceSeen] = useState(false);
  const [camError, setCamError] = useState(null);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const rafRef = useRef(0);
  const streamRef = useRef(null);
  const lastResRef = useRef(null);
  const segMaskRef = useRef(null);
  const faceBoxRef = useRef(null);
  const srcRef = useRef(null); // current frame source (video/image) for the WebGL path
  const procRef = useRef(null); // offscreen processed canvas (feeds the PiP)
  const pipRef = useRef(null);  // small processed preview (top-right)
  const cropRef = useRef(null); // smoothed portrait crop rect on the face
  const sampleRef = useRef(null); // 1px scratch canvas for skin-depth sampling
  const skinDepthRef = useRef(''); const frameCountRef = useRef(0);
  const hairMaskRef = useRef(null); // latest hair segmentation mask (full frame)
  const motionRef = useRef(0); // per-frame face motion (normalised), EMA-smoothed
  const prevLmRef = useRef(null);   // previous few points, for the motion metric
  const prevFullRef = useRef(null); // previous full landmark array, for extrapolation

  // live option values for the render loop (avoid stale closures)
  // makeup layers: driven by the lesson when running (cumulative, colours from
  // their shade data + auto skin depth), else by the manual controls.
  const profile = { undertone: null, depth: skinDepth || null };
  let L;
  if (lessonOn) {
    const m = lessonLayers(step, profile);
    L = {
      lips: m.lips ? { ...m.lips, lightResponse } : null,
      eyes: m.eyes ? { ...m.eyes, lightResponse } : null,
      lashes: m.lashes ? { ...m.lashes } : null,
      foundation: m.foundation ? { ...m.foundation } : null,
      blush: m.blush ? { ...m.blush, lightResponse } : null,
    };
  } else {
    L = {
      lips: { color: PRODUCTS[sel].hex, intensity, finish, lightResponse },
      eyes: eyeOn ? { color: EYE_SHADES[eyeSel].hex, intensity: eyeIntensity, lightResponse } : null,
      lashes: lashOn ? { intensity: lashIntensity } : null,
      foundation: fndOn ? { color: FOUNDATION_SHADES[fndSel].hex, intensity: fndIntensity } : null,
      blush: blushOn ? { color: BLUSH_SHADES[blushSel].hex, intensity: blushIntensity, lightResponse } : null,
    };
  }

  const optsRef = useRef({});
  optsRef.current = {
    ...L,
    hair: hairOn && !lessonOn ? { color: HAIR_SHADES[hairSel].hex, intensity: hairIntensity } : null,
    compare, showPoints, useGL, useSeg, segDebug,
    tut: lessonOn, // in lesson mode the big view shows the makeup
  };

  const selectProduct = useCallback((i) => { setSel(i); setFinish(PRODUCTS[i].finish); }, []);

  // Apply makeup onto `ctx` (which already holds the frame). source = the frame
  // element for the WebGL path.
  const applyMakeup = useCallback((ctx, w, h, lms, source) => {
    const o = optsRef.current;
    if (!lms || o.compare) return;
    const still = motionRef.current <= MOVE_THRESH;
    const lips = o.lips ? { ...o.lips } : null;
    if (lips && o.useSeg && still && segMaskRef.current) lips.overrideMask = segMaskRef.current;
    const hair = o.hair && hairMaskRef.current ? { ...o.hair, mask: hairMaskRef.current } : null;
    const layers = { foundation: o.foundation, blush: o.blush, hair, eyes: o.eyes, lashes: o.lashes, lips };
    if (o.useGL && source) {
      const glc = renderMakeupGL(source, w, h, lms, layers);
      if (glc) { ctx.drawImage(glc, 0, 0, w, h); return; }
    }
    renderMakeup(ctx, w, h, lms, layers); // Canvas fallback
  }, []);

  // Portrait crop centred on the face (face fills the frame), smoothed over time.
  const computeCrop = useCallback((lms, w, h, aspect) => {
    let want;
    if (lms) {
      let minx = 1, miny = 1, maxx = 0, maxy = 0;
      for (const p of lms) {
        if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
        if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
      }
      const fh = (maxy - miny) * h;
      const cx = ((minx + maxx) / 2) * w, cy = ((miny + maxy) / 2) * h - fh * 0.05;
      let sh = Math.min(h, fh * 1.9);     // face ~53% of the crop height
      let sw = sh * aspect;
      if (sw > w) { sw = w; sh = sw / aspect; }
      want = { sw, sh, cx, cy };
    } else {
      want = { sw: Math.min(w, h * aspect), sh: h, cx: w / 2, cy: h / 2 };
    }
    const prev = cropRef.current;
    const k = prev ? 0.2 : 1; // EMA smoothing
    const s = prev ? {
      sw: prev.sw + (want.sw - prev.sw) * k,
      sh: prev.sh + (want.sh - prev.sh) * k,
      cx: prev.cx + (want.cx - prev.cx) * k,
      cy: prev.cy + (want.cy - prev.cy) * k,
    } : want;
    cropRef.current = s;
    let sx = s.cx - s.sw / 2, sy = s.cy - s.sh / 2;
    sx = Math.max(0, Math.min(w - s.sw, sx));
    sy = Math.max(0, Math.min(h - s.sh, sy));
    return { sx, sy, sw: s.sw, sh: s.sh };
  }, []);

  // Big view = original (portrait-cropped on the face). Small PiP = processed, same crop.
  const renderViews = useCallback((source, w, h, lms) => {
    const main = canvasRef.current;
    if (!main) return;
    const o = optsRef.current;

    // processed into an offscreen canvas (full frame)
    let proc = procRef.current;
    if (!proc) { proc = document.createElement('canvas'); procRef.current = proc; }
    if (proc.width !== w || proc.height !== h) { proc.width = w; proc.height = h; }
    const pctx = proc.getContext('2d');
    pctx.drawImage(source, 0, 0, w, h);
    applyMakeup(pctx, w, h, lms, source);

    // portrait output size (3:4) cropped on the face
    const outH = h, outW = Math.round(h * 0.75);
    if (main.width !== outW || main.height !== outH) { main.width = outW; main.height = outH; }
    const { sx, sy, sw, sh } = computeCrop(lms, w, h, outW / outH);

    // big = your live camera (original), small PiP = the look (builds up on Next)
    const bigSrc = source;
    const pipSrc = proc;

    const ctx = main.getContext('2d');
    ctx.drawImage(bigSrc, sx, sy, sw, sh, 0, 0, outW, outH);

    const pip = pipRef.current;
    if (pip) {
      const pw = Math.max(2, Math.round(outW * 0.42)), ph = Math.max(2, Math.round(outH * 0.42));
      if (pip.width !== pw || pip.height !== ph) { pip.width = pw; pip.height = ph; }
      pip.getContext('2d').drawImage(pipSrc, sx, sy, sw, sh, 0, 0, pw, ph);
    }
  }, [applyMakeup, computeCrop]);

  // ---------- CAMERA ----------
  const startCamera = useCallback(async () => {
    const fl = landmarkerRef.current;
    if (!fl) return;
    try {
      await fl.setOptions({ runningMode: 'VIDEO' });
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      v.srcObject = stream;
      await v.play();
      setCamError(null);

      let lastTime = -1;
      const tick = () => {
        rafRef.current = requestAnimationFrame(tick);
        const cv = canvasRef.current;
        if (!v || !cv || v.videoWidth === 0) return;
        if (cv.width !== v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; }
        // run detection only on fresh frames (decouples detect rate from draw rate)
        if (v.currentTime !== lastTime) {
          lastTime = v.currentTime;
          try { lastResRef.current = fl.detectForVideo(v, performance.now()); } catch (_) {}
        }
        srcRef.current = v;
        const raw = lastResRef.current?.faceLandmarks?.[0];
        let lms = raw;
        if (raw) {
          // motion estimate from a few stable points (normalised coords)
          const idxs = [1, 13, 14, 61, 291, 199];
          const prev = prevLmRef.current;
          if (prev) {
            let d = 0;
            for (const i of idxs) d += Math.hypot(raw[i].x - prev[i].x, raw[i].y - prev[i].y);
            motionRef.current = motionRef.current * 0.35 + (d / idxs.length) * 0.65;
          }
          const snap = {};
          for (const i of idxs) snap[i] = { x: raw[i].x, y: raw[i].y };
          prevLmRef.current = snap;

          // extrapolate along velocity to cancel detection latency (mask keeps up with motion)
          lms = predictLandmarks(raw, prevFullRef.current, PREDICT);
          prevFullRef.current = raw;

          // periodically re-estimate skin depth (deep-skin-aware shades)
          if ((frameCountRef.current++ % 20) === 0) {
            if (!sampleRef.current) { sampleRef.current = document.createElement('canvas'); sampleRef.current.width = sampleRef.current.height = 1; }
            const d = estimateDepth(v, raw, cv.width, cv.height, sampleRef.current);
            if (d && d !== skinDepthRef.current) { skinDepthRef.current = d; setSkinDepth(d); }
          }

          faceBoxRef.current = faceBBox(lms, cv.width, cv.height);
          // drop the ONNX mask the instant we move; segmentation resumes when still
          if (motionRef.current > MOVE_THRESH && segMaskRef.current) {
            segMaskRef.current = null; setSegHasMask(false);
          }
        }
        setFaceSeen(!!raw);
        renderViews(v, cv.width, cv.height, lms);
      };
      cancelAnimationFrame(rafRef.current);
      tick();
    } catch (e) {
      console.error(e);
      setCamError(e?.message || String(e));
    }
  }, [landmarkerRef, renderViews]);

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const s = streamRef.current;
    if (s) { s.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // ---------- PHOTO ----------
  const detectPhoto = useCallback(async () => {
    const fl = landmarkerRef.current;
    const img = imgRef.current;
    const cv = canvasRef.current;
    if (!fl || !img || !cv || !img.naturalWidth) return;
    await fl.setOptions({ runningMode: 'IMAGE' });
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    srcRef.current = img;
    let lms = null;
    try { lms = fl.detect(img)?.faceLandmarks?.[0]; } catch (e) { console.error(e); }
    lastResRef.current = { faceLandmarks: lms ? [lms] : [] };
    setFaceSeen(!!lms);
    if (lms) {
      if (!sampleRef.current) { sampleRef.current = document.createElement('canvas'); sampleRef.current.width = sampleRef.current.height = 1; }
      const d = estimateDepth(img, lms, cv.width, cv.height, sampleRef.current);
      if (d && d !== skinDepthRef.current) { skinDepthRef.current = d; setSkinDepth(d); }
    }
    // segmentation for the still (if enabled and loaded)
    if (optsRef.current.useSeg && segmenterReady() && lms) {
      resetSegmenter();
      const bbox = faceBBox(lms, cv.width, cv.height);
      try { segMaskRef.current = await segmentLips(img, bbox, cv.width, cv.height); }
      catch (e) { console.error('[seg] inference failed:', e); segMaskRef.current = null; }
      setSegHasMask(!!segMaskRef.current);
    } else {
      segMaskRef.current = null;
      setSegHasMask(false);
    }
    // hair segmentation for the still
    if (hairOn && segmenterReady()) {
      try { hairMaskRef.current = await segmentHair(img, cv.width, cv.height); }
      catch (e) { console.error('[hair-seg] failed:', e); hairMaskRef.current = null; }
    } else {
      hairMaskRef.current = null;
    }
    renderViews(img, cv.width, cv.height, lms);
  }, [landmarkerRef, renderViews, hairOn]);

  const redrawPhoto = useCallback(() => {
    const img = imgRef.current, cv = canvasRef.current;
    if (!img || !cv || !img.naturalWidth) return;
    srcRef.current = img;
    renderViews(img, cv.width, cv.height, lastResRef.current?.faceLandmarks?.[0]);
  }, [renderViews]);

  const onFile = useCallback((e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const img = imgRef.current;
    img.onload = () => detectPhoto();
    img.src = URL.createObjectURL(f);
  }, [detectPhoto]);

  // start/stop with mode + readiness
  useEffect(() => {
    if (!ready) return;
    if (mode === 'camera') { startCamera(); return () => stopCamera(); }
    stopCamera();
    redrawPhoto(); // if a photo is already loaded, repaint it
  }, [ready, mode, startCamera, stopCamera, redrawPhoto]);

  // re-render the still when controls change (camera repaints itself each frame)
  useEffect(() => {
    if (mode === 'photo') redrawPhoto();
  }, [sel, eyeSel, eyeOn, intensity, eyeIntensity, lashOn, lashIntensity, fndSel, fndOn, fndIntensity,
      blushSel, blushOn, blushIntensity, hairSel, hairOn, hairIntensity, lightResponse, finish, compare,
      showPoints, useGL, segDebug, lessonOn, step, skinDepth, mode, redrawPhoto]);

  // the segmentation model is needed for the ONNX lip-edge refine AND for hair
  const needSeg = useSeg || hairOn;

  // lazy-load the segmentation model the first time anything needs it
  useEffect(() => {
    if (!needSeg || segReady || segErr) return;
    let alive = true;
    initSegmenter()
      .then(() => { if (alive) setSegReady(true); })
      .catch((e) => { if (alive) setSegErr(e?.message || String(e)); });
    return () => { alive = false; };
  }, [needSeg, segReady, segErr]);

  // camera: hair segmentation on the full frame (slower cadence — it's heavy)
  useEffect(() => {
    if (!hairOn || !segReady || mode !== 'camera') { hairMaskRef.current = null; return; }
    let busy = false, stop = false;
    const id = setInterval(async () => {
      if (busy || stop) return;
      const v = videoRef.current, cv = canvasRef.current;
      if (!v || v.videoWidth === 0 || !cv) return;
      busy = true;
      try {
        const mask = await segmentHair(v, cv.width, cv.height);
        if (!stop && mask) hairMaskRef.current = mask;
      } catch (e) { console.error('[hair-seg] failed:', e); }
      busy = false;
    }, 250);
    return () => { stop = true; clearInterval(id); hairMaskRef.current = null; };
  }, [hairOn, segReady, mode]);

  // camera: run segmentation asynchronously (throttled), independent of the draw loop
  useEffect(() => {
    if (!useSeg || !segReady || mode !== 'camera') { segMaskRef.current = null; return; }
    resetSegmenter();
    let busy = false, stop = false;
    const id = setInterval(async () => {
      if (busy || stop) return;
      const v = videoRef.current, cv = canvasRef.current;
      if (!v || v.videoWidth === 0 || !cv) return;
      // moving → release the ONNX mask immediately so the edge tracks landmarks, no lag/smear
      if (motionRef.current > MOVE_THRESH) {
        if (segMaskRef.current) { segMaskRef.current = null; setSegHasMask(false); resetSegmenter(); }
        return;
      }
      // still → refine the edge with segmentation
      busy = true;
      try {
        const mask = await segmentLips(v, faceBoxRef.current, cv.width, cv.height);
        if (!stop && motionRef.current <= MOVE_THRESH && mask) { segMaskRef.current = mask; setSegHasMask(true); }
      } catch (e) { console.error('[seg] inference failed:', e); /* keep landmark fallback */ }
      busy = false;
    }, 150);
    return () => { stop = true; clearInterval(id); segMaskRef.current = null; setSegHasMask(false); };
  }, [useSeg, segReady, mode]);

  // photo: re-run detection+segmentation when seg/hair is toggled or the model becomes ready
  useEffect(() => {
    if (mode === 'photo' && imgRef.current?.src) detectPhoto();
  }, [useSeg, hairOn, segReady, mode, detectPhoto]);

  const mirrored = mode === 'camera';

  // region tabs + per-region palette wiring
  const REGIONS = [
    { key: 'lips', label: 'Lips' },
    { key: 'eyes', label: 'Eyes' },
    { key: 'lashes', label: 'Lashes' },
    { key: 'foundation', label: 'Face' },
    { key: 'blush', label: 'Blush' },
    // { key: 'hair', label: 'Hair' }, // hidden for now (needs segmentation, heavier)
  ];
  const palettes = { lips: PRODUCTS, eyes: EYE_SHADES, foundation: FOUNDATION_SHADES, blush: BLUSH_SHADES, hair: HAIR_SHADES };
  const palSel = { lips: sel, eyes: eyeSel, foundation: fndSel, blush: blushSel, hair: hairSel };
  const palPick = {
    lips: (i) => selectProduct(i),
    eyes: (i) => { setEyeSel(i); setEyeOn(true); },
    foundation: (i) => { setFndSel(i); setFndOn(true); },
    blush: (i) => { setBlushSel(i); setBlushOn(true); },
    hair: (i) => { setHairSel(i); setHairOn(true); },
  };
  const regionOn = { lips: true, eyes: eyeOn, lashes: lashOn, foundation: fndOn, blush: blushOn, hair: hairOn };
  const regionSetOn = { eyes: setEyeOn, lashes: setLashOn, foundation: setFndOn, blush: setBlushOn, hair: setHairOn };
  const regionInt = { lips: intensity, eyes: eyeIntensity, lashes: lashIntensity, foundation: fndIntensity, blush: blushIntensity, hair: hairIntensity };
  const regionSetInt = { lips: setIntensity, eyes: setEyeIntensity, lashes: setLashIntensity, foundation: setFndIntensity, blush: setBlushIntensity, hair: setHairIntensity };
  const activePal = palettes[target];
  const activeShade = activePal ? activePal[palSel[target]].shade : 'lashes';

  const lessonStep = LESSON.steps[step];
  const isFinal = step === LESSON.steps.length - 1;
  const stepProduct = resolveStep(step, profile).product;

  return (
    <div className={`app${lessonOn ? ' lesson' : ''}`}>
      {lessonOn ? (
        <div className="lesson-head">
          <p className="lesson-eyebrow">{isFinal ? 'Final step' : `Step ${step + 1} of ${LESSON.steps.length}`}</p>
          <div className="lesson-progress">
            {LESSON.steps.map((_, i) => <span key={i} className={`seg${i <= step ? ' on' : ''}`} />)}
          </div>
          <h1 className="lesson-title">{lessonStep.title}</h1>
          <p className="lesson-desc">{lessonStep.text}</p>
        </div>
      ) : (
        <header>
          <div className="brand-wrap">
            <p className="brand-eyebrow">Beauty Studio</p>
            <div className="brand">REESOLVE<span>.</span></div>
          </div>
          <div className="tag">try-on · tutorials</div>
        </header>
      )}

      <div className="stage">
        <div className={`viewport${mirrored ? ' mir' : ''}`}>
          <video ref={videoRef} playsInline muted style={{ display: 'none' }} />
          <img ref={imgRef} alt="" style={{ display: 'none' }} />
          <canvas ref={canvasRef} />
          <div className={`pip${lessonOn ? ' live' : ''}`}>
            {lessonOn && <span className="pip-top">Live</span>}
            <canvas ref={pipRef} />
            <span className="pip-label">{lessonOn ? '✦ Live preview' : 'with makeup'}</span>
          </div>
          {lessonOn && <span className="cam-label">Your live camera</span>}
          {!ready && !error && <div className="overlay">Loading face model…</div>}
          {error && <div className="overlay err">Model failed to load.<br /><small>{error}</small></div>}
          {ready && mode === 'camera' && camError && (
            <div className="overlay err">Camera unavailable.<br /><small>{camError}</small><br />
              <small>Camera needs https or localhost.</small></div>
          )}
          {ready && mode === 'photo' && !imgRef.current?.src && (
            <div className="overlay">Upload a photo to begin</div>
          )}
          {ready && !faceSeen && ((mode === 'camera' && !camError) || (mode === 'photo' && imgRef.current?.src)) && (
            <div className="badge warn">no face detected</div>
          )}
          {ready && faceSeen && !lessonOn && <div className="badge ok">{target} · {activeShade}</div>}

          {lessonOn && stepProduct && (
            <div className="prod-chip"><span className="pc-ico" /> {stepProduct}</div>
          )}

          {!lessonOn && activePal && (
            <div className="swatches" role="radiogroup" aria-label="Shade">
              {activePal.map((p, i) => (
                <button key={p.id} className={`sw${i === palSel[target] ? ' on' : ''}`} title={p.shade}
                  role="radio" aria-checked={i === palSel[target]} style={{ background: p.hex }}
                  onClick={() => palPick[target](i)} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="lesson-foot">
        <div className="lesson-nav">
          <button className="round" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>‹</button>
          {isFinal
            ? <button className="primary" onClick={() => setStep(0)}>↺ Start over</button>
            : <button className="primary" onClick={() => setStep((s) => s + 1)}>Next step ›</button>}
        </div>
      </div>
    </div>
  );
}