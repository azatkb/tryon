import React from 'react';
import { createRoot } from 'react-dom/client';
import DebugApp from './DebugApp.jsx';
import App from './App.jsx';
import { TryOnCanvas } from './tryon/index.js';
import './App.css';
import './debug.css';

// 'debug' = the mask/entity workbench, 'app' = the lesson app,
// 'embed' = the bare drop-in component, as a host would use it.
const VIEW = 'debug';

const VIEWS = {
  debug: <DebugApp />,
  app: <App />,
  embed: (
    <TryOnCanvas
      style={{ width: '100vw', height: '100vh' }}
      layers={{
        foundation: { color: '#E8B48F', intensity: 0.26 },
        blush: { color: '#E8738E', intensity: 0.38 },
        lips: { color: '#C2185B', intensity: 0.6, finish: 'satin' },
        lashes: { intensity: 0.8 },
      }}
    />
  ),
};

createRoot(document.getElementById('root')).render(
  <React.StrictMode>{VIEWS[VIEW]}</React.StrictMode>
);