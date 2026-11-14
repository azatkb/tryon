// videoWriter.js — frame-exact MP4 writer (WebCodecs H.264 + mp4-muxer).
//
// MediaRecorder samples a canvas on its own clock: frames that take longer
// than one tick to render are dropped or duplicated, and Chrome's encoder
// quietly lowers the resolution under load. Here every frame is handed to the
// encoder explicitly, with an explicit timestamp, at the full source size.
//
//   const wr = await createMp4Writer({ width, height, fps });
//   await wr.addFrame(canvas, timestampUs);     // once per rendered frame
//   const blob = await wr.finish();             // video/mp4

import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';

export function mp4WriterSupported() {
  return typeof window !== 'undefined' && 'VideoEncoder' in window && 'VideoFrame' in window;
}

// H.264 first (plays everywhere), VP9-in-MP4 as a fallback.
const CODECS = [
  { codec: 'avc1.640034', mux: 'avc' }, // High, level 5.2 (up to 4K)
  { codec: 'avc1.640033', mux: 'avc' }, // High, level 5.1
  { codec: 'avc1.640028', mux: 'avc' }, // High, level 4.0 (1080p)
  { codec: 'avc1.4d0034', mux: 'avc' }, // Main
  { codec: 'avc1.42003e', mux: 'avc' }, // Baseline
  { codec: 'vp09.00.51.08', mux: 'vp9' },
];

/**
 * @param {object} o
 * @param {number} o.width, o.height  output size (rounded down to even)
 * @param {number} [o.fps=30]         nominal frame rate (bitrate + keyframe spacing)
 * @param {boolean} [o.mirror=false]  flip horizontally (match a mirrored selfie preview)
 * @param {number} [o.bitrate]        bits/s; default scales with pixel count
 */
export async function createMp4Writer({ width, height, fps = 30, mirror = false, bitrate } = {}) {
  if (!mp4WriterSupported()) throw new Error('WebCodecs VideoEncoder is not available in this browser');
  const W = Math.max(2, width & ~1), H = Math.max(2, height & ~1);
  const br = bitrate || Math.round(Math.min(60e6, Math.max(6e6, W * H * fps * 0.2)));

  let chosen = null;
  for (const c of CODECS) {
    const cfg = { codec: c.codec, width: W, height: H, bitrate: br, framerate: fps };
    if (c.mux === 'avc') cfg.avc = { format: 'avc' };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(cfg);
      if (supported) { chosen = { ...c, cfg }; break; }
    } catch (_) { /* try next */ }
  }
  if (!chosen) throw new Error(`No supported video encoder for ${W}x${H}`);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    // No frameRate here: mp4-muxer only accepts integers and would snap the
    // timescale to it. Its default fine timescale keeps 23.976/29.97 exact.
    video: { codec: chosen.mux, width: W, height: H },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  // Every chunk is handed to the muxer with an explicit duration. Some encoders
  // (hardware H.264 on Windows) give chunks without one; mp4-muxer then throws
  // inside this callback — silently, the encoder keeps going — the first
  // chunk's codec config never reaches the muxer, and finalize() crashed with
  // "Cannot read properties of null (reading 'colorSpace')".
  const frameDur = Math.max(1, Math.round(1e6 / fps));
  let failure = null, chunks = 0, gotConfig = false;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const dur = Number.isFinite(chunk.duration) && chunk.duration > 0 ? chunk.duration : frameDur;
        let m = meta && typeof meta === 'object' ? meta : undefined;
        const dc = m?.decoderConfig;
        if (dc && dc.colorSpace && (dc.colorSpace.primaries == null || dc.colorSpace.transfer == null || dc.colorSpace.matrix == null)) {
          // partial colour info → the 'colr' box would be written with garbage
          m = { ...m, decoderConfig: { ...dc, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false, ...Object.fromEntries(Object.entries(dc.colorSpace).filter(([, v]) => v != null)) } } };
        } else if (dc && !dc.colorSpace && chosen.mux === 'vp9') {
          m = { ...m, decoderConfig: { ...dc, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } } };
        }
        muxer.addVideoChunkRaw(data, chunk.type, chunk.timestamp, dur, m);
        if (m?.decoderConfig) gotConfig = true;
        chunks++;
      } catch (e) { if (!failure) failure = e; }
    },
    error: (e) => { if (!failure) failure = e; },
  });
  encoder.configure(chosen.cfg);

  // Staging canvas: crops to even size and applies the mirror.
  const stage = document.createElement('canvas');
  stage.width = W; stage.height = H;
  const sctx = stage.getContext('2d');

  const keyEvery = Math.max(1, Math.round(fps * 2));
  let count = 0, lastTs = -1;

  function encode(src, timestampUs) {
    if (failure) throw failure;
    sctx.setTransform(mirror ? -1 : 1, 0, 0, 1, mirror ? W : 0, 0);
    sctx.drawImage(src, 0, 0, W, H);
    // Timestamps must strictly increase.
    const ts = Math.max(Math.round(timestampUs), lastTs + 1);
    lastTs = ts;
    const frame = new VideoFrame(stage, { timestamp: ts, duration: frameDur });
    encoder.encode(frame, { keyFrame: count % keyEvery === 0 });
    frame.close();
    count++;
  }

  return {
    width: W, height: H, codec: chosen.codec,
    get frames() { return count; },
    /** Offline: waits for the encoder to keep up, never drops a frame. */
    async addFrame(src, timestampUs) {
      while (encoder.encodeQueueSize > 4) {
        await new Promise((r) => encoder.addEventListener('dequeue', r, { once: true }));
      }
      encode(src, timestampUs);
    },
    /** Real-time: returns false (frame skipped) if the encoder is far behind or
     *  has failed — never throws (it's called from the render loop); finish()
     *  reports the failure. */
    addFrameNow(src, timestampUs) {
      if (failure || encoder.state !== 'configured' || encoder.encodeQueueSize > 12) return false;
      try { encode(src, timestampUs); } catch (e) { if (!failure) failure = e; return false; }
      return true;
    },
    async finish() {
      try { await encoder.flush(); } catch (e) { if (!failure) failure = e; }
      try { encoder.close(); } catch (_) { /* already closed */ }
      if (failure) throw new Error(`Video encoder (${chosen.codec}) failed: ${failure.message || failure}`);
      if (!chunks) throw new Error(`Video encoder (${chosen.codec}) produced no frames`);
      if (!gotConfig) throw new Error(`Video encoder (${chosen.codec}) gave no codec config — can't write the MP4`);
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    },
    cancel() { try { encoder.close(); } catch (_) { /* already closed */ } },
  };
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = name; a.href = url; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Estimate a video's frame rate from requestVideoFrameCallback media times.
 * Plays a short muted burst, then restores time/pause state. Falls back to 30.
 */
