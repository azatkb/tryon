// Shade logic copied from REESOLVE's tutorial engine, kept compatible with their
// catalogue format (a product "row" with a `shades: [{name, hex, undertone, ...}]`
// array). Drop their real catalogue into catalog.js and lookShade() picks the
// shade that fits each look — no code changes needed.

// Per tutorial/look and face area, which shade family the look calls for.
export const TUTORIAL_SHADE_FAMILY = {
  'everyday-makeup': { lip: 'pink-nude', cheek: 'rosy', bronze: 'bronze' },
  'date-night-in-5-minutes': { lip: 'berry', cheek: 'rosy', glow: 'champagne' },
  'kiss-proof-lip-combo': { lip: 'pink-nude' },
  'make-blush-last-all-day': { cheek: 'rosy' },
  'fake-8-hours-of-sleep': { lip: 'pink-nude', cheek: 'peach', glow: 'champagne' },
  'make-it-last-all-night': { lip: 'berry', cheek: 'rosy', bronze: 'bronze' },
  'contour-without-the-confusion': { bronze: 'bronze', contour: 'contour' },
  'make-those-eyes-pop': { eye: 'neutral', shimmer: 'champagne' },
};

export function shadeFamilyFor(tipId, label) {
  const f = TUTORIAL_SHADE_FAMILY[tipId] || {};
  const c = String(label || '').toLowerCase();
  if (/lip/.test(c)) return f.lip || null;
  if (/liner/.test(c)) return null;
  if (/blush/.test(c)) return f.cheek || null;
  if (/contour/.test(c)) return f.contour || f.bronze || null;
  if (/bronzer/.test(c)) return f.bronze || null;
  if (/highlight/.test(c)) return f.glow || null;
  if (/shimmer|lighter eyeshadow/.test(c)) return f.shimmer || f.eye || null;
  if (/shadow/.test(c)) return f.eye || null;
  return null;
}

// Name words (good/bad) + a colour window on the shade's hex (hue, saturation %, lightness %).
export const SHADE_FAMILIES = {
  'pink-nude': { good: /\b(nude|pink\w*|rose|rosy|mauve|blush|petal|ballet|bare|buff|beige|clear|sheer|soft|baby|blossom|peony|rosewood|praline|naked)\b/, bad: /\b(red|cherry|ruby|scarlet|crimson|fire|berry|plum|wine|oxblood|burgundy|vamp|black|chocolate|espresso|orange|coral|tangerine|violet|purple|blue|green|gold|bronze)\b/, h: [[330, 360], [0, 30]], s: [0, 60], l: [45, 88] },
  rosy: { good: /\b(pink\w*|rose|rosy|petal|flush|blush|peony|blossom|baby|cheeky|pinch)\b/, bad: /\b(bronze|brown|tan|orange|coral|peach|red|plum|nude|gold)\b/, h: [[320, 360], [0, 20]], s: [20, 100], l: [45, 85] },
  peach: { good: /\b(peach\w*|apricot|coral|melon|papaya|sunset|nectar)\b/, bad: /\b(berry|plum|wine|brown|red|mauve|cool)\b/, h: [[5, 40]], s: [25, 100], l: [55, 90] },
  berry: { good: /\b(berry|plum|wine|raspberry|mulberry|rose|rosewood|mauve|merlot|cranberry|fig)\b/, bad: /\b(nude|peach|coral|orange|clear|beige|bare|gold)\b/, h: [[300, 360], [0, 12]], s: [15, 100], l: [15, 50] },
  red: { good: /\b(red|cherry|ruby|scarlet|crimson|fire)\b/, bad: /\b(nude|pink|peach|coral|beige|clear|plum|brown)\b/, h: [[345, 360], [0, 12]], s: [50, 100], l: [25, 55] },
  bronze: { good: /\b(bronze\w*|tan|sun\w*|warm|caramel|honey|amber|terra\w*|golden|toffee|cocoa)\b/, bad: /\b(pink|rose|berry|plum|cool|grey|gray|taupe|ash)\b/, h: [[10, 42]], s: [20, 100], l: [22, 62] },
  contour: { good: /\b(taupe|cool|ash|grey|gray|mushroom|shadow|sculpt\w*|contour|mocha)\b/, bad: /\b(pink|rose|berry|orange|gold|bronze|shimmer|glow)\b/, h: [[0, 45]], s: [0, 40], l: [22, 62] },
  champagne: { good: /\b(champagne|gold\w*|pearl|opal|moon\w*|glow|ivory|vanilla|prosecco|star\w*)\b/, bad: /\b(bronze|copper|rose|pink|purple|blue|green|deep|dark)\b/, h: [[20, 60]], s: [0, 100], l: [65, 100] },
  neutral: { good: /\b(taupe|brown|nude|neutral|beige|cocoa|mocha|chocolate|caramel|tan|sand|stone|espresso|coffee|champagne)\b/, bad: /\b(blue|green|teal|purple|violet|pink|red|yellow|orange|turquoise|lilac|lavender)\b/, h: [[5, 50]], s: [0, 60], l: [10, 85] },
};

// Representative hex per family (fallback when a catalogue has no shade).
export const FAMILY_HEX = {
  'pink-nude': '#C98F8A', rosy: '#D77A86', peach: '#E89477', berry: '#8E2F5A',
  red: '#B52532', bronze: '#9A6B3F', contour: '#8A7466', champagne: '#E8D7B0', neutral: '#8A7466',
};

export function hexHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, bl = (n & 255) / 255;
  const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl), l = (mx + mn) / 2, d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - bl) / d + 6) % 6 : mx === g ? (bl - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: d ? (d / (1 - Math.abs(2 * l - 1))) * 100 : 0, l: l * 100 };
}

