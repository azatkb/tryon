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
  smoothLandmarks, predictLandmarks, estimateFaceLum, estimateLightBalance, estimateFaceYaw, faceMotion,
  detectBlink,
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
    redrawEveryTick = false,  // true = draw on every rAF even without a new frame
    syncToDetection = true,   // show the frame detection actually ran on (no mask drift)
    active = true,
    onFrame,
    onError,
  } = options;

  const { landmarkerRef, ready, error } = useFaceLandmarker();
  const [camError, setCamError] = useState(null);
  const [faceSeen, setFaceSeen] = useState(false);

  // Live mirrors of the props so the rAF loop never reads a stale closure.
  const cfgRef = useRef({});
  cfgRef.current = {
    layers, getLayers, renderer, smoothing, lumInterval,
    redrawEveryTick, syncToDetection, onFrame,
  };

  const videoRef = useRef(null);
  const rafRef = useRef(0);
  const streamRef = useRef(null);
  const procRef = useRef(null);       // offscreen full-frame processed canvas
  const snapRef = useRef(null);       // frozen camera frame, shared by detect + display
  const lastResRef = useRef(null);
  const smoothedRef = useRef(null);
  const prevFullRef = useRef(null);
  const prevMotionRef = useRef(null);
  const frameRef = useRef(0);

  // Per-frame metrics the host may want (motion gating, exposure, landmarks).
  // A ref, not state: these change every frame and must not drive re-renders.
  const metricsRef = useRef({ motion: 0, faceLum: 0.5, lightBal: 0, faceYaw: 0, blinkL: 1, blinkR: 1, landmarks: null, moving: false });

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
      const withLum = { ...live, faceLum: metricsRef.current.faceLum, lightBal: metricsRef.current.lightBal, faceYaw: metricsRef.current.faceYaw, motion: metricsRef.current.motion, blinkL: metricsRef.current.blinkL, blinkR: metricsRef.current.blinkR };
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
      lightBal: metricsRef.current.lightBal,
      faceYaw: metricsRef.current.faceYaw,
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

    // Prediction only exists to cover the gap between the frame detection ran
    // on and the frame being displayed. A frame-locked preview has no such gap
    // — the landmarks already fit the pixels on screen exactly — so predicting
    // would push the mask OFF a frame it currently fits, and add noise doing
    // it. Default it off there, keep it on when showing the live element.
    const predict = cfg.smoothing.predict
      ?? (cfg.syncToDetection !== false ? 0 : 1.0);
    const lms = predict > 0
      ? predictLandmarks(smoothed, prevFullRef.current, predict)
      : smoothed;
    prevFullRef.current = smoothed;

    // Exposure is a slow signal — sample it occasionally and ease into it so
    // the shader's normalisation can't flicker frame to frame.
    const every = cfg.lumInterval ?? 20;
    if (every > 0 && frameRef.current++ % every === 0) {
      const lum = estimateFaceLum(src, raw);
      if (lum != null) m.faceLum = m.faceLum * 0.7 + lum * 0.3;
      const bal = estimateLightBalance(src, raw);
      if (bal != null) m.lightBal = m.lightBal * 0.7 + bal * 0.3;
    }
    // Yaw is cheap (no canvas sampling) — measure every frame for responsiveness
    const yaw = estimateFaceYaw(raw);
    if (yaw != null) m.faceYaw = m.faceYaw * 0.6 + yaw * 0.4;

    // Blink detection: per-eye openness 0..1, EMA-smoothed for fade in/out.
    // Eye makeup intensity is scaled by these values so lashes/liner/shadow
    // gracefully fade during blinks rather than painting on closed lids.
    const blink = detectBlink(raw);
    m.blinkL = m.blinkL * 0.3 + blink.left * 0.7;  // fast follow — blinks are quick
    m.blinkR = m.blinkR * 0.3 + blink.right * 0.7;

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
          const cfg = cfgRef.current;
          const isFresh = v.currentTime !== lastTime;
          // A 30fps camera against a 60Hz display means half of these ticks
          // carry a video frame we have already drawn. Re-running detection,
          // ten mask uploads and the shader to produce the same pixels is the
          // cheapest thing to stop doing, and nothing is lost: there is no new
          // image to show. Hosts that drive their own animation on top can set
          // redrawEveryTick to keep the old behaviour.
          if (!isFresh && !cfg.redrawEveryTick) return;
          if (isFresh) lastTime = v.currentTime;

          const w = v.videoWidth, h = v.videoHeight;
          let src = v;

          // FRAME-LOCKED PREVIEW.
          //
          // Detecting straight off the <video> samples it at time T, but the
          // draw that follows happens at T + however long detection took — and
          // a live video element keeps advancing in between. When a new camera
          // frame lands inside that window the picture on screen is NEWER than
          // the landmarks drawn over it, and the makeup slides off the face.
          //
          // Freezing the frame first removes the window entirely: detection and
          // display read the same pixels, so the mask cannot drift from the
          // face it was computed on. The copy costs ~0.008ms, against ~6ms for
          // one texture upload — effectively free.
          //
          // The trade is that the preview shows you a moment ago rather than
          // now. For a mirror that is invisible; lipstick lagging your lip is
          // not. Hosts that would rather have the freshest possible image can
          // set syncToDetection: false.
          if (cfg.syncToDetection !== false) {
            let snap = snapRef.current;
            if (!snap) { snap = document.createElement('canvas'); snapRef.current = snap; }
            if (snap.width !== w || snap.height !== h) { snap.width = w; snap.height = h; }
            if (isFresh) snap.getContext('2d').drawImage(v, 0, 0, w, h);
            src = snap;
          }

          const lms = trackFrame(src, isFresh);
          setFaceSeen(!!lms);
          processFrame(src, w, h, lms);
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
      const bal = estimateLightBalance(img, lms);
      if (bal != null) m.lightBal = bal;
      const yaw = estimateFaceYaw(lms);
      if (yaw != null) m.faceYaw = yaw;
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