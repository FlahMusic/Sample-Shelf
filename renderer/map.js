/* global state, Keys, play, stop, select, scrollTo, fmtBpm, fmtBpmShown, fmtKeyShown, n, rowMenu, dragOut, soundOf */
// map view: every shown sample placed by how it sounds. same filters, selection, lock and preview as the list.
// click a dot = it becomes the anchor. up/down steps through its list (similar, or fits with), shift = 5.
// left/right = back/forward through what you played. plain drag = sweep (plays what it passes).
// ctrl+drag a dot = drag it out. right/middle drag = pan, wheel = zoom.
const canvas = $('#map');
const g2 = canvas.getContext('2d');
const tip = $('#mapTip');

const map = {
  view: { s: 1, ox: 0, oy: 0 },
  fitted: false,
  pts: [], // shown samples that have a spot: { r, u, v }
  grid: null,
  anchor: null,
  tab: 'similar', // or 'fits'
  list: [], // the anchor's list for the current tab
  step: -1,
  matchKey: false,
  hover: null,
  history: [],
  hpos: -1,
  zDirty: true,
  progress: '',
};
$('#legend').replaceChildren(...[...SOUND_NAMES, 'loop'].map((s) => {
  const el = document.createElement('span');
  el.textContent = s === 'loop' ? 'loops' : s;
  el.style.setProperty('--c', COLORS[s]);
  if (s === 'loop') el.className = 'loop';
  else { el.dataset.s = s; el.title = 'show only ' + s + ' (click again to undo)'; el.addEventListener('click', () => toggleSound(s)); }
  return el;
}));
const sound = (r) => r._sound;
const colorOf = (r) => (r._kind === 'loop' ? COLORS.loop : COLORS[sound(r)] || COLORS.none);

// ---------- features: z-scored so no one number decides closeness ----------
// the sound model's numbers as they are, as typed arrays (z-scoring them made neighbours worse)
function ensureZ() {
  if (!map.zDirty) return;
  map.zDirty = false;
  for (const r of state.all) if (r.feat) r._z = Float32Array.from(r.feat);
}
const zdist = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) { const d = a[k] - b[k]; s += d * d; } return s; };

// ---------- the two lists ----------
// similar: nearest by sound among what's shown, same kind as the anchor (loops for a loop, one-shots for a
// one-shot). "only matching key" keeps the ones whose key fits the anchor's
function similarTo(a) {
  ensureZ();
  if (!a._z) return [];
  const best = [];
  const K = 32;
  for (const r of state.view) {
    if (r === a || !r._z || r._kind !== a._kind) continue;
    if (map.matchKey && !(a.key && a.scale && r.key && r.scale && Keys.keyRelation(a.key, a.scale, r.key, r.scale) >= 0)) continue;
    const d = zdist(a._z, r._z);
    if (best.length < K) { best.push([d, r]); if (best.length === K) best.sort((x, y) => x[0] - y[0]); }
    else if (d < best[K - 1][0]) { best[K - 1] = [d, r]; best.sort((x, y) => x[0] - y[0]); }
  }
  return best.sort((x, y) => x[0] - y[0]).map(([, r]) => r);
}
// fits with: loops that would play together with a loop anchor. key fits (camelot) unless the key lock is on
// (then everything gets moved into one key anyway), bpm within 6% or half/double unless the bpm lock is on.
// best fit first: same key, relative, a fifth, then least stretch
function fitsWith(a) {
  if (a._kind !== 'loop') return [];
  const p = state.prefs;
  const out = [];
  for (const r of state.view) {
    if (r === a || r._kind !== 'loop') continue;
    let rel = 0;
    if (!p.lockKey) {
      if (!a.key || !a.scale || !r.key || !r.scale) continue;
      rel = Keys.keyRelation(a.key, a.scale, r.key, r.scale);
      if (rel < 0) continue;
    }
    let off = 0;
    if (!p.sync) {
      if (!a.bpm || !r.bpm) continue;
      off = Keys.bpmFit(a.bpm, r.bpm);
      if (off == null) continue;
    } else if (r.bpm) off = Math.abs(Math.log(p.syncBpm / r.bpm)); // locked: least stretch first
    else off = 9;
    out.push([rel * 10 + off, r]);
  }
  return out.sort((x, y) => x[0] - y[0]).slice(0, 60).map(([, r]) => r);
}