export function depthLevel(v) {
  const t = String(v || '').toLowerCase().replace(/[_-]+/g, ' ');
  if (!t.trim()) return null;
  if (/\b(rich|very deep|dark|ebony|espresso|mahogany)\b/.test(t)) return 7;
  if (/\bmedium deep\b/.test(t)) return 5;
  if (/\b(deep|cocoa|chocolate)\b/.test(t)) return 6;
  if (/\b(medium tan|tan medium)\b/.test(t)) return 4;
  if (/\b(tan|caramel|toffee|mocha|cinnamon|chestnut)\b/.test(t)) return 5;
  if (/\b(light medium|medium light)\b/.test(t)) return 2;
  if (/\b(medium|mid)\b/.test(t)) return 3;
  if (/\b(fair|porcelain|pale|ivory)\b/.test(t)) return 0;
  if (/\b(light|lightest)\b/.test(t)) return 1;
  return null;
}

export const DEPTH_L = { 'pink-nude': [74, 34], rosy: [72, 44], peach: [74, 48], berry: [46, 24] };
function depthTarget(family, lv) {
  const r = DEPTH_L[family];
  if (!r || lv == null) return null;
  return r[0] + (r[1] - r[0]) * lv / 7;
}

const DEEP_WORDS = {
  'pink-nude': [/\b(cocoa|mocha|toffee|caramel|chocolate|espresso|cinnamon|spice\w*|brown\w*|deep|rich|mahogany|chestnut|hazel\w*|nutmeg)\b/g, 'nude'],
  rosy: [/\b(berry|raspberry|cranberry|fuchsia|magenta|mulberry|deep|rich)\b/g, 'rose'],
  peach: [/\b(terracotta|brick|copper|tangerine|orange|spice\w*|deep|rich)\b/g, 'peach'],
};

export function shadeFitScore(shade, family, lv) {
  const f = SHADE_FAMILIES[family];
  if (!f || !shade) return 0;
  let text = (String(shade.name || '') + ' ' + String(shade.variant_title || '')).toLowerCase();
  const dw = lv != null && lv >= 4 ? DEEP_WORDS[family] : null;
  if (dw) text = text.replace(dw[0], ' ' + dw[1] + ' ');
  let v = f.bad.test(text) ? -3 : f.good.test(text) ? 2 : 0;
  const c = hexHsl(shade.hex);
  if (c) {
    const tg = depthTarget(family, lv);
    const lo = tg == null ? f.l[0] : Math.min(f.l[0], tg - 14);
    const hi = tg == null ? f.l[1] : Math.max(f.l[1], tg + 14);
    const hue = f.h.some(([a, z]) => c.h >= a && c.h <= z);
    v += hue && c.s >= f.s[0] && c.s <= f.s[1] && c.l >= lo && c.l <= hi ? 2 : -2;
  }
  return v;
}

function shadeLightness(s, family) {
  const c = hexHsl(s && s.hex);
  if (c) return c.l;
  let lv = depthLevel(s && s.depth);
  if (lv == null) lv = depthLevel(String((s && s.name) || '') + ' ' + String((s && s.variant_title) || ''));
  return lv == null ? null : depthTarget(family, lv);
}

function pickShade(shades, current) {
  if (!current) return null;
  const c = String(current).trim().toLowerCase();
  return shades.find((s) => String(s.name || '').trim().toLowerCase() === c) || null;
}

// The shade a catalogue row should show for a look family, given the user's
// undertone / skin depth. Returns { shade, fits, strong, far }.
export function lookShade(row, family, undertone, current, depth) {
  const shades = (Array.isArray(row && row.shades) ? row.shades : []).filter((s) => s && s.name && s.available !== false);
  const cur = current ? pickShade(shades, current) : null;
  if (!family) return { shade: cur, fits: true, strong: false, far: false };
  const lv = depthLevel(depth);
  const tgt = depthTarget(family, lv);
  const off = (s) => {
    if (tgt == null) return 0;
    const l = shadeLightness(s, family);
    return l == null ? 2 : Math.round(Math.abs(l - tgt) / 6);
  };
  if (!shades.length) {
    const own = String((row && row.name) || '').split(' — ')[1] || current || '';
    const v = own ? shadeFitScore({ name: own, hex: row && row.hex }, family, lv) : 0;
    const far = v > 0 && off({ name: own, hex: row && row.hex }) > 3;
    return { shade: null, fits: v >= 0, strong: v > 0 && !far, far };
  }
  const score = (s) => shadeFitScore(s, family, lv);
  const matched = family === 'bronze' || family === 'contour';
  if (cur && (matched ? score(cur) >= 0 : score(cur) > 0) && off(cur) <= 3) return { shade: cur, fits: true, strong: score(cur) > 0, far: false };
  const tone = String(undertone || '').trim().split(/\s+/)[0].toLowerCase();
  let best = null, bv = 0;
  shades.forEach((s) => {
    const sc = score(s);
    if (sc <= 0) return;
    const v = -off(s) * 100 + sc * 10 + (tone && String(s.undertone || '').trim().split(/\s+/)[0].toLowerCase() === tone ? 2 : 0) + (s.image_url ? 1 : 0);
    if (!best || v > bv) { best = s; bv = v; }
  });
  if (best) { const far = off(best) > 3; return { shade: best, fits: true, strong: !far, far }; }
  const known = shades.some((s) => score(s) !== 0);
  return { shade: cur, fits: !known || (!!cur && score(cur) >= 0), strong: false, far: false };
}