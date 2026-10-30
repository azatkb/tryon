import { LIPS_OUTER, LIPS_INNER, LOWER_LIP } from './lips.js';
import { EYE_R_LASH, EYE_L_LASH, EYE_R_V, EYE_L_V, EYE_LIFT,
         EYE_R_FULL, EYE_L_FULL, FACE_OVAL, BROW_R, BROW_L, NOSE,
         CHEEK_R, CHEEK_L, FACE_SIDE_L, FACE_SIDE_R } from './regions.js';

// When on, face-area makeup (blush, contour, highlight, concealer, foundation)
// is cut away where it overlaps protected features (eyes, nose, lips, brows).
let PROTECT = true;

// Hysteresis for the inner-lip cutout: once the mouth-open cutout is active,
// keep it on until the gap drops well below the activation threshold, so a
// mouth hovering near 8% open doesn't flicker the cutout on and off.
let _lipCutoutActive = false;
export function setFeatureProtect(v) { PROTECT = !!v; }

// Runtime override for a region's edge softness (blur fraction of mask width).
// Lets the debug panel's "edge hardness" slider retune a layer live.
export function setRegionBlur(region, frac) {
  if (CFG[region]) CFG[region].blur = frac;
}

// Layer name -> the CFG block whose blur it drives (foundation's block is "face").
const REGION_CFG = {
  foundation: 'face', underEye: 'underEye', blush: 'blush',
  highlight: 'highlight', contour: 'contour', eyes: 'eyes',
};

// Edge hardness 0..1 -> blur fraction, per region. ONE table, so a lesson's
// `edge` field and the workbench slider can't drift apart — they did, and that
// is why debug and the tutorial kept disagreeing.
// The soft end stays narrower than the band each region draws: past it the blur
// no longer softens the edge, it flattens the mask and the colour disappears.
const EDGE_RANGE = {
  face:      [0.020, 0.004],
  underEye:  [0.030, 0.008],
  blush:     [0.020, 0.004],
  highlight: [0.016, 0.005],
  contour:   [0.032, 0.012],
  eyes:      [0.011, 0.003],
};

/** Set a region's edge hardness: 0 = softest wash, 1 = tightest to the mask. */
export function setRegionEdge(region, hardness) {
  const key = REGION_CFG[region] || region;
  const r = EDGE_RANGE[key];
  if (!r || !CFG[key]) return;
  const t = Math.min(1, Math.max(0, hardness));
  CFG[key].blur = r[0] + (r[1] - r[0]) * t;
}

/** The [soft, hard] blur range for a region — for UI that shows the extremes. */
export function edgeRangeFor(region) {
  return EDGE_RANGE[REGION_CFG[region] || region] || null;
}
// Per-eye foreshortening: how much each eye is compressed by head rotation.
// Returns [ratioR, ratioL] where 1 = frontal (full width), <1 = foreshortened.
// The narrower eye is the far one; its inner corner (nose side) should tuck in.
// Eye perspective: ratio of each eye's apparent width to the wider one.
// Called multiple times per frame (eyeshadow, eyeliner, lashes) — cached
// per landmarks reference so the result is consistent within a frame.
// Rate-limited: max 0.08 change per frame to kill jitter without adding lag.
let _perspPrev = null;
let _perspCached = null;
let _perspRef = null;
const PERSP_MAX_STEP = 0.08;

function eyePerspective(landmarks) {
  if (landmarks === _perspRef && _perspCached) return _perspCached;
  _perspRef = landmarks;

  const wR = Math.abs(landmarks[33].x - landmarks[133].x);
  const wL = Math.abs(landmarks[263].x - landmarks[362].x);
  const maxW = Math.max(wR, wL, 0.001);
  let rR = wR / maxW, rL = wL / maxW;
  if (_perspPrev) {
    // Clamp per-frame change — kills jitter, follows real turns instantly
    const dR = rR - _perspPrev[0], dL = rL - _perspPrev[1];
    rR = _perspPrev[0] + Math.max(-PERSP_MAX_STEP, Math.min(PERSP_MAX_STEP, dR));
    rL = _perspPrev[1] + Math.max(-PERSP_MAX_STEP, Math.min(PERSP_MAX_STEP, dL));
  }
  _perspPrev = [rR, rL];
  _perspCached = [rR, rL];
  return _perspCached;
}

function cutFeatures(m, landmarks) {
  if (!PROTECT) return;
  m.save();
  m.filter = 'none';
  m.globalCompositeOperation = 'destination-out';
  for (const poly of [NOSE, EYE_R_FULL, EYE_L_FULL, LIPS_OUTER, BROW_R, BROW_L]) {
    fillPoly(m, landmarks, poly, MW, MH);
  }
  m.restore();
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  TUNING — all mask shape/softness settings in one place.                   ║
// ║  Sizes are fractions of FACE WIDTH (faceW) unless noted; blur is fraction  ║
// ║  of mask width (MW). Per-step STRENGTH lives in tutorials.js (intensity),  ║
// ║  and shader colour math (contour darkness, highlight colour) in webglLips.js. ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const CFG = {
  maskScale: 0.5,          // internal mask resolution (× frame). Lower = faster, softer.

  lips:  { blur: 0.006 },  // lip edge softness (ombre needs a little)

  lipLiner: { width: 0.003,      // liner ring thickness
              blur: 0.0015,      // softness (thin)
              lowerLift: 0.10 }, // lower-lip line pulled UP toward the mouth,
                                 // as a fraction of lip height — real liner sits
                                 // inside the lower edge, not on it

  eyeliner: { width: 0.005,
              wing: 0.45,        // wing length, relative to eye opening
              wingReach: 1.25,   // how far the flick travels ALONG the eye axis
              wingLift: 0.30,    // how far it rises across that axis (keep well
                                 // under wingReach — a wing goes out, not up)
              blur: 0.0012,
              taper: true },     // taper = thin at inner corner

  brows: { blur: 0.004 }, // brow fill edge softness

  // Diffusion must stay well under the band height (EYE_LIFT, in regions.js)
  // or it flattens the mask instead of softening its edge.
  eyes:  { blur: 0.007,
           outward: 0.28,  // how far the wash fans sideways near the outer corner
           tail: 0.42 },   // how far it carries PAST the outer corner, toward
                           // the temple — both as multiples of the lift

  lashes: { width: 0.0022, // lash line / flick thickness (× face HEIGHT)
            count: 32,     // denser flicks
            len: 0.40,     // slightly longer for drama
            reachT: 0.62,  // reach further across the lid
            curl: 0.28,    // curl arc — 0=straight, 1=full curl
            blur: 0.0006 },

  face:  { blur: 0.017 },  // foundation edge softness

  blush: { half: 0.17,     // sweep length (cheek apple → temple)
           width: 0.095,   // sweep thickness
           blur: 0.004,    // soft edges — kept under the band (see contour note)
           coreAlpha: 1.0, // centre intensity: full, so "100%" really is 100%
           haloRatio: 2.2, // halo width relative to core
           haloAlpha: 0.42 },// halo intensity (soft outer glow)

  // Keep `blur` NARROWER than the core band it softens. A blur wider than the
  // stroke doesn't just soften the edge, it flattens the peak: at width 0.055 /
  // blur 0.038 the mask topped out at 0.44 alpha and contour was invisible.
  contour: { width: 0.075, // core stroke thickness — wider band, more blendable
             drop: 0.25,   // push the curve down into the hollow
             blur: 0.022,  // powder-soft edge, but narrower than the band
             wide: 2.6,    // halo width = core × this (wider soft underlay)
             edge: 0.55,   // halo alpha
             core: 1.0 },  // core alpha — full, the blur does the feathering

  // highlight & underEye use a feathered 2-pass stroke: a wide faint halo + a
  // bright core. Like blush, softness comes from a gradient profile that PEAKS
  // near 1.0 in the centre with light blur — not from a thin line over-blurred
  // (that just fades to nothing).
  // Same rule as contour: the 0.03 / 0.016 pair was blurring a 13px band with a
  // 15px kernel, so the highlight never reached full strength either.
  highlight: { width: 0.042, // core stroke thickness along the top of the cheekbone
               reach: 0.3,   // how far from the apple toward the eye (shorter = smaller)
               blur: 0.011,  // edge softness — narrower than the band
               wide: 2.2,    // halo width = core × this
               edge: 0.5,    // halo alpha
               core: 1.0 },  // core alpha (bright centre)

  // Concealer: a soft down-pointing triangle under the eye (the classic make-up
  // shape) — brightest just under the lid, fading as it reaches down the cheek.
  underEye: { drop: 0.05,     // top edge sits this far below the lower lid
              apexDrop: 0.22, // triangle height — how far down the cheek the tip reaches
              apexIn: 0.0,    // tip lean toward the nose (0 = straight down)
              spread: 0.5,    // extend both top corners outward (longer to the sides, ~1cm)
              fade: 0.25,     // alpha at the tip (top is 1.0) — vertical falloff
              blur: 0.016 },  // edge softness
};