function setAnchor(r) {
  map.anchor = r;
  map.step = -1;
  relist();
}
function relist() {
  const a = map.anchor;
  map.list = !a ? [] : map.tab === 'similar' ? similarTo(a) : fitsWith(a);
  renderSide();
  drawMap();
}

// ---------- layout + hit testing ----------
const GRID = 64;
function mapRefilter() {
  map.pts = [];
  for (const r of state.view) if (r.mx != null) map.pts.push({ r, u: r.mx, v: r.my });
  map.grid = Array.from({ length: GRID * GRID }, () => []);
  // strays can sit a little outside 0..1: they go in the edge cells
  const cell = (u) => Math.max(0, Math.min(GRID - 1, Math.floor(u * GRID)));
  for (const p of map.pts) map.grid[cell(p.u) * GRID + cell(p.v)].push(p);
  // the anchor's list follows the filters
  if (map.anchor && state.mode === 'map') { map.list = map.tab === 'similar' ? similarTo(map.anchor) : fitsWith(map.anchor); renderSide(); }
  mapStatus();
  drawMap();
}
const radius = () => Math.max(2, Math.min(7, 2.2 * Math.sqrt(map.view.s / map.base)));
function hit(x, y) {
  const { s, ox, oy } = map.view;
  const u = (x - ox) / s, v = (y - oy) / s;
  const rad = (radius() + 3) / s;
  let best = null, bd = rad * rad;
  const cell = (w) => Math.max(0, Math.min(GRID - 1, Math.floor(w * GRID)));
  for (let gx = cell(u - rad); gx <= cell(u + rad); gx++) {
    for (let gy = cell(v - rad); gy <= cell(v + rad); gy++) {
      for (const p of map.grid[gx * GRID + gy]) { const d = (p.u - u) ** 2 + (p.v - v) ** 2; if (d <= bd) { bd = d; best = p; } }
    }
  }
  return best;
}

// ---------- drawing ----------
let drawQueued = false;
function drawMap() {
  if (state.mode !== 'map' || drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; paint(); });
}
function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}
function fit() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const s = Math.min(w, h) * 0.92;
  map.base = s;
  map.view = { s, ox: (w - s) / 2, oy: (h - s) / 2 };
  map.fitted = w > 0;
}
// move the map so r sits in the middle, zoomed in a little if it's zoomed right out
function centerOn(r) {
  if (r.mx == null) return;
  if (!map.fitted) fit();
  const v = map.view;
  if (v.s < map.base * 3) v.s = map.base * 3;
  v.ox = canvas.clientWidth / 2 - r.mx * v.s;
  v.oy = canvas.clientHeight / 2 - r.my * v.s;
}
const sx = (p) => p.u * map.view.s + map.view.ox;
const sy = (p) => p.v * map.view.s + map.view.oy;
function paint() {
  const { w, h } = sizeCanvas();
  if (!map.fitted) fit();
  g2.clearRect(0, 0, w, h);
  const rad = radius();
  // dots, batched by colour
  const by = {};
  for (const p of map.pts) {
    const x = sx(p), y = sy(p);
    if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
    (by[colorOf(p.r)] = by[colorOf(p.r)] || []).push(x, y);
  }
  g2.globalAlpha = map.anchor ? 0.55 : 0.85;
  for (const [c, xy] of Object.entries(by)) {
    g2.fillStyle = c;
    g2.beginPath();
    for (let i = 0; i < xy.length; i += 2) { g2.moveTo(xy[i] + rad, xy[i + 1]); g2.arc(xy[i], xy[i + 1], rad, 0, Math.PI * 2); }
    g2.fill();
  }
  g2.globalAlpha = 1;
  const at = (r) => (r.mx == null ? null : { x: r.mx * map.view.s + map.view.ox, y: r.my * map.view.s + map.view.oy });
  const a = map.anchor;
  const pa = a && at(a);
  // fits with: lines from the anchor
  if (pa && map.tab === 'fits') {
    g2.strokeStyle = 'rgba(94,224,255,.28)';
    g2.lineWidth = 1;
    g2.beginPath();
    for (const r of map.list) { const q = at(r); if (q) { g2.moveTo(pa.x, pa.y); g2.lineTo(q.x, q.y); } }
    g2.stroke();
  }
  // circles: the list, nearest 8 strongest, then 16, then the rest
  map.list.forEach((r, i) => {
    const q = at(r);
    if (!q) return;
    g2.fillStyle = colorOf(r);
    g2.beginPath(); g2.arc(q.x, q.y, rad + 1, 0, Math.PI * 2); g2.fill();
    g2.strokeStyle = i < 8 ? 'rgba(230,242,255,.95)' : i < 16 ? 'rgba(230,242,255,.55)' : 'rgba(230,242,255,.28)';
    g2.lineWidth = i < 8 ? 2 : 1.5;
    g2.beginPath(); g2.arc(q.x, q.y, rad + 4, 0, Math.PI * 2); g2.stroke();
  });
  // favourites: a gold ring
  g2.strokeStyle = '#ffd25e'; g2.lineWidth = 2;
  g2.beginPath();
  for (const p of map.pts) {
    if (!p.r.fav) continue;
    const x = sx(p), y = sy(p);
    g2.moveTo(x + rad + 2.5, y); g2.arc(x, y, rad + 2.5, 0, Math.PI * 2);
  }
  g2.stroke();
  // selection, playing, anchor
  for (const id of state.sel) {
    const r = state.byId.get(id); const q = r && at(r);
    if (!q) continue;
    g2.strokeStyle = '#5ee0ff'; g2.lineWidth = 3;
    g2.beginPath(); g2.arc(q.x, q.y, rad + 6, 0, Math.PI * 2); g2.stroke();
  }
  if (pa) {
    g2.fillStyle = colorOf(a);
    g2.beginPath(); g2.arc(pa.x, pa.y, rad + 4, 0, Math.PI * 2); g2.fill();
    g2.strokeStyle = '#ffffff'; g2.lineWidth = 2.5;
    g2.beginPath(); g2.arc(pa.x, pa.y, rad + 9, 0, Math.PI * 2); g2.stroke();
  }
  const pr = state.playingId && state.byId.get(state.playingId);
  const pp = pr && at(pr);
  if (pp) { g2.strokeStyle = '#5ee0ff'; g2.lineWidth = 1.5; g2.setLineDash([3, 3]); g2.beginPath(); g2.arc(pp.x, pp.y, rad + 13, 0, Math.PI * 2); g2.stroke(); g2.setLineDash([]); }
  if (map.hover) { const q = at(map.hover); if (q) { g2.strokeStyle = '#e6f2ff'; g2.lineWidth = 1.5; g2.beginPath(); g2.arc(q.x, q.y, rad + 3, 0, Math.PI * 2); g2.stroke(); } }
}

