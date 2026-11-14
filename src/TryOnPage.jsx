/**
 * TryOnPage — live try-on with the product catalogue from src/data/*.json.
 *
 * Every product category is picked on its own:
 *   lipstick · lip liner · eyeshadow · eyeliner · mascara · brows ·
 *   foundation · concealer · blush · highlighter
 * A LOOK fills a group of them at once; changing one product afterwards keeps
 * the rest of the look.
 *
 * Products per category come from src/data/<file>.json ({ products: [ { brand,
 * name, image, finish, shades: [ { name, hex | hexes, finish?, amount? } ] } ] }):
 *   lipstick → lips.json        eyeshadow → eyes.json      blush → face.json
 *   lipliner → lipliner.json    eyeliner  → eyeliner.json  mascara → mascara.json
 *   brows    → brows.json       foundation → foundation.json
 *   concealer → concealer.json  highlighter → highlighter.json
 * A missing / empty file falls back to a small built-in "Basic" palette, so
 * every category is usable today. Files are read raw and parsed tolerantly.
 *
 * Source: camera by default, or a local video file ("▶ Video" in the header).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import TryOnCanvas from './tryon/TryOnCanvas.jsx';
import { setEyeShadowShape, setEyeShadowProcedural } from './tryon/index.js';
import './tryon-page.css';

// ── data ──────────────────────────────────────────────────────────────
const RAW = import.meta.glob('./data/*.json', { query: '?raw', import: 'default', eager: true });
function loadJson(name) {
  const raw = RAW[`./data/${name}.json`];
  if (!raw || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch (e) { console.warn(`[tryon] data/${name}.json:`, e.message); return null; }
}
const productsOf = (d) => (d && Array.isArray(d.products) ? d.products : []);
const LOOKS = loadJson('looks')?.looks || [];
const FACE = loadJson('face');
const EYES = loadJson('eyes');
const COVERAGE = FACE?.coverage || { sheer: { cover: 0.3, smooth: 0.2 }, medium: { cover: 0.5, smooth: 0.32 }, full: { cover: 0.62, smooth: 0.4 } };

const basic = (name, finish, shades) => [{ id: `basic-${name}`, brand: 'Basic', name, finish, shades }];
const sh = (name, hex, extra) => ({ name, hex, ...extra });

// Built-in palettes (used when the category has no JSON products yet)
const BASIC = {
  lipstick: basic('Lipstick', 'satin', [
    sh('Nude', '#C2807A'), sh('Rose', '#C27C80'), sh('Mauve', '#A8676B', { finish: 'matte' }), sh('Coral', '#C83A3A'),
    sh('Red', '#B3202A'), sh('Wine', '#8C494F', { finish: 'gloss' }), sh('Brown nude', '#9A6A5E', { finish: 'matte' }),
  ]),
  lipliner: basic('Lip Liner', 'matte', [
    sh('Nude', '#9A5E54'), sh('Rose', '#A0646A'), sh('Brown', '#6A4438'), sh('Red', '#94161F'), sh('Berry', '#5E2239'),
  ]),
  eyeshadow: basic('Eyeshadow', 'matte', [
    { name: 'Nude', hexes: ['#DCB598', '#DAB5A7', '#8C684B'] }, { name: 'Taupe', hexes: ['#C2A592', '#977462', '#6C4F40'] },
    { name: 'Brown', hexes: ['#A9785A', '#6E4430', '#3E2618'] }, { name: 'Plum', hexes: ['#B88C9A', '#7E4E66', '#563245'] },
    { name: 'Charcoal', hexes: ['#716664', '#3E3433', '#1A1515'] },
  ]),
  eyeliner: basic('Eyeliner', 'matte', [
    sh('Black', '#141010'), sh('Brown', '#3E2618'), sh('Plum', '#3A1E28'), sh('Navy', '#1C2340'),
  ]),
  mascara: basic('Mascara', null, [sh('Black', '#0A0A0A'), sh('Brown black', '#2E1C12'), sh('Brown', '#4A2E1E')]),
  brows: basic('Brow', null, [
    sh('Blonde', '#A08060'), sh('Taupe', '#7A6250'), sh('Medium brown', '#5A4030'), sh('Dark brown', '#3A2A20'), sh('Soft black', '#2A2220'),
  ]),
  foundation: basic('Foundation', 'natural', [
    sh('Porcelain', '#F1D4C0'), sh('Light', '#E8C0A0'), sh('Light medium', '#D9A882'), sh('Medium', '#C8956C'),
    sh('Tan', '#B07A55'), sh('Deep', '#8A5A3C'), sh('Rich', '#5E3A26'),
  ]),
  concealer: basic('Concealer', null, [sh('Light', '#F0D2BC'), sh('Medium', '#DDB28E'), sh('Tan', '#C29270'), sh('Deep', '#8E6044')]),
  blush: basic('Blush', null, [sh('Peach', '#EEA297'), sh('Pink', '#EB9CBB'), sh('Coral', '#F7726F'), sh('Berry', '#C2386B'), sh('Terracotta', '#C47A66')]),
  highlighter: basic('Highlighter', null, [sh('Pearl', '#F4E4DC'), sh('Champagne', '#F1D6C8'), sh('Gold', '#F2D3A8'), sh('Rose', '#F4D8D4')]),
};
const FILE = {
  lipstick: 'lips', lipliner: 'lipliner', eyeshadow: 'eyes', eyeliner: 'eyeliner', mascara: 'mascara', brows: 'brows',
  foundation: 'foundation', concealer: 'concealer', blush: 'face', highlighter: 'highlighter',
};
const CATALOG = Object.fromEntries(Object.keys(FILE).map((k) => {
  const list = productsOf(loadJson(FILE[k]));
  return [k, list.length ? list : BASIC[k]];
}));

// Groups → categories (move a category to another group by moving its line)
const GROUPS = [
  { key: 'looks', label: 'Looks', cats: [] },
  { key: 'lips', label: 'Lips', cats: [['lipstick', 'Lipstick'], ['lipliner', 'Lip liner']] },
  { key: 'eyes', label: 'Eyes', cats: [['eyeshadow', 'Eyeshadow'], ['eyeliner', 'Eyeliner'], ['mascara', 'Mascara'], ['brows', 'Brows']] },
  { key: 'face', label: 'Face', cats: [['foundation', 'Foundation'], ['concealer', 'Concealer'], ['blush', 'Blush'], ['highlighter', 'Highlighter']] },
];
const EMPTY = { lipstick: null, lipliner: null, eyeshadow: null, eyeliner: null, mascara: null, brows: null,
  foundation: null, concealer: null, blush: null, highlighter: null, contour: 0 };

// ── mapping selection → renderer layers ───────────────────────────────
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const LIP_FINISH = { matte: 'matte', matte_velvet: 'matte', velvet: 'matte', satin: 'satin', cream: 'satin', balm: 'satin',
  gloss: 'gloss', glossy: 'gloss', sheershine: 'gloss', shine: 'gloss', shimmer: 'gloss', metallic: 'gloss' };
const EYE_FINISH = { matte: 'matte', satin: 'satin', shimmer: 'shimmer', metallic: 'shimmer', glitter: 'shimmer' };
const FND_FINISH = { matte: 'matte', powder: 'matte', natural: 'natural', satin: 'satin', radiance: 'dewy', dewy: 'dewy', glow: 'dewy' };
const hexOf = (s) => s?.hex || (Array.isArray(s?.hexes) ? s.hexes[Math.min(1, s.hexes.length - 1)] : null);

function buildLayers(sel, k) {
  const L = {};
  const s = sel;
  if (s.lipstick?.hex) {
    const fin = (s.lipstick.finish || 'satin').toLowerCase();
    const finish = LIP_FINISH[fin] || 'satin';
    const sheer = /sheer|balm/.test(fin);
    L.lips = {
      color: s.lipstick.hex, finish,
      intensity: clamp(((s.lipstick.amount ?? 70) / 100) * (sheer ? 0.75 : 1) * k.lipstick, 0.05, 1),
      coverage: sheer ? 0.35 : finish === 'matte' ? 0.75 : 0.6,
    };
  }
  if (s.lipliner?.hex) L.lipLiner = { color: s.lipliner.hex, intensity: clamp(((s.lipliner.amount ?? 65) / 100) * k.lipliner, 0.05, 1) };
  if (s.eyeshadow?.hexes?.length) {
    const h = s.eyeshadow.hexes;
    const finish = EYE_FINISH[(s.eyeshadow.finish || 'matte').toLowerCase()] || 'matte';
    L.eyes = {
      // lid = mid tone, crease = deep tone. The soft top / ends of the shadow
      // are the renderer's "highlight" zone (low mask values) — given the LIGHT
      // tone they drew a pale rim around the shadow (hard visible edge), so
      // they blend out in the deep tone like real blended shadow.
      color: h[1] || h[0], creaseColor: h[2] || h[1] || h[0], highlightColor: h[2] || h[1] || h[0],
      finish, creaseFinish: 'matte', highlightFinish: 'matte',
      intensity: clamp(((s.eyeshadow.amount ?? 80) / 100) * 0.75 * k.eyeshadow, 0.05, 1),
    };
  }
  if (s.eyeliner?.hex) L.eyeliner = { color: s.eyeliner.hex, intensity: clamp(0.85 * k.eyeliner, 0.1, 1), wing: !!s.eyeliner.wing };
  if (s.mascara?.hex) L.lashes = { color: s.mascara.hex, intensity: clamp(0.85 * k.mascara, 0.1, 1) };
  if (s.brows?.hex) L.brows = { color: s.brows.hex, intensity: clamp(0.55 * k.brows, 0.05, 1) };
  if (s.foundation?.hex) {
    const cov = COVERAGE[s.foundation.coverage || 'medium'] || COVERAGE.medium;
    L.foundation = { color: s.foundation.hex, intensity: clamp(cov.cover * k.foundation, 0.05, 1),
      finish: FND_FINISH[(s.foundation.finish || 'natural').toLowerCase()] || 'natural' };
  }
  if (s.concealer?.hex) L.underEye = { color: s.concealer.hex, intensity: clamp(0.45 * k.concealer, 0.05, 1) };
  if (s.blush?.hex) L.blush = { color: s.blush.hex, intensity: clamp(((s.blush.amount ?? 26) / 100) * 1.5 * k.blush, 0.05, 0.9) };
  if (s.highlighter) L.highlight = { color: s.highlighter.hex, intensity: clamp(0.35 * k.highlighter, 0.05, 0.9) };
  if (s.contour > 0) L.contour = { intensity: clamp((s.contour / 100) * 1.6, 0, 0.8) };
  return L;
}

/** A look → the categories it sets (the rest stays as it is). */
function lookSelection(lk) {
  const s = { contour: lk.contour || 0 };
  s.lipstick = lk.lips ? { hex: lk.lips.hex, finish: lk.lips.finish, amount: lk.lips.amount } : null;
  s.lipliner = lk.liner?.hex ? { hex: lk.liner.hex, amount: lk.liner.amount } : null;
  const e = lk.eyes;
  s.eyeshadow = e?.hexes ? { hexes: e.hexes, finish: e.finish, amount: e.amount, spread: e.spread, lower: e.lower } : null;
  s.eyeliner = e?.liner ? { hex: e.linerHex || '#1E1612', wing: !!e.wing } : null;
  s.mascara = e?.lashes ? { hex: e.lashHex || '#0A0A0A' } : null;
  s.blush = lk.cheeks?.hex ? { hex: lk.cheeks.hex, amount: lk.cheeks.amount } : null;
  s.highlighter = lk.hl?.hex ? { hex: lk.hl.hex } : null;
  return s;
}

