import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,          // listen on the LAN, not just localhost
    allowedHosts: true,  // accept tunnel hostnames (cloudflared/ngrok/localtunnel) — avoids "Blocked request"
  },
  // onnxruntime-web ships prebuilt wasm/webgpu; don't let Vite try to pre-bundle it.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});