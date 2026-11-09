/**
 * LiveTryOn — WebSocket-based real-time makeup rendering.
 *
 * Camera frame → WS (JPEG) → Python backend (MediaPipe + OpenCV) → rendered frame back.
 * Displays the rendered stream at ~15-20 FPS depending on backend speed.
 */
import { useRef, useState, useCallback, useEffect } from 'react';

const DEFAULT_WS_URL = 'ws://localhost:8000/ws';

export default function LiveTryOn({ wsUrl }) {
  const videoRef    = useRef(null);
  const canvasRef   = useRef(null);   // capture canvas (hidden)
  const displayRef  = useRef(null);   // rendered output
  const wsRef       = useRef(null);
  const streamRef   = useRef(null);
  const rafRef      = useRef(null);
  const busyRef     = useRef(false);  // prevents stacking sends

  const [connected, setConnected]   = useState(false);
  const [cameraOn, setCameraOn]     = useState(false);
  const [fps, setFps]               = useState(0);
  const [renderMs, setRenderMs]     = useState(0);
  const [error, setError]           = useState('');
  const [serverUrl, setServerUrl]   = useState(() => {
    try { return localStorage.getItem('ws_server') || wsUrl || DEFAULT_WS_URL; }
    catch { return wsUrl || DEFAULT_WS_URL; }
  });

  // ── WebSocket ───────────────────────────────────────────────────
  const connectWs = useCallback(() => {
    if (wsRef.current) return;
    setError('');
    const ws = new WebSocket(serverUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      wsRef.current = ws;
      setConnected(true);
      console.log('[LiveTryOn] WS connected');
    };

    ws.onmessage = (ev) => {
      const data = new Uint8Array(ev.data);
      if (data.length < 5) return;

      // First 4 bytes: render time in ms (little-endian)
      const ms = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
      setRenderMs(ms);

      // Rest: JPEG
      const jpeg = data.slice(4);
      const blob = new Blob([jpeg], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);

      const img = new Image();
      img.onload = () => {
        const ctx = displayRef.current?.getContext('2d');
        if (ctx) {
          displayRef.current.width = img.naturalWidth;
          displayRef.current.height = img.naturalHeight;
          ctx.drawImage(img, 0, 0);
        }
        URL.revokeObjectURL(url);
        busyRef.current = false;
      };
      img.src = url;
    };

    ws.onerror = () => {
      setError('WebSocket error — is the backend running?');
    };

    ws.onclose = () => {
      wsRef.current = null;
      setConnected(false);
      busyRef.current = false;
      console.log('[LiveTryOn] WS closed');
    };
  }, [serverUrl]);

  const disconnectWs = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  // ── Camera ──────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
      streamRef.current = s;
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        videoRef.current.play();
      }
      setCameraOn(true);
    } catch (e) {
      setError('Camera access denied: ' + e.message);
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  // ── Frame loop ──────────────────────────────────────────────────
  useEffect(() => {
    if (!cameraOn || !connected) return;

    let frameCount = 0;
    let lastFpsTime = performance.now();

    const sendFrame = () => {
      rafRef.current = requestAnimationFrame(sendFrame);

      const v = videoRef.current;
      const ws = wsRef.current;
      if (!v || !ws || ws.readyState !== 1 || busyRef.current) return;
      if (v.videoWidth === 0) return;

      // Capture to hidden canvas
      const cv = canvasRef.current;
      if (!cv) return;
      cv.width = v.videoWidth;
      cv.height = v.videoHeight;
      const ctx = cv.getContext('2d');
      // Mirror the camera for selfie view
      ctx.translate(cv.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(v, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // Encode as JPEG and send
      cv.toBlob((blob) => {
        if (!blob || !wsRef.current) return;
        busyRef.current = true;
        blob.arrayBuffer().then(buf => {
          if (wsRef.current?.readyState === 1) {
            wsRef.current.send(buf);
          } else {
            busyRef.current = false;
          }
        });

        frameCount++;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
          setFps(Math.round(frameCount * 1000 / (now - lastFpsTime)));
          frameCount = 0;
          lastFpsTime = now;
        }
      }, 'image/jpeg', 0.8);
    };

    sendFrame();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [cameraOn, connected]);

  // ── Cleanup ─────────────────────────────────────────────────────
  useEffect(() => () => {
    disconnectWs();
    stopCamera();
  }, []);

  const saveUrl = (val) => {
    setServerUrl(val);
    try { localStorage.setItem('ws_server', val); } catch {}
  };

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="app" style={{ paddingTop: 24 }}>
      <h1 style={{ fontFamily: 'var(--f-head)', fontSize: 28, margin: 0, textAlign: 'center' }}>
        Live Try-On (Server)
      </h1>
      <p style={{ color: 'var(--muted)', textAlign: 'center', margin: 0, fontSize: 14 }}>
        Real-time makeup via Python backend
      </p>

      {/* Server URL */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <input type="text" placeholder="ws://host:port/ws"
          value={serverUrl} onChange={e => saveUrl(e.target.value)}
          style={inputStyle} />
        <span style={{
          fontSize: 12, whiteSpace: 'nowrap', fontWeight: 600,
          color: connected ? 'var(--ok, #4CAF50)' : 'var(--warn, #FF9800)'
        }}>
          {connected ? '● Connected' : '○ Offline'}
        </span>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {!connected ? (
          <button onClick={connectWs} style={btnStyle}>🔌 Connect</button>
        ) : (
          <button onClick={disconnectWs} style={{ ...btnStyle, borderColor: '#C62828', color: '#C62828' }}>
            ✕ Disconnect
          </button>
        )}
        {!cameraOn ? (
          <button onClick={startCamera} style={btnStyle} disabled={!connected}>
            📷 Start Camera
          </button>
        ) : (
          <button onClick={stopCamera} style={{ ...btnStyle, ...btnPrimary }}>
            ⏹ Stop Camera
          </button>
        )}
      </div>

      {/* Stats */}
      {cameraOn && connected && (
        <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
          <span>FPS: {fps}</span>
          <span>Render: {renderMs}ms</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <p style={{ color: '#C62828', textAlign: 'center', margin: '8px 0 0', fontSize: 13 }}>
          ⚠️ {error}
        </p>
      )}

      {/* Video display */}
      <div style={{ position: 'relative', marginTop: 12 }}>
        {/* Hidden video element for camera feed */}
        <video ref={videoRef} autoPlay playsInline muted
          style={{ display: 'none' }} />
        {/* Hidden capture canvas */}
        <canvas ref={canvasRef} style={{ display: 'none' }} />

        {/* Rendered output */}
        <canvas ref={displayRef}
          style={{
            width: '100%', borderRadius: 12, background: '#111',
            aspectRatio: '4/3', objectFit: 'contain',
            transform: 'scaleX(1)', // already mirrored in capture
          }} />

        {!cameraOn && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            color: 'var(--muted)', fontSize: 14, fontFamily: 'var(--f-body)',
          }}>
            {connected ? 'Press "Start Camera" to begin' : 'Connect to server first'}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────
const inputStyle = {
  flex: 1, padding: '10px 14px', borderRadius: 10, border: '1px solid var(--line)',
  background: 'var(--surface)', color: 'var(--fg)', fontSize: 14, outline: 'none',
};
const btnStyle = {
  padding: '10px 16px', borderRadius: 10, border: '1px solid var(--line)',
  background: 'var(--surface)', color: 'var(--fg)', cursor: 'pointer',
  fontSize: 14, fontFamily: 'var(--f-body)', fontWeight: 500,
};
const btnPrimary = {
  background: 'var(--grad)', color: 'var(--on-primary)', border: 'none',
};
