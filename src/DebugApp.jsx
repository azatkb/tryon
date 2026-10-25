import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  useTryOn, glAvailable,
  drawLandmarks, setFeatureProtect, setRegionBlur,
  buildFaceMask, buildBlushMask, buildEyeMask, buildLashMask,
  buildContourMask, buildHighlightMask, buildUnderEyeMask, buildLipMask,
  buildLipLinerMask, buildEyelinerMask, buildBrowMask,
} from './tryon/index.js';
import { ENTITIES, AREAS, entitiesByArea } from './entities.js';
import { CATALOG } from './catalog.js';
import { lookShade, FAMILY_HEX } from './shadeData.js';

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
    case 'eyes':       return ['eyes',      { color: hex, intensity: 0.70, lightResponse: 0.5 }];
    case 'mascara':    return ['lashes',    { intensity: 0.80 }];
    case 'foundation': return ['foundation',{ color: hex, intensity: 0.26 }];
    case 'blush':      return ['blush',     { color: hex, intensity: 0.38, lightResponse: 0.5 }];
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
// tune key -> CFG key whose .blur we retune (foundation's CFG block is "face").
const CFG_KEY = {
  foundation: 'face', underEye: 'underEye', blush: 'blush',
  highlight: 'highlight', contour: 'contour', eyes: 'eyes',
};
// edge softness range per region [soft (hardness 0), hard (hardness 1)] as blur fraction.
// Soft end stays narrower than the band each stroke draws — a blur wider than
// the stroke flattens the mask peak instead of just softening its edge.
const BLUR_RANGE = {
  foundation: [0.020, 0.004], underEye: [0.030, 0.008], blush: [0.020, 0.004],
  highlight: [0.016, 0.005], contour: [0.032, 0.012],
  // midpoint lands on CFG.eyes.blur (0.007), so hardness 0.5 == shipped default
  eyes: [0.011, 0.003],
};
// defaults: opacity (layer intensity) + hardness (0=soft .. 1=hard)
const TUNE_DEFAULT = {
  foundation: { op: 0.26, hd: 0.45 }, underEye: { op: 0.55, hd: 0.55 }, blush: { op: 1.00, hd: 1.00 },
  highlight: { op: 0.55, hd: 0.50 }, contour: { op: 0.55, hd: 0.55 },
  eyes: { op: 1.00, hd: 1.00 },
};
const blurFor = (rk, hd) => { const [s, h] = BLUR_RANGE[rk]; return s + (h - s) * hd; };

export default function DebugApp() {
  const canvasRef = useRef(null), maskTintRef = useRef(null);
  const [useGL, setUseGL] = useState(glAvailable());
  const [borders, setBorders] = useState(false);
  const [showPoints, setShowPoints] = useState(false);
  const [protect, setProtect] = useState(true);
  const [tune, setTune] = useState(() => JSON.parse(JSON.stringify(TUNE_DEFAULT)));
  const [panelOpen, setPanelOpen] = useState(true);

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
    for (const rk of Object.keys(CFG_KEY)) setRegionBlur(CFG_KEY[rk], blurFor(rk, tune[rk].hd));
  }, [tune]);

  // Renderer layers from the enabled, implemented entities. Recomputed only
  // when the panel changes — the engine re-reads this object every frame.
  const layers = useMemo(() => {
    const L = {};
    for (const e of ENTITIES) {
      if (!enabled[e.id] || !IMPLEMENTED.has(e.id)) continue;
      const row = CATALOG[e.catalog];
      const picked = lookShade(row, e.family, null, null, null);
      const shade = picked.shade || (row && row.shades && row.shades[0]) || null;
      const hex = SHADE_OVERRIDE[e.region]
        || (shade && shade.hex) || (e.family && FAMILY_HEX[e.family]) || '#000000';
      const m = layerFor(e.region, hex, e.finish);
      if (m) {
        const tk = TUNE_KEY[e.id];
        if (tk && tune[tk]) m[1].intensity = tune[tk].op;
        L[m[0]] = m[1];
      }
    }
    if (enabled.contour) L.contour = { intensity: tune.contour.op };
    return L;
  }, [enabled, tune]);

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

  const { ready, error, camError } = useTryOn({
    layers,
    renderer: useGL ? 'auto' : 'canvas',
    onFrame,
  });

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
      <div className="dbg-stage">
        <canvas ref={canvasRef} className="mir" />
        {!ready && !error && <div className="dbg-overlay">Loading face model…</div>}
        {error && <div className="dbg-overlay err">Model failed: {error}</div>}
        {camError && <div className="dbg-overlay err">Camera: {camError}</div>}
      </div>

      <div className={`dbg-panel${panelOpen ? '' : ' dbg-panel--collapsed'}`}>
        <div className="dbg-head">
          <b style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => setPanelOpen((o) => !o)}>
            {panelOpen ? '▾' : '▸'} Debug · entities
          </b>
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
          <label className="dbg-row"><input type="checkbox" checked={borders} onChange={(e) => setBorders(e.target.checked)} /> Show mask borders</label>
          <label className="dbg-row"><input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} /> Mesh points</label>
          <label className="dbg-row"><input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} /> Protect features (nose/eyes/lips/brows)</label>
          <label className="dbg-row"><input type="checkbox" checked={useGL} disabled={!glAvailable()} onChange={(e) => setUseGL(e.target.checked)} /> WebGL render</label>
        </div>}
      </div>
    </div>
  );
}