// Masks are built at reduced resolution (cheap blur/fill) and scaled up when drawn.
const MASK_SCALE = CFG.maskScale;
let MW = 0, MH = 0;

// Reused offscreen canvases (avoid per-frame allocation).
// lashMaskCv is FULL-RES (no MASK_SCALE) so lash strokes stay crisp.
let maskCv, eyeMaskCv, faceMaskCv, lashMaskCv, blushMaskCv, contourMaskCv, highlightMaskCv, underEyeMaskCv, lipLinerMaskCv, eyelinerMaskCv, browMaskCv, packCv, colorCv, specCv, refineCv, lumaCv;
// Frequency separation scratch canvases (full resolution)
let freqLoCv, freqHiCv;
let LW = 0, LH = 0; // full-res dimensions for lash canvas
function ensure(w, h) {
  if (!maskCv) {
    maskCv = document.createElement('canvas'); eyeMaskCv = document.createElement('canvas');
    faceMaskCv = document.createElement('canvas'); lashMaskCv = document.createElement('canvas');
    blushMaskCv = document.createElement('canvas'); contourMaskCv = document.createElement('canvas');
    highlightMaskCv = document.createElement('canvas'); underEyeMaskCv = document.createElement('canvas');
    lipLinerMaskCv = document.createElement('canvas'); eyelinerMaskCv = document.createElement('canvas');
    browMaskCv = document.createElement('canvas'); packCv = document.createElement('canvas');
    colorCv = document.createElement('canvas'); specCv = document.createElement('canvas');
    refineCv = document.createElement('canvas'); lumaCv = document.createElement('canvas');
    freqLoCv = document.createElement('canvas'); freqHiCv = document.createElement('canvas');
  }
  MW = Math.max(2, Math.round(w * MASK_SCALE));
  MH = Math.max(2, Math.round(h * MASK_SCALE));
  LW = w; LH = h; // lash mask at full resolution — crisp lines
  if (lashMaskCv.width !== LW || lashMaskCv.height !== LH) { lashMaskCv.width = LW; lashMaskCv.height = LH; }
  for (const c of [maskCv, eyeMaskCv, faceMaskCv, blushMaskCv, contourMaskCv, highlightMaskCv, underEyeMaskCv, lipLinerMaskCv, eyelinerMaskCv, browMaskCv, packCv, refineCv]) { if (c.width !== MW || c.height !== MH) { c.width = MW; c.height = MH; } }
  for (const c of [colorCv, specCv, lumaCv, freqLoCv, freqHiCv]) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }
}

// Pack contour / highlight / under-eye masks into one RGB texture (R / G / B)
// so the shader samples one texture instead of three (stays within GL limits).
export function buildSculptPack(w, h, landmarks, want) {
  ensure(w, h);
  const m = packCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.globalCompositeOperation = 'source-over';
  m.clearRect(0, 0, MW, MH);
  // Fill OPAQUE black first. The pack is read as .rgb in the shader; if the pack
  // stayed transparent, WebGL's un-premultiply (rgb/alpha) would snap every
  // feathered edge back to full intensity (hard edge). With alpha=1 everywhere,
  // rgb/1 keeps the soft gradient the masks carry — so edges fade like blush.
  m.fillStyle = '#000';
  m.fillRect(0, 0, MW, MH);
  const put = (src, tint) => {
    const r = refineCv.getContext('2d');
    r.setTransform(1, 0, 0, 1, 0, 0);
    r.globalCompositeOperation = 'source-over';
    r.clearRect(0, 0, MW, MH);
    r.drawImage(src, 0, 0);
    r.globalCompositeOperation = 'source-in';
    r.fillStyle = tint; r.fillRect(0, 0, MW, MH);
    r.globalCompositeOperation = 'source-over';
    m.globalCompositeOperation = 'lighter';
    m.drawImage(refineCv, 0, 0);
  };
  if (want.contour) put(buildContourMask(w, h, landmarks), '#ff0000');
  if (want.highlight) put(buildHighlightMask(w, h, landmarks), '#00ff00');
  if (want.underEye) put(buildUnderEyeMask(w, h, landmarks), '#0000ff');
  m.globalCompositeOperation = 'source-over';
  return packCv;
}