const ONE = Object.fromEntries(Object.keys(EMPTY).map((k) => [k, 1]));

export default function TryOnPage() {
  const [group, setGroup] = useState('looks');
  const [catOf, setCatOf] = useState({ lips: 'lipstick', eyes: 'eyeshadow', face: 'foundation' });   // last sub-tab per group
  const tab = group === 'looks' ? 'looks' : catOf[group];
  const setTab = (c) => setCatOf((m) => ({ ...m, [group]: c }));
  const G = GROUPS.find((g) => g.key === group);
  const [look, setLook] = useState(null);
  const [sel, setSel] = useState(EMPTY);
  const [chosen, setChosen] = useState({});      // category → "productIdx:shadeIdx"
  const [amount, setAmount] = useState(ONE);     // per-category intensity multiplier
  const [panelOpen, setPanelOpen] = useState(true);
  // Picking something closes the sheet so the face is visible. Only where the
  // panel covers the camera (phone layout); the desktop side panel stays open.
  const closeTimer = useRef(0);
  const autoClose = () => {
    if (!window.matchMedia?.('(max-width: 899px)').matches) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setPanelOpen(false), 160);   // let the tap highlight show first
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  // ── source: camera, or a local video file ──
  const [videoUrl, setVideoUrl] = useState(null);
  const [videoEl, setVideoEl] = useState(null);
  const fileRef = useRef(null);
  const onVideoFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setVideoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(f); });
  };
  const backToCamera = () => {
    if (videoEl) videoEl.pause();
    setVideoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
  };
  // Safari pauses a muted video it thinks is invisible — play on
  const keepPlaying = () => { if (videoUrl && videoEl && !videoEl.ended) setTimeout(() => videoEl.paused && videoEl.play().catch(() => {}), 0); };

  // eyeshadow shape follows the selection ("spread" / "lower" from looks)
  useEffect(() => {
    setEyeShadowProcedural(true);
    const e = sel.eyeshadow;
    const spread = e?.spread ?? 1;
    setEyeShadowShape({
      top: clamp(0.55 * Math.sqrt(spread), 0.3, 0.8),
      wing: clamp(0.75 * spread, 0.3, 1.2),
      lower: e && typeof e.lower === 'number' ? clamp(0.06 * e.lower, 0, 0.16) : 0.04,
    });
  }, [sel.eyeshadow]);

  const layers = useMemo(() => buildLayers(sel, amount), [sel, amount]);

  const applyLook = (lk) => {
    setLook(lk.key);
    const ls = lookSelection(lk);
    setChosen((c) => { const n = { ...c }; for (const k of Object.keys(ls)) delete n[k]; return n; });
    setSel((x) => ({ ...x, ...ls }));     // foundation / concealer / brows stay
    autoClose();
  };
  const clearAll = () => { setLook(null); setChosen({}); setSel(EMPTY); };

  const pickShade = (cat, p, pi, s, si) => {
    setLook(null);
    setChosen((c) => ({ ...c, [cat]: `${pi}:${si}` }));
    const finish = s.finish || p.finish;
    let v;
    if (cat === 'eyeshadow') v = { hexes: Array.isArray(s.hexes) ? s.hexes : [s.hex, s.hex, s.hex], finish, amount: s.amount ?? 80 };
    else if (cat === 'eyeliner') v = { hex: hexOf(s), wing: sel.eyeliner?.wing ?? false };
    else if (cat === 'foundation') v = { hex: hexOf(s), finish, coverage: sel.foundation?.coverage || 'medium' };
    else v = { hex: hexOf(s), finish, amount: s.amount ?? p.amount };
    setSel((x) => ({ ...x, [cat]: v }));
    autoClose();
  };
  const clearCat = (cat) => {
    setLook(null);
    setChosen((c) => ({ ...c, [cat]: undefined }));
    setSel((x) => ({ ...x, [cat]: null }));
    autoClose();
  };
  const patch = (cat, o) => { setLook(null); setSel((x) => (x[cat] ? { ...x, [cat]: { ...x[cat], ...o } } : x)); };

  const finishLabels = EYES?.finishLabels || {};
  const list = tab === 'looks' ? [] : CATALOG[tab] || [];
  const anyOn = Object.entries(sel).some(([k, v]) => (k === 'contour' ? v > 0 : !!v));

  return (
    <div className="tp">
      {videoUrl && (
        <video ref={setVideoEl} src={videoUrl} playsInline muted loop autoPlay preload="auto"
          onLoadedData={(e) => e.currentTarget.play().catch(() => {})} onPause={keepPlaying}
          style={{ position: 'fixed', left: 0, top: 0, width: 2, height: 2, opacity: 0.01, pointerEvents: 'none' }} />
      )}
      <TryOnCanvas className="tp-cam" layers={layers} style={{ position: 'absolute', inset: 0 }}
        source={videoUrl && videoEl ? 'video' : 'camera'} sourceEl={videoUrl ? videoEl : null}
        mirrored={!videoUrl} active={!videoUrl || !!videoEl} />

      <header className="tp-top">
        <span className="tp-brand">REESOLVE</span>
        <span className="tp-current">{look ? LOOKS.find((l) => l.key === look)?.name : anyOn ? 'Custom' : 'No makeup'}</span>
        <input ref={fileRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={onVideoFile} />
        {videoUrl
          ? <button className="tp-mini" onClick={backToCamera} title="Back to the camera">● Cam</button>
          : <button className="tp-mini" onClick={() => fileRef.current?.click()} title="Use a video file as the source">▶ Video</button>}
        <button className="tp-ghost" onClick={clearAll}>Clear</button>
      </header>

      <section className={`tp-panel${panelOpen ? '' : ' tp-panel--closed'}`}>
        <button className="tp-handle" onClick={() => { clearTimeout(closeTimer.current); setPanelOpen((o) => !o); }} aria-label="Toggle panel"><span /></button>
        <nav className="tp-tabs">
          {GROUPS.map((g) => (
            <button key={g.key} className={`tp-tab tp-tab--group${group === g.key ? ' is-on' : ''}${g.cats.some(([c]) => sel[c]) ? ' has' : ''}`}
              onClick={() => { clearTimeout(closeTimer.current); setGroup(g.key); setPanelOpen(true); }}>
              {g.label}
            </button>
          ))}
        </nav>
        {panelOpen && G.cats.length > 0 && (
          <nav className="tp-subtabs">
            {G.cats.map(([c, label]) => (
              <button key={c} className={`tp-sub${tab === c ? ' is-on' : ''}${sel[c] ? ' has' : ''}`} onClick={() => setTab(c)}>{label}</button>
            ))}
          </nav>
        )}

        {panelOpen && tab === 'looks' && (
          <div className="tp-scroll">
            {LOOKS.length === 0 && <div className="tp-empty">No looks in data/looks.json</div>}
            {LOOKS.map((lk) => (
              <button key={lk.key} className={`tp-look${look === lk.key ? ' is-on' : ''}`} onClick={() => applyLook(lk)}>
                <span className="tp-look-sw">
                  {(lk.eyes?.hexes || []).slice(0, 3).map((h, i) => <i key={`e${i}`} style={{ background: h }} />)}
                  {lk.cheeks?.hex && <i style={{ background: lk.cheeks.hex }} />}
                  {lk.lips?.hex && <i style={{ background: lk.lips.hex }} />}
                </span>
                <span className="tp-look-name">{lk.name}{lk.photoOnly && <em> · photo</em>}</span>
                <span className="tp-look-sub">{lk.sub}</span>
              </button>
            ))}
          </div>
        )}

        {panelOpen && tab !== 'looks' && (
          <>
            <div className="tp-row">
              <button className={`tp-ghost${sel[tab] ? '' : ' is-on'}`} onClick={() => clearCat(tab)}>None</button>
              <label className="tp-amount">
                Intensity
                <input type="range" min="0.3" max="1.5" step="0.05" value={amount[tab]}
                  onChange={(e) => setAmount((a) => ({ ...a, [tab]: +e.target.value }))} />
              </label>
            </div>
            {tab === 'eyeliner' && sel.eyeliner && (
              <div className="tp-row tp-chips">
                {[['Classic', false], ['Wing', true]].map(([l, w]) => (
                  <button key={l} className={`tp-chip${!!sel.eyeliner.wing === w ? ' is-on' : ''}`} onClick={() => patch('eyeliner', { wing: w })}>{l}</button>
                ))}
              </div>
            )}
            {tab === 'foundation' && sel.foundation && (
              <div className="tp-row tp-chips">
                {Object.keys(COVERAGE).map((c) => (
                  <button key={c} className={`tp-chip${(sel.foundation.coverage || 'medium') === c ? ' is-on' : ''}`}
                    onClick={() => patch('foundation', { coverage: c })}>{c[0].toUpperCase() + c.slice(1)}</button>
                ))}
              </div>
            )}
            <div className="tp-scroll">
              {list.map((p, pi) => (
                <div key={p.id || pi} className="tp-prod">
                  {p.image && <img className="tp-prod-img" src={p.image} alt="" loading="lazy" />}
                  <div className="tp-prod-body">
                    <div className="tp-prod-brand">{p.brand}</div>
                    <div className="tp-prod-name">{p.name}</div>
                    {p.finish && <div className="tp-prod-fin">{finishLabels[p.finish] || p.finish}</div>}
                    <div className="tp-shades">
                      {(p.shades || []).map((s, si) => {
                        const on = chosen[tab] === `${pi}:${si}`;
                        const hexes = Array.isArray(s.hexes) ? s.hexes : [hexOf(s)];
                        return (
                          <button key={si} className={`tp-shade${on ? ' is-on' : ''}`} title={s.name}
                            onClick={() => pickShade(tab, p, pi, s, si)}>
                            <span className="tp-shade-sw">{hexes.map((h, i) => <i key={i} style={{ background: h }} />)}</span>
                            <span className="tp-shade-name">{s.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}