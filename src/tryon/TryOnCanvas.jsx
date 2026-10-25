// TryOnCanvas — the zero-config way to embed the try-on.
//
// Drops a mirrored, self-sizing canvas into any layout and keeps it painted
// with the processed frame. Hosts that need their own presentation (a crop, a
// PiP, overlays) should use `useTryOn` directly instead.
//
//   <TryOnCanvas layers={{ lips: { color: '#C2185B', intensity: 0.6 } }} />

import { useRef, useCallback } from 'react';
import { useTryOn } from './useTryOn.js';

export default function TryOnCanvas({
  layers = {},
  renderer = 'auto',
  smoothing,
  resolution,
  mirrored = true,
  active = true,
  className = '',
  style,
  onOverlay,          // (ctx, { landmarks, w, h, faceLum }) => void — draw on top
  onReady,            // called once the first frame with a face lands
  children,           // overlay UI, rendered above the canvas
}) {
  const canvasRef = useRef(null);
  const announced = useRef(false);

  const handleFrame = useCallback(({ processed, landmarks, w, h, faceLum }) => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    ctx.drawImage(processed, 0, 0, w, h);
    onOverlay?.(ctx, { landmarks, w, h, faceLum });
    if (landmarks && !announced.current) { announced.current = true; onReady?.(); }
  }, [onOverlay, onReady]);

  const { ready, error, camError, faceSeen } = useTryOn({
    layers, renderer, smoothing, resolution, active, onFrame: handleFrame,
  });

  return (
    <div className={`tryon${className ? ` ${className}` : ''}`} style={{ position: 'relative', ...style }}>
      <canvas
        ref={canvasRef}
        style={{
          display: 'block', width: '100%', height: '100%', objectFit: 'cover',
          transform: mirrored ? 'scaleX(-1)' : 'none',
        }}
      />
      {!ready && !error && <div className="tryon-status">Loading face model…</div>}
      {error && <div className="tryon-status tryon-status--err">Model failed to load</div>}
      {ready && camError && <div className="tryon-status tryon-status--err">Camera unavailable</div>}
      {ready && !camError && !faceSeen && <div className="tryon-status">No face detected</div>}
      {children}
    </div>
  );
}