// a soft, rotated, elongated blob — shared shape for sculpt/glow sweeps
function sweep(m, cx, cy, ang, half, width, a0) {
  m.save();
  m.translate(cx, cy);
  m.rotate(ang);
  m.scale(half / width, 1);
  const g = m.createRadialGradient(0, 0, 0, 0, 0, width);
  g.addColorStop(0, `rgba(255,255,255,${a0})`);
  g.addColorStop(0.55, `rgba(255,255,255,${a0 * 0.45})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  m.fillStyle = g;
  m.beginPath(); m.arc(0, 0, width, 0, Math.PI * 2); m.fill();
  m.restore();
}

function fillPoly(ctx, landmarks, indices, w, h) {
  ctx.beginPath();
  indices.forEach((i, k) => {
    const x = landmarks[i].x * w, y = landmarks[i].y * h;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
}

// Smooth closed outline through the landmark points (Catmull-Rom -> Bézier).
// Straight lineTo between sparse lip points gives a jagged shape whose feather
// bleeds onto skin ("smeared"); a smooth curve hugs the real lip edge.
// Closed Catmull-Rom-ish curve through an arbitrary point list. Same smoothing
// tracePath uses, but over points a caller has already adjusted.
function traceSmooth(ctx, pts) {
  const n = pts.length;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
  }
  ctx.closePath();
}

function tracePath(ctx, landmarks, indices, w, h) {
  const pts = indices.map((i) => [landmarks[i].x * w, landmarks[i].y * h]);
  const n = pts.length;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
  }
  ctx.closePath();
}

/**
 * Build the lip mask into the shared maskCv and return it (white = lips).
 * Landmarks are the base; an ONNX segmentation mask in opts.overrideMask only
 * refines the edge, with a floor so weak segmentation can't erase the lips.
 */
export function buildLipMask(w, h, landmarks, opts = {}) {
  ensure(w, h);
  const blur = Math.max(1.2, MW * CFG.lips.blur); // softer edge → room for the ombre liner
  const m = maskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  m.fillStyle = '#fff';
  m.filter = `blur(${blur}px)`;
  tracePath(m, landmarks, LIPS_OUTER, MW, MH);
  m.fill();
  m.filter = 'none';
  const gap = Math.abs(landmarks[14].y - landmarks[13].y);
  const lipW = Math.abs(landmarks[291].x - landmarks[61].x);
  // Hysteresis: activate at 8%, deactivate at 5% — avoids flicker near threshold
  const ratio = lipW > 0 ? gap / lipW : 0;
  _lipCutoutActive = ratio > (_lipCutoutActive ? 0.05 : 0.08);
  if (_lipCutoutActive) {
    // The mouth-opening cutout must never punch through the lip fill.
    // LIPS_INNER landmarks don't perfectly nest inside LIPS_OUTER (the real
    // lip shape is more complex than 20 sparse points can capture), so we
    // build the cutout as the INTERSECTION of:
    //   A) the LIPS_INNER path (the actual mouth opening), and
    //   B) a heavily-shrunk LIPS_OUTER path (the maximum safe cutout).
    // This way the cutout can never extend past the safe zone no matter how
    // the inner landmarks misbehave — the shrunk outer acts as a hard clamp.

    // Step 1: draw LIPS_INNER (the mouth opening) onto a temp canvas
    const tc = refineCv.getContext('2d');
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.clearRect(0, 0, MW, MH);
    tc.fillStyle = '#fff';
    tc.filter = `blur(${Math.max(1, blur * 0.5)}px)`;
    tracePath(tc, landmarks, LIPS_INNER, MW, MH);
    tc.fill();

    // Step 2: intersect with shrunk LIPS_OUTER — guarantees minimum lip thickness
    const outerPts = LIPS_OUTER.map((i) => [landmarks[i].x * MW, landmarks[i].y * MH]);
    let ocx = 0, ocy = 0;
    for (const [x, y] of outerPts) { ocx += x; ocy += y; }
    ocx /= outerPts.length; ocy /= outerPts.length;
    // Shrink outer by 25% — leaves a guaranteed lip-paint band around the mouth
    const safeInset = 0.25;
    const safePts = outerPts.map(([x, y]) => [
      x + (ocx - x) * safeInset,
      y + (ocy - y) * safeInset,
    ]);
    tc.globalCompositeOperation = 'destination-in';
    tc.filter = 'none';
    traceSmooth(tc, safePts);
    tc.fill();
    tc.globalCompositeOperation = 'source-over';

    // Step 3: use the clamped cutout to erase from the lip mask
    m.globalCompositeOperation = 'destination-out';
    m.drawImage(refineCv, 0, 0);
    m.globalCompositeOperation = 'source-over';
  }
  if (opts.overrideMask) {
    const SEG_FLOOR = 0.45; // 0 = seg fully controls the edge, 1 = seg ignored
    const rf = refineCv.getContext('2d');
    rf.setTransform(1, 0, 0, 1, 0, 0);
    rf.clearRect(0, 0, MW, MH);
    rf.globalAlpha = SEG_FLOOR; rf.fillStyle = '#fff'; rf.fillRect(0, 0, MW, MH);
    rf.globalAlpha = 1; rf.drawImage(opts.overrideMask, 0, 0, MW, MH);
    m.globalCompositeOperation = 'destination-in';
    m.drawImage(refineCv, 0, 0, MW, MH);
    m.globalCompositeOperation = 'source-over';
  }
  return maskCv;
}

// Build an eyeshadow mask (both eyes) into eyeMaskCv: a soft band above each
// upper lash line, offset toward the brow by a fraction of eye height.
export function buildEyeMask(w, h, landmarks) {
  ensure(w, h);
  const m = eyeMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  m.filter = `blur(${Math.max(2, MW * CFG.eyes.blur)}px)`;
  const [perspR, perspL] = eyePerspective(landmarks);
  for (const [lash, vref, persp] of [[EYE_R_LASH, EYE_R_V, perspR], [EYE_L_LASH, EYE_L_V, perspL]]) {
    const eyeH = Math.abs(landmarks[vref[0]].y - landmarks[vref[1]].y) * MH;
    const lift = eyeH * EYE_LIFT;
    const lo = lash.map((i) => [landmarks[i].x * MW, landmarks[i].y * MH]);
    const n = lo.length;
    const outer = lo[0], inner = lo[n - 1];   // lash arrays run outer -> inner

    // Work in the eye's own frame so the shape follows a tilted head.
    let axX = outer[0] - inner[0], axY = outer[1] - inner[1];
    const axL = Math.hypot(axX, axY) || 1; axX /= axL; axY /= axL;
    let upX = (landmarks[vref[0]].x - landmarks[vref[1]].x) * MW;
    let upY = (landmarks[vref[0]].y - landmarks[vref[1]].y) * MH;
    const upL = Math.hypot(upX, upY) || 1; upX /= upL; upY /= upL;

    // ── Perspective tuck ──────────────────────────────────────────────
    // When the face turns, the far eye foreshortens (persp < 1). The inner
    // corner (nose side) needs to tuck inward and the shadow height should
    // compress — mimicking real perspective where the near-nose edge wraps
    // around the bridge and disappears.
    // tuck: 0 = frontal (no change), up to ~0.6 at strong foreshortening
    const tuck = Math.max(0, 1 - persp) * 2.0;  // stronger tuck for eyeshadow
    // Pull inner points toward the eye centre along the lash axis
    if (tuck > 0.01) {
      const cx = (outer[0] + inner[0]) / 2, cy = (outer[1] + inner[1]) / 2;
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1);  // 0 at outer, 1 at inner
        const pull = t > 0.35 ? (t - 0.35) / 0.65 * tuck : 0;
        if (pull > 0) {
          lo[k][0] += (cx - lo[k][0]) * pull * 0.65;
          lo[k][1] += (cy - lo[k][1]) * pull * 0.4;
        }
      }
    }

    // Shadow height scales down on the foreshortened eye — perspective
    // compresses the visible lid surface, so the wash should be shorter.
    const perspLift = lift * (1 - tuck * 0.35);

    // A straight vertical extrusion of the lash line gives a band exactly as
    // wide as the eye with sheer sides — which reads as a narrow stripe. Real
    // shadow is a fan: it climbs higher at the outer third and carries OUT past
    // the outer corner toward the temple, which is what gives the eye its lift.
    const hi = lo.map((p, k) => {
      const t = k / (n - 1);                       // 0 at outer, 1 at inner
      const lf = perspLift * (1.3 - 0.6 * t);     // taller over the outer third
      const ow = perspLift * CFG.eyes.outward * (1 - t) * (1 - t); // fan, outer-weighted
      return [p[0] + upX * lf + axX * ow, p[1] + upY * lf + axY * ow];
    });

    // Tail also shrinks on foreshortened eye
    const tailLen = perspLift * CFG.eyes.tail;
    const tailBase = [outer[0] + axX * tailLen * 0.5, outer[1] + axY * tailLen * 0.5];
    const tailTip = [outer[0] + axX * tailLen + upX * lift * 1.0,
                     outer[1] + axY * tailLen + upY * lift * 1.0];

    // outer corner -> along the lash line -> inner, back along the lifted edge,
    // then out through the tail and closed.
    const poly = [tailBase, ...lo, ...hi.slice().reverse(), tailTip];

    // Gradient runs along the eye's own "up", not screen vertical: dense at the
    // lash line, still solid through the crease, sheer at the brow bone.
    const gx = (outer[0] + inner[0]) / 2, gy = (outer[1] + inner[1]) / 2;
    const grad = m.createLinearGradient(
      gx, gy,
      gx + upX * lift * 1.35, gy + upY * lift * 1.35,
    );
    grad.addColorStop(0,    'rgba(255,255,255,1.0)');  // dense at lash line
    grad.addColorStop(0.50, 'rgba(255,255,255,0.90)'); // still solid through the crease
    grad.addColorStop(0.80, 'rgba(255,255,255,0.52)');
    grad.addColorStop(1,    'rgba(255,255,255,0.12)'); // sheer at brow bone
    m.fillStyle = grad;
    m.beginPath();
    m.moveTo(poly[0][0], poly[0][1]);
    for (let k = 1; k < poly.length; k++) m.lineTo(poly[k][0], poly[k][1]);
    m.closePath();
    m.fill();

    // ── Inner-corner fade on the far eye ─────────────────────────────
    // On top of the geometric tuck, fade the opacity near the nose so the
    // shadow doesn't end with a hard edge at the bridge.
    if (tuck > 0.05) {
      const fadeStr = Math.min(1, tuck * 0.7);   // 0 at frontal, up to ~0.7
      // Gradient runs from inner corner (fully transparent) outward along the
      // eye axis, covering the inner ~40% of the eye width.
      const fadeEnd = [
        inner[0] + (outer[0] - inner[0]) * 0.4,
        inner[1] + (outer[1] - inner[1]) * 0.4,
      ];
      const fg = m.createLinearGradient(inner[0], inner[1], fadeEnd[0], fadeEnd[1]);
      fg.addColorStop(0, `rgba(0,0,0,${fadeStr})`);
      fg.addColorStop(1, 'rgba(0,0,0,0)');
      m.globalCompositeOperation = 'destination-out';
      m.fillStyle = fg;
      m.beginPath();
      m.moveTo(poly[0][0], poly[0][1]);
      for (let k = 1; k < poly.length; k++) m.lineTo(poly[k][0], poly[k][1]);
      m.closePath();
      m.fill();
      m.globalCompositeOperation = 'source-over';
    }
  }

  // Keep the wash off the brow hair. Clamping the gradient short of the brow
  // would also rob the lid of the height that makes the shape read, so instead
  // let it climb and subtract the brows — the shadow reaches the brow BONE and
  // stops at the hair. Cut with the same blur so the boundary stays soft.
  m.save();
  m.filter = `blur(${Math.max(2, MW * CFG.eyes.blur)}px)`;
  m.globalCompositeOperation = 'destination-out';
  // Fill the brow, then stroke the same path to dilate the cut past the hair —
  // the landmark polygon traces the brow tightly, and a bare fill leaves a rim
  // of colour sitting on its edge.
  m.lineJoin = 'round';
  m.lineCap = 'round';
  m.lineWidth = Math.max(3, MH * 0.022);
  for (const poly of [BROW_R, BROW_L]) {
    fillPoly(m, landmarks, poly, MW, MH);  // leaves the path current
    m.stroke();
  }
  m.restore();

  m.filter = 'none';
  return eyeMaskCv;
}

// Foundation mask: the face oval minus the eyes and lips (so they stay clean).
export function buildFaceMask(w, h, landmarks) {
  ensure(w, h);
  const m = faceMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  m.globalCompositeOperation = 'source-over';
  m.fillStyle = '#fff';
  m.filter = `blur(${Math.max(2, MW * CFG.face.blur)}px)`;
  fillPoly(m, landmarks, FACE_OVAL, MW, MH);
  m.filter = 'none';
  m.globalCompositeOperation = 'destination-out';
  fillPoly(m, landmarks, EYE_R_FULL, MW, MH);
  fillPoly(m, landmarks, EYE_L_FULL, MW, MH);
  fillPoly(m, landmarks, LIPS_OUTER, MW, MH);
  m.globalCompositeOperation = 'source-over';
  // Foundation is a base layer — it should cover the whole face (incl. nose &
  // brows), so it is intentionally NOT subject to feature protection.
  return faceMaskCv;
}

// Lash mask: a thin line along the upper lash line plus a few fine flicks at the
// outer corner — delicate, like real lashes (not a thick liner).
// Built at FULL resolution (LW×LH, not MW×MH) so lines stay crisp.
export function buildLashMask(w, h, landmarks) {
  ensure(w, h);
  const m = lashMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, LW, LH);
  m.lineCap = 'round';
  m.lineJoin = 'round';
  m.filter = 'none'; // crisp — no blur ever on lashes
  const thin = Math.max(1.0, LH * CFG.lashes.width);

  const [perspR, perspL] = eyePerspective(landmarks);

  for (const [lash, vref, persp] of [[EYE_R_LASH, EYE_R_V, perspR], [EYE_L_LASH, EYE_L_V, perspL]]) {
    const pts = lash.map((i) => [landmarks[i].x * LW, landmarks[i].y * LH]);
    const n2 = pts.length;
    const eyeH = Math.abs(landmarks[vref[0]].y - landmarks[vref[1]].y) * LH;
    // pts[0] = outer corner, pts[last] = inner corner
    const outerDir = Math.sign(pts[0][0] - pts[n2 - 1][0]) || 1;

    // Perspective tuck: gently pull inner points toward eye centre on the
    // foreshortened eye. Softer than eyeshadow/liner — lashes are thin strokes
    // and collapse visibly if pulled too hard.
    const tuck = Math.max(0, 1 - persp) * 1.2;   // stronger but still softer than eyeshadow
    if (tuck > 0.01) {
      const cx = (pts[0][0] + pts[n2 - 1][0]) / 2;
      const cy = (pts[0][1] + pts[n2 - 1][1]) / 2;
      for (let k = 0; k < n2; k++) {
        const t = k / (n2 - 1);
        const pull = t > 0.45 ? (t - 0.45) / 0.55 * tuck : 0;
        if (pull > 0) {
          pts[k][0] += (cx - pts[k][0]) * pull * 0.45;
          pts[k][1] += (cy - pts[k][1]) * pull * 0.28;
        }
      }
    }

    // 1. thin upper lash line — with inner-corner fade on far eye
    m.lineWidth = thin;
    if (tuck > 0.05) {
      // Draw segments with fading alpha near inner corner
      for (let k = 1; k < n2; k++) {
        const t = k / (n2 - 1); // 0 outer, 1 inner
        const fade = 1 - Math.max(0, (t - 0.55) / 0.45) * Math.min(1, tuck * 0.9);
        m.strokeStyle = `rgba(255,255,255,${fade.toFixed(3)})`;
        m.beginPath();
        m.moveTo(pts[k - 1][0], pts[k - 1][1]);
        m.lineTo(pts[k][0], pts[k][1]);
        m.stroke();
      }
    } else {
      m.strokeStyle = '#fff';
      m.beginPath();
      pts.forEach(([x, y], k) => (k === 0 ? m.moveTo(x, y) : m.lineTo(x, y)));
      m.stroke();
    }

    // 2. Natural lash flicks — clustered, with thickness/curl/length variation
    //    Real lashes grow in clusters of 2-4 from follicle groups, not evenly
    //    spaced. Each cluster fans slightly and individual lashes within it vary
    //    in length and curl. Longest at the outer third, tapering inward.
    const baseLen = eyeH * CFG.lashes.len;
    // arc-length sampler along the polyline (u: 0 = outer corner, 1 = inner)
    const seg = []; let total = 0;
    for (let k = 1; k < pts.length; k++) {
      const d = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      seg.push(d); total += d;
    }
    const at = (u) => {
      let d = u * total, k = 0;
      while (k < seg.length && d > seg[k]) { d -= seg[k]; k++; }
      if (k >= seg.length) return pts[pts.length - 1];
      const f = seg[k] ? d / seg[k] : 0;
      return [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f];
    };
    // Deterministic pseudo-random — stable across frames, no flicker
    const hash = (seed) => {
      let h = seed * 2654435761 >>> 0;
      h = ((h >>> 16) ^ h) * 45679 >>> 0;
      return (h & 0xffff) / 0xffff;  // 0..1
    };
    const baseCurl = CFG.lashes.curl ?? 0.25;
    // Perspective factor: far eye → inner flicks shorter & curl inward
    const perspShorten = Math.max(0.4, persp);
    const perspCurlFlip = Math.max(0, (1 - persp) * 0.6);

    // Generate clusters. Each cluster has 2-3 lashes fanning from one root zone.
    // ~11-13 clusters across the lash line, giving 28-38 individual lashes.
    const CLUSTERS = 12;
    const clusterSpacing = CFG.lashes.reachT / CLUSTERS;
    for (let ci = 0; ci < CLUSTERS; ci++) {
      const clusterU = (ci + 0.5) * clusterSpacing;
      if (clusterU > CFG.lashes.reachT) continue;
      // Number of lashes per cluster: 2-3, with outer clusters getting 3
      const clusterSize = ci < 4 ? 3 : (hash(ci * 97) > 0.5 ? 3 : 2);
      // Cluster spread: how far apart the roots are (narrower toward inner corner)
      const spreadFactor = (1 - clusterU / CFG.lashes.reachT) * 0.6 + 0.4;
      const clusterSpread = clusterSpacing * 0.35 * spreadFactor;

      for (let li = 0; li < clusterSize; li++) {
        // Each lash within the cluster is offset slightly from cluster centre
        const lashOffset = (li - (clusterSize - 1) / 2) * clusterSpread / clusterSize;
        const u = Math.max(0, Math.min(CFG.lashes.reachT, clusterU + lashOffset));
        const seed = ci * 31 + li * 7;

        // ── Length envelope ──
        // Bell-shaped: peaks at u≈0.2 (outer third), not at u=0
        const bellPeak = 0.18;
        const bellWidth = 0.55;
        const bellDist = (u - bellPeak) / bellWidth;
        const envelope = Math.exp(-bellDist * bellDist * 2.5);
        // Minimum: inner corner still gets short lashes (not zero)
        const envClamp = 0.25 + envelope * 0.75;
        // Per-lash length jitter ±20%, deterministic
        const lenJitter = 0.80 + 0.40 * hash(seed + 1);
        // Perspective: inner flicks on far eye scale down
        const innerPerspScale = 1 - (1 - perspShorten) * u;
        const lashLen = baseLen * envClamp * lenJitter * innerPerspScale;
        // Very short lashes are invisible noise — skip
        if (lashLen < 1.2) continue;

        // ── Thickness variation ──
        // Outer lashes thicker, inner thinner; variation within cluster
        const thickEnv = 0.55 + 0.45 * (1 - u / CFG.lashes.reachT);
        const thickJitter = 0.75 + 0.50 * hash(seed + 2);
        m.lineWidth = Math.max(0.6, thin * 0.65 * thickEnv * thickJitter);

        // ── Curl variation ──
        // Each lash curls differently: outer lashes curl more, centres medium,
        // inner lashes flatter. ±30% random variation on top.
        const curlPos = baseCurl * (0.8 + 0.4 * (1 - u / CFG.lashes.reachT));
        const curlJitter = 0.70 + 0.60 * hash(seed + 3);
        const curl = curlPos * curlJitter;

        // ── Angular fan ──
        // Lashes fan outward from centre: outer lashes lean outward,
        // inner lashes lean slightly inward, creating a natural fan shape
        const fanAngle = (0.5 - u / CFG.lashes.reachT) * 0.35;  // radians

        const [x, y] = at(u);
        // Perspective curl flip on far eye
        const flipAmount = perspCurlFlip * u;
        const effectiveOuterDir = outerDir * (1 - flipAmount * 2);

        // Inner-corner fade
        const fadeFactor = tuck > 0.05
          ? 1 - Math.max(0, (u - 0.55) / 0.45) * Math.min(1, tuck * 0.9)
          : 1;
        if (fadeFactor < 0.02) continue;

        // ── Bezier lash stroke ──
        // tip: curled outward/upward with fan angle applied
        const baseAngle = -Math.PI / 2;  // straight up
        const lashAngle = baseAngle + fanAngle;
        const tipX = x + Math.cos(lashAngle) * lashLen + effectiveOuterDir * lashLen * curl * 0.45;
        const tipY = y + Math.sin(lashAngle) * lashLen;
        // control point: creates the curl arc — offset outward from the line
        const ctrlT = 0.45 + curl * 0.15;  // how far up the control sits
        const ctrlX = x + Math.cos(lashAngle) * lashLen * ctrlT + effectiveOuterDir * lashLen * curl * 0.25;
        const ctrlY = y + Math.sin(lashAngle) * lashLen * (0.5 + curl * 0.3);

        m.strokeStyle = `rgba(255,255,255,${fadeFactor.toFixed(3)})`;
        m.beginPath();
        m.moveTo(x, y);
        m.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
        m.stroke();
      }
    }
  }
  // Protect: cut nose region so lashes don't bleed onto the bridge at profile angles
  if (PROTECT) {
    m.save();
    m.filter = 'none';
    m.globalCompositeOperation = 'destination-out';
    fillPoly(m, landmarks, NOSE, LW, LH);
    m.restore();
  }
  return lashMaskCv;
}

// Blush mask: a diffused flush swept from high on the cheekbone up toward the
// temple (not a round patch), symmetric on both sides. The sweep is an elongated,
// feathered ellipse oriented along cheek-apple -> outer-eye corner.
export function buildBlushMask(w, h, landmarks) {
  ensure(w, h);
  const m = blushMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  const blushBlur = Math.max(2, MW * CFG.blush.blur);
  m.filter = `blur(${blushBlur}px)`; // diffuse edges
  const faceW = Math.abs(landmarks[FACE_SIDE_R].x - landmarks[FACE_SIDE_L].x) * MW;
  const half = Math.max(1, faceW * CFG.blush.half);   // sweep length (semi-major)
  const width = Math.max(1, faceW * CFG.blush.width); // sweep width  (semi-minor)

  // right eye outer 33, left eye outer 263 → direction "up and out" toward the temple
  const cfg = CFG.blush;
  for (const [ci, outer] of [[CHEEK_R, 33], [CHEEK_L, 263]]) {
    const cx = landmarks[ci].x * MW, cy = landmarks[ci].y * MH;
    const ox = landmarks[outer].x * MW, oy = landmarks[outer].y * MH;
    const ang = Math.atan2(oy - cy, ox - cx);
    const bx = cx + Math.cos(ang) * half * 0.35;
    const by = cy + Math.sin(ang) * half * 0.35 - width * 0.18;

    // 1. Wide diffuse halo — the outer glow that blends into skin
    //    Smoother 5-stop gradient for invisible edge falloff
    m.save();
    m.translate(bx, by);
    m.rotate(ang);
    m.scale(half * cfg.haloRatio / (width * cfg.haloRatio), 1);
    const hr = width * cfg.haloRatio;
    const halo = m.createRadialGradient(0, 0, 0, 0, 0, hr);
    halo.addColorStop(0,    `rgba(255,255,255,${cfg.haloAlpha})`);
    halo.addColorStop(0.30, `rgba(255,255,255,${cfg.haloAlpha * 0.65})`);
    halo.addColorStop(0.55, `rgba(255,255,255,${cfg.haloAlpha * 0.30})`);
    halo.addColorStop(0.80, `rgba(255,255,255,${cfg.haloAlpha * 0.08})`);
    halo.addColorStop(1,    'rgba(255,255,255,0)');
    m.fillStyle = halo;
    m.beginPath(); m.arc(0, 0, hr, 0, Math.PI * 2); m.fill();
    m.restore();

    // 2. Tight pigment core — where the brush deposited most colour
    //    Smoother 6-stop gradient mimics powder deposition
    m.save();
    m.translate(bx, by);
    m.rotate(ang);
    m.scale(half / width, 1);
    const core = m.createRadialGradient(0, 0, 0, 0, 0, width);
    core.addColorStop(0,    `rgba(255,255,255,${cfg.coreAlpha})`);
    core.addColorStop(0.25, `rgba(255,255,255,${cfg.coreAlpha * 0.80})`);
    core.addColorStop(0.45, `rgba(255,255,255,${cfg.coreAlpha * 0.50})`);
    core.addColorStop(0.65, `rgba(255,255,255,${cfg.coreAlpha * 0.22})`);
    core.addColorStop(0.85, `rgba(255,255,255,${cfg.coreAlpha * 0.06})`);
    core.addColorStop(1,    'rgba(255,255,255,0)');
    m.fillStyle = core;
    m.beginPath(); m.arc(0, 0, width, 0, Math.PI * 2); m.fill();
    m.restore();
  }
  m.filter = 'none';

  // Second softer blur pass — eliminates any banding from the gradient stops.
  // Copy → clear → re-draw blurred. This costs ~0.3ms but dissolves edges.
  const r = refineCv.getContext('2d');
  r.setTransform(1, 0, 0, 1, 0, 0);
  r.clearRect(0, 0, MW, MH);
  r.filter = `blur(${Math.max(1, blushBlur * 0.6)}px)`;
  r.drawImage(blushMaskCv, 0, 0, MW, MH);
  r.filter = 'none';
  m.clearRect(0, 0, MW, MH);
  m.drawImage(refineCv, 0, 0, MW, MH);
  cutFeatures(m, landmarks);
  return blushMaskCv;
}

// Contour: a thin cool streak that FOLLOWS the cheekbone — a feathered stroke
// along a curve through real landmarks (ear → cheekbone → mouth corner), not a
// blob. Bends with the face and head pose. Tune via CFG.contour.
export function buildContourMask(w, h, landmarks) {
  ensure(w, h);
  const m = contourMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  m.lineCap = 'round';
  m.lineJoin = 'round';
  const contourBlur = Math.max(3, MW * CFG.contour.blur);
  m.filter = `blur(${contourBlur}px)`;
  const faceW = Math.abs(landmarks[FACE_SIDE_R].x - landmarks[FACE_SIDE_L].x) * MW;
  const drop = faceW * CFG.contour.drop;
  const base = faceW * CFG.contour.width;
  const P = (i) => [landmarks[i].x * MW, landmarks[i].y * MH];
  // subject-right: ear 234, cheekbone 205, mouth corner 61; left: 454, 425, 291
  for (const [ear, cheek, mouth] of [[FACE_SIDE_L, CHEEK_R, 61], [FACE_SIDE_R, CHEEK_L, 291]]) {
    const e = P(ear), c = P(cheek), mo = P(mouth);
    // start high near the ear, end above the mouth corner, both pulled toward the cheekbone;
    // control = cheekbone pushed down so the streak sits in the hollow under the bone.
    const S = [e[0] * 0.55 + c[0] * 0.45, e[1] * 0.55 + c[1] * 0.45];
    const E = [mo[0] * 0.45 + c[0] * 0.55, mo[1] * 0.4 + c[1] * 0.6];
    const C = [c[0], c[1] + drop];
    m.beginPath();
    m.moveTo(S[0], S[1]);
    m.quadraticCurveTo(C[0], C[1], E[0], E[1]);
    // wide faint halo, then the brighter core — feathered falloff
    m.lineWidth = base * CFG.contour.wide;
    m.strokeStyle = `rgba(255,255,255,${CFG.contour.edge})`;
    m.stroke();
    m.lineWidth = base;
    m.strokeStyle = `rgba(255,255,255,${CFG.contour.core})`;
    m.stroke();
  }
  m.filter = 'none';

  // Second blur pass — smooth any stroke aliasing for seamless skin blend
  const rc = refineCv.getContext('2d');
  rc.setTransform(1, 0, 0, 1, 0, 0);
  rc.clearRect(0, 0, MW, MH);
  rc.filter = `blur(${Math.max(1, contourBlur * 0.5)}px)`;
  rc.drawImage(contourMaskCv, 0, 0, MW, MH);
  rc.filter = 'none';
  m.clearRect(0, 0, MW, MH);
  m.drawImage(refineCv, 0, 0, MW, MH);

  cutFeatures(m, landmarks);
  return contourMaskCv;
}

// Highlight: a face-wide mask (same oval as foundation) stored in the Green channel
// of the sculpt pack. The shader applies it only where the pixel is already bright
// (per-pixel luminance gate) — so it automatically follows where light is hitting
// the face. No landmark-based stroke needed; the light detector does the work.
export function buildHighlightMask(w, h, landmarks) {
  ensure(w, h);
  const m = highlightMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  // Fill the face oval with a radial gradient that's brightest in the centre
  // and fades toward the hairline / jaw — gives a natural 3-D roundness to the glow.
  const cx = landmarks[1].x * MW;  // nose tip ≈ face centre x
  const cy = landmarks[1].y * MH;
  const faceW = Math.abs(landmarks[FACE_SIDE_R].x - landmarks[FACE_SIDE_L].x) * MW;
  const faceH = faceW * 1.3; // approximate face height
  m.save();
  m.scale(1, faceH / faceW); // stretch to oval
  const g = m.createRadialGradient(cx, cy * (faceW / faceH), 0, cx, cy * (faceW / faceH), faceW * 0.62);
  g.addColorStop(0,   'rgba(255,255,255,1.0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.7)');
  g.addColorStop(0.85,'rgba(255,255,255,0.2)');
  g.addColorStop(1,   'rgba(255,255,255,0)');
  m.fillStyle = g;
  m.beginPath();
  m.ellipse(cx, cy * (faceW / faceH), faceW * 0.62, faceW * 0.62, 0, 0, Math.PI * 2);
  m.fill();
  m.restore();
  m.filter = `blur(${Math.max(3, MW * CFG.highlight.blur)}px)`;
  // re-apply blur by drawing to itself (filter on the context above already applied to fill)
  // Actually set filter before drawing:
  m.filter = 'none';
  // Redo with blur upfront
  m.clearRect(0, 0, MW, MH);
  m.filter = `blur(${Math.max(3, MW * CFG.highlight.blur)}px)`;
  m.save();
  m.scale(1, faceH / faceW);
  m.fillStyle = g;
  m.beginPath();
  m.ellipse(cx, cy * (faceW / faceH), faceW * 0.62, faceW * 0.62, 0, 0, Math.PI * 2);
  m.fill();
  m.restore();
  m.filter = 'none';
  // Highlight covers the nose — it's a face-wide glow, nose bridge catches light too.
  // Only cut eyes/lips/brows (not NOSE) so the bridge still glows naturally.
  if (PROTECT) {
    m.save();
    m.filter = 'none';
    m.globalCompositeOperation = 'destination-out';
    for (const poly of [EYE_R_FULL, EYE_L_FULL, LIPS_OUTER, BROW_R, BROW_L]) fillPoly(m, landmarks, poly, MW, MH);
    m.restore();
  }
  return highlightMaskCv;
}

// Under-eye: a soft brighten band that FOLLOWS the lower lid (inner → centre →
// outer), dropped slightly into the dark-circle area. Tune via CFG.underEye.
export function buildUnderEyeMask(w, h, landmarks) {
  ensure(w, h);
  const m = underEyeMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  m.lineJoin = 'round';
  m.filter = `blur(${Math.max(3, MW * CFG.underEye.blur)}px)`;
  const faceW = Math.abs(landmarks[FACE_SIDE_R].x - landmarks[FACE_SIDE_L].x) * MW;
  const cfg = CFG.underEye;
  const drop = faceW * cfg.drop;
  const P = (i) => [landmarks[i].x * MW, landmarks[i].y * MH + drop]; // dropped under the lid
  const sp = cfg.spread;
  // lower-lid inner / centre / outer: right 133,145,33 ; left 362,374,263
  for (const [inner, low, outer] of [[133, 145, 33], [362, 374, 263]]) {
    const I = P(inner), L = P(low), O = P(outer);
    // top corners extended OUTWARD from the lid centre → longer on both sides
    const extend = (p) => [p[0] + (p[0] - L[0]) * sp, p[1] + (p[1] - L[1]) * sp];
    const a = extend(I), c = extend(O);
    // tip: down onto the cheek, nudged toward the nose (inner − outer direction)
    const apex = [L[0] + (I[0] - O[0]) * cfg.apexIn, L[1] + faceW * cfg.apexDrop];
    // vertical gradient: bright under the lid, fading toward the tip
    const g = m.createLinearGradient(L[0], L[1], apex[0], apex[1]);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, `rgba(255,255,255,${cfg.fade})`);
    m.fillStyle = g;
    // top edge curves along the lid (a→L→c), then down to the tip and back
    m.beginPath();
    m.moveTo(a[0], a[1]);
    m.quadraticCurveTo(L[0], L[1], c[0], c[1]);
    m.quadraticCurveTo((c[0] + apex[0]) / 2, (c[1] + apex[1]) / 2, apex[0], apex[1]);
    m.quadraticCurveTo((a[0] + apex[0]) / 2, (a[1] + apex[1]) / 2, a[0], a[1]);
    m.closePath();
    m.fill();
  }
  m.filter = 'none';
  cutFeatures(m, landmarks);
  return underEyeMaskCv;
}

// Lip liner: a ring strictly INSIDE the lip contour — crisp outer edge (no blur),
// very slight inner softness. Achieved by stroking at 2× width then clipping to
// the lip fill, so the outer half of the stroke is cut away → inner ring only.
export function buildLipLinerMask(w, h, landmarks) {
  ensure(w, h);
  const m = lipLinerMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  m.filter = 'none'; // crisp outer edge — no blur

  // Clip to a slightly inset lip shape — the Catmull-Rom spline on the inset
  // stroke path can overshoot at mouth corners; a 1-2px safety margin on the
  // clip ensures nothing pokes out past the actual lip contour.
  m.save();
  const clipPts = LIPS_OUTER.map((i) => [landmarks[i].x * MW, landmarks[i].y * MH]);
  let clipCx = 0, clipCy = 0;
  for (const [x, y] of clipPts) { clipCx += x; clipCy += y; }
  clipCx /= clipPts.length; clipCy /= clipPts.length;
  const clipShrink = 0.035; // ~3.5% inset — tighter to the lip edge
  const clipInset = clipPts.map(([x, y]) => [
    x + (clipCx - x) * clipShrink,
    y + (clipCy - y) * clipShrink,
  ]);
  traceSmooth(m, clipInset);
  m.clip();

  const lineW = Math.max(2, MW * CFG.lipLiner.width);

  // Build the path the liner actually follows. Two adjustments to the raw lip
  // boundary, both of which is what a hand would do:
  //
  //  1. The whole ring is inset by half the stroke width, so the line sits
  //     just INSIDE the lip edge at a constant thickness, instead of straddling
  //     the boundary and being half eaten by the clip.
  //  2. The lower-lip run is lifted further, toward the mouth line. Liner on
  //     the bottom lip is drawn inside the natural edge, never along it.
  const pts = LIPS_OUTER.map((i) => [landmarks[i].x * MW, landmarks[i].y * MH]);
  const n = pts.length;

  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= n; cy /= n;

  // "Up" for the mouth: bottom-lip centre -> top-lip centre. Taken from the
  // face, so the lift follows a tilted head.
  let upX = (landmarks[0].x - landmarks[17].x) * MW;
  let upY = (landmarks[0].y - landmarks[17].y) * MH;
  const lipH = Math.hypot(upX, upY) || 1;
  upX /= lipH; upY /= lipH;
  const lift = lipH * CFG.lipLiner.lowerLift;

  // LIPS_OUTER runs upper-left -> upper-right (0..10), then lower-right ->
  // lower-left (11..19). Only that second run is lifted, fading to nothing at
  // the mouth corners so the ring stays a continuous closed curve.
  const LOWER_FROM = 11, LOWER_TO = n - 1;
  const adj = pts.map(([x, y], i) => {
    let dx = cx - x, dy = cy - y;
    const d = Math.hypot(dx, dy) || 1;
    let px = x + (dx / d) * (lineW * 0.75);
    let py = y + (dy / d) * (lineW * 0.75);
    if (i >= LOWER_FROM && i <= LOWER_TO) {
      const t = (i - (LOWER_FROM - 1)) / (LOWER_TO + 1 - (LOWER_FROM - 1));
      const taper = Math.sin(Math.PI * t);   // 0 at both corners, 1 at centre
      px += upX * lift * taper;
      py += upY * lift * taper;
    }
    return [px, py];
  });

  m.strokeStyle = '#fff';
  m.lineJoin = 'round';
  m.lineCap = 'round';
  m.lineWidth = lineW;
  traceSmooth(m, adj);
  m.stroke();

  m.restore();
  return lipLinerMaskCv;
}

// Eyeliner: a line along the upper lash line with a small outer wing.
export function buildEyelinerMask(w, h, landmarks) {
  ensure(w, h);
  const m = eyelinerMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  m.lineCap = 'round';
  m.lineJoin = 'round';
  m.lineWidth = Math.max(1, MH * CFG.eyeliner.width);
  m.filter = `blur(${Math.max(0.5, MW * CFG.eyeliner.blur)}px)`;
  const [perspR, perspL] = eyePerspective(landmarks);
  for (const [lash, vref, persp] of [[EYE_R_LASH, EYE_R_V, perspR], [EYE_L_LASH, EYE_L_V, perspL]]) {
    m.strokeStyle = '#fff';
    const pts = lash.map((i) => [landmarks[i].x * MW, landmarks[i].y * MH]);
    const n = pts.length;
    const eyeH = Math.abs(landmarks[vref[0]].y - landmarks[vref[1]].y) * MH;
    const baseW = Math.max(1, MH * CFG.eyeliner.width);

    // ── Perspective tuck: pull inner-corner points toward eye centre ──
    const tuck = Math.max(0, 1 - persp) * 2.0;  // matches eyeshadow strength
    if (tuck > 0.01) {
      const cx = (pts[0][0] + pts[n - 1][0]) / 2;
      const cy = (pts[0][1] + pts[n - 1][1]) / 2;
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1); // 0 at outer, 1 at inner
        const pull = t > 0.35 ? (t - 0.35) / 0.65 * tuck : 0;
        if (pull > 0) {
          pts[k][0] += (cx - pts[k][0]) * pull * 0.65;
          pts[k][1] += (cy - pts[k][1]) * pull * 0.4;
        }
      }
    }

    if (CFG.eyeliner.taper) {
      // Draw each segment individually with varying thickness — thin at inner, thick at outer
      for (let k = 1; k < n; k++) {
        const t = 1 - (k - 1) / (n - 1); // 1 at outer corner, 0 at inner
        const segW = baseW * (0.35 + t * 0.65); // taper from 35% to 100%
        m.lineWidth = segW;
        m.beginPath();
        m.moveTo(pts[k - 1][0], pts[k - 1][1]);
        m.lineTo(pts[k][0], pts[k][1]);
        m.stroke();
      }
    } else {
      m.lineWidth = baseW;
      m.beginPath();
      pts.forEach(([x, y], k) => (k === 0 ? m.moveTo(x, y) : m.lineTo(x, y)));
      m.stroke();
    }

    // Wing: a flick that continues the eye OUTWARD, lifting only a little.
    //
    // Built in the eye's own frame, not the screen's. Offsetting by screen x/y
    // made the wing shoot up at ~40 degrees and, worse, kept pointing at the
    // top of the screen when the head tilted. The two axes below come from the
    // face itself, so the flick stays glued to the eye at any head angle:
    //   ax = inner corner -> outer corner (the direction a wing travels)
    //   ux = lower lid -> upper lid       (which way is "up" for this eye)
    const wl = eyeH * CFG.eyeliner.wing;
    const inner = pts[n - 1], outer = pts[0];
    let axX = outer[0] - inner[0], axY = outer[1] - inner[1];
    const axLen = Math.hypot(axX, axY) || 1;
    axX /= axLen; axY /= axLen;

    let upX = (landmarks[vref[0]].x - landmarks[vref[1]].x) * MW;
    let upY = (landmarks[vref[0]].y - landmarks[vref[1]].y) * MH;
    const upLen = Math.hypot(upX, upY) || 1;
    upX /= upLen; upY /= upLen;

    // Wing scales down on the foreshortened eye — perspective compresses it
    const perspScale = Math.max(0.3, persp);
    const reach = wl * CFG.eyeliner.wingReach * perspScale;
    const lift = wl * CFG.eyeliner.wingLift * perspScale;
    const wx = outer[0], wy = outer[1];
    const tipX = wx + axX * reach + upX * lift;
    const tipY = wy + axY * reach + upY * lift;
    // Control point sits most of the way along the axis with barely any lift,
    // so the flick leaves the lash line flat and curves up only at its end.
    const ctrlX = wx + axX * reach * 0.55 + upX * lift * 0.10;
    const ctrlY = wy + axY * reach * 0.55 + upY * lift * 0.10;

    m.lineWidth = baseW;
    m.beginPath();
    m.moveTo(wx, wy);
    m.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
    m.stroke();

    // ── Inner-corner fade on far eye ──
    if (tuck > 0.05) {
      const fadeStr = Math.min(1, tuck * 0.8);
      const innerPt = pts[n - 1], outerPt = pts[0];
      const fadeEnd = [
        innerPt[0] + (outerPt[0] - innerPt[0]) * 0.35,
        innerPt[1] + (outerPt[1] - innerPt[1]) * 0.35,
      ];
      const fg = m.createLinearGradient(innerPt[0], innerPt[1], fadeEnd[0], fadeEnd[1]);
      fg.addColorStop(0, `rgba(0,0,0,${fadeStr})`);
      fg.addColorStop(1, 'rgba(0,0,0,0)');
      m.globalCompositeOperation = 'destination-out';
      m.fillStyle = fg;
      // Cover the eye region generously — the gradient does the precision work
      const r = Math.hypot(outerPt[0] - innerPt[0], outerPt[1] - innerPt[1]) * 0.6;
      m.fillRect(innerPt[0] - r, innerPt[1] - r, r * 2, r * 2);
      m.globalCompositeOperation = 'source-over';
    }
  }
  m.filter = 'none';
  return eyelinerMaskCv;
}

// Brows: filled brow shapes (tint / fill), feathered.
export function buildBrowMask(w, h, landmarks) {
  ensure(w, h);
  const m = browMaskCv.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, MW, MH);
  m.fillStyle = '#fff';
  m.filter = `blur(${Math.max(1, MW * CFG.brows.blur)}px)`;
  fillPoly(m, landmarks, BROW_R, MW, MH);
  fillPoly(m, landmarks, BROW_L, MW, MH);
  m.filter = 'none';
  return browMaskCv;
}

// Shared compositor: recolour whatever `maskSrc` covers, preserving the region's
// own luminance/texture ('color' blend). Used by both lips and eyeshadow.
// opts: { color, intensity, finish?, lightResponse?, pigment?, gloss? }
function compositeRegion(ctx, w, h, maskSrc, opts) {
  const { color, intensity } = opts;
  const finish = opts.finish ?? 'satin';
  const lightResponse = opts.lightResponse ?? 0.5;
  const pigment = opts.pigment ?? 0.12;

  if (lightResponse > 0) {
    const lum = lumaCv.getContext('2d');
    lum.setTransform(1, 0, 0, 1, 0, 0);
    lum.clearRect(0, 0, w, h);
    lum.filter = 'grayscale(1) contrast(1.25)';
    lum.drawImage(ctx.canvas, 0, 0, w, h);
    lum.filter = 'none';
  }

  // shade shaped by the mask
  const c = colorCv.getContext('2d');
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, w, h);
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(maskSrc, 0, 0, w, h);
  c.globalCompositeOperation = 'source-over';

  ctx.save();
  ctx.globalAlpha = intensity;
  ctx.globalCompositeOperation = 'color';
  ctx.drawImage(colorCv, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = intensity * pigment;
  ctx.drawImage(colorCv, 0, 0);
  if (finish === 'satin') {
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = intensity * 0.5;
    ctx.drawImage(colorCv, 0, 0);
  }
  ctx.restore();

  if (lightResponse > 0) {
    const lum = lumaCv.getContext('2d');
    lum.globalCompositeOperation = 'destination-in';
    lum.drawImage(maskSrc, 0, 0, w, h);
    lum.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = lightResponse;
    ctx.drawImage(lumaCv, 0, 0, w, h);
    ctx.restore();
  }
}

/**
 * Recolour the lips in-place on `ctx` (which already holds the current frame).
 * opts: { color, intensity, finish:'matte'|'satin'|'gloss', lightResponse?, overrideMask? }
 */
export function renderLips(ctx, w, h, landmarks, opts) {
  if (!landmarks || landmarks.length < 468) return;
  ensure(w, h);
  buildLipMask(w, h, landmarks, opts);
  compositeRegion(ctx, w, h, maskCv, opts);

  // gloss: specular highlight on the lower lip, clipped to the mask
  if (opts.finish === 'gloss') {
    let sx = 0, sy = 0, n = 0;
    for (const i of LOWER_LIP) { sx += landmarks[i].x; sy += landmarks[i].y; n++; }
    const cx = (sx / n) * w, cy = (sy / n) * h - h * 0.012;
    const r = w * 0.05;
    const s = specCv.getContext('2d');
    s.clearRect(0, 0, w, h);
    const g = s.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    s.fillStyle = g; s.fillRect(0, 0, w, h);
    s.globalCompositeOperation = 'destination-in';
    s.drawImage(maskCv, 0, 0, w, h);
    s.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.75;
    ctx.drawImage(specCv, 0, 0);
    ctx.restore();
  }
}

/** Recolour the eyelids (eyeshadow). opts: { color, intensity, lightResponse? } */
export function renderEyes(ctx, w, h, landmarks, opts) {
  if (!landmarks || landmarks.length < 468) return;
  ensure(w, h);
  buildEyeMask(w, h, landmarks);
  compositeRegion(ctx, w, h, eyeMaskCv, { ...opts, finish: 'satin', pigment: 0.2 });
}

// Darkening composite for lashes: paint a dark colour along the mask (not a
// luminance-preserving recolour — lashes should get darker, not tinted).
function compositeDark(ctx, w, h, maskSrc, color, intensity) {
  const c = colorCv.getContext('2d');
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, w, h);
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(maskSrc, 0, 0, w, h);
  c.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalAlpha = intensity;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(colorCv, 0, 0);
  ctx.restore();
}

// Lightening composite (highlight / under-eye brighten) — 'screen' with a warm white.
function compositeLight(ctx, w, h, maskSrc, color, intensity) {
  const c = colorCv.getContext('2d');
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, w, h);
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(maskSrc, 0, 0, w, h);
  c.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalAlpha = intensity;
  ctx.globalCompositeOperation = 'screen';
  ctx.drawImage(colorCv, 0, 0);
  ctx.restore();
}

/**
 * Frequency-separation foundation: colour-correct the low-frequency (tone/hue)
 * while preserving the high-frequency detail (pores, freckles, fine lines).
 *
 * 1. Blur the face region → low-freq
 * 2. Subtract: original − blurred = high-freq (skin texture)
 * 3. Tint the low-freq with foundation colour (via 'color' blend)
 * 4. Recombine: tinted low-freq + high-freq
 * 5. Composite through the face mask at the requested intensity
 *
 * The result looks like real foundation: the skin tone shifts but every pore,
 * scar and freckle remains intact, not smeared or airbrushed.
 */
function compositeFoundation(ctx, w, h, maskSrc, opts) {
  const { color, intensity } = opts;
  const finish = opts.finish ?? 'natural';

  // Blur radius: roughly 1.5% of face width — large enough to capture tone,
  // small enough to not bleed across face boundaries.
  const blurPx = Math.max(3, Math.round(w * 0.015));

  const lo = freqLoCv.getContext('2d');
  const hi = freqHiCv.getContext('2d');

  // Step 1: blurred version of the face → low frequency
  lo.setTransform(1, 0, 0, 1, 0, 0);
  lo.filter = `blur(${blurPx}px)`;
  lo.drawImage(ctx.canvas, 0, 0, w, h);
  lo.filter = 'none';

  // Step 2: high-freq = original − low.  Canvas can't subtract directly, but
  // we can approximate with two complementary soft-light passes. The approach:
  // draw the original on hi, then use 'difference' with the blurred version.
  // This gives us an unsigned difference — add it back later as 'overlay'.
  hi.setTransform(1, 0, 0, 1, 0, 0);
  hi.clearRect(0, 0, w, h);
  hi.drawImage(ctx.canvas, 0, 0, w, h);
  hi.globalCompositeOperation = 'difference';
  hi.drawImage(freqLoCv, 0, 0, w, h);
  hi.globalCompositeOperation = 'source-over';

  // Step 3: tint the low-freq with the foundation colour (shift skin tone)
  lo.globalCompositeOperation = 'color';
  lo.globalAlpha = Math.min(1.0, intensity * 1.2);
  lo.fillStyle = color;
  lo.fillRect(0, 0, w, h);
  lo.globalAlpha = 1;
  lo.globalCompositeOperation = 'source-over';

  // Finish adjustments on low-freq
  if (finish === 'matte') {
    // Matte: slightly desaturate highlights → flatten shine
    lo.globalCompositeOperation = 'saturation';
    lo.globalAlpha = 0.15;
    lo.fillStyle = '#888';
    lo.fillRect(0, 0, w, h);
    lo.globalAlpha = 1;
    lo.globalCompositeOperation = 'source-over';
  } else if (finish === 'dewy') {
    // Dewy: boost luminance slightly → subtle glow
    lo.globalCompositeOperation = 'screen';
    lo.globalAlpha = 0.06;
    lo.fillStyle = '#fff';
    lo.fillRect(0, 0, w, h);
    lo.globalAlpha = 1;
    lo.globalCompositeOperation = 'source-over';
  }

  // Step 4: mask the tinted low-freq to face area only
  lo.globalCompositeOperation = 'destination-in';
  lo.drawImage(maskSrc, 0, 0, w, h);
  lo.globalCompositeOperation = 'source-over';

  // Step 5: composite onto frame.
  // a) Replace skin tone with tinted version within the mask
  ctx.save();
  ctx.globalAlpha = intensity;
  ctx.globalCompositeOperation = 'color';
  ctx.drawImage(freqLoCv, 0, 0);

  // b) Add a subtle pigment layer (multiply) for coverage depth
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = intensity * 0.08;
  ctx.drawImage(freqLoCv, 0, 0);
  ctx.restore();

  // Step 6: restore high-frequency texture on top.
  // Mask the texture to the face mask so we only boost skin-area detail.
  hi.globalCompositeOperation = 'destination-in';
  hi.drawImage(maskSrc, 0, 0, w, h);
  hi.globalCompositeOperation = 'source-over';

  // 'overlay' recombines the detail: dark pores darken, light freckles lighten —
  // the texture snaps back onto the tinted base.
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 1.6; // > 1 clamped to 1 by spec, but some impl allow boost; fallback fine
  ctx.drawImage(freqHiCv, 0, 0);
  ctx.restore();

  // A final soft-light pass of the high-freq at reduced alpha gives extra
  // texture recovery without blowing contrast (pores stay visible but subtle).
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = 0.5;
  ctx.drawImage(freqHiCv, 0, 0);
  ctx.restore();
}

/**
 * Full makeup pass (Canvas). True MUA order — each product goes on in the
 * sequence it would at a counter, because what sits under what changes the
 * result: base (foundation → concealer), sculpt (contour → blush → highlight),
 * eyes (brows → shadow → liner → mascara), lips (liner → lipstick).
 * Each region optional.
 */
export function renderMakeup(ctx, w, h, landmarks, opts) {
  if (!landmarks || landmarks.length < 468) return;
  if (opts.foundation) {
    buildFaceMask(w, h, landmarks);
    compositeFoundation(ctx, w, h, faceMaskCv, opts.foundation);
  }
  if (opts.underEye) {
    buildUnderEyeMask(w, h, landmarks);
    compositeLight(ctx, w, h, underEyeMaskCv, '#F2E2D2', opts.underEye.intensity ?? 0.4);
  }
  if (opts.contour) {
    buildContourMask(w, h, landmarks);
    compositeDark(ctx, w, h, contourMaskCv, '#6B5548', opts.contour.intensity ?? 0.35);
  }
  if (opts.blush) {
    buildBlushMask(w, h, landmarks);
    compositeRegion(ctx, w, h, blushMaskCv, { ...opts.blush, finish: 'none', pigment: 0.15 });
  }
  if (opts.highlight) {
    buildHighlightMask(w, h, landmarks);
    compositeLight(ctx, w, h, highlightMaskCv, '#F5ECD6', opts.highlight.intensity ?? 0.5);
  }
  if (opts.hair && opts.hair.mask) {
    compositeRegion(ctx, w, h, opts.hair.mask, { ...opts.hair, finish: 'none', pigment: 0.15 });
  }
  if (opts.brows) {
    buildBrowMask(w, h, landmarks);
    compositeRegion(ctx, w, h, browMaskCv, { ...opts.brows, finish: 'none', pigment: 0.2, lightResponse: 0 });
  }
  if (opts.eyes) renderEyes(ctx, w, h, landmarks, opts.eyes);
  if (opts.eyeliner) {
    buildEyelinerMask(w, h, landmarks);
    compositeDark(ctx, w, h, eyelinerMaskCv, opts.eyeliner.color || '#0a0a0a', opts.eyeliner.intensity ?? 0.9);
  }
  if (opts.lashes) {
    // Lashes are thin strokes — even small landmark lag is visible as floating
    // lashes during a sharp head jerk. Fade them out when motion is high;
    // perspective tuck inside buildLashMask is untouched.
    const lashMotion = opts.motion ?? 0;
    const LASH_FADE_START = 0.003;  // begin fading
    const LASH_FADE_END   = 0.008;  // fully hidden
    const lashFade = lashMotion <= LASH_FADE_START ? 1
      : lashMotion >= LASH_FADE_END ? 0
      : 1 - (lashMotion - LASH_FADE_START) / (LASH_FADE_END - LASH_FADE_START);
    if (lashFade > 0.01) {
      buildLashMask(w, h, landmarks);
      compositeDark(ctx, w, h, lashMaskCv, '#000000', (opts.lashes.intensity ?? 0.8) * lashFade);
    }
  }
  // Lip liner goes DOWN FIRST, lipstick over it — that's the actual sequence.
  // The lipstick then covers it by its own alpha, so the liner survives mostly
  // at the lip edge (where the colour is thinnest) exactly as it does on a face.
  if (opts.lipLiner) {
    buildLipLinerMask(w, h, landmarks);
    compositeRegion(ctx, w, h, lipLinerMaskCv, { ...opts.lipLiner, finish: 'none', pigment: 0.25 });
  }
  if (opts.lips) renderLips(ctx, w, h, landmarks, opts.lips);
}

// ---- Debug overlay: tint the ONNX segmentation mask so you can see what it predicts ----
let dbgCv;
export function drawSegMask(ctx, w, h, mask, alpha = 0.5) {
  if (!mask) return;
  if (!dbgCv) dbgCv = document.createElement('canvas');
  if (dbgCv.width !== w || dbgCv.height !== h) { dbgCv.width = w; dbgCv.height = h; }
  const t = dbgCv.getContext('2d');
  t.clearRect(0, 0, w, h);
  t.drawImage(mask, 0, 0, w, h);      // white where lips, alpha = confidence
  t.globalCompositeOperation = 'source-in';
  t.fillStyle = '#00e5a0';            // recolour the mask green
  t.fillRect(0, 0, w, h);
  t.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(dbgCv, 0, 0, w, h);
  ctx.restore();
}

// ---- Debug overlay: draw the raw MediaPipe landmarks so you can see tracking ----
const LIP_SET = new Set([...LIPS_OUTER, ...LIPS_INNER]);

export function drawLandmarks(ctx, w, h, landmarks) {
  if (!landmarks) return;
  ctx.save();
  // all mesh points (faint)
  ctx.fillStyle = 'rgba(110,210,255,0.5)';
  const sz = Math.max(1, w * 0.0016);
  for (let i = 0; i < landmarks.length; i++) {
    if (LIP_SET.has(i)) continue;
    const p = landmarks[i];
    ctx.fillRect(p.x * w - sz / 2, p.y * h - sz / 2, sz, sz);
  }
  // lip outline the mask is built from
  ctx.strokeStyle = 'rgba(255,90,160,0.95)';
  ctx.lineWidth = Math.max(1, w * 0.002);
  tracePath(ctx, landmarks, LIPS_OUTER, w, h); ctx.stroke();
  tracePath(ctx, landmarks, LIPS_INNER, w, h); ctx.stroke();
  // lip points (bigger)
  ctx.fillStyle = '#ff5aa0';
  const lr = Math.max(1.5, w * 0.004);
  for (const i of LIP_SET) {
    const p = landmarks[i];
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, lr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}