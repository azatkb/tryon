// useTryOn — the headless try-on engine.
//
// Owns everything that is the same for every host: the camera, the MediaPipe
// detection cadence, landmark smoothing and prediction, exposure measurement,
// and the WebGL/Canvas makeup render. It produces a full-frame processed canvas
// each frame and hands it to `onFrame`; the host decides how to present it
// (blit it, crop it, put it in a PiP, draw overlays on top).
//
// It deliberately does NOT render any JSX. That keeps it embeddable in a host
// with its own layout, and lets App and DebugApp — which present the same
// pipeline very differently — share one implementation.
//
//   const { ready, error, camError, faceSeen, metricsRef, videoEl } = useTryOn({
//     layers,                       // makeup layers; re-read every frame
//     onFrame: ({ processed, w, h }) => ctx.drawImage(processed, 0, 0),
//   });

import { useEffect, useRef, useState, useCallback } from 'react';
import { useFaceLandmarker } from './useFaceLandmarker.js';
import { renderMakeup } from './lipRenderer.js';
import { renderMakeupGL, glAvailable } from './webglLips.js';
import {
  smoothLandmarks, predictLandmarks, estimateFaceLum, faceMotion,
} from './faceMetrics.js';

export const DEFAULT_RESOLUTION = { width: 1920, height: 1080 };

/** Face motion above this counts as "moving" — hosts use it to gate heavy work. */
export const MOVE_THRESH = 0.0015;

