import { useRef, useState, useCallback } from 'react';

// ─── config ────────────────────────────────────────────────────────
const RUNPOD_ENDPOINT = 'https://api.runpod.ai/v2/qwen-image-edit-2511';
const RUNPOD_API_KEY  = 'rpa_5E0DBQOY1R262BTP25QZEMF16KGZX7S4RE5Y9Z0Ke3h2bi'; // set your key here or via env
const POLL_INTERVAL   = 3000;

// ─── hardcoded makeup prompt ───────────────────────────────────────
const MAKEUP_PROMPT = 'Edit ONLY the makeup on this person\'s face, do NOT change anything else — keep the exact same background, hair, clothing, lighting, pose, facial expression, skin texture, pores, and face shape completely unchanged. Apply realistic professional makeup that looks like it was applied by hand, not digitally overlaid: smooth satin foundation blended into skin preserving natural pores and texture, light concealer under eyes, warm sculpted contour on cheekbones and jawline blended into skin, coral-rose blush diffused naturally on cheeks, soft golden highlighter on cheekbone peaks, groomed filled eyebrows matching natural hair color, bronze and copper eyeshadow seamlessly blended on eyelids and crease, thin precise black eyeliner on upper lash line with small wing, full black mascara on lashes, berry-toned lip liner on lip edges, rich rose-berry satin lipstick on lips blended naturally. The makeup must look physically real as if photographed in the same lighting conditions, not like a filter or digital overlay. Preserve the exact facial expression, smile, eye gaze, wrinkles and micro-expressions from the original photo — do not neutralize, soften or alter the person\'s expression in any way.';

// ─── resize to max 1000px width, then convert to base64 ───────────
const MAX_W = 1000;

function resizeAndBase64(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > MAX_W) { h = Math.round(h * MAX_W / w); w = MAX_W; }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(cv.toDataURL('image/jpeg', 0.92));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

