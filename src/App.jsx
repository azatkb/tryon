import { useEffect, useRef, useState, useCallback } from 'react';
import { useFaceLandmarker } from './useFaceLandmarker.js';
import { renderLips } from './lipRenderer.js';
import { PRODUCTS } from './products.js';

const FINISHES = ['matte', 'satin', 'gloss'];

export default function App() {
  const { landmarkerRef, ready, error } = useFaceLandmarker();

  const [mode, setMode] = useState('camera'); // 'camera' | 'photo'
  const [sel, setSel] = useState(0); // selected product index
  const [intensity, setIntensity] = useState(0.7);
  const [finish, setFinish] = useState('satin');
  const [compare, setCompare] = useState(false);
  const [faceSeen, setFaceSeen] = useState(false);
  const [camError, setCamError] = useState(null);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const rafRef = useRef(0);
  const streamRef = useRef(null);
  const lastResRef = useRef(null);

  // live option values for the render loop (avoid stale closures)
  const optsRef = useRef({});
  optsRef.current = { color: PRODUCTS[sel].hex, intensity, finish, compare };

  const selectProduct = useCallback((i) => { setSel(i); setFinish(PRODUCTS[i].finish); }, []);

  const draw = useCallback((ctx, w, h, lms) => {
    const o = optsRef.current;
    if (lms && !o.compare) renderLips(ctx, w, h, lms, o);
  }, []);

  // ---------- CAMERA ----------
  const startCamera = useCallback(async () => {
    const fl = landmarkerRef.current;
    if (!fl) return;
    try {
      await fl.setOptions({ runningMode: 'VIDEO' });
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
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
        const ctx = cv.getContext('2d');
        ctx.drawImage(v, 0, 0, cv.width, cv.height);
        const lms = lastResRef.current?.faceLandmarks?.[0];
        setFaceSeen(!!lms);
        draw(ctx, cv.width, cv.height, lms);
      };
      cancelAnimationFrame(rafRef.current);
      tick();
    } catch (e) {
      console.error(e);
      setCamError(e?.message || String(e));
    }
  }, [landmarkerRef, draw]);

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
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    let lms = null;
    try { lms = fl.detect(img)?.faceLandmarks?.[0]; } catch (e) { console.error(e); }
    lastResRef.current = { faceLandmarks: lms ? [lms] : [] };
    setFaceSeen(!!lms);
    draw(ctx, cv.width, cv.height, lms);
  }, [landmarkerRef, draw]);

  const redrawPhoto = useCallback(() => {
    const img = imgRef.current, cv = canvasRef.current;
    if (!img || !cv || !img.naturalWidth) return;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    draw(ctx, cv.width, cv.height, lastResRef.current?.faceLandmarks?.[0]);
  }, [draw]);

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
  }, [sel, intensity, finish, compare, mode, redrawPhoto]);

  const mirrored = mode === 'camera';

  return (
    <div className="app">
      <header>
        <div className="brand">REESOLVE<span>.</span></div>
        <div className="tag">lip try-on · prototype</div>
      </header>

      <div className="stage">
        <div className={`viewport${mirrored ? ' mir' : ''}`}>
          <video ref={videoRef} playsInline muted style={{ display: 'none' }} />
          <img ref={imgRef} alt="" style={{ display: 'none' }} />
          <canvas ref={canvasRef} />
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
          {ready && faceSeen && <div className="badge ok">tracking · {compare ? 'original' : PRODUCTS[sel].shade}</div>}
        </div>
      </div>

      <div className="panel">
        <div className="seg modes">
          <button className={mode === 'camera' ? 'on' : ''} onClick={() => setMode('camera')}>Live camera</button>
          <button className={mode === 'photo' ? 'on' : ''} onClick={() => setMode('photo')}>Photo</button>
          {mode === 'photo' && (
            <label className="upload">
              Upload<input type="file" accept="image/*" onChange={onFile} hidden />
            </label>
          )}
        </div>

        <div className="field">
          <label>Products · {PRODUCTS.length}</label>
          <div className="palette">
            {PRODUCTS.map((p, i) => (
              <button key={p.id} className={`product${i === sel ? ' on' : ''}`}
                onClick={() => selectProduct(i)}>
                <span className="dot" style={{ background: p.hex }} />
                <span className="pinfo">
                  <span className="pbrand">{p.brand} · {p.line}</span>
                  <span className="pshade">{p.shade}</span>
                </span>
                <span className="pfin">{p.finish}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="field row">
          <div>
            <label>Finish</label>
            <div className="seg">
              {FINISHES.map((f) => (
                <button key={f} className={finish === f ? 'on' : ''} onClick={() => setFinish(f)}>{f}</button>
              ))}
            </div>
          </div>
          <div className="grow">
            <label>Intensity · {Math.round(intensity * 100)}%</label>
            <input type="range" min="0.1" max="1" step="0.01" value={intensity}
              onChange={(e) => setIntensity(parseFloat(e.target.value))} />
          </div>
        </div>

        <label className="compare">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
          Show original (no makeup)
        </label>

        <p className="note">
          Real MediaPipe Face Landmarker (478 points) drives a lip mask; the shade is composited with the
          <code> color </code> blend so the lips keep their own texture and shine. Production moves this to
          WebGL shaders + a BiSeNet segmentation mask for cleaner edges and 60&nbsp;fps on mid-range phones.
        </p>
      </div>
    </div>
  );
}