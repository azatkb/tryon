# REESOLVE — Lip Try-On Prototype

A working React prototype of real-time **lip colour replacement**: the real
**MediaPipe Face Landmarker** (478-point face mesh) runs on-device over live
camera or an uploaded photo, and the chosen shade is composited onto the lips in
a way that **keeps the lips' own texture, highlights and shine** — so it reads as
applied makeup, not a flat filter.

This is the Phase-1 demonstrator for the rendering approach: MediaPipe for
tracking (kept), a lip mask from the mesh, and a texture-preserving blend.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL. The live camera needs a secure context — `http://localhost`
works, and `npm run dev` already serves there.

**Testing on a phone (camera needs HTTPS off localhost):**
```bash
npm run dev            # note the Network URL it prints
```
Phones refuse `getUserMedia` over plain `http://<lan-ip>`. Options:
- use the **Photo** mode (upload works over http), or
- put it behind HTTPS — e.g. `npx vite --https` with a local cert, or tunnel with
  `cloudflared`/`ngrok` and open the https URL on the phone.

## How it works

```
camera / photo
      │
      ▼
MediaPipe FaceLandmarker  (useFaceLandmarker.js)  ── 478 landmarks, GPU delegate
      │   lip landmark indices (lips.js)
      ▼
lip mask: outer lip filled, inner mouth opening cut out, edges feathered
      │
      ▼
recolour (lipRenderer.js):
   • 'color' blend  → hue+saturation from the shade, lightness from the real lips
   • small 'multiply' → pigment density for pale shades
   • 'soft-light'   → satin sheen
   • 'screen' radial → gloss highlight on the lower lip
      │
      ▼
<canvas> frame (camera mirrored for UX)
```

Detection runs only on fresh video frames; the frame is still drawn every rAF, so
draw rate is already decoupled from detect rate.

## Files

| file | role |
|------|------|
| `src/useFaceLandmarker.js` | loads the MediaPipe model once (VIDEO mode; switches to IMAGE for photos) |
| `src/lips.js` | MediaPipe lip landmark indices (outer / inner / lower-lip) |
| `src/lipRenderer.js` | builds the feathered lip mask and does the texture-preserving recolour |
| `src/App.jsx` | camera/photo, controls, the render loop |

The model + WASM load from Google/jsDelivr CDNs (pinned in `useFaceLandmarker.js`).
For production, self-host both.

## What this prototype is **not** yet (the production path)

These are the next steps, matching the engineering proposal:

1. **WebGL/WebGPU rendering.** Canvas 2D blend modes are used here for clarity.
   Production moves the blend into a fragment shader — far faster and opens up
   real finish models (matte/satin/metallic), per-region intensity, and
   lighting-aware shading.
2. **Segmentation mask (BiSeNet).** The lip polygon from landmarks is good but
   coarse at the edges. A per-pixel segmentation mask gives clean, natural lip
   edges and lets us extend to skin (foundation/blush), eyes and brows.
3. **Performance hardening.** Downscaled inference (~256²) with mask upscale,
   landmark interpolation between detections, and a WASM-SIMD fallback — targeting
   a steady 60 fps on mid-range Android.
4. **Shade accuracy.** Wire shades to real brand colour data (measured/brand-supplied),
   with camera/white-balance calibration so the on-screen colour matches the product.

## Notes
- One face (`numFaces: 1`); raise it in `useFaceLandmarker.js` if needed.
- Photos never leave the device — everything runs client-side.
- Front-camera preview is mirrored; the underlying canvas is not, so exported
  frames would be un-mirrored.
