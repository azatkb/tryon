import { useEffect, useRef, useState } from 'react';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/**
 * Loads the MediaPipe FaceLandmarker once. Returns { landmarkerRef, ready, error }.
 * runningMode starts as VIDEO; switch to IMAGE with landmarker.setOptions for stills.
 */
export function useFaceLandmarker() {
  const landmarkerRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM);
        const fl = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
        });
        if (cancelled) { fl.close(); return; }
        landmarkerRef.current = fl;
        setReady(true);
      } catch (e) {
        console.error(e);
        if (!cancelled) setError(e?.message || String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (landmarkerRef.current) { landmarkerRef.current.close(); landmarkerRef.current = null; }
    };
  }, []);

  return { landmarkerRef, ready, error };
}
