import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  useTryOn, glAvailable,
  drawLandmarks, setFeatureProtect, setRegionEdge,
  buildFaceMask, buildBlushMask, buildEyeMask, buildLashMask,
  buildContourMask, buildHighlightMask, buildUnderEyeMask, buildLipMask,
  buildLipLinerMask, buildEyelinerMask, buildBrowMask, getLastLipSeg, resetLipSeg, setLipRoughness, setLipSymmetry, setLipSoftness, setLipOpenDetect, getLipModel, setLipCore, setLipPixelCut,
  UV_PRODUCTS, loadUVMasks, reloadUVMasks, uvMaskCanvas, setUVMaskImage, getUVMaskImage, setUVMasksEnabled, bakeUVMasks, uvTemplate, canvasToPngBlob,
  setEyeShadowProcedural, setEyeShadowShape, getEyeShadowShape,
} from './tryon/index.js';
import { createMp4Writer, downloadBlob, mp4WriterSupported } from './videoWriter.js';
import { refineLipContour, drawRefinedContour } from './tryon/lipContourRefine.js';
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

// Scene light gizmo, top-right corner (out of the way of the face): a disc
// seen from the camera — the dot is where the key light sits (centre = light
// on the camera axis, edge = from the side; hollow dot = light from behind
// the camera plane is impossible, so it's always filled), plus the numbers.
function drawLight(ctx, w, h, lms, L, mirrored = false) {
  // the camera preview is mirrored by CSS: draw un-mirrored, in screen terms
  const x = mirrored ? -L.dir[0] : L.dir[0], y = L.dir[1];
  const az = mirrored ? -L.azimuth : L.azimuth;
  const R = Math.max(18, Math.round(Math.min(w, h) * 0.045));
  const pad = Math.round(R * 0.5);
  const cx = w - pad - R, cy = pad + R;
  ctx.save();
  if (mirrored) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  // light position on the disc (orthographic view of the light direction)
  const lx = cx + x * R, ly = cy + y * R;
  ctx.globalAlpha = 0.4 + 0.6 * Math.min(1, L.conf ?? 1);
  ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(lx, ly); ctx.stroke();
  ctx.fillStyle = '#ffd54a';
  ctx.beginPath(); ctx.arc(lx, ly, Math.max(3, R * 0.16), 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.9;
  const fs = Math.max(10, Math.round(R * 0.36));
  ctx.font = `${fs}px sans-serif`; ctx.textAlign = 'right'; ctx.fillStyle = '#fff';
  ctx.fillText(`az ${Math.round(az)}°  el ${Math.round(L.elevation)}°`, w - pad, cy + R + fs + 4);
  ctx.fillText(`amb ${Math.round(L.ambientShare * 100)}%  conf ${Math.round((L.conf ?? 0) * 100)}%`, w - pad, cy + R + 2 * fs + 7);
  ctx.restore();
}

// Which mask builder draws a region (for the border overlay).
const MASK_BUILDERS = {
  foundation: buildFaceMask, blush: buildBlushMask, eyes: buildEyeMask,
  mascara: buildLashMask, contour: buildContourMask, highlight: buildHighlightMask,
  concealer: buildUnderEyeMask, lips: buildLipMask,
  lipLiner: buildLipLinerMask, eyeliner: buildEyelinerMask, brows: buildBrowMask,
};
// Region (border overlay) -> UV mask key.
const UV_REGION = {
  foundation: 'foundation', blush: 'blush', eyes: 'eyes', contour: 'contour', highlight: 'highlight',
  concealer: 'underEye', eyeliner: 'eyeliner', brows: 'brows',
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
  const videoElRef = useRef(null);     // <video> for video file playback
  const intentPauseRef = useRef(false); // true while WE paused it (vs. the browser)
  const [useGL, setUseGL] = useState(glAvailable());
  const [borders, setBorders] = useState(false);
  const [showPoints, setShowPoints] = useState(false);
  const [showLight, setShowLight] = useState(true);
  const [motionFade, setMotionFade] = useState(false);
  const [fadeSens, setFadeSens] = useState(1);
  const fadeInfoRef = useRef(null);
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
  const [videoMode, setVideoMode] = useState(false);
  const [videoUrl, setVideoUrl] = useState(null);
  const [videoPaused, setVideoPaused] = useState(false);
  const [recording, setRecording] = useState(false);   // live camera recording
  const [saving, setSaving] = useState(false);         // finishing the MP4
  const [recError, setRecError] = useState(null);
  const liveWriterRef = useRef(null);
  const pauseStartRef = useRef(0);
  const videoModeRef = useRef(false);
  videoModeRef.current = videoMode;
  const liveT0Ref = useRef(0);
  const [lipContour, setLipContour] = useState(false);
  const [colorSeg, setColorSeg] = useState(true);
  const [lipRough, setLipRough] = useState(0.75);
  const [lipSym, setLipSym] = useState(0.6);
  const [lipSoft, setLipSoft] = useState(1.0);
  const [lipCover, setLipCover] = useState(0.6);
  const [lipTex, setLipTex] = useState(null);        // HTMLImageElement of a lip product texture
  const [lipTexMix, setLipTexMix] = useState(0.7);
  const [lipTexScale, setLipTexScale] = useState(2.0);
  const segInfoRef = useRef(null);
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
  const [rawView, setRawView] = useState(false);
  const rendInfoRef = useRef(null);
  const stateRef = useRef({});
  stateRef.current = { enabled, useGL, borders, showPoints, showLight, tune, lipContour, colorSeg, rawView };

  // feature protection is a module-level flag in the renderer
  useEffect(() => { setFeatureProtect(protect); }, [protect]);
  useEffect(() => { setLipRoughness(lipRough); }, [lipRough]);
  useEffect(() => { setLipSymmetry(lipSym); }, [lipSym]);
  useEffect(() => { setLipSoftness(lipSoft); }, [lipSoft]);
  const [openDet, setOpenDet] = useState('mp');
  const openDetRef = useRef('mp'); openDetRef.current = openDet;
  const [lipCore, setLipCoreS] = useState(true);
  const [pixCut, setPixCut] = useState(true);
  useEffect(() => { setLipPixelCut(pixCut); }, [pixCut]);
  useEffect(() => { setLipCore(lipCore); }, [lipCore]);
  useEffect(() => { setLipOpenDetect(openDet); }, [openDet]);

  // ── UV masks ──
  const [uvOn, setUvOn] = useState(true);
  const [uvKey, setUvKey] = useState('foundation');
  const [uvLoaded, setUvLoaded] = useState(0);
  const uvCount = () => setUvLoaded(UV_PRODUCTS.filter((k) => getUVMaskImage(k)).length);
  useEffect(() => { setUVMasksEnabled(uvOn); }, [uvOn]);
  // Eyeshadow: adaptive (laid out per face in eye widths) vs the eyes.png UV mask
  const [eyeAdaptive, setEyeAdaptive] = useState(true);
  const [eyeShape, setEyeShape] = useState(() => getEyeShadowShape());
  useEffect(() => { setEyeShadowProcedural(eyeAdaptive); }, [eyeAdaptive]);
  useEffect(() => { setEyeShadowShape(eyeShape); }, [eyeShape]);
  useEffect(() => { loadUVMasks().then(uvCount); }, []);
  const uvBake = async (download) => {
    const maps = bakeUVMasks({ size: 512 });
    for (const [k, c] of Object.entries(maps)) {
      setUVMaskImage(k, c);
      if (download) { downloadBlob(await canvasToPngBlob(c), `${k}.png`); await new Promise((r) => setTimeout(r, 250)); }
    }
    uvCount();
  };

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
    if (L.lips) L.lips.coverage = lipCover;
    if (L.lips && lipTex) { L.lips.texture = lipTex; L.lips.textureMix = lipTexMix; L.lips.textureScale = lipTexScale; }
    L.cinema = cinema;
    return L;
  }, [enabled, tune, cinema, eyeFinish, fndFinish, blushFinish, activeLesson, lipCover, lipTex, lipTexMix, lipTexScale]);

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
      // Outline the mask the renderer ACTUALLY used for lips / liner.
      const seg = stateRef.current.colorSeg ? getLastLipSeg() : null;
      // UV products: outline the UV mask on the mesh (what the renderer draws).
      const uvMask = UV_REGION[region] ? uvMaskCanvas(UV_REGION[region], lms, w, h) : null;
      const mask = uvMask || ((region === 'lips' || region === 'lipLiner')
        ? build(w, h, lms, { lipSeg: seg })
        : build(w, h, lms));

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
  const scratchRef = useRef(null);
  const debugContourBufRef = useRef([]);
  // Last raw frame + landmarks, for "Save debug frame" (exact repro offline).
  const dumpRef = useRef(null);
  const saveDebugFrame = useCallback(async () => {
    const d = dumpRef.current;
    if (!d || !d.source || !d.landmarks) return;
    const c = document.createElement('canvas'); c.width = d.w; c.height = d.h;
    c.getContext('2d').drawImage(d.source, 0, 0, d.w, d.h);          // original pixels, no makeup, not mirrored
    const stamp = Date.now();
    downloadBlob(await canvasToPngBlob(c), `debug-frame-${stamp}.png`);
    const seg = getLastLipSeg();
    const info = {
      w: d.w, h: d.h, landmarks: d.landmarks.map((p) => [p.x, p.y, p.z || 0]),
      settings: { openMode: openDetRef.current, lipCore, lipRough, lipSym, lipSoft, lipCover, colorSeg },
      seg: seg ? { conf: seg.conf, dprime: seg.dprime, open: seg.open, t: seg.t, outer: seg.outerSmooth, inner: seg.inner } : null,
    };
    await new Promise((r) => setTimeout(r, 300));
    downloadBlob(new Blob([JSON.stringify(info)], { type: 'application/json' }), `debug-frame-${stamp}.json`);
  }, [lipCore, lipRough, lipSym, lipSoft, lipCover, colorSeg]);
  const onFrame = useCallback(({ processed, source, landmarks, w, h, light, fade, jump, renderer }) => {
    if (rendInfoRef.current && rendInfoRef.current.textContent !== renderer) rendInfoRef.current.textContent = renderer || '';
    dumpRef.current = { source, landmarks, w, h };
    if (fadeInfoRef.current) fadeInfoRef.current.textContent = `jump ${((jump || 0) * 100).toFixed(1)}% · makeup ${Math.round((fade ?? 1) * 100)}%`;
    const cv = canvasRef.current;
    if (!cv) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    // "Raw frame": what the browser decoded, no makeup render — tells a
    // decode problem (HDR video in Safari) from a render problem.
    ctx.drawImage(stateRef.current.rawView ? source : processed, 0, 0, w, h);
    // Live recording: every rendered frame goes to the encoder (after overlays).
    const capture = () => {
      const wr = liveWriterRef.current;
      if (wr) wr.addFrameNow(cv, (performance.now() - liveT0Ref.current) * 1000);
    };
    // Segmentation quality readout (DOM write, no React re-render)
    const si = segInfoRef.current;
    if (si) {
      const sg = stateRef.current.colorSeg ? getLastLipSeg() : null;
      si.textContent = sg ? `d'=${sg.dprime.toFixed(2)} conf=${Math.round(sg.conf * 100)}% · mouth ${sg.open ? 'open ' + Math.round((sg.openRatio || 0) * 100) + '%' : 'closed'}${openDetRef.current === 'predict' ? (getLipModel()?.n >= 8 ? ' · model ✓' : ' · model ' + (getLipModel()?.n || 0) + '/8 (keep mouth closed)') : ''}` : '';
      si.style.color = !sg ? '#888' : sg.conf > 0.7 ? '#4caf50' : sg.conf > 0.3 ? '#ff9800' : '#f44336';
    }
    if (!landmarks) { capture(); return; }
    if (stateRef.current.borders) drawBorders(ctx, w, h, landmarks);
    if (stateRef.current.showPoints) drawLandmarks(ctx, w, h, landmarks);
    if (stateRef.current.showLight && light) drawLight(ctx, w, h, landmarks, light, !videoModeRef.current);

    // Lip contour refinement — sample brightness from the SOURCE frame
    if (stateRef.current.lipContour && source) {
      if (!scratchRef.current) scratchRef.current = document.createElement('canvas');
      const sc = scratchRef.current;
      if (sc.width !== w || sc.height !== h) { sc.width = w; sc.height = h; }
      const sctx = sc.getContext('2d', { willReadFrequently: true });
      sctx.drawImage(source, 0, 0, w, h);
      const imageData = sctx.getImageData(0, 0, w, h);

      const refined = refineLipContour(imageData, landmarks, w, h, {
        frameBuffer: debugContourBufRef.current,
        bufferSize: 3,
        spatialStr: 0.4,
      });
      drawRefinedContour(ctx, refined, { color: '#0f0', lineWidth: 1.5 });
    }
    capture();
  }, [drawBorders]);

  const tryOnSource = videoMode ? 'video' : photoMode ? 'element' : 'camera';
  const tryOnEl = videoMode ? videoElRef.current : imgRef.current;
  const { ready, error, camError, detectStill, redrawStill } = useTryOn({
    layers,
    source: tryOnSource,
    sourceEl: tryOnEl,
    renderer: useGL ? 'auto' : 'canvas',
    lipColorSeg: colorSeg,
    // sensitivity > 1 = hides on smaller jumps
    motionFade: motionFade ? { lo: 0.04 / fadeSens, hi: 0.11 / fadeSens, recover: 5 } : false,
    onFrame,
  });

  // Photo upload handler
  const handlePhoto = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Exit video mode if active
    if (videoElRef.current) { intentPauseRef.current = true; videoElRef.current.pause(); }
    setVideoMode(false);
    setVideoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
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
  }, [photoMode, layers, ready, redrawStill, colorSeg, lipRough, lipSym, lipSoft, eyeAdaptive, eyeShape, pixCut]);

  // Back to camera
  const exitPhoto = useCallback(() => {
    setPhotoMode(false);
    setPhotoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
  }, []);

  // Video file upload handler
  const handleVideo = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setVideoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
    setVideoMode(true);
    setPhotoMode(false);
    setVideoPaused(false);
  }, []);

  // When video element is ready, start playback
  const handleVideoLoaded = useCallback(() => {
    const v = videoElRef.current;
    if (v) { intentPauseRef.current = false; v.play().catch(() => {}); setVideoPaused(false); detectVideoColor(v); }
  }, []);
  // The browser paused it (Safari power saving), not the user: play on.
  const handleVideoPausedByBrowser = useCallback(() => {
    const v = videoElRef.current;
    if (!v || v.ended || !videoModeRef.current || intentPauseRef.current) return;
    setTimeout(() => { if (!intentPauseRef.current && v.paused) v.play().catch(() => {}); }, 0);
  }, []);
  // What the browser decodes: an HDR video (iPhone: HLG / Dolby Vision) is
  // drawn into a canvas WITHOUT tone mapping by some Safari versions — the
  // whole frame comes out blown out. Shown in the panel.
  const [videoColor, setVideoColor] = useState('');
  const detectVideoColor = (v) => {
    const sv = /Version\/([\d.]+).*Safari/.exec(navigator.userAgent);
    let info = `${v.videoWidth}×${v.videoHeight}` + (sv ? ` · Safari ${sv[1]}` : '');
    const probe = () => {
      try {
        if (typeof VideoFrame === 'undefined') return ' · no WebCodecs';
        const vf = new VideoFrame(v);
        const cs = vf.colorSpace || {};
        let r = ` · ${cs.transfer || '?'} / ${cs.primaries || '?'}${cs.fullRange ? ' full' : ''}`;
        if (cs.transfer === 'hlg' || cs.transfer === 'pq') r += ' · HDR!';
        vf.close();
        return r;
      } catch (e) { return ` · VideoFrame: ${(e && e.message) || e}`; }
    };
    // the first decoded frame may not be readable at 'loadeddata' yet
    const done = () => setVideoColor(info + probe());
    if (typeof v.requestVideoFrameCallback === 'function') { let ok = false; v.requestVideoFrameCallback(() => { ok = true; done(); }); setTimeout(() => { if (!ok) done(); }, 1500); }
    else setTimeout(done, 300);
  };


  const toggleVideoPause = useCallback(() => {
    const v = videoElRef.current;
    if (!v) return;
    if (v.paused) {
      // Resume: shift the recording clock so the pause leaves no frozen gap.
      if (pauseStartRef.current) { liveT0Ref.current += performance.now() - pauseStartRef.current; pauseStartRef.current = 0; }
      intentPauseRef.current = false;
      v.play().catch(() => {}); setVideoPaused(false);
    } else {
      pauseStartRef.current = performance.now();
      intentPauseRef.current = true;
      v.pause(); setVideoPaused(true);
    }
  }, []);

  const exitVideo = useCallback(() => {
    const v = videoElRef.current;
    if (v) { intentPauseRef.current = true; v.pause(); v.removeAttribute('src'); v.load(); }
    setVideoMode(false);
    setVideoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setVideoPaused(false);
  }, []);

  // ── Recording: WebCodecs H.264 → MP4, every rendered frame, full resolution ──
  // Camera and video: each frame onFrame paints is encoded with its real time.
  // Rec starts, Stop saves the file immediately.
  const startRecording = useCallback(async () => {
    const cv = canvasRef.current;
    if (!cv || !cv.width) return;
    setRecError(null);
    try {
      const wr = await createMp4Writer({
        width: cv.width, height: cv.height, fps: 30,
        mirror: !videoModeRef.current, // camera preview is mirrored on screen — save what you see
      });
      liveT0Ref.current = performance.now();
      pauseStartRef.current = videoElRef.current?.paused && videoModeRef.current ? performance.now() : 0;
      liveWriterRef.current = wr;
      setRecording(true);
    } catch (e) { setRecError(e.message || String(e)); }
  }, []);

  const stopRecording = useCallback(async () => {
    const wr = liveWriterRef.current;
    liveWriterRef.current = null;
    setRecording(false);
    if (!wr) return;
    setSaving(true);
    try {
      if (wr.frames > 0) downloadBlob(await wr.finish(), `reesolve-tryon-${wr.width}x${wr.height}.mp4`);
      else wr.cancel();
    } catch (e) { setRecError(e.message || String(e)); }
    setSaving(false);
  }, []);

  // Leaving a mode (or loading another file) saves a recording in progress.
  useEffect(() => () => {
    if (liveWriterRef.current) stopRecording();
  }, [videoMode, photoMode, videoUrl, stopRecording]);

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
      {/* Video for video mode — sourceEl for useTryOn video loop.
          NOT 0×0 / off-screen: Safari pauses a muted video it considers
          invisible and keeps handing drawImage the first frame. 2×2 px in
          the corner at 1 % opacity is "visible" to it and to nobody else. */}
      <video ref={videoElRef} src={videoUrl || undefined} onLoadedData={handleVideoLoaded}
        onPause={handleVideoPausedByBrowser}
        playsInline muted loop preload="auto"
        style={{ position: 'fixed', left: 0, top: 0, width: 2, height: 2, opacity: 0.01, pointerEvents: 'none', zIndex: 0 }} />

      <div className="dbg-stage">
        {photoMode && photoUrl ? (
          /* Side-by-side: full width, padding top/bottom, no mirror */
          <div style={{ display: 'flex', gap: 4, width: '100%', height: '100%',
            padding: '24px 0', boxSizing: 'border-box',
            alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ flex: 1, height: '100%', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <canvas ref={origCanvasRef}
                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
              <span style={{ position: 'absolute', bottom: 28, left: 10, fontSize: '.75rem', color: 'rgba(255,255,255,0.75)',
                textShadow: '0 1px 4px rgba(0,0,0,0.9)', fontWeight: 600, letterSpacing: '.5px' }}>Original</span>
            </div>
            <div style={{ width: 2, alignSelf: 'stretch', margin: '24px 0', background: 'rgba(255,255,255,0.12)', borderRadius: 1 }} />
            <div style={{ flex: 1, height: '100%', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <canvas ref={canvasRef}
                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
              <span style={{ position: 'absolute', bottom: 28, left: 10, fontSize: '.75rem', color: 'rgba(255,255,255,0.75)',
                textShadow: '0 1px 4px rgba(0,0,0,0.9)', fontWeight: 600, letterSpacing: '.5px' }}>REESOLVE</span>
            </div>
          </div>
        ) : (
          <canvas ref={canvasRef} className={videoMode ? '' : 'mir'}
            onClick={videoMode ? toggleVideoPause : undefined}
            style={videoMode ? { cursor: 'pointer' } : undefined} />
        )}
        {!ready && !error && <div className="dbg-overlay">Loading face model...</div>}
        {error && <div className="dbg-overlay err">Model failed: {error}</div>}
        {camError && !photoMode && !videoMode && <div className="dbg-overlay err">Camera: {camError}</div>}
        {photoMode && !photoUrl && <div className="dbg-overlay">Upload a photo to debug</div>}
        {videoMode && !videoUrl && <div className="dbg-overlay">Upload a video to debug</div>}
        {videoMode && videoPaused && <div className="dbg-overlay" style={{ background: 'rgba(0,0,0,0.3)', fontSize: '1.5rem' }}>&#9208; Paused</div>}
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
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid #333' }}>
            <label style={{ fontSize: '.72rem', cursor: 'pointer', padding: '3px 10px', borderRadius: 12, fontWeight: 600,
              border: photoMode ? '2px solid #2196f3' : '1px solid #555',
              background: photoMode ? '#2196f3' : 'transparent',
              color: photoMode ? '#fff' : '#ccc' }}>
              Photo
              <input type="file" accept="image/*" onChange={handlePhoto} style={{ display: 'none' }} />
            </label>
            <label style={{ fontSize: '.72rem', cursor: 'pointer', padding: '3px 10px', borderRadius: 12, fontWeight: 600,
              border: videoMode ? '2px solid #9c27b0' : '1px solid #555',
              background: videoMode ? '#9c27b0' : 'transparent',
              color: videoMode ? '#fff' : '#ccc' }}>
              Video
              <input type="file" accept="video/*" onChange={handleVideo} style={{ display: 'none' }} />
            </label>
            {(photoMode || videoMode) && (
              <button onClick={videoMode ? exitVideo : exitPhoto} style={{ fontSize: '.72rem', padding: '3px 10px', borderRadius: 12,
                border: '1px solid #555', background: 'transparent', color: '#ccc', cursor: 'pointer', fontWeight: 600 }}>
                Camera
              </button>
            )}
            {videoMode && videoUrl && (
              <button onClick={toggleVideoPause} style={{ fontSize: '.72rem', padding: '3px 10px', borderRadius: 12,
                border: '1px solid #ff9800', background: videoPaused ? '#ff9800' : 'transparent',
                color: videoPaused ? '#fff' : '#ff9800', cursor: 'pointer', fontWeight: 600 }}>
                {videoPaused ? '▶ Play' : '⏸ Pause'}
              </button>
            )}
            {videoMode && videoUrl && videoColor && (
              <span title="Decoded video: size · browser · transfer / primaries"
                style={{ fontSize: '.68rem', color: /HDR/.test(videoColor) ? '#ff9800' : '#888' }}>{videoColor} · <span ref={rendInfoRef} /></span>
            )}
            <label style={{ fontSize: '.68rem', color: '#aaa', cursor: 'pointer' }} title="Show the decoded frame without any render — to tell a decoding problem from a render problem">
              <input type="checkbox" checked={rawView} onChange={(e) => setRawView(e.target.checked)} /> raw frame
            </label>
            {photoMode && photoUrl && (
              <button onClick={downloadCombined} style={{ fontSize: '.72rem', padding: '3px 10px', borderRadius: 12,
                border: '1px solid #4caf50', background: '#4caf50', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
                ⬇ Download
              </button>
            )}
            {!photoMode && (!videoMode || videoUrl) && !saving && (
              <button onClick={recording ? stopRecording : startRecording} disabled={!mp4WriterSupported()}
                style={{ fontSize: '.72rem', padding: '3px 10px', borderRadius: 12,
                border: recording ? '2px solid #f44336' : '1px solid #4caf50',
                background: recording ? '#f44336' : 'transparent',
                color: recording ? '#fff' : '#4caf50', cursor: 'pointer', fontWeight: 600,
                animation: recording ? 'recBlink 1s infinite' : 'none' }}>
                {recording ? '\u23F9 Stop & Save' : '\u23FA Rec'}
              </button>
            )}
            {saving && (
              <span style={{ fontSize: '.72rem', padding: '3px 10px', borderRadius: 12,
                border: '1px solid #ff9800', color: '#ff9800', fontWeight: 600,
                animation: 'recBlink 1.5s infinite' }}>
                Saving MP4...
              </span>
            )}
            {!mp4WriterSupported() && !photoMode && (
              <span style={{ fontSize: '.68rem', color: '#f44336' }}>Recording needs Chrome/Edge 94+</span>
            )}
            {recError && <span style={{ fontSize: '.68rem', color: '#f44336' }}>{recError}</span>}
          </div>
          <label className="dbg-row"><input type="checkbox" checked={borders} onChange={(e) => setBorders(e.target.checked)} /> Show mask borders</label>
          <label className="dbg-row"><input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} /> Mesh points</label>
          <label className="dbg-row"><input type="checkbox" checked={showLight} onChange={(e) => setShowLight(e.target.checked)} /> Scene light (direction)</label>
          <label className="dbg-row"><input type="checkbox" checked={motionFade} onChange={(e) => setMotionFade(e.target.checked)} /> Hide on fast motion</label>
          {motionFade && (
            <label className="dbg-row" style={{ paddingLeft: 18 }}>
              Sensitivity <input type="range" min="0.5" max="3" step="0.1" value={fadeSens}
                onChange={(e) => setFadeSens(+e.target.value)} style={{ width: 90, verticalAlign: 'middle' }} />
              {' '}{fadeSens.toFixed(1)} <span ref={fadeInfoRef} style={{ color: '#aaa', marginLeft: 6 }} />
            </label>
          )}
          <label className="dbg-row"><input type="checkbox" checked={colorSeg} onChange={(e) => setColorSeg(e.target.checked)} /> Lip color seg <span ref={segInfoRef} style={{ marginLeft: 6, fontSize: '.68rem' }} /></label>
          {colorSeg && (
            <label className="dbg-row" style={{ paddingLeft: 18 }}>
              Lip edge <input type="range" min="0" max="1" step="0.05" value={lipRough}
                onChange={(e) => setLipRough(+e.target.value)} style={{ width: 90, verticalAlign: 'middle' }} />
              {' '}{lipRough.toFixed(2)}
            </label>
          )}
          {colorSeg && (
            <label className="dbg-row" style={{ paddingLeft: 18 }}>
              Symmetry <input type="range" min="0" max="1" step="0.05" value={lipSym}
                onChange={(e) => setLipSym(+e.target.value)} style={{ width: 82, verticalAlign: 'middle' }} />
              {' '}{lipSym.toFixed(2)}
            </label>
          )}
          {colorSeg && (
            <label className="dbg-row" style={{ paddingLeft: 18 }}>
              Lip soft <input type="range" min="0" max="2" step="0.05" value={lipSoft}
                onChange={(e) => setLipSoft(+e.target.value)} style={{ width: 90, verticalAlign: 'middle' }} />
              {' '}{lipSoft.toFixed(2)}
            </label>
          )}
          <label className="dbg-row" style={{ paddingLeft: 18 }}><input type="checkbox" checked={lipCore} onChange={(e) => setLipCoreS(e.target.checked)} /> Lip core (MP mesh, always painted)</label>
          <label className="dbg-row" style={{ paddingLeft: 18 }} title="Open mouth: cut teeth / mouth cavity by pixels (off = inner contour polygon)"><input type="checkbox" checked={pixCut} onChange={(e) => setPixCut(e.target.checked)} /> Mouth cut by pixels (teeth / cavity)</label>
          <label className="dbg-row" style={{ paddingLeft: 18 }}>
            Inner lip <select value={openDet} onChange={(e) => setOpenDet(e.target.value)} style={{ fontSize: '.68rem' }}>
              <option value="mp">MediaPipe</option>
              <option value="predict">Predict (thickness)</option>
              <option value="pixel">Pixel (exp.)</option>
            </select>
          </label>
          <label className="dbg-row"><input type="checkbox" checked={lipContour} onChange={(e) => setLipContour(e.target.checked)} /> Lip contour refine</label>
          <label className="dbg-row"><input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} /> Protect features (nose/eyes/lips/brows)</label>
          <label className="dbg-row"><input type="checkbox" checked={useGL} disabled={!glAvailable()} onChange={(e) => setUseGL(e.target.checked)} /> WebGL render</label>
          <label className="dbg-row" style={{marginTop:6}}>
            Cinema <input type="range" min="0" max="1" step="0.01" value={cinema} onChange={(e) => setCinema(+e.target.value)} style={{width:90,verticalAlign:'middle'}} /> {cinema.toFixed(2)}
          </label>
          <label className="dbg-row"><input type="checkbox" checked={uvOn} onChange={(e) => setUvOn(e.target.checked)} /> UV masks ({uvLoaded}/{UV_PRODUCTS.length})</label>
          <label className="dbg-row" style={{ paddingLeft: 18 }} title="Eyeshadow shaped per face in eye widths (doesn't stretch up to a high brow). Off = eyes.png UV mask.">
            <input type="checkbox" checked={eyeAdaptive} onChange={(e) => setEyeAdaptive(e.target.checked)} /> Eyeshadow adaptive
          </label>
          {eyeAdaptive && [['top', 'Height', 0.25, 0.8], ['browShare', 'Max to brow', 0.4, 1], ['wing', 'Wing', 0.2, 1.2], ['inner', 'Inner', 0.95, 1.5], ['lower', 'Under lashes', 0, 0.2]].map(([k, label, lo, hi]) => (
            <label key={k} className="dbg-row" style={{ paddingLeft: 36, fontSize: '.72rem' }}>
              {label} <input type="range" min={lo} max={hi} step="0.01" value={eyeShape[k]}
                onChange={(e) => setEyeShape((s) => ({ ...s, [k]: +e.target.value }))} style={{ width: 90, verticalAlign: 'middle' }} /> {eyeShape[k].toFixed(2)}
            </label>
          ))}
          <div className="dbg-row" style={{ gap: 6, flexWrap: 'wrap', paddingLeft: 18 }}>
            <button style={{ fontSize: '.68rem', padding: '0 6px' }} onClick={() => reloadUVMasks().then(uvCount)} title="Re-read public/uv-masks/*.png (after replacing files)">Reload</button>
            <button style={{ fontSize: '.68rem', padding: '0 6px' }} onClick={() => uvBake(false)} title="Bake today's procedural masks into UV and use them">Bake</button>
            <button style={{ fontSize: '.68rem', padding: '0 6px' }} onClick={() => uvBake(true)} title="Bake and download every UV PNG">Bake ⬇</button>
            <button style={{ fontSize: '.68rem', padding: '0 6px' }} onClick={async () => downloadBlob(await canvasToPngBlob(uvTemplate(1024)), 'uv_template.png')}>Template ⬇</button>
            <button style={{ fontSize: '.68rem', padding: '0 6px' }} onClick={saveDebugFrame} title="Original frame (no makeup) + landmarks + settings — send both files to reproduce exactly">Save debug frame</button>
          </div>
          <div className="dbg-row" style={{ gap: 6, paddingLeft: 18 }}>
            <select value={uvKey} onChange={(e) => setUvKey(e.target.value)} style={{ fontSize: '.68rem' }}>
              {UV_PRODUCTS.map((k) => <option key={k} value={k}>{k}{getUVMaskImage(k) ? ' ✓' : ''}</option>)}
            </select>
            <label style={{ cursor: 'pointer', textDecoration: 'underline', fontSize: '.72rem' }}>
              Import PNG
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => {
                const f = e.target.files?.[0]; if (!f) return;
                const img = new Image();
                img.onload = () => { setUVMaskImage(uvKey, img); uvCount(); };
                img.src = URL.createObjectURL(f);
                e.target.value = '';
              }} />
            </label>
            {getUVMaskImage(uvKey) && <button onClick={() => { setUVMaskImage(uvKey, null); uvCount(); }} style={{ fontSize: '.68rem', padding: '0 6px' }} title="Back to the procedural mask">✕</button>}
          </div>
          <div className="dbg-row" style={{ gap: 6 }}>
            <label style={{ cursor: 'pointer', textDecoration: 'underline' }}>
              {lipTex ? 'Lip texture ✓' : 'Lip texture…'}
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => {
                const f = e.target.files?.[0]; if (!f) return;
                const img = new Image();
                img.onload = () => setLipTex(img);
                img.src = URL.createObjectURL(f);
                e.target.value = '';
              }} />
            </label>
            {lipTex && <button onClick={() => setLipTex(null)} style={{ fontSize: '.68rem', padding: '0 6px' }}>✕</button>}
          </div>
          {lipTex && (
            <label className="dbg-row" style={{ paddingLeft: 18 }}>
              Tex mix <input type="range" min="0" max="1" step="0.05" value={lipTexMix}
                onChange={(e) => setLipTexMix(+e.target.value)} style={{ width: 90, verticalAlign: 'middle' }} />
              {' '}{lipTexMix.toFixed(2)}
            </label>
          )}
          {lipTex && (
            <label className="dbg-row" style={{ paddingLeft: 18 }}>
              Tex scale <input type="range" min="0.5" max="8" step="0.1" value={lipTexScale}
                onChange={(e) => setLipTexScale(+e.target.value)} style={{ width: 90, verticalAlign: 'middle' }} />
              {' '}{lipTexScale.toFixed(1)}
            </label>
          )}
          <label className="dbg-row">
            Lip cover <input type="range" min="0" max="1" step="0.05" value={lipCover}
              onChange={(e) => setLipCover(+e.target.value)} style={{ width: 90, verticalAlign: 'middle' }} />
            {' '}{lipCover.toFixed(2)}
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