export function useTryOn(options = {}) {
  const {
    layers = {},
    getLayers,                // optional () => layers, called per frame
    source = 'camera',        // 'camera' | 'element'
    sourceEl = null,          // required when source === 'element' (an <img>/<video>)
    renderer = 'auto',        // 'auto' | 'gl' | 'canvas'
    smoothing = {},           // { alpha, maxAlpha, gain, predict }
    resolution = DEFAULT_RESOLUTION,
    lumInterval = 20,         // frames between exposure re-measurements
    active = true,
    onFrame,
    onError,
  } = options;

  const { landmarkerRef, ready, error } = useFaceLandmarker();
  const [camError, setCamError] = useState(null);
  const [faceSeen, setFaceSeen] = useState(false);

  // Live mirrors of the props so the rAF loop never reads a stale closure.
  const cfgRef = useRef({});
  cfgRef.current = { layers, getLayers, renderer, smoothing, lumInterval, onFrame };

  const videoRef = useRef(null);
  const rafRef = useRef(0);
  const streamRef = useRef(null);
  const procRef = useRef(null);       // offscreen full-frame processed canvas
  const lastResRef = useRef(null);
  const smoothedRef = useRef(null);
  const prevFullRef = useRef(null);
  const prevMotionRef = useRef(null);
  const frameRef = useRef(0);

  // Per-frame metrics the host may want (motion gating, exposure, landmarks).
  // A ref, not state: these change every frame and must not drive re-renders.
  const metricsRef = useRef({ motion: 0, faceLum: 0.5, landmarks: null, moving: false });

  // The hidden <video> is owned here so a host only has to provide a canvas.
  if (!videoRef.current && typeof document !== 'undefined' && source === 'camera') {
    const v = document.createElement('video');
    v.playsInline = true;
    v.muted = true;
    v.setAttribute('playsinline', '');
    videoRef.current = v;
  }

  /**
   * Run detection + makeup on one frame of `src` and hand the result to onFrame.
   * Exported so hosts can drive a still image without the rAF loop.
   */
  const processFrame = useCallback((src, w, h, overrideLms) => {
    const cfg = cfgRef.current;
    if (!src || !w || !h) return null;

    let proc = procRef.current;
    if (!proc) { proc = document.createElement('canvas'); procRef.current = proc; }
    if (proc.width !== w || proc.height !== h) { proc.width = w; proc.height = h; }
    const pctx = proc.getContext('2d');
    pctx.drawImage(src, 0, 0, w, h);

    const lms = overrideLms !== undefined ? overrideLms : metricsRef.current.landmarks;
    if (lms) {
      // getLayers is the escape hatch for hosts whose layers carry per-frame
      // data (a segmentation mask that lands between renders, say) — a plain
      // `layers` object can only update when React re-renders.
      const live = cfg.getLayers ? cfg.getLayers(metricsRef.current) : cfg.layers;
      const withLum = { ...live, faceLum: metricsRef.current.faceLum };
      const useGL = cfg.renderer === 'gl' || (cfg.renderer === 'auto' && glAvailable());
      let done = false;
      if (useGL) {
        const glc = renderMakeupGL(src, w, h, lms, withLum);
        if (glc) { pctx.drawImage(glc, 0, 0, w, h); done = true; }
      }
      if (!done) renderMakeup(pctx, w, h, lms, withLum);
    }

    cfg.onFrame?.({
      processed: proc, source: src, landmarks: lms, w, h,
      faceLum: metricsRef.current.faceLum,
      motion: metricsRef.current.motion,
      moving: metricsRef.current.moving,
    });
    return proc;
  }, []);

  /**
   * Detect on a fresh frame, then smooth + predict. Updates metricsRef and
   * returns the landmarks to render with (already smoothed/predicted).
   */
  const trackFrame = useCallback((src, isFresh) => {
    const fl = landmarkerRef.current;
    if (!fl) return null;
    if (isFresh) {
      try { lastResRef.current = fl.detectForVideo(src, performance.now()); } catch (_) { /* keep last */ }
    }
    const raw = lastResRef.current?.faceLandmarks?.[0];
    if (!raw) {
      metricsRef.current.landmarks = null;
      return null;
    }
    const cfg = cfgRef.current;

    const { motion, snapshot } = faceMotion(raw, prevMotionRef.current);
    prevMotionRef.current = snapshot;
    const m = metricsRef.current;
    m.motion = m.motion * 0.35 + motion * 0.65;
    m.moving = m.motion > MOVE_THRESH;

    const smoothed = smoothLandmarks(raw, smoothedRef.current, m.motion, cfg.smoothing);
    smoothedRef.current = smoothed;
    const lms = predictLandmarks(smoothed, prevFullRef.current, cfg.smoothing.predict ?? 1.0);
    prevFullRef.current = smoothed;

    // Exposure is a slow signal — sample it occasionally and ease into it so
    // the shader's normalisation can't flicker frame to frame.
    const every = cfg.lumInterval ?? 20;
    if (every > 0 && frameRef.current++ % every === 0) {
      const lum = estimateFaceLum(src, raw);
      if (lum != null) m.faceLum = m.faceLum * 0.7 + lum * 0.3;
    }

    m.landmarks = lms;
    m.raw = raw;
    return lms;
  }, [landmarkerRef]);

  // ---- camera lifecycle + render loop ----
  useEffect(() => {
    if (!ready || !active || source !== 'camera') return undefined;
    const fl = landmarkerRef.current;
    const v = videoRef.current;
    if (!fl || !v) return undefined;

    let stopped = false;
    let lastTime = -1;

    (async () => {
      try {
        await fl.setOptions({ runningMode: 'VIDEO' });
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: resolution.width, min: 640 },
            height: { ideal: resolution.height, min: 480 },
          },
          audio: false,
        });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        v.srcObject = stream;
        await v.play();
        setCamError(null);

        const tick = () => {
          rafRef.current = requestAnimationFrame(tick);
          if (!v.videoWidth) return;
          const isFresh = v.currentTime !== lastTime;
          if (isFresh) lastTime = v.currentTime;
          const lms = trackFrame(v, isFresh);
          setFaceSeen(!!lms);
          processFrame(v, v.videoWidth, v.videoHeight, lms);
        };
        cancelAnimationFrame(rafRef.current);
        tick();
      } catch (e) {
        if (stopped) return;
        const msg = e?.message || String(e);
        setCamError(msg);
        onError?.(e);
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(rafRef.current);
      const s = streamRef.current;
      if (s) { s.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
      if (v) v.srcObject = null;
    };
    // resolution is read once per camera session; changing it restarts the camera
  }, [ready, active, source, resolution.width, resolution.height,
      landmarkerRef, trackFrame, processFrame, onError]);

  /**
   * Detect + render a still image. Hosts call this for photo mode, where there
   * is no frame loop to hang the work off.
   */
  const detectStill = useCallback(async (el) => {
    const fl = landmarkerRef.current;
    const img = el || sourceEl;
    if (!fl || !img) return null;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    await fl.setOptions({ runningMode: 'IMAGE' });
    let lms = null;
    try { lms = fl.detect(img)?.faceLandmarks?.[0] || null; } catch (e) { onError?.(e); }
    lastResRef.current = { faceLandmarks: lms ? [lms] : [] };
    const m = metricsRef.current;
    m.landmarks = lms; m.raw = lms; m.motion = 0; m.moving = false;
    if (lms) {
      const lum = estimateFaceLum(img, lms);
      if (lum != null) m.faceLum = lum;
    }
    setFaceSeen(!!lms);
    processFrame(img, w, h, lms);
    return lms;
  }, [landmarkerRef, sourceEl, processFrame, onError]);

  /** Re-run the makeup pass on the last still without re-detecting. */
  const redrawStill = useCallback((el) => {
    const img = el || sourceEl;
    if (!img) return;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w && h) processFrame(img, w, h, metricsRef.current.landmarks);
  }, [sourceEl, processFrame]);

  return {
    ready, error, camError, faceSeen,
    videoEl: videoRef.current,
    metricsRef,
    glAvailable: glAvailable(),
    detectStill, redrawStill, processFrame,
  };
}