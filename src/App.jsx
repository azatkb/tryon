import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTryOn, glAvailable, faceBBox, depthFromLum, setRegionEdge } from './tryon/index.js';
import { initSegmenter, segmentLips, segmentHair, segmenterReady, resetSegmenter } from './lipSegmenter.js';
import { PRODUCTS, EYE_SHADES, FOUNDATION_SHADES, BLUSH_SHADES, HAIR_SHADES } from './products.js';
import { LESSON, lessonLayers, resolveStep } from './tutorials.js';

const FINISHES = ['matte', 'satin', 'gloss'];

// Scale every layer's intensity by one user-facing "how much makeup" factor.
// 1.0 = the lesson's own tuned values. Clamped at 1 so pushing past 100% can't
// drive a region into a flat fill.
function scaleIntensity(layers, k) {
  if (k === 1) return layers;
  const out = {};
  for (const key of Object.keys(layers)) {
    const l = layers[key];
    if (!l || typeof l.intensity !== 'number') { out[key] = l; continue; }
    out[key] = { ...l, intensity: Math.min(1, l.intensity * k) };
  }
  return out;
}

export default function App() {
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

  // global look intensity — scales every applied layer (1 = as the lesson tuned it)
  const [lookIntensity, setLookIntensity] = useState(1);

  // Push each step's `edge` into the renderer. Edge hardness is a property of
  // the mask, not of a layer object, so it can't ride along in lessonLayers()
  // the way intensity and colour do — it has to be set on the renderer itself.
  useEffect(() => {
    for (const s of LESSON.steps) {
      if (typeof s.edge === 'number') setRegionEdge(s.region, s.edge);
    }
  }, []);

  const [lightResponse, setLightResponse] = useState(0.5);
  const [compare, setCompare] = useState(false);
  const [showPoints, setShowPoints] = useState(false);
  const [useGL, setUseGL] = useState(glAvailable());
  const [useSeg, setUseSeg] = useState(false); // ONNX lip-edge refine — off by default (heavier)
  const [segReady, setSegReady] = useState(false);
  const [segErr, setSegErr] = useState(null);
  const [segDebug, setSegDebug] = useState(false);
  const [segHasMask, setSegHasMask] = useState(false);
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const segMaskRef = useRef(null);
  const faceBoxRef = useRef(null);
  const pipRef = useRef(null);  // small processed preview (top-right)
  const cropRef = useRef(null); // smoothed portrait crop rect on the face
  const skinDepthRef = useRef('');
  const hairMaskRef = useRef(null); // latest hair segmentation mask (full frame)

  // live option values for the render loop (avoid stale closures)
  // makeup layers: driven by the lesson when running (cumulative, colours from
  // their shade data + auto skin depth), else by the manual controls.
  const profile = { undertone: null, depth: skinDepth || null };
  let L;
  if (lessonOn) {
    const m = lessonLayers(step, profile);
    L = {
      foundation: m.foundation || null,
      underEye:   m.underEye   || null,
      contour:    m.contour    || null,
      highlight:  m.highlight  || null,
      blush:      m.blush    ? { ...m.blush,    lightResponse } : null,
      brows:      m.brows    ? { ...m.brows,    lightResponse } : null,
      eyes:       m.eyes     ? { ...m.eyes,     lightResponse } : null,
      eyeliner:   m.eyeliner ? { ...m.eyeliner, lightResponse } : null,
      lashes:     m.lashes   || null,
      lipLiner:   m.lipLiner ? { ...m.lipLiner, lightResponse } : null,
      lips:       m.lips     ? { ...m.lips,     lightResponse } : null,
    };
  } else {
    L = {
      lips: { color: PRODUCTS[sel].hex, intensity, finish, lightResponse },
      eyes: eyeOn ? { color: EYE_SHADES[eyeSel].hex, intensity: eyeIntensity, lightResponse } : null,
      lashes: lashOn ? { intensity: lashIntensity } : null,
      foundation: fndOn ? { color: FOUNDATION_SHADES[fndSel].hex, intensity: fndIntensity } : null,
      blush: blushOn ? { color: BLUSH_SHADES[blushSel].hex, intensity: blushIntensity, lightResponse } : null,
      underEye: null, contour: null, highlight: null,
    };
  }

  const optsRef = useRef({});
  optsRef.current = {
    ...scaleIntensity(L, lookIntensity),
    hair: hairOn && !lessonOn ? { color: HAIR_SHADES[hairSel].hex, intensity: hairIntensity } : null,
    compare, showPoints, useGL, useSeg, segDebug,
    tut: lessonOn,
  };

  const selectProduct = useCallback((i) => { setSel(i); setFinish(PRODUCTS[i].finish); }, []);

  // Layers, resolved per frame. The two segmentation masks land asynchronously
  // between React renders, so they have to be merged in here rather than in the
  // layers object the engine would otherwise read once per render.
  const getLayers = useCallback((metrics) => {
    const o = optsRef.current;
    if (o.compare) return {};            // compare mode = show the bare frame
    const lips = o.lips ? { ...o.lips } : null;
    if (lips && o.useSeg && !metrics.moving && segMaskRef.current) {
      lips.overrideMask = segMaskRef.current;
    }
    return {
      foundation: o.foundation, underEye: o.underEye, contour: o.contour,
      highlight: o.highlight, blush: o.blush, brows: o.brows, eyes: o.eyes,
      eyeliner: o.eyeliner, lashes: o.lashes, lipLiner: o.lipLiner, lips,
      hair: o.hair && hairMaskRef.current ? { ...o.hair, mask: hairMaskRef.current } : null,
    };
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

  // The engine hands us the processed full frame; this is purely presentation.
  // Big view = your bare camera, portrait-cropped on the face. Small PiP = the
  // same crop of the processed frame, so the look builds up beside you.
  const onFrame = useCallback(({ processed, source, landmarks, w, h }) => {
    const main = canvasRef.current;
    if (!main) return;

    const outH = h, outW = Math.round(h * 0.75);   // 3:4 portrait
    if (main.width !== outW || main.height !== outH) { main.width = outW; main.height = outH; }
    const { sx, sy, sw, sh } = computeCrop(landmarks, w, h, outW / outH);

    main.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, outW, outH);

    const pip = pipRef.current;
    if (pip) {
      const pw = Math.max(2, Math.round(outW * 0.42)), ph = Math.max(2, Math.round(outH * 0.42));
      if (pip.width !== pw || pip.height !== ph) { pip.width = pw; pip.height = ph; }
      pip.getContext('2d').drawImage(processed, sx, sy, sw, sh, 0, 0, pw, ph);
    }

    // Skin depth drives shade resolution — re-read it from the engine's own
    // exposure measurement rather than sampling the frame a second time.
    if (landmarks) {
      const d = depthFromLum(metricsRef.current.faceLum);
      if (d !== skinDepthRef.current) { skinDepthRef.current = d; setSkinDepth(d); }
      faceBoxRef.current = faceBBox(landmarks, w, h);
      if (metricsRef.current.moving && segMaskRef.current) {
        segMaskRef.current = null; setSegHasMask(false);
      }
    }
  }, [computeCrop]);

  const {
    ready, error, camError, faceSeen, metricsRef, videoEl, detectStill, redrawStill,
  } = useTryOn({
    getLayers,
    source: mode === 'camera' ? 'camera' : 'element',
    sourceEl: imgRef.current,
    renderer: useGL ? 'auto' : 'canvas',
    active: mode === 'camera',
    onFrame,
  });

  // ---------- PHOTO ----------
  // The engine does the detection and the makeup pass; this only adds the
  // segmentation work, which is App-specific and too slow for the frame loop.
  const detectPhoto = useCallback(async () => {
    const img = imgRef.current;
    if (!img?.naturalWidth) return;
    const w = img.naturalWidth, h = img.naturalHeight;
    const lms = await detectStill(img);

    if (optsRef.current.useSeg && segmenterReady() && lms) {
      resetSegmenter();
      try { segMaskRef.current = await segmentLips(img, faceBBox(lms, w, h), w, h); }
      catch (e) { console.error('[seg] inference failed:', e); segMaskRef.current = null; }
      setSegHasMask(!!segMaskRef.current);
    } else {
      segMaskRef.current = null;
      setSegHasMask(false);
    }

    if (hairOn && segmenterReady()) {
      try { hairMaskRef.current = await segmentHair(img, w, h); }
      catch (e) { console.error('[hair-seg] failed:', e); hairMaskRef.current = null; }
    } else {
      hairMaskRef.current = null;
    }
    redrawStill(img); // repaint now that the masks exist
  }, [detectStill, redrawStill, hairOn]);

  const redrawPhoto = useCallback(() => {
    const img = imgRef.current;
    if (img?.naturalWidth) redrawStill(img);
  }, [redrawStill]);

  const onFile = useCallback((e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const img = imgRef.current;
    img.onload = () => detectPhoto();
    img.src = URL.createObjectURL(f);
  }, [detectPhoto]);

  // leaving camera mode: repaint any photo that's already loaded
  useEffect(() => {
    if (ready && mode === 'photo') redrawPhoto();
  }, [ready, mode, redrawPhoto]);

  // re-render the still when controls change (camera repaints itself each frame)
  useEffect(() => {
    if (mode === 'photo') redrawPhoto();
  }, [sel, eyeSel, eyeOn, intensity, eyeIntensity, lashOn, lashIntensity, fndSel, fndOn, fndIntensity,
      blushSel, blushOn, blushIntensity, hairSel, hairOn, hairIntensity, lightResponse, finish, compare,
      showPoints, useGL, segDebug, lessonOn, step, skinDepth, mode, lookIntensity,
      redrawPhoto]);

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
      const v = videoEl;
      // full-frame dimensions, NOT the main canvas — that one is a portrait crop
      if (!v || v.videoWidth === 0) return;
      busy = true;
      try {
        const mask = await segmentHair(v, v.videoWidth, v.videoHeight);
        if (!stop && mask) hairMaskRef.current = mask;
      } catch (e) { console.error('[hair-seg] failed:', e); }
      busy = false;
    }, 250);
    return () => { stop = true; clearInterval(id); hairMaskRef.current = null; };
  }, [hairOn, segReady, mode, videoEl]);

  // camera: run segmentation asynchronously (throttled), independent of the draw loop
  useEffect(() => {
    if (!useSeg || !segReady || mode !== 'camera') { segMaskRef.current = null; return; }
    resetSegmenter();
    let busy = false, stop = false;
    const id = setInterval(async () => {
      if (busy || stop) return;
      const v = videoEl;
      if (!v || v.videoWidth === 0) return;
      // moving → release the ONNX mask immediately so the edge tracks landmarks, no lag/smear
      if (metricsRef.current.moving) {
        if (segMaskRef.current) { segMaskRef.current = null; setSegHasMask(false); resetSegmenter(); }
        return;
      }
      // still → refine the edge with segmentation (full-frame dimensions)
      busy = true;
      try {
        const mask = await segmentLips(v, faceBoxRef.current, v.videoWidth, v.videoHeight);
        if (!stop && !metricsRef.current.moving && mask) { segMaskRef.current = mask; setSegHasMask(true); }
      } catch (e) { console.error('[seg] inference failed:', e); /* keep landmark fallback */ }
      busy = false;
    }, 150);
    return () => { stop = true; clearInterval(id); segMaskRef.current = null; setSegHasMask(false); };
  }, [useSeg, segReady, mode, videoEl, metricsRef]);

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
        <div className="look-int">
          <div className="li-head">
            <label htmlFor="lookInt">Intensity</label>
            <button type="button" className={`li-val${lookIntensity === 1 ? '' : ' off'}`}
              title="Reset to the tuned look" onClick={() => setLookIntensity(1)}>
              {Math.round(lookIntensity * 100)}%
            </button>
          </div>
          <div className="li-track">
            <input id="lookInt" type="range" min="0" max="1.5" step="0.01" value={lookIntensity}
              style={{ '--p': `${(lookIntensity / 1.5) * 100}%` }}
              onChange={(e) => setLookIntensity(+e.target.value)}
              aria-label="Makeup intensity" />
            <span className="li-detent" aria-hidden="true" />
          </div>
          <div className="li-scale" aria-hidden="true">
            <span>Bare</span><span className="li-mid">Natural</span><span>Full</span>
          </div>
        </div>

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