// map positions, in a worker thread. a rebuild runs umap over every measured sample. otherwise samples
// without a spot go next to their nearest measured neighbours, so the map doesn't move under you
// (umap-js can't add points to a finished layout). also guesses a sound for samples whose words don't say
// one: the most common sound among its 10 nearest labelled neighbours of the same kind.
const { parentPort, workerData } = require('worker_threads');
const { UMAP } = require('umap-js');
const { soundOf, kindOf } = require('./classify');

const { items, rebuild } = workerData;
const D = items[0].feat.length;
const post = (m) => parentPort.postMessage(m);

// the sound model's numbers as they are (z-scoring them made neighbours worse: 55.8% vs 57.1%)
const X = items.map((r) => Float64Array.from(r.feat));
const dist = (a, b) => { let s = 0; for (let k = 0; k < D; k++) { const d = a[k] - b[k]; s += d * d; } return s; };
// k nearest of `from` (indexes) to point i
function nearest(i, from, k) {
  const best = [];
  for (const j of from) {
    if (j === i) continue;
    const d = dist(X[i], X[j]);
    if (best.length < k) { best.push([d, j]); best.sort((a, b) => a[0] - b[0]); }
    else if (d < best[k - 1][0]) { best[k - 1] = [d, j]; best.sort((a, b) => a[0] - b[0]); }
  }
  return best;
}

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pos = new Array(items.length).fill(null);
const placed = items.map((r, i) => (r.mx != null ? i : -1)).filter((i) => i >= 0);

if (rebuild || placed.length < items.length / 2) {
  // min dist 0.5 (not 0.1): on his shelf 0.1 packed most sounds into one tight blob
  const u = new UMAP({ nComponents: 2, nNeighbors: 15, minDist: 0.5, random: rnd });
  post({ type: 'progress', what: 'finding neighbours' });
  const epochs = u.initializeFit(X.map((f) => Array.from(f)));
  for (let e = 0; e < epochs; e++) {
    u.step();
    if (e % 10 === 0) post({ type: 'progress', what: 'laying out', pct: Math.round((100 * e) / epochs) });
  }
  // the middle 98% fills 0..1 (same scale both ways). the few strays past that sit a little outside,
  // so they don't squash everything else into a blob
  const xy = u.getEmbedding();
  const q = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor(p * (arr.length - 1))];
  const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  const x0 = q(xs, 0.01), x1 = q(xs, 0.99), y0 = q(ys, 0.01), y1 = q(ys, 0.99);
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const c = (v) => Math.min(1.15, Math.max(-0.15, v));
  xy.forEach((p, i) => { pos[i] = [c(0.5 + (p[0] - cx) / span), c(0.5 + (p[1] - cy) / span)]; });
} else {
  for (const i of placed) pos[i] = [items[i].mx, items[i].my];
  const todo = items.map((_, i) => i).filter((i) => !pos[i]);
  todo.forEach((i, n) => {
    const nn = nearest(i, placed, 6);
    let x = 0, y = 0, w = 0;
    for (const [d, j] of nn) { const wt = 1 / (Math.sqrt(d) + 1e-3); x += pos[j][0] * wt; y += pos[j][1] * wt; w += wt; }
    // a little jitter so two near-identical sounds don't sit exactly on top of each other
    pos[i] = [x / w + (rnd() - 0.5) * 0.004, y / w + (rnd() - 0.5) * 0.004];
    if (n % 200 === 0) post({ type: 'progress', what: 'placing new sounds', pct: Math.round((100 * n) / todo.length) });
  });
}

post({ type: 'progress', what: 'guessing sounds' });
const kind = items.map((r) => kindOf(r));
const word = items.map((r) => soundOf(r));
const labelled = { loop: [], oneshot: [] };
items.forEach((r, i) => { if (word[i]) labelled[kind[i]].push(i); });
const sound = {};
items.forEach((r, i) => {
  if (word[i]) return;
  const votes = {};
  for (const [, j] of nearest(i, labelled[kind[i]], 10)) votes[word[j]] = (votes[word[j]] || 0) + 1;
  let best = null;
  for (const s in votes) if (!best || votes[s] > votes[best]) best = s;
  if (best) sound[r.id] = best;
});

const out = {};
items.forEach((r, i) => { out[r.id] = [Math.round(pos[i][0] * 10000) / 10000, Math.round(pos[i][1] * 10000) / 10000]; });
post({ type: 'done', pos: out, sound });
