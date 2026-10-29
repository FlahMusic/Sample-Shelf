// sound map prototype (cloud, linux). needs: npm i essentia.js@0.1.3 umap-js@1.4.0
// run: node sound-map-prototype.js out.json  -> synthetic sounds -> features -> umap 2D -> neighbour purity + timing
// prototype: synthetic drums/loops -> essentia features -> umap 2D -> neighbour purity
const { EssentiaWASM, Essentia } = require('essentia.js');
const { UMAP } = require('umap-js');
const fs = require('fs');
const e = new Essentia(EssentiaWASM);
const SR = 44100;
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const noise = () => rnd() * 2 - 1;

function kick(i) { const n = SR * (0.3 + rnd() * 0.5), x = new Float32Array(n), f0 = 40 + rnd() * 30, sweep = 120 + rnd() * 200, dec = 4 + rnd() * 8; let ph = 0;
  for (let t = 0; t < n; t++) { const s = t / SR; ph += 2 * Math.PI * (f0 + sweep * Math.exp(-s * 35)) / SR; x[t] = Math.sin(ph) * Math.exp(-s * dec) + (t < 300 ? noise() * 0.3 * (1 - t / 300) : 0); } return x; }
function snare(i) { const n = SR * (0.2 + rnd() * 0.3), x = new Float32Array(n), f = 160 + rnd() * 80, nd = 10 + rnd() * 15, mix = 0.4 + rnd() * 0.5; let lp = 0;
  for (let t = 0; t < n; t++) { const s = t / SR; lp += 0.5 * (noise() - lp); x[t] = (1 - mix) * Math.sin(2 * Math.PI * f * s) * Math.exp(-s * 25) + mix * lp * Math.exp(-s * nd); } return x; }
function hat(i) { const n = SR * (0.05 + rnd() * (i % 3 === 0 ? 0.6 : 0.1)), x = new Float32Array(n), dec = 20 + rnd() * 60; let prev = 0;
  for (let t = 0; t < n; t++) { const s = t / SR; const w = noise(); x[t] = (w - prev) * 0.6 * Math.exp(-s * dec); prev = w; } return x; }
const ROOTS = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B']; const NOTES = Object.fromEntries(ROOTS.map((r, i) => [r, 261.63 * Math.pow(2, i / 12)]));
function loop(i) { const bpm = [118, 120, 122, 124, 126, 128, 140, 70, 90, 174][(i * 3) % 10], root = ROOTS[(i * 5) % 12], minor = (i * 7) % 3 !== 0, f = NOTES[root] / 2, beat = 60 / bpm, n = Math.floor(SR * beat * 8), x = new Float32Array(n);
  const third = f * Math.pow(2, (minor ? 3 : 4) / 12), fifth = f * Math.pow(2, 7 / 12);
  for (let t = 0; t < n; t++) { const s = t / SR, env = Math.exp(-((s % (beat / 2))) * 6); x[t] = 0.3 * env * (Math.sin(2 * Math.PI * f * s) + 0.6 * Math.sin(2 * Math.PI * third * s) + 0.5 * Math.sin(2 * Math.PI * fifth * s) + 0.2 * Math.sin(4 * Math.PI * f * s)); }
  return { x, bpm, key: root, scale: minor ? 'minor' : 'major' }; }

function features(x) {
  const frames = e.FrameGenerator(x, 2048, 512);
  const rows = [];
  for (let i = 0; i < frames.size(); i++) {
    const fr = frames.get(i);
    const win = e.Windowing(fr, true, 2048, 'hann');
    const spec = e.Spectrum(win.frame, 2048);
    const m = e.MFCC(spec.spectrum, 2, 11000, 1025, 0, 'dbamp', 0, 'unit_sum', 40, 13, SR);
    const coeffs = e.vectorToArray(m.mfcc);
    const cen = e.Centroid(spec.spectrum, 1).centroid;
    const zcr = e.ZeroCrossingRate(fr).zeroCrossingRate;
    rows.push([...coeffs, cen, zcr]);
    win.frame.delete(); spec.spectrum.delete(); m.mfcc.delete(); m.bands.delete();
  }
  frames.delete();
  const d = rows[0].length, mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of rows) r.forEach((v, j) => (mean[j] += v / rows.length));
  for (const r of rows) r.forEach((v, j) => (sd[j] += (v - mean[j]) ** 2 / rows.length));
  return [...mean, ...sd.map(Math.sqrt), Math.log(x.length / SR)];
}

const items = [];
for (let i = 0; i < 25; i++) items.push({ type: 'kick', name: `kick ${i + 1}`, x: kick(i) });
for (let i = 0; i < 25; i++) items.push({ type: 'snare', name: `snare ${i + 1}`, x: snare(i) });
for (let i = 0; i < 25; i++) items.push({ type: 'hat', name: `hat ${i + 1}`, x: hat(i) });
for (let i = 0; i < 40; i++) { const l = loop(i); items.push({ type: 'loop', name: `${l.key}${l.scale === 'minor' ? 'm' : ''} loop ${l.bpm}`, ...l }); }

const t0 = Date.now();
let feats; try { feats = items.map((it) => features(it.x)); } catch (err) { console.log('ERR', err && (err.message || err)); process.exit(1); }
const t1 = Date.now();
// z-score each column
const D = feats[0].length;
for (let j = 0; j < D; j++) { const col = feats.map((f) => f[j]); const m = col.reduce((a, b) => a + b) / col.length; const s = Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / col.length) || 1; feats.forEach((f) => (f[j] = (f[j] - m) / s)); }
const umap = new UMAP({ nComponents: 2, nNeighbors: 8, minDist: 0.9, spread: 2, random: rnd });
const xy = umap.fit(feats);
const t2 = Date.now();
// purity: share of 5 nearest 2D neighbours with same type
let ok = 0, tot = 0;
xy.forEach((p, i) => { const nn = xy.map((q, j) => [j, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2]).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, 5);
  nn.forEach(([j]) => { tot++; if (items[j].type === items[i].type) ok++; }); });
console.log(`features ${t1 - t0}ms for ${items.length} sounds, umap ${t2 - t1}ms, neighbour purity ${(100 * ok / tot).toFixed(1)}%`);
const out = items.map((it, i) => ({ name: it.name, type: it.type, x: +xy[i][0].toFixed(3), y: +xy[i][1].toFixed(3), bpm: it.bpm || null, key: it.key || null, scale: it.scale || null, len: +(it.x.length / SR).toFixed(2) }));
fs.writeFileSync(process.argv[2], JSON.stringify(out));
// timing: one-shots only, and loops capped to first 3s
const ts = Date.now(); items.filter(i => i.type !== 'loop').forEach(i => features(i.x)); const td = Date.now() - ts;
const tl0 = Date.now(); items.filter(i => i.type === 'loop').forEach(i => features(i.x.subarray(0, SR * 3))); const tl = Date.now() - tl0;
console.log(`one-shots ${(td / 75).toFixed(0)}ms each, loops capped at 3s ${(tl / 40).toFixed(0)}ms each`);
