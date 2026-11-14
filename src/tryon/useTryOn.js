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
import { renderMakeupMultiPass, multiPassAvailable } from './webglMultiPass.js';
import {
  smoothLandmarks, createLandmarkFilter, predictLandmarks, estimateFaceLum, estimateLightBalance, estimateFaceYaw, faceMotion,
  detectBlink,
} from './faceMetrics.js';
import { refineLipContour } from './lipContourRefine.js';
import { LIPS_OUTER } from './lips.js';
import { segmentLipsColor, resetLipSeg } from './lipColorSeg.js';
import { loadUVMasks } from './uv/uvMasks.js';
import { createLightTracker } from './uv/faceLight.js';

export const DEFAULT_RESOLUTION = { width: 1920, height: 1080 };

/** Face motion above this counts as "moving" — hosts use it to gate heavy work. */
export const MOVE_THRESH = 0.0015;

/** @deprecated — kept for API compat; queue-based pipeline detects every frame. */
export let DETECT_EVERY = 1;

export function useTryOn(options = {}) {
  const {
    layers = {},
    getLayers,                // optional () => layers, called per frame
    source = 'camera',        // 'camera' | 'element' | 'video'
    sourceEl = null,          // required when source === 'element' (an <img>/<video>)
    renderer = 'auto',        // 'auto' | 'gl' | 'multipass' | 'canvas'
    smoothing = {},           // { mode: 'oneEuro'|'ema', minCutoff, beta, … | alpha, maxAlpha, gain; predict }
    resolution = DEFAULT_RESOLUTION,
    lumInterval = 20,         // frames between exposure re-measurements
    redrawEveryTick = false,  // true = draw on every rAF even without a new frame
    syncToDetection = true,   // show the frame detection actually ran on (no mask drift)
    contourRefine = true,     // enable/disable lip contour refinement (luminance, legacy)
    lipColorSeg = true,       // per-pixel colour segmentation of the lips (overrides contourRefine)
    motionFade = false,       // hide makeup during jumps / whip turns (false = never; true | { lo, hi, recover } to enable)
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
    layers, getLayers, renderer, smoothing, lumInterval, source, motionFade,
    redrawEveryTick, syncToDetection, contourRefine, lipColorSeg, onFrame,
  };

  const videoRef = useRef(null);
  const rafRef = useRef(0);
  const streamRef = useRef(null);
  const procRef = useRef(null);       // offscreen full-frame processed canvas
  const snapRef = useRef(null);       // frozen camera frame, shared by detect + display
  const lastResRef = useRef(null);
  const contourScratchRef = useRef(null); // scratch canvas for lip contour refinement
  const contourBufRef = useRef([]);       // ring buffer of last N frames for median filter
  const refinedRef = useRef(null);        // latest async-computed refined contour
  const refineRunning = useRef(false);    // true while an async refine is in flight
  const refineBlendRef = useRef(0);       // 0 = pure MP, 1 = pure refined (smooth ramp)
  const refineTickRef = useRef(0);        // frame counter for throttling refine
  const smoothedRef = useRef(null);
  const euroRef = useRef(null);
  const lightRef = useRef(null);         // scene light tracker         // One Euro landmark filter (default smoothing)
  const euroKeyRef = useRef('');
  const prevFullRef = useRef(null);
  const prevMotionRef = useRef(null);
  const frameRef = useRef(0);

  // Per-frame metrics the host may want (motion gating, exposure, landmarks).
  // A ref, not state: these change every frame and must not drive re-renders.
  const metricsRef = useRef({ fade: 1, jump: 0, motion: 0, faceLum: 0.5, lightBal: 0, faceYaw: 0, blinkL: 1, blinkR: 1, landmarks: null, moving: false });

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
      const withLum = { ...live, faceLum: metricsRef.current.faceLum, lightBal: metricsRef.current.lightBal, faceYaw: metricsRef.current.faceYaw, light: metricsRef.current.light, motion: metricsRef.current.motion, blinkL: metricsRef.current.blinkL, blinkR: metricsRef.current.blinkR,
        // frame clock for motion blur: media time for video files (offline export = real-time look)
        frameTime: cfg.source === 'video' && typeof src.currentTime === 'number' ? src.currentTime * 1000 : performance.now() };

      // Lip contour refinement — async, throttled, with smooth blend.
      // Refine runs every ~4 frames in background. Result blended with MP
      // landmarks via refineBlend (0=MP, 1=refined). Blend ramps down on
      // motion, ramps up when still.
      if (cfg.lipColorSeg && (live.lips || live.lipLiner)) {
        // Pixel-accurate lip mask trained on this frame's own colours. Both
        // lipstick and liner are cut from it, so their edges always coincide.
        try {
          const seg = segmentLipsColor(src, w, h, lms, { moving: metricsRef.current.moving });
          if (seg) withLum.lipSeg = seg;
        } catch (_) { /* fall back to the landmark polygon */ }
      } else if (cfg.contourRefine && (live.lips || live.lipLiner)) {
        const isMoving = metricsRef.current.moving;
        // Smooth blend ramp: fade out on motion, fade in when still
        const blend = refineBlendRef.current;
        if (isMoving) {
          refineBlendRef.current = Math.max(0, blend - 0.15); // fast fade out
          if (refineBlendRef.current < 0.01) {
            contourBufRef.current.length = 0; // reset buffer after fully faded
          }
        } else if (refinedRef.current) {
          refineBlendRef.current = Math.min(1, blend + 0.08); // slow fade in
        }

        // Apply blended contour
        const b = refineBlendRef.current;
        if (b > 0.01 && refinedRef.current && refinedRef.current.length > 0) {
          // Apply stored deltas to CURRENT MP landmarks — correction
          // tracks with face movement instead of lagging behind
          const blended = refinedRef.current.map((delta, i) => {
            const mp = { x: lms[LIPS_OUTER[i]].x * w, y: lms[LIPS_OUTER[i]].y * h };
            return {
              x: mp.x + delta.dx * b,
              y: mp.y + delta.dy * b,
            };
          });
          withLum.refinedOuter = blended;
        }

        // Throttled async refine — every 4th frame, only when not moving
        refineTickRef.current++;
        if (!isMoving && !refineRunning.current && refineTickRef.current % 4 === 0) {
          refineRunning.current = true;
          try {
            if (!contourScratchRef.current) contourScratchRef.current = document.createElement('canvas');
            const sc = contourScratchRef.current;
            if (sc.width !== w || sc.height !== h) { sc.width = w; sc.height = h; }
            const sctx = sc.getContext('2d', { willReadFrequently: true });
            sctx.drawImage(src, 0, 0, w, h);
            const imgData = sctx.getImageData(0, 0, w, h);
            const lmsCopy = lms;
            const buf = contourBufRef.current;
            setTimeout(() => {
              try {
                if (!metricsRef.current.moving) {
                  const refined = refineLipContour(imgData, lmsCopy, w, h, {
                    frameBuffer: buf, bufferSize: 3, spatialStr: 0.4,
                  });
                  if (!metricsRef.current.moving) {
                    // Store as deltas from MP landmarks so correction
                    // tracks with face movement between refine frames
                    refinedRef.current = refined.map((rp, i) => {
                      const mp = lmsCopy[LIPS_OUTER[i]];
                      return { dx: rp.x - mp.x * w, dy: rp.y - mp.y * h };
                    });
                  }
                }
              } catch (_) { /* best-effort */ }
              refineRunning.current = false;
            }, 0);
          } catch (_) { refineRunning.current = false; }
        }
      }

      const useMP = cfg.renderer === 'multipass' || (cfg.renderer === 'auto' && multiPassAvailable());
      const useGL = !useMP && (cfg.renderer === 'gl' || (cfg.renderer === 'auto' && glAvailable()));
      // Motion fade: cross-fade made-up → original frame (fully off = skip render)
      const fade = metricsRef.current.fade ?? 1;
      let done = fade < 0.02;
      pctx.globalAlpha = Math.min(1, fade);
      if (!done && useMP) {
        const mpc = renderMakeupMultiPass(src, w, h, lms, withLum);
        if (mpc) { pctx.drawImage(mpc, 0, 0, w, h); done = true; }
      }
      if (!done && (useGL || cfg.renderer === 'auto')) {
        const glc = renderMakeupGL(src, w, h, lms, withLum);
        if (glc) { pctx.drawImage(glc, 0, 0, w, h); done = true; }
      }
      pctx.globalAlpha = 1;
      if (!done) renderMakeup(pctx, w, h, lms, withLum);
    }

    cfg.onFrame?.({
      processed: proc, source: src, landmarks: lms, w, h,
      faceLum: metricsRef.current.faceLum,
      lightBal: metricsRef.current.lightBal,
      faceYaw: metricsRef.current.faceYaw,
      light: metricsRef.current.light,
      fade: metricsRef.current.fade, jump: metricsRef.current.jump,
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

    // ── Motion fade ──
    // Choppy input (dropped frames, low fps) or a whip turn: MediaPipe and
    // the frame can disagree by more than the makeup can hide. Measure the
    // per-frame jump in face widths; above `lo` the makeup fades, above `hi`
    // it's off. It drops instantly and comes back smoothly once the face
    // settles (`recover` per second) — no makeup sliding off the face.
    if (isFresh) {
      const mf = cfg.motionFade;
      const fw = raw[234] && raw[454] ? Math.hypot(raw[454].x - raw[234].x, raw[454].y - raw[234].y) : 0;
      const jump = fw > 1e-3 ? motion / fw : 0;
      m.jump = jump;
      const now = performance.now();
      const dt = m.fadeT ? Math.min(0.5, (now - m.fadeT) / 1000) : 0;
      m.fadeT = now;
      if (mf === false) m.fade = 1;
      else {
        const lo = mf?.lo ?? 0.04, hi = mf?.hi ?? 0.11, rec = mf?.recover ?? 5;
        const t = Math.min(1, Math.max(0, (jump - lo) / (hi - lo)));
        const target = 1 - t * t * (3 - 2 * t);
        m.fade = target < m.fade ? target : m.fade + (target - m.fade) * Math.min(1, dt * rec);
      }
    }

    let smoothed;
    if (cfg.smoothing.mode === 'ema') {
      smoothed = smoothLandmarks(raw, smoothedRef.current, m.motion, cfg.smoothing);
    } else {
      // One Euro: time-based. Video files use media time so offline rendering
      // (seek per frame, any speed) smooths exactly like real-time playback.
      const sm = cfg.smoothing;
      const key = `${sm.minCutoff}|${sm.beta}|${sm.dCutoff}|${sm.fastMinCutoff}|${sm.lashMinCutoff}`;
      if (!euroRef.current || euroKeyRef.current !== key) { euroRef.current = createLandmarkFilter(sm); euroKeyRef.current = key; }
      const t = cfg.source === 'video' && typeof src.currentTime === 'number' ? src.currentTime * 1000 : performance.now();
      smoothed = euroRef.current(raw, t);
    }
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
    // Scene light: direction / contrast fitted from the face's own shading
    // (mesh normals vs skin brightness). Throttled + eased inside the tracker.
    if (!lightRef.current) lightRef.current = createLightTracker();
    m.light = lightRef.current(src, lms);
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

  // Switching source (camera / video / photo) starts the lip mask from scratch.
  useEffect(() => { resetLipSeg(); euroRef.current?.reset(); lightRef.current?.reset(); }, [source, sourceEl]);
  // UV face masks — products without a PNG keep the procedural mask.
  useEffect(() => { loadUVMasks(); }, []);

  // ---- camera lifecycle + render loop ----
  useEffect(() => {
    if (!ready || !active || source !== 'camera') return undefined;
    const fl = landmarkerRef.current;
    const v = videoRef.current;
    if (!fl || !v) return undefined;

    let stopped = false;
    let lastTime = -1;
    let draining = false;  // true while detect+render pipeline is running

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

        // Double-buffered snap canvases — one for capture, one for
        // the detect+render pipeline that may still be reading.
        const snaps = [document.createElement('canvas'), document.createElement('canvas')];
        let snapIdx = 0;
        let queued = null;   // { src, w, h } — latest captured frame

        // Drain: take the latest queued frame, run MediaPipe → render.
        // If another frame arrived while we were busy, schedule again
        // via microtask so the browser can paint in between.
        const drain = () => {
          if (draining || !queued) return;
          draining = true;
          const { src, w, h } = queued;
          queued = null;
          const lms = trackFrame(src, true);
          setFaceSeen(!!lms);
          processFrame(src, w, h, lms);
          draining = false;
          if (queued) queueMicrotask(drain);
        };

        const tick = () => {
          rafRef.current = requestAnimationFrame(tick);
          if (!v.videoWidth) return;
          const isFresh = v.currentTime !== lastTime;
          if (!isFresh) return;           // duplicate display tick — skip
          lastTime = v.currentTime;

          const w = v.videoWidth, h = v.videoHeight;

          // Capture to the buffer NOT currently being read by drain.
          snapIdx = 1 - snapIdx;
          const snap = snaps[snapIdx];
          if (snap.width !== w || snap.height !== h) { snap.width = w; snap.height = h; }
          snap.getContext('2d').drawImage(v, 0, 0, w, h);

          // Queue it — latest always wins, older frame is dropped.
          queued = { src: snap, w, h };

          // If pipeline is idle, drain immediately (lowest latency).
          // If busy, drain will pick it up when current frame finishes.
          if (!draining) drain();
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

  // ---- video element playback loop (source === 'video') ----
  // Like the camera loop but reads from a host-provided <video> element playing
  // a local file instead of a getUserMedia stream. No stream ownership.
  useEffect(() => {
    if (!ready || !active || source !== 'video') return undefined;
    const fl = landmarkerRef.current;
    const v = sourceEl;
    if (!fl || !v || v.tagName !== 'VIDEO') return undefined;

    let stopped = false;
    let lastTime = -1;
    let draining = false;
    let cancelVfc = () => {};

    (async () => {
      try {
        await fl.setOptions({ runningMode: 'VIDEO' });

        const snaps = [document.createElement('canvas'), document.createElement('canvas')];
        let snapIdx = 0;
        let queued = null;

        const drain = () => {
          if (draining || !queued) return;
          draining = true;
          const { src, w, h } = queued;
          queued = null;
          const lms = trackFrame(src, true);
          setFaceSeen(!!lms);
          processFrame(src, w, h, lms);
          draining = false;
          if (queued) queueMicrotask(drain);
        };

        const capture = () => {
          if (!v.videoWidth || v.paused || v.ended) return;
          const isFresh = v.currentTime !== lastTime;
          if (!isFresh) return;
          lastTime = v.currentTime;

          const w = v.videoWidth, h = v.videoHeight;
          snapIdx = 1 - snapIdx;
          const snap = snaps[snapIdx];
          if (snap.width !== w || snap.height !== h) { snap.width = w; snap.height = h; }
          snap.getContext('2d').drawImage(v, 0, 0, w, h);
          queued = { src: snap, w, h };
          if (!draining) drain();
        };
        const tick = () => {
          if (stopped) return;
          rafRef.current = requestAnimationFrame(tick);
          capture();
        };
        // Every frame the video PRESENTS (Safari 15.4+, Chrome): fires exactly
        // when a new frame is ready to draw. rAF stays as the fallback.
        const hasVFC = typeof v.requestVideoFrameCallback === 'function';
        let vfcId = 0;
        const onVideoFrame = () => {
          if (stopped) return;
          vfcId = v.requestVideoFrameCallback(onVideoFrame);
          capture();
        };
        if (hasVFC) vfcId = v.requestVideoFrameCallback(onVideoFrame);
        cancelVfc = () => { if (hasVFC && vfcId) try { v.cancelVideoFrameCallback(vfcId); } catch (_) { /* gone */ } };
        cancelAnimationFrame(rafRef.current);
        tick();
      } catch (e) {
        if (stopped) return;
        onError?.(e);
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(rafRef.current);
      cancelVfc();
    };
  }, [ready, active, source, sourceEl,
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
    resetLipSeg();  // a new still must not blend with the previous frame's mask
    let lms = null;
    try { lms = fl.detect(img)?.faceLandmarks?.[0] || null; } catch (e) { onError?.(e); }
    lastResRef.current = { faceLandmarks: lms ? [lms] : [] };
    const m = metricsRef.current;
    m.landmarks = lms; m.raw = lms; m.motion = 0; m.moving = false; m.fade = 1; m.jump = 0;
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

  /**
   * Detect + render exactly one frame of a video element, synchronously, with
   * full VIDEO-mode tracking (smoothing, motion, lip segmentation). For
   * frame-by-frame export: seek the (paused) element, call this, then encode
   * what onFrame painted. The playback loop ignores a paused element, so the
   * two never process the same frame twice.
   */
  const exportSnapRef = useRef(null);
  const renderVideoFrame = useCallback((el) => {
    const v = el || sourceEl;
    if (!landmarkerRef.current || !v || !v.videoWidth) return null;
    const w = v.videoWidth, h = v.videoHeight;
    let snap = exportSnapRef.current;
    if (!snap) { snap = document.createElement('canvas'); exportSnapRef.current = snap; }
    if (snap.width !== w || snap.height !== h) { snap.width = w; snap.height = h; }
    snap.getContext('2d').drawImage(v, 0, 0, w, h);
    const lms = trackFrame(snap, true);
    setFaceSeen(!!lms);
    processFrame(snap, w, h, lms);
    return lms;
  }, [sourceEl, landmarkerRef, trackFrame, processFrame]);

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
    detectStill, redrawStill, processFrame, renderVideoFrame,
  };
}