// Public API of the try-on engine.
//
// This folder is self-contained: drop `tryon/` into any React project, add
// @mediapipe/tasks-vision, and it runs. Nothing in here reaches outside the
// folder, and hosts should import only from this file — never from the modules
// inside it, so their internals stay free to change.
//
// Two levels of entry, depending on how much control the host needs:
//
//   <TryOnCanvas layers={...} />   drop-in: owns camera, canvas and painting
//   useTryOn({ layers, onFrame })  headless: you own the presentation
//
// What lives here:
//   TryOnCanvas / useTryOn  orchestration — camera, detection, the frame loop
//   webglLips               the GLSL makeup shader (the production path)
//   lipRenderer             mask builders + the Canvas 2D fallback renderer
//   lips / regions          landmark index sets the masks are built from
//   useFaceLandmarker       MediaPipe model loading
//   faceMetrics             smoothing, motion, exposure — pure functions

export { default as TryOnCanvas } from './TryOnCanvas.jsx';
export { useTryOn, MOVE_THRESH, DEFAULT_RESOLUTION } from './useTryOn.js';

export {
  smoothLandmarks, predictLandmarks, estimateFaceLum, estimateLightBalance, estimateFaceYaw,
  faceMotion, faceBBox, depthFromLum,
} from './faceMetrics.js';

// Renderers, for hosts that paint a frame themselves.
export { renderMakeupGL, glAvailable } from './webglLips.js';
export { renderMakeup, drawLandmarks, drawSegMask } from './lipRenderer.js';

// Render tuning — module-level switches in the Canvas renderer.
export { setFeatureProtect, setRegionBlur, setRegionEdge, edgeRangeFor } from './lipRenderer.js';

// Mask builders, for hosts that want to inspect or overlay a region.
export {
  buildFaceMask, buildBlushMask, buildEyeMask, buildLashMask,
  buildContourMask, buildHighlightMask, buildUnderEyeMask, buildLipMask,
  buildLipLinerMask, buildEyelinerMask, buildBrowMask, buildSculptPack,
} from './lipRenderer.js';

// The model loader, for hosts that drive detection themselves.
export { useFaceLandmarker } from './useFaceLandmarker.js';