// ─── RunPod helpers ────────────────────────────────────────────────
async function submitJob(imageData, prompt) {
  const apiKey = RUNPOD_API_KEY || localStorage.getItem('runpod_key') || '';
  if (!apiKey) throw new Error('RunPod API key not set');
  const res = await fetch(`${RUNPOD_ENDPOINT}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: {
        prompt,
        images: [imageData],
        enable_base64_output: false,
        enable_sync_mode: false,
        output_format: 'jpeg',
        seed: -1,
        size: '1024*1024',
      },
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`RunPod submit failed (${res.status}): ${txt}`);
  }
  return res.json();
}

async function pollJob(jobId) {
  const apiKey = RUNPOD_API_KEY || localStorage.getItem('runpod_key') || '';
  const res = await fetch(`${RUNPOD_ENDPOINT}/status/${jobId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
  return res.json();
}

// ─── component ─────────────────────────────────────────────────────
export default function PhotoPage() {
  const videoRef   = useRef(null);
  const canvasRef  = useRef(null);
  const streamRef  = useRef(null);
  const fileRef    = useRef(null);

  const [step, setStep]         = useState('capture'); // capture | loading | result | error
  const [photo, setPhoto]       = useState(null);
  const [photoBlob, setBlob]    = useState(null);
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState('');
  const [progress, setProgress] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  const [apiKey, setApiKey]     = useState(() => {
    try { return localStorage.getItem('runpod_key') || ''; } catch { return ''; }
  });

  // ── camera ───────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      });
      streamRef.current = s;
      if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play(); }
      setCameraOn(true);
    } catch (e) { setError('Camera access denied: ' + e.message); }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  const takePhoto = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const cv = canvasRef.current || document.createElement('canvas');
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext('2d').drawImage(v, 0, 0);
    cv.toBlob(blob => {
      setBlob(blob);
      setPhoto(URL.createObjectURL(blob));
      stopCamera();
      // auto-submit immediately
      doSubmit(blob);
    }, 'image/jpeg', 0.92);
  }, [stopCamera]);

  const handleFile = useCallback((e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBlob(f);
    setPhoto(URL.createObjectURL(f));
    stopCamera();
    doSubmit(f);
  }, [stopCamera]);

  const saveKey = useCallback((val) => {
    setApiKey(val);
    try { localStorage.setItem('runpod_key', val); } catch {}
  }, []);

  // ── submit (auto, no look selection) ─────────────────────────────
  const doSubmit = useCallback(async (blob) => {
    if (!blob) return;
    setStep('loading');
    setProgress('Encoding image…');
    setError('');

    try {
      const imageData = await resizeAndBase64(blob);
      setProgress('Sending to AI…');

      const job = await submitJob(imageData, MAKEUP_PROMPT);
      const jobId = job.id;
      setProgress(`Job ${jobId} queued…`);

      let attempts = 0;
      const maxAttempts = 120;
      while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        attempts++;
        const status = await pollJob(jobId);
        setProgress(`Status: ${status.status} (${attempts * POLL_INTERVAL / 1000}s)`);

        if (status.status === 'COMPLETED') {
          const out = status.output;
          const url =
            (typeof out === 'string' && out.startsWith('http')) ? out :
            out?.result && typeof out.result === 'string' ? out.result :
            out?.image_url ? out.image_url :
            out?.image ? out.image :
            null;
          if (url) {
            setResult(url.startsWith('http') ? url : `data:image/png;base64,${url}`);
          } else {
            throw new Error('Unexpected output: ' + JSON.stringify(out));
          }
          setStep('result');
          return;
        }
        if (status.status === 'FAILED') throw new Error(status.error || 'Job failed');
      }
      throw new Error('Timeout — job took too long');
    } catch (e) {
      setError(e.message);
      setStep('error');
    }
  }, []);

  const reset = useCallback(() => {
    setStep('capture'); setPhoto(null); setBlob(null);
    setResult(null); setError(''); setProgress('');
  }, []);

  // ── render ───────────────────────────────────────────────────────
  return (
    <div className="app" style={{ paddingTop: 24 }}>
      <h1 style={{ fontFamily: 'var(--f-head)', fontSize: 28, margin: 0, textAlign: 'center' }}>
        AI Makeup Try-On
      </h1>
      <p style={{ color: 'var(--muted)', textAlign: 'center', margin: 0, fontSize: 14 }}>
        Photo mode
      </p>

      {/* API Key */}
      {!RUNPOD_API_KEY && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="password" placeholder="RunPod API Key"
            value={apiKey} onChange={e => saveKey(e.target.value)} style={inputStyle} />
          <span style={{ fontSize: 12, color: apiKey ? 'var(--ok)' : 'var(--warn)', whiteSpace: 'nowrap' }}>
            {apiKey ? '✓ saved' : 'required'}
          </span>
        </div>
      )}

      {/* ── CAPTURE ── */}
      {step === 'capture' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {cameraOn && (
            <video ref={videoRef} autoPlay playsInline muted
              style={{ width: '100%', borderRadius: 12, background: '#000' }} />
          )}
          <canvas ref={canvasRef} style={{ display: 'none' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            {!cameraOn ? (
              <button onClick={startCamera} style={btnStyle}>📷 Open Camera</button>
            ) : (
              <button onClick={takePhoto} style={{ ...btnStyle, ...btnPrimary }}>📸 Take Photo</button>
            )}
            <button onClick={() => fileRef.current?.click()} style={btnStyle}>📁 Upload Photo</button>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFile} />
          </div>
        </div>
      )}

      {/* ── LOADING ── */}
      {step === 'loading' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', padding: '40px 0' }}>
          {photo && (
            <img src={photo} alt="Processing"
              style={{ width: '60%', borderRadius: 12, opacity: 0.5, maxHeight: 240, objectFit: 'contain' }} />
          )}
          <div className="photo-spinner" />
          <p style={{ color: 'var(--muted)', textAlign: 'center', margin: 0, fontSize: 13 }}>{progress}</p>
          <style>{`
            .photo-spinner {
              width: 48px; height: 48px; border: 4px solid var(--line);
              border-top-color: var(--primary); border-radius: 50%;
              animation: spin 0.8s linear infinite;
            }
            @keyframes spin { to { transform: rotate(360deg); } }
          `}</style>
        </div>
      )}

      {/* ── RESULT ── */}
      {step === 'result' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <p style={{ margin: '0 0 4px', fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>Before</p>
              <img src={photo} alt="Before"
                style={{ width: '100%', borderRadius: 8, objectFit: 'cover', aspectRatio: '3/4' }} />
            </div>
            <div>
              <p style={{ margin: '0 0 4px', fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>After</p>
              <img src={result} alt="After"
                style={{ width: '100%', borderRadius: 8, objectFit: 'cover', aspectRatio: '3/4' }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={reset} style={btnStyle}>🔄 New Photo</button>
            {result?.startsWith('http') && (
              <a href={result} download="reesolve-edit.png"
                style={{ ...btnStyle, ...btnPrimary, textDecoration: 'none', textAlign: 'center' }}>
                💾 Save
              </a>
            )}
          </div>
        </div>
      )}

      {/* ── ERROR ── */}
      {step === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', padding: '20px 0' }}>
          <p style={{ color: '#C62828', textAlign: 'center', margin: 0 }}>⚠️ {error}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={reset} style={btnStyle}>🔄 Start Over</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── inline styles ──────────────────────────────────────────────────
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