export async function detectVideoFps(v) {
  if (!v || !('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return 30;
  const wasPaused = v.paused, t0 = v.currentTime;
  const times = [];
  try {
    await new Promise((resolve) => {
      let n = 0;
      const timer = setTimeout(resolve, 1500);
      const cb = (_now, meta) => {
        times.push(meta.mediaTime);
        if (++n >= 12) { clearTimeout(timer); resolve(); } else v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
      v.play().catch(resolve);
    });
  } finally {
    v.pause();
    v.currentTime = t0;
    if (!wasPaused) v.play().catch(() => {});
  }
  const d = [];
  for (let i = 1; i < times.length; i++) { const x = times[i] - times[i - 1]; if (x > 0.003) d.push(x); }
  if (d.length < 3) return 30;
  d.sort((a, b) => a - b);
  const frameDur = d[Math.floor(d.length * 0.25)]; // low quartile = single-frame step
  const fps = 1 / frameDur;
  const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
  return common.reduce((best, c) => (Math.abs(c - fps) < Math.abs(best - fps) ? c : best), 30);
}

/**
 * Seek and resolve once the frame at `t` is decoded and drawable.
 * Order matters: wait for 'seeked' FIRST — a frame callback registered before
 * the seek can fire for the old frame and you'd draw a stale picture.
 */
export function seekTo(v, t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(safety); resolve(); } };
    const safety = setTimeout(finish, 3000);
    const onSeeked = () => {
      if ('requestVideoFrameCallback' in v) {
        // Paused + seeked: Chrome presents the new frame and fires this once.
        const fallback = setTimeout(finish, 80);
        v.requestVideoFrameCallback(() => { clearTimeout(fallback); finish(); });
      } else {
        requestAnimationFrame(() => requestAnimationFrame(finish));
      }
    };
    v.addEventListener('seeked', onSeeked, { once: true });
    v.currentTime = t;
  });
}