// ---------- side panel ----------
function renderSide() {
  const a = map.anchor;
  $('#sideTitle').textContent = a ? a.name : 'nothing picked';
  $('#sideTitle').title = a ? a.name : '';
  $('#sideHint').hidden = !!a;
  $('#matchKeyBox').hidden = map.tab !== 'similar';
  $('#matchKey').disabled = !(a && a.key && a.scale);
  document.querySelectorAll('#sideTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === map.tab));
  let empty = '';
  if (a && !map.list.length) {
    if (map.tab === 'fits' && a._kind !== 'loop') empty = 'fits with is for loops';
    else if (map.tab === 'fits') empty = !state.prefs.lockKey && !(a.key && a.scale) ? 'needs a key with major/minor' : !state.prefs.sync && !a.bpm ? 'needs a bpm' : 'nothing shown fits';
    else empty = a._z ? 'nothing shown is close' : 'not measured yet, press scan';
  }
  $('#sideEmpty').textContent = empty;
  $('#sideEmpty').hidden = !empty;
  const rows = map.list.map((r, i) => {
    const d = document.createElement('div');
    d.className = 'srow' + (i === map.step ? ' on' : '') + (state.playingId === r.id ? ' playing' : '');
    d.draggable = true;
    d.dataset.i = i;
    d.innerHTML = '<span class="dot"></span><span class="sname"></span><span class="sbpm"></span><span class="skey"></span>';
    d.children[0].style.background = colorOf(r);
    // names in a pack often start the same: cut from the left so the end shows
    d.children[1].textContent = '\u200e' + (r.fav ? '★ ' : '') + r.name.replace(/\.[^.]+$/, '') + '\u200e';
    d.children[1].title = r.name + '\n' + r.folder;
    d.children[2].textContent = fmtBpmShown(r);
    d.children[3].textContent = fmtKeyShown(r);
    return d;
  });
  $('#sideList').replaceChildren(...rows);
  const on = $('#sideList').children[map.step];
  if (on) on.scrollIntoView({ block: 'nearest' });
}
$('#sideTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  map.tab = b.dataset.tab;
  map.step = -1;
  relist();
});
$('#matchKey').addEventListener('change', (e) => { map.matchKey = e.target.checked; map.step = -1; relist(); });
$('#sideList').addEventListener('mousedown', (e) => {
  const el = e.target.closest('.srow');
  if (!el || e.button !== 0) return;
  stepTo(+el.dataset.i);
});
$('#sideList').addEventListener('dblclick', (e) => { const el = e.target.closest('.srow'); if (el) setAnchor(map.list[+el.dataset.i]); });
$('#sideList').addEventListener('dragstart', (e) => {
  e.preventDefault();
  const el = e.target.closest('.srow');
  if (el) dragOut([map.list[+el.dataset.i]]);
});
$('#sideList').addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.srow');
  if (!el) return;
  const r = map.list[+el.dataset.i];
  pickOnly(r);
  rowMenu(r);
});
$('#rebuildMap').addEventListener('click', async () => {
  if (!(await window.shelf.rebuildMap())) return;
  map.progress = 'laying out…';
  mapStatus();
});

