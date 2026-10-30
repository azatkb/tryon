import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  useTryOn, glAvailable,
  drawLandmarks, setFeatureProtect, setRegionEdge,
  buildFaceMask, buildBlushMask, buildEyeMask, buildLashMask,
  buildContourMask, buildHighlightMask, buildUnderEyeMask, buildLipMask,
  buildLipLinerMask, buildEyelinerMask, buildBrowMask,
} from './tryon/index.js';
import { ENTITIES, AREAS, entitiesByArea } from './entities.js';
import { CATALOG } from './catalog.js';
import { LESSON, LESSONS, lessonLayers, resolveStep } from './tutorials.js';
import { lookShade, FAMILY_HEX, SHADE_FAMILIES } from './shadeData.js';

// Workbench shade overrides. The catalogue's default eyeshadow is "Taupe"
// (#8A7466) — a grey-beige at luminance 0.47, which on mid-tone skin is close
// to invisible however the shader treats it. "Cocoa" from the same palette is
// the brown that actually reads. Debug-only: the product data and the lesson
// copy ("a neutral taupe wash") are left alone.
const SHADE_OVERRIDE = {
  eyes: '#7A4A2E', // warm bronze-brown — richer than the palette's Cocoa
};

// Entity region -> how it maps into the renderer's layer object.
function layerFor(region, hex, finish) {
  switch (region) {
    case 'lips':       return ['lips',      { color: hex, intensity: 0.60, finish: finish || 'satin', lightResponse: 0.5 }];
    case 'eyes':       return ['eyes',      { color: hex, intensity: 0.70, finish: finish || 'satin', lightResponse: 0.5 }];
    case 'mascara':    return ['lashes',    { intensity: 0.80 }];
    case 'foundation': return ['foundation',{ color: hex, intensity: 0.26, finish: finish || 'natural' }];
    case 'blush':      return ['blush',     { color: hex, intensity: 0.38, finish: finish || 'powder', lightResponse: 0.5 }];
    case 'highlight':  return ['highlight', { intensity: 0.55 }];
    case 'concealer':  return ['underEye',  { intensity: 0.55 }];
    case 'contour':    return ['contour',   { intensity: 0.55 }];
    case 'lipLiner':   return ['lipLiner',  { color: hex, intensity: 0.80 }];
    case 'eyeliner':   return ['eyeliner',  { color: hex, intensity: 0.85 }];
    case 'brows':      return ['brows',     { color: hex, intensity: 0.55 }];
    default:           return null;
  }
}

// Which mask builder draws a region (for the border overlay).
const MASK_BUILDERS = {
  foundation: buildFaceMask, blush: buildBlushMask, eyes: buildEyeMask,
  mascara: buildLashMask, contour: buildContourMask, highlight: buildHighlightMask,
  concealer: buildUnderEyeMask, lips: buildLipMask,
  lipLiner: buildLipLinerMask, eyeliner: buildEyelinerMask, brows: buildBrowMask,
};
const REGION_COLOR = {
  foundation: '#49C0FF', blush: '#FF5AA0', eyes: '#B98CFF', mascara: '#FFC84A',
  contour: '#49FFC0', highlight: '#FFF07A', concealer: '#6AD0FF', lips: '#FF6A6A',
  lipLiner: '#FF3D7F', eyeliner: '#C8FF4A', brows: '#FFA64A',
};

const IMPLEMENTED = new Set(['lipstick', 'eyeshadow', 'mascara', 'foundation', 'concealer', 'blush', 'highlight', 'lip-liner', 'eyeliner', 'brows']);

// Entities that get live opacity + edge-hardness sliders in the panel.
// entity.region -> tune key (the layer/CFG region the sliders drive).
const TUNE_KEY = {
  foundation: 'foundation', concealer: 'underEye', blush: 'blush',
  highlight: 'highlight', contour: 'contour', eyeshadow: 'eyes',
};

// Panel defaults are READ FROM THE LESSON, not kept as a second table here.
// Two hand-maintained copies is exactly how the workbench and the tutorial
// ended up rendering different makeup. Edit tutorials.js; this follows.
// All tunable regions need an entry even if the lesson doesn't have that step,
// otherwise the slider crashes on `tune[rk].op`.
const ALL_TUNE_REGIONS = ['foundation', 'underEye', 'blush', 'highlight', 'contour', 'eyes', 'brows'];
function tuneFromLesson(lesson) {
  const base = Object.fromEntries(ALL_TUNE_REGIONS.map(r => [r, { op: 0.0, hd: 0.30 }]));
  for (const s of lesson.steps) {
    if (typeof s.edge === 'number') base[s.region] = { op: s.intensity, hd: s.edge };
  }
  return base;
}
const TUNE_DEFAULT = tuneFromLesson(LESSON);

