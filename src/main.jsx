import React, { useState, useEffect, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './App.css';
import './debug.css';

// Lazy-load pages so /photo doesn't pull in MediaPipe / ONNX bundles
const DebugApp  = lazy(() => import('./DebugApp.jsx'));
const AppPage   = lazy(() => import('./App.jsx'));
const PhotoPage = lazy(() => import('./PhotoPage.jsx'));
const LiveTryOn = lazy(() => import('./LiveTryOn.jsx'));
const TryOnPage = lazy(() => import('./TryOnPage.jsx'));
const EmbedView = lazy(() =>
  import('./tryon/index.js').then(m => ({
    default: () => (
      <m.TryOnCanvas
        style={{ width: '100vw', height: '100vh' }}
        layers={{
          foundation: { color: '#E8B48F', intensity: 0.26 },
          blush: { color: '#E8738E', intensity: 0.38 },
          lips: { color: '#C2185B', intensity: 0.6, finish: 'satin' },
          lashes: { intensity: 0.8 },
        }}
      />
    ),
  }))
);

// Minimal pathname router — no extra dependencies.
// '/'      → debug (main try-on workbench)
// '/photo' → Qwen Image Edit via RunPod
// '/app'   → lesson app
// '/embed' → bare TryOnCanvas component
// '/tryon' → live try-on with the product catalogue (src/data/*.json)
function Router() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const loading = (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center',
                  height: '100vh', color: 'var(--muted)', fontFamily: 'var(--f-body)' }}>
      Loading…
    </div>
  );

  return (
    <Suspense fallback={loading}>
      {path === '/photo' ? <PhotoPage /> :
       path === '/live'  ? <LiveTryOn /> :
       path === '/tryon' ? <TryOnPage /> :
       path === '/app'   ? <AppPage /> :
       path === '/embed' ? <EmbedView /> :
       /* '/' and everything else */ <DebugApp />}
    </Suspense>
  );
}

// Navigate without full reload — call from anywhere via window.__navigate('/photo')
window.__navigate = (to) => {
  if (to !== window.location.pathname) {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
};

createRoot(document.getElementById('root')).render(
  <React.StrictMode><Router /></React.StrictMode>
);