function mapStatus() {
  const shown = state.view.filter((r) => !r.error).length;
  const on = map.pts.length;
  const bits = [];
  if (map.progress) bits.push(map.progress);
  if (shown - on) bits.push(`${n(shown - on)} not on the map yet${state.scanning ? '' : ' (scan measures them)'}`);
  $('#mapNote').textContent = bits.join(' · ');
  $('#mapEmpty').hidden = on > 0 || !state.all.length;
}

// ---------- picking + playing ----------
// select one sample without the list's cursor/range logic
function pickOnly(r) {
  state.sel.clear(); state.sel.add(r.id);
  const i = state.view.indexOf(r);
  if (i >= 0) { state.cursor = i; state.rangeStart = i; }
}
function audition(r) {
  pickOnly(r);
  play(r, { toggle: false });
  drawMap();
}
function stepTo(i) {
  if (!map.list.length) return;
  map.step = Math.max(0, Math.min(map.list.length - 1, i));
  audition(map.list[map.step]);
  renderSide();
}
// called by play(): what got played goes on the history (unless we're walking the history)
let walking = false;
function mapPlayed(r) {
  if (walking) return;
  if (map.history[map.hpos] === r.id) return;
  map.history = map.history.slice(0, map.hpos + 1);
  map.history.push(r.id);
  if (map.history.length > 200) map.history.shift();
  map.hpos = map.history.length - 1;
}
function walk(d) {
  const i = map.hpos + d;
  const r = state.byId.get(map.history[i]);
  if (!r) return;
  map.hpos = i;
  walking = true;
  audition(r);
  walking = false;
  map.step = map.list.indexOf(r);
  renderSide();
}

