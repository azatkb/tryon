import React from 'react';
import { createRoot } from 'react-dom/client';
import DebugApp from './DebugApp.jsx';
import App from './App.jsx';
import './App.css';
import './debug.css';

// Debug workbench for now. Flip USE_DEBUG to false to go back to the lesson app.
const USE_DEBUG = true;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {USE_DEBUG ? <DebugApp /> : <App />}
  </React.StrictMode>
);