// Collect all shade families used across lessons for the palette viewer.
function collectFamilies() {
  const seen = new Set();
  for (const ls of LESSONS) for (const s of ls.steps) if (s.family) seen.add(s.family);
  return [...seen].sort();
}

export default function DebugApp() {
  const canvasRef = useRef(null), maskTintRef = useRef(null);
  const origCanvasRef = useRef(null);  // original photo for side-by-side
  const imgRef = useRef(null);
  const [useGL, setUseGL] = useState(glAvailable());
  const [borders, setBorders] = useState(false);
  const [showPoints, setShowPoints] = useState(false);
  const [protect, setProtect] = useState(true);
  const [tune, setTune] = useState(() => JSON.parse(JSON.stringify(TUNE_DEFAULT)));
  const [panelOpen, setPanelOpen] = useState(true);
  const [cinema, setCinema] = useState(0);
  const [eyeFinish, setEyeFinish] = useState('satin');
  const [fndFinish, setFndFinish] = useState('natural');
  const [blushFinish, setBlushFinish] = useState('powder');
  const [lessonIdx, setLessonIdx] = useState(0);
  const [showFamilies, setShowFamilies] = useState(false);
  const [photoMode, setPhotoMode] = useState(false);
  const [photoUrl, setPhotoUrl] = useState(null);
  const activeLesson = LESSONS[lessonIdx] || LESSON;
  const allFamilies = useMemo(collectFamilies, []);

  // enabled entities (default: all implemented on for full realism)
  const [enabled, setEnabled] = useState(() => {
    const s = {};
    for (const e of ENTITIES) s[e.id] = IMPLEMENTED.has(e.id);
    s.contour = true;
    return s;
  });
  const stateRef = useRef({});
  stateRef.current = { enabled, useGL, borders, showPoints, tune };

  // feature protection is a module-level flag in the renderer
  useEffect(() => { setFeatureProtect(protect); }, [protect]);

  // push edge-hardness sliders into the renderer's CFG blur values
  useEffect(() => {
    for (const rk of Object.keys(tune)) setRegionEdge(rk, tune[rk].hd);
  }, [tune]);

  // Renderer layers built from the ACTIVE LESSON's steps. Tune sliders and
  // finish overrides are applied on top. Entity toggles still gate regions.
  const REGION_TO_ENTITY = { foundation: 'foundation', underEye: 'concealer', blush: 'blush',
    highlight: 'highlight', contour: 'contour', eyes: 'eyeshadow', eyeliner: 'eyeliner',
    lashes: 'mascara', lips: 'lipstick', lipLiner: 'lip-liner', brows: 'brows' };

  const layers = useMemo(() => {
    // Build full lesson layers (all steps applied)
    const lastIdx = activeLesson.steps.length - 1;
    const L = lessonLayers(lastIdx, undefined, activeLesson);

    // Gate by entity toggles — remove regions whose entity is disabled
    for (const [region, entId] of Object.entries(REGION_TO_ENTITY)) {
      if (region === 'contour') continue; // handled separately
      if (!enabled[entId] && L[region]) delete L[region];
    }
    if (!enabled.contour) delete L.contour;

    // Apply tune slider overrides (opacity + edge)
    for (const [rk, tv] of Object.entries(tune)) {
      if (L[rk]) L[rk].intensity = tv.op;
    }

    // Override finishes from panel selectors
    if (L.eyes) L.eyes.finish = eyeFinish;
    if (L.foundation) L.foundation.finish = fndFinish;
    if (L.blush) L.blush.finish = blushFinish;
    L.cinema = cinema;
    return L;
  }, [enabled, tune, cinema, eyeFinish, fndFinish, blushFinish, activeLesson]);

  const drawBorders = useCallback((ctx, w, h, lms) => {
    if (!maskTintRef.current) maskTintRef.current = document.createElement('canvas');
    const t = maskTintRef.current;
    if (t.width !== w || t.height !== h) { t.width = w; t.height = h; }
    const tx = t.getContext('2d');
    // edge-detect scratch
    if (!maskTintRef._edge) { maskTintRef._edge = document.createElement('canvas'); }
    const e = maskTintRef._edge;
    if (e.width !== w || e.height !== h) { e.width = w; e.height = h; }
    const ex = e.getContext('2d');

    const regions = ENTITIES
      .filter((ent) => stateRef.current.enabled[ent.id] && IMPLEMENTED.has(ent.id))
      .map((ent) => ent.region);
    if (stateRef.current.enabled.contour) regions.push('contour');

    for (const region of regions) {
      const build = MASK_BUILDERS[region];
      if (!build) continue;
      const mask = region === 'lips' ? build(w, h, lms, {}) : build(w, h, lms);

      // Draw mask into t, tinted with region color
      tx.clearRect(0, 0, w, h);
      tx.globalCompositeOperation = 'source-over';
      tx.drawImage(mask, 0, 0, w, h);
      tx.globalCompositeOperation = 'source-in';
      tx.fillStyle = REGION_COLOR[region] || '#fff';
      tx.fillRect(0, 0, w, h);

      // Edge-detect: draw mask dilated then subtract original → outline only
      ex.clearRect(0, 0, w, h);
      ex.globalCompositeOperation = 'source-over';
      // Dilate by drawing offset copies
      for (const [dx, dy] of [[-2,0],[2,0],[0,-2],[0,2]]) {
        ex.drawImage(t, dx, dy, w, h);
      }
      ex.globalCompositeOperation = 'destination-out';
      ex.drawImage(t, 0, 0, w, h);

      // Blit thin outline onto main ctx
      ctx.save();
      ctx.globalAlpha = 0.90;
      ctx.drawImage(e, 0, 0, w, h);
      ctx.restore();
    }
  }, []);

  // The engine owns camera, detection, smoothing, exposure and the makeup pass.
  // All this workbench does is blit the processed frame and draw its overlays.
  const onFrame = useCallback(({ processed, landmarks, w, h }) => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    ctx.drawImage(processed, 0, 0, w, h);
    if (!landmarks) return;
    if (stateRef.current.borders) drawBorders(ctx, w, h, landmarks);
    if (stateRef.current.showPoints) drawLandmarks(ctx, w, h, landmarks);
  }, [drawBorders]);

  const { ready, error, camError, detectStill, redrawStill } = useTryOn({
    layers,
    source: photoMode ? 'element' : 'camera',
    sourceEl: imgRef.current,
    renderer: useGL ? 'auto' : 'canvas',
    onFrame,
  });

  // Photo upload handler
  const handlePhoto = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPhotoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
    setPhotoMode(true);
  }, []);

  // Detect face when photo loads + draw original for side-by-side
  const handleImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    // Draw original onto origCanvasRef for side-by-side comparison
    const oc = origCanvasRef.current;
    if (oc) {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w && h) {
        oc.width = w; oc.height = h;
        oc.getContext('2d').drawImage(img, 0, 0, w, h);
      }
    }
    if (ready) detectStill(img);
  }, [ready, detectStill]);

  // Redraw makeup when layers change in photo mode
  useEffect(() => {
    if (photoMode && imgRef.current && ready) {
      redrawStill(imgRef.current);
    }
  }, [photoMode, layers, ready, redrawStill]);

  // Back to camera
  const exitPhoto = useCallback(() => {
    setPhotoMode(false);
    setPhotoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
  }, []);

  // Download combined side-by-side: original | processed
  const downloadCombined = useCallback(() => {
    const orig = origCanvasRef.current;
    const proc = canvasRef.current;
    if (!orig || !proc || !orig.width || !proc.width) return;
    const w = orig.width, h = orig.height;
    const gap = Math.round(w * 0.005);  // thin gap between halves
    const combo = document.createElement('canvas');
    combo.width = w * 2 + gap;
    combo.height = h;
    const ctx = combo.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, combo.width, combo.height);
    ctx.drawImage(orig, 0, 0, w, h);
    ctx.drawImage(proc, w + gap, 0, w, h);
    // Labels
    ctx.font = `bold ${Math.max(14, Math.round(h * 0.025))}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 4;
    const pad = Math.round(h * 0.02);
    ctx.fillText('Original', pad, h - pad);
    ctx.fillText('REESOLVE', w + gap + pad, h - pad);
    ctx.shadowBlur = 0;
    // Download
    const a = document.createElement('a');
    a.download = 'reesolve-comparison.png';
    a.href = combo.toDataURL('image/png');
    a.click();
  }, []);

  const toggle = (id) => setEnabled((s) => ({ ...s, [id]: !s[id] }));
  const setAll = (val) => setEnabled((s) => { const n = { ...s }; for (const e of ENTITIES) if (IMPLEMENTED.has(e.id)) n[e.id] = val; return n; });

  const slider = (rk, label, field) => (
    <label className="dbg-slider">
      <span>{label}</span>
      <input type="range" min="0" max="1" step="0.01" value={tune[rk][field]}
        onChange={(e) => { const v = +e.target.value; setTune((t) => ({ ...t, [rk]: { ...t[rk], [field]: v } })); }} />
      <em>{Math.round(tune[rk][field] * 100)}</em>
    </label>
  );
  const tuneBlock = (rk) => (
    <div className="dbg-tune">
      {slider(rk, 'opacity', 'op')}
      {slider(rk, 'края', 'hd')}
    </div>
  );

  return (
    <div className="dbg">
      {/* Hidden img for photo mode — needed as sourceEl for detectStill */}
      {photoUrl && <img ref={imgRef} src={photoUrl} onLoad={handleImgLoad}
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
        crossOrigin="anonymous" />}

      <div className="dbg-stage">
        {photoMode && photoUrl ? (
          /* Side-by-side: original | processed */
          <div style={{ display: 'flex', gap: 2, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <canvas ref={origCanvasRef} className="mir" style={{ maxWidth: '100%', maxHeight: '100%' }} />
              <span style={{ position: 'absolute', bottom: 8, left: 10, fontSize: '.7rem', color: 'rgba(255,255,255,0.7)',
                textShadow: '0 1px 3px rgba(0,0,0,0.8)', fontWeight: 600 }}>Original</span>
            </div>
            <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <canvas ref={canvasRef} className="mir" style={{ maxWidth: '100%', maxHeight: '100%' }} />
              <span style={{ position: 'absolute', bottom: 8, left: 10, fontSize: '.7rem', color: 'rgba(255,255,255,0.7)',
                textShadow: '0 1px 3px rgba(0,0,0,0.8)', fontWeight: 600 }}>REESOLVE</span>
            </div>
          </div>
        ) : (
          <canvas ref={canvasRef} className="mir" />
        )}
        {!ready && !error && <div className="dbg-overlay">Loading face model…</div>}
        {error && <div className="dbg-overlay err">Model failed: {error}</div>}
        {camError && !photoMode && <div className="dbg-overlay err">Camera: {camError}</div>}
        {photoMode && !photoUrl && <div className="dbg-overlay">Upload a photo to debug</div>}
      </div>

      <div className={`dbg-panel${panelOpen ? '' : ' dbg-panel--collapsed'}`}>
        {/* ── Lesson picker ── */}
        <div className="dbg-head">
          <b style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => setPanelOpen((o) => !o)}>
            {panelOpen ? '▾' : '▸'} Debug
          </b>
        </div>
        {panelOpen && (
          <div className="dbg-group">
            <div className="dbg-area">Lesson ({LESSONS.length})</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 0' }}>
              {LESSONS.map((ls, i) => (
                <button key={i}
                  onClick={() => { setLessonIdx(i); setTune(JSON.parse(JSON.stringify(tuneFromLesson(ls)))); }}
                  style={{
                    padding: '3px 10px', borderRadius: 12, fontSize: '.72rem', fontWeight: 600,
                    border: i === lessonIdx ? '2px solid #c2185b' : '1px solid #555',
                    background: i === lessonIdx ? '#c2185b' : 'transparent',
                    color: i === lessonIdx ? '#fff' : '#ccc', cursor: 'pointer',
                  }}>
                  {ls.title}
                </button>
              ))}
            </div>
            <div style={{ fontSize: '.7rem', color: '#888', marginTop: 2 }}>
              Steps: {activeLesson.steps.length} · Eye: {activeLesson.steps.find(s => s.region === 'eyes')?.family || '—'} · Lip: {activeLesson.steps.find(s => s.region === 'lips')?.family || '—'}
            </div>
          </div>
        )}

        {/* ── Shade families ── */}
        {panelOpen && (
          <div className="dbg-group">
            <div className="dbg-area" style={{ cursor: 'pointer' }} onClick={() => setShowFamilies(f => !f)}>
              {showFamilies ? '▾' : '▸'} Shade Families ({Object.keys(SHADE_FAMILIES).length})
            </div>
            {showFamilies && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 3, padding: '4px 0' }}>
                {Object.entries(FAMILY_HEX).map(([fam, hex]) => (
                  <div key={fam} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '.68rem', color: '#ccc' }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, background: hex, border: '1px solid #555', flexShrink: 0 }} />
                    {fam}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Entities ── */}
        <div className="dbg-head" style={{ borderTop: '1px solid #333', marginTop: 4, paddingTop: 4 }}>
          <b>Entities</b>
          {panelOpen && <span className="dbg-mini">
            <button onClick={() => setAll(true)}>all</button>
            <button onClick={() => setAll(false)}>none</button>
          </span>}
        </div>
        {panelOpen && AREAS.map((a) => (
          <div key={a.id} className="dbg-group">
            <div className="dbg-area">{a.label}</div>
            {entitiesByArea(a.id).map((e) => {
              const impl = IMPLEMENTED.has(e.id);
              const tk = TUNE_KEY[e.id];
              return (
                <div key={e.id}>
                  <label className={`dbg-row${impl ? '' : ' off'}`}>
                    <input type="checkbox" checked={!!enabled[e.id]} disabled={!impl} onChange={() => toggle(e.id)} />
                    <span className="dbg-dot" style={{ background: REGION_COLOR[e.region] || '#888' }} />
                    {e.name}{impl ? '' : ' · todo'}
                  </label>
                  {tk && impl && enabled[e.id] && tuneBlock(tk)}
                </div>
              );
            })}
          </div>
        ))}
        {panelOpen && <div className="dbg-group">
          <div className="dbg-area">Contour (non-contract)</div>
          <label className="dbg-row">
            <input type="checkbox" checked={!!enabled.contour} onChange={() => toggle('contour')} />
            <span className="dbg-dot" style={{ background: REGION_COLOR.contour }} />Contour
          </label>
          {enabled.contour && tuneBlock('contour')}
        </div>}
        {panelOpen && <div className="dbg-foot">
          {/* ── Photo mode ── */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid #333' }}>
            <label style={{ fontSize: '.72rem', cursor: 'pointer', padding: '3px 10px', borderRadius: 12, fontWeight: 600,
              border: photoMode ? '2px solid #2196f3' : '1px solid #555',
              background: photoMode ? '#2196f3' : 'transparent',
              color: photoMode ? '#fff' : '#ccc' }}>
              Photo
              <input type="file" accept="image/*" onChange={handlePhoto} style={{ display: 'none' }} />
            </label>
            {photoMode && (
              <button onClick={exitPhoto} style={{ fontSize: '.72rem', padding: '3px 10px', borderRadius: 12,
                border: '1px solid #555', background: 'transparent', color: '#ccc', cursor: 'pointer', fontWeight: 600 }}>
                Camera
              </button>
            )}
            {photoMode && photoUrl && (
              <button onClick={downloadCombined} style={{ fontSize: '.72rem', padding: '3px 10px', borderRadius: 12,
                border: '1px solid #4caf50', background: '#4caf50', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
                ⬇ Download
              </button>
            )}
          </div>
          <label className="dbg-row"><input type="checkbox" checked={borders} onChange={(e) => setBorders(e.target.checked)} /> Show mask borders</label>
          <label className="dbg-row"><input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} /> Mesh points</label>
          <label className="dbg-row"><input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} /> Protect features (nose/eyes/lips/brows)</label>
          <label className="dbg-row"><input type="checkbox" checked={useGL} disabled={!glAvailable()} onChange={(e) => setUseGL(e.target.checked)} /> WebGL render</label>
          <label className="dbg-row" style={{marginTop:6}}>
            Cinema <input type="range" min="0" max="1" step="0.01" value={cinema} onChange={(e) => setCinema(+e.target.value)} style={{width:90,verticalAlign:'middle'}} /> {cinema.toFixed(2)}
          </label>
          <label className="dbg-row">
            Foundation <select value={fndFinish} onChange={(e) => setFndFinish(e.target.value)} style={{marginLeft:4}}>
              <option value="matte">Matte</option><option value="natural">Natural</option><option value="dewy">Dewy</option>
            </select>
          </label>
          <label className="dbg-row">
            Eyeshadow <select value={eyeFinish} onChange={(e) => setEyeFinish(e.target.value)} style={{marginLeft:4}}>
              <option value="matte">Matte</option><option value="satin">Satin</option><option value="shimmer">Shimmer</option>
            </select>
          </label>
          <label className="dbg-row">
            Blush <select value={blushFinish} onChange={(e) => setBlushFinish(e.target.value)} style={{marginLeft:4}}>
              <option value="powder">Powder</option><option value="cream">Cream</option>
            </select>
          </label>
        </div>}
      </div>
    </div>
  );
}