// ---------- mouse ----------
let drag = null; // { mode: 'sweep'|'pan', x, y, moved, last }
canvas.addEventListener('mousedown', (e) => {
  const x = e.offsetX, y = e.offsetY;
  const p = hit(x, y);
  if (e.button === 0 && e.ctrlKey && p) {
    // ctrl+drag a dot drags it (or the selection it's in) out to the daw
    if (!state.sel.has(p.r.id)) { pickOnly(p.r); drawMap(); }
    canvas.draggable = true;
    return;
  }
  canvas.draggable = false;
  if (e.button === 1 || e.button === 2) { drag = { mode: 'pan', x, y, moved: false, p, ox: map.view.ox, oy: map.view.oy }; e.preventDefault(); return; }
  if (e.button !== 0) return;
  drag = { mode: 'sweep', x, y, moved: false, last: p && p.r };
  if (p) {
    if (e.shiftKey) { state.sel.has(p.r.id) ? state.sel.delete(p.r.id) : state.sel.add(p.r.id); drawMap(); return; }
    setAnchor(p.r);
    audition(p.r);
  }
});
canvas.addEventListener('dragstart', (e) => {
  e.preventDefault();
  dragOut([...state.sel].map((id) => state.byId.get(id)));
  canvas.draggable = false;
});
window.addEventListener('mousemove', (e) => {
  if (state.mode !== 'map') return;
  const b = canvas.getBoundingClientRect();
  const x = e.clientX - b.left, y = e.clientY - b.top;
  if (drag) {
    if (Math.abs(x - drag.x) + Math.abs(y - drag.y) > 3) drag.moved = true;
    if (drag.mode === 'pan') { map.view.ox = drag.ox + x - drag.x; map.view.oy = drag.oy + y - drag.y; drawMap(); return; }
    // sweep: every new dot it passes plays, the newest cuts the last
    const p = hit(x, y);
    if (p && p.r !== drag.last) { drag.last = p.r; audition(p.r); }
  }
  if (e.target !== canvas) { if (map.hover) { map.hover = null; tip.hidden = true; drawMap(); } return; }
  const p = hit(x, y);
  const r = p && p.r;
  canvas.style.cursor = r ? (e.ctrlKey ? 'grab' : 'pointer') : drag && drag.mode === 'pan' ? 'grabbing' : 'default';
  if (r !== map.hover) { map.hover = r; drawMap(); }
  if (!r) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.replaceChildren();
  const name = document.createElement('b'); name.textContent = r.name;
  const bits = [r._kind === 'loop' ? 'loop' : 'one-shot', r._sound ? r._sound + (r._soundWord ? '' : '?') : '', r.bpm && fmtBpmShown(r) + ' bpm', fmtKeyShown(r)].filter(Boolean);
  const info = document.createElement('div'); info.textContent = bits.join(' · ');
  tip.append(name, info);
  tip.style.left = Math.min(x + 14, b.width - tip.offsetWidth - 6) + 'px';
  tip.style.top = Math.max(4, y - tip.offsetHeight - 10) + 'px';
});
window.addEventListener('mouseup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  canvas.draggable = false;
  // a sweep ends on the last sound it played: that's the new anchor
  if (d.mode === 'sweep' && d.moved && d.last && d.last !== map.anchor) setAnchor(d.last);
  // right-click without dragging on a dot = the usual menu
  if (d.mode === 'pan' && !d.moved && e.button === 2 && d.p) { pickOnly(d.p.r); drawMap(); rowMenu(d.p.r); }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mouseleave', () => { if (!drag) { map.hover = null; tip.hidden = true; drawMap(); } });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = Math.exp(-e.deltaY * 0.0015);
  const v = map.view;
  const s = Math.max(map.base * 0.5, Math.min(map.base * 60, v.s * k));
  const f = s / v.s;
  v.ox = e.offsetX - (e.offsetX - v.ox) * f;
  v.oy = e.offsetY - (e.offsetY - v.oy) * f;
  v.s = s;
  drawMap();
}, { passive: false });
canvas.addEventListener('dblclick', (e) => { if (!hit(e.offsetX, e.offsetY)) { fit(); drawMap(); } });
window.addEventListener('resize', () => { if (state.mode === 'map') { const was = map.base; fit(); if (!was) map.fitted = true; drawMap(); } });

// ---------- keys (only while the map shows) ----------
function mapKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!map.anchor) { const r = state.byId.get([...state.sel][0]); if (r) setAnchor(r); else return true; }
    const d = (e.key === 'ArrowDown' ? 1 : -1) * (e.shiftKey ? 5 : 1);
    stepTo(map.step < 0 && d < 0 ? 0 : map.step + d);
    return true;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); walk(e.key === 'ArrowLeft' ? -1 : 1); return true; }
  if (e.key === 'Enter') {
    e.preventDefault();
    const r = map.list[map.step] || state.byId.get([...state.sel][0]);
    if (r) setAnchor(r);
    return true;
  }
  return false;
}

// ---------- switching views ----------
function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('mapmode', mode === 'map');
  document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === mode));
  tip.hidden = true;
  if (mode === 'map') {
    if (!map.fitted) fit();
    // the list's pick becomes the anchor
    if (!map.anchor) { const r = state.byId.get([...state.sel][0]); if (r) map.anchor = r; }
    mapRefilter();
    if (map.anchor) relist(); else renderSide();
  } else {
    render();
    if (state.cursor >= 0) scrollTo(state.cursor);
  }
}
$('#viewSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === state.mode) return;
  setMode(b.dataset.v);
  state.prefs.view = state.mode;
  window.shelf.setPrefs(state.prefs);
});

// positions arrive from the layout worker
window.shelf.on('map:progress', (m) => { map.progress = m.what + (m.pct != null ? ` ${m.pct}%` : ''); mapStatus(); });
window.shelf.on('map:done', (m) => {
  for (const r of state.all) {
    const p = m.pos[r.id];
    if (p) { r.mx = p[0]; r.my = p[1]; }
    r.soundGuess = m.sound[r.id];
    r._sound = r._soundWord || r.soundGuess || null;
  }
  map.progress = '';
  if (state.mode === 'map') mapRefilter(); else mapStatus();
});
