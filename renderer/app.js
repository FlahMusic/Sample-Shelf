/* global Keys, kindOf, isDrum, isVocal, soundOf, SignalsmithStretch, map, mapRefilter, drawMap, renderSide, mapPlayed, mapKey, mapStatus, setMode, relist, centerOn */
const $ = (s) => document.querySelector(s);
const ROW = 30;
const PITCH_IDX = Object.fromEntries(Keys.PITCHES.map((p, i) => [p, i]));
// sound colours: the list, the sound filter and the map all use these (bright, for the dark windows)
const COLORS = { kick: '#ff5c8a', snare: '#ff9a4d', hat: '#4da3ff', perc: '#ffd24d', bass: '#a585ff', keys: '#3fe0d0', vocal: '#e07bff', fx: '#9fb3d9', loop: '#4dffa6', none: '#5a6f94' };
const SOUND_NAMES = ['kick', 'snare', 'hat', 'perc', 'bass', 'keys', 'vocal', 'fx'];
// names sort like people read them: "kick 2" before "kick 10"
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const state = {
  all: [],
  byId: new Map(),
  view: [],
  sort: { key: 'name', dir: 1 },
  sel: new Set(),
  rangeStart: -1, // where a shift-click range starts
  cursor: -1,
  playingId: null,
  mode: 'list', // or 'map'
  scanning: false,
  settings: { roots: [], hidden: [], libDir: null },
  scanRoot: null, // folder the scan is in right now
  prefs: { autoplay: true, sync: false, syncBpm: 120, lockKey: false, lockRoot: 'A', lockScale: 'minor', view: 'list', volume: 0.8, even: false, tree: true },
  filt: { loop: true, oneshot: true, fav: false, keys: new Set(), sounds: new Set(), bpmMin: null, bpmMax: null, dir: null },
  treeOpen: new Set(),
  treeSig: '',
};

// ---------- audio engine (signalsmith stretch) ----------
// two stretch nodes ("decks"). each play goes to the idle one so the old one can fade out with no gap
let ctx = null;
let decks = [];
let lead = 0; // how far ahead to schedule so the node's latency is covered
let live = null; // { deck, rec, t0, input0, rate, dur, loop, timer }
let master = null; // volume
let last = null; // { rec, buf, peaks } of the last sound played, for the waveform
let playToken = 0;
let idleTimer = null;
let engineReady = null;
const FADE = 0.03;
// stft block length. the 120 ms default plays bass ~4.5 cents sharp on average (max 7) on flah's bass loops;
// 240 ms brings it to ~1 (max 2.6), with drum pre-echo about the same (-17.6 vs -18.1 dB). costs ~60 ms more start delay
const BLOCK_MS = 240;

function engine() {
  if (!engineReady) engineReady = (async () => {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = state.prefs.volume ** 2;
    master.connect(ctx.destination);
    // load the worklet from the package file instead of its default blob: url, so the csp stays 'self'
    SignalsmithStretch.moduleUrl = new URL('../node_modules/signalsmith-stretch/SignalsmithStretch.js', location.href).href;
    for (let i = 0; i < 2; i++) {
      const node = await SignalsmithStretch(ctx);
      await node.configure({ blockMs: BLOCK_MS });
      const gain = ctx.createGain();
      gain.gain.value = 0;
      node.connect(gain).connect(master);
      decks.push({ node, gain });
    }
    // latency() is input + output latency; only the output part needs covering.
    // measured on this pc: half of it starts sounds with nothing cut off
    lead = (await decks[0].node.latency()) / 2 + 0.01;
  })();
  return engineReady;
}

async function decode(r) {
  const bytes = await window.shelf.readAudio(r.wav);
  return ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

// where in the source file a playing sound is at audio time t
function posAt(p, t) {
  const pos = p.input0 + Math.max(0, t - p.t0) * p.rate;
  return p.loop ? pos % p.dur : pos;
}

function fadeOut(p, t) {
  clearTimeout(p.timer);
  const g = p.deck.gain.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(0, t + FADE);
  if (p.src) p.src.stop(t + FADE);
  else p.deck.node.schedule({ active: false, output: t + FADE });
}

// keepPos: same file carries on from where it is (used when switching between plain and stretched).
// at: start this many seconds into the file (seek, or 0 = from the top)
function startDeck(r, buf, keepPos, at) {
  clearTimeout(idleTimer);
  if (ctx.state !== 'running') ctx.resume();
  const rate = rateFor(r);
  const semis = semisFor(r);
  // nothing to stretch or shift: play the file as is. no stretcher colour, and it starts sooner
  const plain = rate === 1 && semis === 0;
  const t0 = ctx.currentTime + (plain ? 0.02 : lead);
  const loop = r._kind === 'loop';
  let input0 = 0;
  if (at != null) input0 = Math.max(0, Math.min(at, buf.duration - 0.01));
  else if (keepPos && live) input0 = posAt(live, t0);
  // in-time swap: with bpm sync on, the next loop picks up on the same beat the last one was on
  else if (live && live.loop && loop && state.prefs.sync && live.rec.bpm && r.bpm) {
    const beats = posAt(live, t0) * live.rec.bpm / 60;
    const newBeats = buf.duration * r.bpm / 60;
    input0 = (beats % newBeats) * 60 / r.bpm;
  }
  const deck = live && live.deck === decks[0] ? decks[1] : decks[0];
  if (live) fadeOut(live, t0);
  let src = null;
  if (plain) {
    src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.connect(deck.gain);
    src.start(t0, input0);
  } else {
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    deck.node.dropBuffers();
    deck.node.addBuffers(chans);
    // vocals keep their formants when shifted, so they don't go chipmunk
    deck.node.schedule({ active: true, input: input0, output: t0, rate, semitones: semis, formantCompensation: r._vocal, loopStart: 0, loopEnd: loop ? buf.duration : 0 });
  }
  const g = deck.gain.gain;
  g.cancelScheduledValues(0);
  g.setValueAtTime(0, ctx.currentTime);
  g.setValueAtTime(0, t0);
  g.linearRampToValueAtTime(evenGain(buf), t0 + 0.004);
  live = { deck, src, buf, rec: r, t0, input0, rate, semis, dur: buf.duration, loop };
  if (!last || last.buf !== buf) last = { rec: r, buf, peaks: null };
  waveLoop();
  if (!loop) {
    const p = live;
    p.timer = setTimeout(() => { if (live === p) stop(); }, (t0 - ctx.currentTime + (buf.duration - input0) / rate) * 1000 + 50);
  }
}

// nothing playing for a while: suspend so the two stretch nodes stop using cpu
function idleLater() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!live && ctx) ctx.suspend(); }, 5000);
}

// ---------- formatting ----------
const fmtBpm = (b) => (b == null ? '' : Number.isInteger(b) ? String(b) : String(Math.round(b * 100) / 100));
const fmtKey = (r) => (r.key ? r.key + (r.scale === 'minor' ? ' min' : r.scale === 'major' ? ' maj' : '') : '');
// a key or note that isn't stated in the file name (or its tags, or by you) is a guess: it gets a ?
const guessed = (r) => r.keySrc === 'auto' || r.keySrc === 'folder';
const fmtKeyShown = (r) => (r._kind === 'oneshot' ? r.key || '' : fmtKey(r)) + (r.key && guessed(r) ? '?' : '');
const fmtBpmShown = (r) => fmtBpm(r.bpm) + (r.bpm && r.bpmSrc === 'auto' ? '?' : '');
const fmtLen = (d) => {
  if (!d && d !== 0) return '';
  if (d < 60) return d.toFixed(d < 10 ? 1 : 0) + 's';
  const m = Math.floor(d / 60); const s = Math.round(d % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (t) => {
  if (!t) return '';
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const n = (x) => x.toLocaleString();
const keyId = (root, scale) => `${root}|${scale}`;
const keyLabel = (root, scale) => root + (scale === 'minor' ? 'm' : '');

// ---------- search box ----------
function tokenize(q) {
  const out = [];
  const re = /(-?)(\w+:)?("([^"]*)"|\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    const neg = m[1] === '-';
    const field = m[2] ? m[2].slice(0, -1).toLowerCase() : null;
    let val = m[4] !== undefined ? m[4] : m[3];
    if (field) val = val.replace(/^"|"$/g, '');
    out.push({ neg, field, val: val.toLowerCase(), raw: val });
  }
  return out;
}
function numTest(spec) {
  let m;
  if ((m = spec.match(/^([\d.]+)-([\d.]+)$/))) { const a = +m[1], b = +m[2]; return (v) => v != null && v >= a && v <= b; }
  if ((m = spec.match(/^>=?([\d.]+)$/))) { const a = +m[1]; return (v) => v != null && v >= a; }
  if ((m = spec.match(/^<=?([\d.]+)$/))) { const a = +m[1]; return (v) => v != null && v <= a; }
  if ((m = spec.match(/^([\d.]+)$/))) { const a = +m[1]; return (v) => v != null && Math.abs(v - a) < 0.5; }
  return () => false;
}
function keyTest(raw) {
  const m = raw.trim().match(/^([A-Ga-g])([#b♯♭]?)\s*(major|minor|maj|min|m|M)?$/);
  if (!m) return () => false;
  const root = Keys.normRoot(m[1] + m[2]);
  const scale = m[3] ? Keys.normScale(m[3]) : null;
  return (r) => r.key === root && (!scale || r.scale === scale);
}

// most specific folder wins: an unticked folder inside a ticked one stays hidden, and the other way round
const rootPrefix = (root) => { const l = root.toLowerCase(); return /[\\/]$/.test(l) ? l : l + '\\'; };
function rootMatcher() {
  const list = state.settings.roots.map((root) => [rootPrefix(root), root]).sort((a, b) => b[0].length - a[0].length);
  return (p) => { for (const [pre, root] of list) if (p.startsWith(pre)) return root; return null; };
}
function hiddenTest() {
  if (!state.settings.hidden.length) return null;
  const match = rootMatcher();
  const off = new Set(state.settings.hidden);
  return (r) => off.has(match(r._pl));
}

function buildFilter() {
  const tests = [];
  const hid = hiddenTest();
  if (hid) tests.push((r) => !hid(r));
  const f = state.filt;
  // checkboxes: both on or both off = everything
  if (f.loop !== f.oneshot) { const want = f.loop ? 'loop' : 'oneshot'; tests.push((r) => r._kind === want); }
  if (f.fav) tests.push((r) => r.fav);
  if (f.sounds.size) tests.push((r) => f.sounds.has(r._sound));
  if (f.dir) tests.push((r) => r._pl.startsWith(f.dir));
  if (f.keys.size) tests.push((r) => r.key && (f.keys.has(keyId(r.key, r.scale)) || (!r.scale && [...f.keys].some((k) => k.startsWith(r.key + '|')))));
  if (f.bpmMin != null) tests.push((r) => r.bpm != null && r.bpm >= f.bpmMin);
  if (f.bpmMax != null) tests.push((r) => r.bpm != null && r.bpm <= f.bpmMax);

  for (const t of tokenize($('#q').value)) {
    let fn;
    switch (t.field) {
      case 'bpm': { const nt = numTest(t.val); fn = (r) => nt(r.bpm); break; }
      case 'len': case 'length': { const nt = numTest(t.val); fn = (r) => nt(r.duration); break; }
      case 'key': fn = keyTest(t.raw); break;
      case 'scale': { const s = Keys.normScale(t.val); fn = (r) => r.scale === s; break; }
      case 'sound': fn = (r) => !!r._sound && r._sound.startsWith(t.val); break;
      case 'tag': fn = (r) => (r.tags || []).some((x) => x.toLowerCase().includes(t.val)); break;
      case 'ext': case 'type': fn = (r) => r.ext === t.val.replace(/^\./, ''); break;
      default: {
        const word = t.field ? `${t.field}:${t.val}` : t.val;
        fn = (r) => r._hay.includes(word);
      }
    }
    tests.push(t.neg ? (r) => !fn(r) : fn);
  }
  return (r) => tests.every((fn) => fn(r));
}

function prep(r) {
  r._pl = r.path.toLowerCase();
  r._hay = `${r.name} ${r.folder} ${(r.tags || []).join(' ')}`.toLowerCase();
  r._kind = kindOf(r);
  r._drum = isDrum(r);
  r._vocal = isVocal(r);
  r._soundWord = soundOf(r);
  r._sound = r._soundWord || r.soundGuess || null;
}

function sortFn() {
  const { key, dir } = state.sort;
  const get = {
    name: (r) => r.name,
    bpm: (r) => r.bpm,
    key: (r) => (r.key ? PITCH_IDX[r.key] * 2 + (r.scale === 'minor' ? 1 : 0) : null),
    duration: (r) => r.duration,
    kind: (r) => r._kind,
    sound: (r) => r._sound,
    folder: (r) => r.folder,
    added: (r) => r.added,
  }[key];
  return (a, b) => {
    const x = get(a), y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string') return natural.compare(x, y) * dir;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  };
}

function refilter() {
  const f = buildFilter();
  // same file in two places = one row
  const dupes = new Map();
  for (const r of state.all) if (r.qhash) dupes.set(r.qhash, (dupes.get(r.qhash) || 0) + 1);
  const seen = new Set();
  state.view = state.all.filter(f).sort(sortFn()).filter((r) => {
    r._dupes = r.qhash ? dupes.get(r.qhash) - 1 : 0;
    if (!r.qhash) return true;
    if (seen.has(r.qhash)) return false;
    seen.add(r.qhash);
    return true;
  });
  state.cursor = Math.min(state.cursor, state.view.length - 1);
  document.querySelectorAll('.head [data-sort]').forEach((el) => {
    el.classList.toggle('asc', el.dataset.sort === state.sort.key && state.sort.dir === 1);
    el.classList.toggle('desc', el.dataset.sort === state.sort.key && state.sort.dir === -1);
  });
  $('#spacer').style.height = state.view.length * ROW + 'px';
  $('#empty').hidden = state.all.length > 0;
  const fl = state.filt;
  $('#clearFilters').hidden = !(fl.loop !== fl.oneshot || fl.fav || fl.keys.size || fl.sounds.size || fl.bpmMin != null || fl.bpmMax != null);
  render();
  renderTree();
  if (state.mode === 'map') mapRefilter();
  const v = state.view.length;
  // status strip: shown · on the shelf · hidden. same audio in two places is one sample
  const hid = hiddenTest();
  const shown = new Map(); // sample -> has a copy in a ticked folder
  for (const r of state.all) { const k = r.qhash || r.id; shown.set(k, shown.get(k) || !(hid && hid(r))); }
  const shelf = shown.size;
  let hidden = 0;
  for (const s of shown.values()) if (!s) hidden++;
  $('#count').textContent = `${n(v)} shown · ${n(shelf)} on the shelf` + (hidden ? ` · ${n(hidden)} in unticked folders` : '');
}

// ---------- rows (only the visible ones exist) ----------
const list = $('#list');
const pool = [];
function rowEl(i) {
  let el = pool[i];
  if (!el) {
    el = document.createElement('div');
    el.className = 'row';
    el.draggable = true;
    el.innerHTML = '<div class="play">▶</div><div class="name"></div><div class="wave"><canvas></canvas></div><div class="num bpm"></div><div class="keyc"></div><div class="num len"></div><div class="kind"><span></span></div><div class="snd"><span><i></i><b></b></span></div><div class="tags"></div><div class="folder"></div><div class="added"></div>';
    list.appendChild(el);
    pool[i] = el;
  }
  return el;
}
const srcLabel = (s) => ({ auto: 'detected, could be off (double-click to confirm or fix)', name: 'from file name', folder: 'from folder name, could be off (double-click to confirm or fix)', tag: 'from file tags', user: 'set by you' }[s] || '');

function render() {
  if (state.mode === 'map') { drawMap(); return; }
  const top = list.scrollTop;
  const h = list.clientHeight;
  const first = Math.max(0, Math.floor(top / ROW) - 4);
  const last = Math.min(state.view.length, Math.ceil((top + h) / ROW) + 4);
  let used = 0;
  for (let i = first; i < last; i++) {
    const r = state.view[i];
    const el = rowEl(used++);
    el.style.display = '';
    el.style.top = i * ROW + 'px';
    el.dataset.i = i;
    el.classList.toggle('sel', state.sel.has(r.id));
    el.classList.toggle('playing', state.playingId === r.id);
    el.classList.toggle('err', !!r.error);
    const c = el.children;
    c[0].textContent = state.playingId === r.id ? '■' : r.error ? '!' : '▶';
    const star = document.createElement('span');
    star.className = 'star' + (r.fav ? ' on' : '');
    star.textContent = '★';
    star.title = r.fav ? 'unfavourite (f)' : 'favourite (f)';
    c[1].replaceChildren(star, r.name);
    c[1].title = r.error ? `couldn't read: ${r.error}` : r._dupes ? `${r.name}\nsame file is in ${r._dupes} other place${r._dupes > 1 ? 's' : ''}, shown once` : r.name;
    drawRowWave(c[2].firstChild, r, state.sel.has(r.id) || state.playingId === r.id);
    c[3].textContent = fmtBpmShown(r);
    c[3].className = 'num bpm ' + (r.bpmSrc || '');
    c[3].title = srcLabel(r.bpmSrc);
    const x = xposeFor(r);
    c[4].textContent = x && x.semis ? `${fmtKeyShown(r)} → ${fmtKey(x.to)} · ${fmtSemis(x.semis)}` : fmtKeyShown(r);
    if (r._kind === 'oneshot' && r.key) { const l = document.createElement('span'); l.className = 'notelbl'; l.textContent = 'note'; c[4].append(' ', l); }
    c[4].className = 'keyc ' + (r.keySrc || '') + (x && x.semis ? ' shifted' : '');
    c[4].title = srcLabel(r.keySrc) + (x ? '\n' + x.why : '');
    if (x && x.badge) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = x.badge; c[4].append(c[4].textContent ? ' ' : '', b); }
    c[5].textContent = fmtLen(r.duration);
    c[6].firstChild.textContent = r._kind === 'loop' ? 'loop' : 'one-shot';
    c[6].firstChild.className = r._kind;
    c[6].className = 'kind' + (r.kindUser ? ' user' : '');
    c[6].title = r.kindUser ? 'set by you' : '';
    const snd = r._sound;
    c[7].className = 'snd' + (snd && !r._soundWord ? ' auto' : '');
    c[7].style.setProperty('--c', COLORS[snd] || COLORS.none);
    c[7].firstChild.style.display = snd ? '' : 'none';
    c[7].firstChild.lastChild.textContent = snd ? snd + (r._soundWord ? '' : '?') : '';
    c[7].title = snd ? (r._soundWord ? 'from the name' : 'a guess from what it sounds like') : '';
    c[8].replaceChildren(...(r.tags || []).map((t) => { const s = document.createElement('span'); s.className = 'chip'; s.textContent = t; return s; }));
    c[9].textContent = '‎' + r.folder + '‎';
    c[9].title = r.folder;
    c[10].textContent = fmtDate(r.added);
  }
  for (let j = used; j < pool.length; j++) pool[j].style.display = 'none';
  askPeaks();
}
list.addEventListener('scroll', () => requestAnimationFrame(render));
window.addEventListener('resize', () => requestAnimationFrame(render));

// ---------- row waveforms: worked out by main the first time a row shows, then kept ----------
const pkWant = new Set();
let pkTimer = 0;
function askPeaks() {
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].style.display === 'none') continue;
    const r = state.view[+pool[i].dataset.i];
    if (r && r.pk === undefined && !r._pkReq && r.wav && !r.error) { r._pkReq = true; pkWant.add(r.id); }
  }
  if (pkWant.size && !pkTimer) pkTimer = setTimeout(fetchPeaks, 60);
}
async function fetchPeaks() {
  const ids = [...pkWant].slice(0, 40);
  ids.forEach((id) => pkWant.delete(id));
  try {
    const got = await window.shelf.peaks(ids);
    for (const id of ids) { const r = state.byId.get(id); if (r) r.pk = got[id] ?? null; }
  } catch { /* no waveform for these */ }
  pkTimer = 0;
  if (state.mode === 'list') render();
  if (pkWant.size) pkTimer = setTimeout(fetchPeaks, 0);
}
function drawRowWave(cv, r, lit) {
  const sig = r.id + (lit ? '+' : '') + (r.pk ? 1 : 0);
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv._sig === sig && cv.width === Math.round(w * dpr)) return;
  cv._sig = sig;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!r.pk) { g.fillStyle = 'rgba(110,170,255,.18)'; g.fillRect(0, h / 2 - 0.5, w, 1); return; }
  if (!r._pk) r._pk = Uint8Array.from(atob(r.pk), (ch) => ch.charCodeAt(0));
  const bins = r._pk.length, bw = w / bins;
  g.fillStyle = lit ? '#5ee0ff' : '#4a7fcf';
  for (let b = 0; b < bins; b++) {
    const a = Math.max(0.5, (r._pk[b] / 255) * (h / 2 - 1));
    g.fillRect(b * bw, h / 2 - a, Math.max(1, bw - 0.6), a * 2);
  }
}

// ---------- folder tree: one folder (and everything in it) at a time ----------
const dirKey = (p) => p.toLowerCase().replace(/[\\/]+$/, '') + '\\';
let tree = [];
function buildTree() {
  const match = rootMatcher();
  const hid = hiddenTest();
  const tops = new Map();
  const node = (name, key, flag) => ({ name, key, kids: new Map(), ids: new Set(), direct: 0, ...flag });
  for (const root of state.settings.roots) tops.set(dirKey(root), node(folderName(root), dirKey(root), { root: true }));
  for (const r of state.all) {
    if (hid && hid(r)) continue;
    const root = match(r._pl);
    // samples outside every scan folder (from an older scan) hang off their drive
    const base = root ? root.replace(/[\\/]+$/, '') : r.folder.split(/[\\/]/)[0];
    const k0 = dirKey(base);
    let at = tops.get(k0);
    if (!at) { at = node(base, k0, { other: true }); tops.set(k0, at); }
    const sample = r.qhash || r.id;
    at.ids.add(sample);
    for (const part of r.folder.slice(base.length).split(/[\\/]/).filter(Boolean)) {
      const k = at.key + part.toLowerCase() + '\\';
      let kid = at.kids.get(k);
      if (!kid) { kid = node(part, k); at.kids.set(k, kid); }
      kid.ids.add(sample);
      at = kid;
    }
    at.direct++;
  }
  // a folder holding nothing but one folder shows as one row: "Packs\Drums" instead of two levels
  const done = (n) => {
    let name = n.name, cur = n;
    while (!cur.root && cur.kids.size === 1 && !cur.direct) { cur = [...cur.kids.values()][0]; name += '\\' + cur.name; }
    return { name, key: cur.key, root: !!n.root, other: !!n.other, count: n.ids.size, kids: [...cur.kids.values()].map(done).sort((x, y) => natural.compare(x.name, y.name)) };
  };
  const all = [...tops.values()].filter((t) => t.root || t.ids.size);
  tree = all.filter((t) => t.root).concat(all.filter((t) => !t.root).sort((x, y) => natural.compare(x.name, y.name))).map(done);
  if (tree.length === 1 && !state.treeOpen.size) state.treeOpen.add(tree[0].key);
}
function renderTree() {
  if (!state.prefs.tree) return;
  const sig = state.all.length + '|' + state.settings.roots.join('|') + '|' + state.settings.hidden.join('|');
  if (sig !== state.treeSig) { state.treeSig = sig; buildTree(); }
  const out = [];
  const walk = (node, depth) => {
    const el = document.createElement('div');
    el.className = 'tnode' + (node.root ? ' root' : '') + (state.filt.dir === node.key ? ' on' : '');
    el.style.paddingLeft = 6 + depth * 12 + 'px';
    el.dataset.k = node.key;
    const open = state.treeOpen.has(node.key);
    el.innerHTML = '<span class="tw"></span><span class="tn"></span><span class="tc"></span>';
    el.children[0].textContent = node.kids.length ? (open ? '▼' : '▶') : '';
    el.children[1].textContent = node.name;
    el.children[2].textContent = n(node.count);
    el.title = node.name;
    out.push(el);
    if (open) for (const k of node.kids) walk(k, depth + 1);
  };
  let other = false;
  for (const t of tree) {
    if (t.other && !other) { other = true; const h = document.createElement('div'); h.className = 'treesub'; h.textContent = 'outside your scan folders'; out.push(h); }
    walk(t, 0);
  }
  if (!tree.length) { const el = document.createElement('div'); el.className = 'popsub'; el.style.padding = '4px 12px'; el.textContent = 'add a folder to browse it here'; out.push(el); }
  $('#treeList').replaceChildren(...out);
}
const findNode = (k, nodes = tree) => { for (const t of nodes) { if (t.key === k) return t; const f = findNode(k, t.kids); if (f) return f; } return null; };
$('#treeList').addEventListener('click', (e) => {
  const el = e.target.closest('.tnode');
  if (!el) return;
  const k = el.dataset.k;
  if (e.target.closest('.tw')) { state.treeOpen.has(k) ? state.treeOpen.delete(k) : state.treeOpen.add(k); renderTree(); return; }
  const node = findNode(k);
  state.filt.dir = state.filt.dir === k ? null : k;
  if (state.filt.dir && node && node.kids.length) state.treeOpen.add(k);
  list.scrollTop = 0;
  refilter();
});
function showTree(on) {
  state.prefs.tree = on;
  document.body.classList.toggle('notree', !on);
  $('#treeShow').hidden = on;
  if (on) renderTree();
  requestAnimationFrame(render);
}
// hiding the tree also lets go of its folder, so nothing stays filtered out of sight
$('#treeHide').addEventListener('click', () => { showTree(false); savePrefs(); if (state.filt.dir) { state.filt.dir = null; refilter(); } });
$('#treeShow').addEventListener('click', () => { showTree(true); savePrefs(); });

// ---------- even volume: every sound at about the same loudness ----------
// the loudest 50 ms of the sound goes to about -16 dBFS rms, never past full scale, at most 4x up or down
const evenCache = new WeakMap();
function evenGain(buf) {
  if (!state.prefs.even) return 1;
  let g = evenCache.get(buf);
  if (g) return g;
  const ch = [];
  for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
  const win = Math.max(1, Math.round(buf.sampleRate * 0.05));
  let top = 0, peak = 0;
  for (let s = 0; s < ch[0].length; s += win) {
    let sum = 0;
    const e = Math.min(ch[0].length, s + win);
    for (let j = s; j < e; j++) for (const d of ch) { const v = d[j]; sum += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
    top = Math.max(top, sum / ((e - s) * ch.length));
  }
  const rms = Math.sqrt(top);
  g = rms > 1e-5 ? Math.min(4, Math.max(0.25, 0.158 / rms), peak > 0 ? 0.98 / peak : 4) : 1;
  evenCache.set(buf, g);
  return g;
}
$('#even').addEventListener('change', (e) => {
  state.prefs.even = e.target.checked;
  savePrefs();
  if (live) live.deck.gain.gain.setTargetAtTime(evenGain(live.buf), ctx.currentTime, 0.03);
});

// ---------- random: play one from what's shown ----------
function playRandom() {
  if (!state.view.length) return;
  const i = Math.floor(Math.random() * state.view.length);
  const r = state.view[i];
  select(i);
  if (state.mode === 'map') { map.anchor = r; map.step = -1; centerOn(r); relist(); }
  else scrollTo(i);
  play(r, { toggle: false });
}
$('#rnd').addEventListener('click', playRandom);

// ---------- selection + playback ----------
const rowIndex = (e) => { const el = e.target.closest('#list .row'); return el ? +el.dataset.i : -1; };

function select(i, e) {
  const r = state.view[i];
  if (!r) return;
  if (e && e.shiftKey && state.rangeStart >= 0) {
    state.sel.clear();
    const [a, b] = [Math.min(state.rangeStart, i), Math.max(state.rangeStart, i)];
    for (let k = a; k <= b; k++) state.sel.add(state.view[k].id);
  } else if (e && (e.ctrlKey || e.metaKey)) {
    state.sel.has(r.id) ? state.sel.delete(r.id) : state.sel.add(r.id);
    state.rangeStart = i;
  } else {
    state.sel.clear(); state.sel.add(r.id); state.rangeStart = i;
  }
  state.cursor = i;
  render();
}

function rateFor(r) {
  if (!state.prefs.sync || r._kind !== 'loop' || !r.bpm) return 1;
  const rate = state.prefs.syncBpm / r.bpm;
  return rate >= 0.25 && rate <= 4 ? rate : 1;
}
// what the key lock does to a loop. one-shots aren't touched this round (pitched ones just show their note)
function xposeFor(r) {
  const p = state.prefs;
  if (!p.lockKey || r._kind !== 'loop') return null;
  if (r.xposeUser === 'off') return { badge: 'not transposed', why: 'you set this to never transpose' };
  if (r._drum && r.xposeUser !== 'on') return { why: 'drums: tempo only, no transpose (right-click to change)' };
  if (!r.key) return { badge: 'no key', why: 'no key known, so it plays as is' };
  if (!r.scale) return { badge: 'no scale', why: 'major or minor not known, so it plays as is. right-click to set it' };
  if (guessed(r) && r.xposeUser !== 'on') return { badge: 'as is', why: 'the file name doesn\'t say the key, so it plays as is. double-click the key to confirm or fix it' };
  const semis = Keys.lockShift(r.key, r.scale, p.lockRoot, p.lockScale);
  const to = Keys.lockedKey(r.scale, p.lockRoot, p.lockScale);
  return { semis, to: { key: to.root, scale: to.scale }, why: guessed(r) ? 'the key is a guess (you chose to transpose it anyway)' : '' };
}
function semisFor(r) { const x = xposeFor(r); return x && x.semis ? x.semis : 0; }
const fmtSemis = (s) => (s > 0 ? '+' + s : s < 0 ? '−' + -s : '0');
function nowText(r) {
  const bits = [];
  if (rateFor(r) !== 1) bits.push(`${fmtBpm(r.bpm)} → ${state.prefs.syncBpm} bpm`);
  else if (r.bpm) bits.push(fmtBpmShown(r) + ' bpm');
  const x = xposeFor(r);
  if (x && x.semis) bits.push(`${fmtKeyShown(r)} → ${fmtKey(x.to)}`);
  else if (r.key) bits.push(fmtKeyShown(r));
  bits.push(fmtLen(r.duration));
  $('#pname').textContent = r.name;
  $('#pname').title = r.path;
  $('#pmeta').textContent = bits.join(' · ');
}

function stop() {
  playToken++;
  if (live) { fadeOut(live, ctx.currentTime); live = null; idleLater(); }
  state.playingId = null; $('#pp').textContent = '▶'; render(); drawWave();
  if (state.mode === 'map') renderSide();
}
// at: seconds into the file to start from (seek, or 0 = from the top, no in-time swap)
async function play(r, { toggle = true, at = null } = {}) {
  if (!r || !r.wav || r.error) return;
  if (toggle && state.playingId === r.id) { stop(); return; }
  const token = ++playToken;
  state.playingId = r.id;
  $('#pp').textContent = '■';
  nowText(r);
  render();
  mapPlayed(r);
  if (state.mode === 'map') renderSide();
  try {
    await engine();
    if (ctx.state !== 'running') await ctx.resume();
    const buf = last && last.rec === r ? last.buf : await decode(r);
    if (token !== playToken) return; // something else got picked while this loaded
    startDeck(r, buf, false, at);
  } catch (err) {
    if (token !== playToken) return;
    setStatus(`can't play: ${err.message}`);
    stop();
  }
}

function scrollTo(i) {
  const top = i * ROW;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + ROW > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW - list.clientHeight;
}

list.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('.cell-edit')) return;
  const i = rowIndex(e);
  if (i < 0) return;
  if (e.target.classList.contains('chip')) { addToSearch(`tag:${quote(e.target.textContent)}`); return; }
  if (e.target.classList.contains('star')) { setFav([state.view[i]], !state.view[i].fav); return; }
  if (e.target.closest('.play')) { select(i); play(state.view[i]); return; }
  if (state.sel.has(state.view[i].id) && state.sel.size > 1 && !e.shiftKey && !e.ctrlKey) return; // keep group for dragging
  select(i, e);
  if (state.prefs.autoplay && !e.shiftKey && !e.ctrlKey) play(state.view[i], { toggle: false });
});
list.addEventListener('click', (e) => {
  const i = rowIndex(e);
  if (i >= 0 && !e.shiftKey && !e.ctrlKey && !e.target.closest('.play') && !e.target.classList.contains('chip') && state.sel.size > 1) select(i);
});
list.addEventListener('dblclick', (e) => {
  const i = rowIndex(e);
  if (i < 0) return;
  const cell = e.target.closest('.bpm, .keyc');
  if (cell) editCell(state.view[i], cell);
  else if (!state.prefs.autoplay) play(state.view[i]);
});
list.addEventListener('contextmenu', (e) => {
  const i = rowIndex(e);
  if (i < 0) return;
  if (!state.sel.has(state.view[i].id)) select(i);
  rowMenu(state.view[i]);
});
// right-click menu for the selection (r = the one clicked). the list and the map both use it
async function rowMenu(r) {
  const ids = [...state.sel];
  const action = await window.shelf.contextMenu({ count: ids.length, hasRoot: ids.some((id) => state.byId.get(id)?.key), measured: r.mx != null, allFav: ids.every((id) => state.byId.get(id)?.fav) });
  if (action === 'reveal') window.shelf.reveal(r.wav || r.path);
  else if (action === 'similar') { map.anchor = r; map.tab = 'similar'; map.step = -1; if (state.mode !== 'map') { setMode('map'); state.prefs.view = 'map'; savePrefs(); } centerOn(r); relist(); }
  else if (action === 'loop' || action === 'oneshot') { applyUpdates(await window.shelf.update(ids, { kindUser: action })); refilter(); }
  else if (action === 'autokind') { applyUpdates(await window.shelf.update(ids, { kindUser: null })); refilter(); }
  else if (action === 'xposeOn' || action === 'xposeOff' || action === 'xposeAuto') {
    applyUpdates(await window.shelf.update(ids, { xposeUser: action === 'xposeOn' ? 'on' : action === 'xposeOff' ? 'off' : null }));
    retime();
  }
  else if (action === 'fav') favSelected();
  else if (action === 'remove') removeSelected();
  else if (action === 'major' || action === 'minor') { applyUpdates(await window.shelf.update(ids, { scale: action })); retime(); }
}

// native drag out to studio one / explorer
list.addEventListener('dragstart', (e) => {
  e.preventDefault();
  const i = rowIndex(e);
  if (i < 0) return;
  if (!state.sel.has(state.view[i].id)) select(i);
  dragOut([...state.sel].map((id) => state.byId.get(id)));
});
// the preview stops when something gets dragged out, so it doesn't play over the daw
function dragOut(recs) {
  const files = recs.filter((r) => r && r.wav && !r.error).map((r) => r.wav);
  if (!files.length) return;
  stop();
  window.shelf.drag(files);
}

const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
function addToSearch(tok) {
  const q = $('#q');
  if (!q.value.split(/\s+/).includes(tok)) q.value = (q.value.trim() + ' ' + tok).trim();
  refilter();
}

// ---------- editing ----------
function editCell(r, cell) {
  const isBpm = cell.classList.contains('bpm');
  const input = document.createElement('input');
  input.className = 'cell-edit';
  input.value = isBpm ? fmtBpm(r.bpm) : fmtKey(r).replace(' min', 'm').replace(' maj', '');
  input.placeholder = isBpm ? '120' : 'Am';
  cell.replaceChildren(input);
  input.focus(); input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    if (commit) {
      const v = input.value.trim();
      let patch = null;
      if (isBpm) {
        const b = v === '' ? null : parseFloat(v);
        if (v === '' || (b > 20 && b < 400)) patch = { bpm: b };
      } else if (v === '') patch = { key: null };
      else { const k = Keys.keyFromTag(v); if (k) patch = { key: k.root, scale: k.scale }; }
      if (patch) { applyUpdates(await window.shelf.update([r.id], patch)); refilter(); return; }
    }
    render();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// favourites: a star, and the "favourites" filter
async function setFav(recs, on) {
  applyUpdates(await window.shelf.update(recs.map((r) => r.id), { fav: on }));
  if (state.filt.fav) refilter();
  if (state.mode === 'map') { drawMap(); renderSide(); }
}
function favSelected() {
  const recs = [...state.sel].map((id) => state.byId.get(id)).filter(Boolean);
  if (recs.length) setFav(recs, !recs.every((r) => r.fav));
}
// ½× / 2×: fixes a tempo that came out at double or half. on the selected loops, else the playing one
async function scaleBpm(f) {
  let recs = [...state.sel].map((id) => state.byId.get(id)).filter((r) => r && r.bpm && r._kind === 'loop');
  if (!recs.length && state.playingId) recs = [state.byId.get(state.playingId)].filter((r) => r && r.bpm && r._kind === 'loop');
  if (!recs.length) { setStatus('select a loop with a bpm first'); return; }
  for (const r of recs) applyUpdates(await window.shelf.update([r.id], { bpm: Math.round(r.bpm * f * 100) / 100 }));
  refilter(); retime();
  setStatus(recs.length === 1 ? `${recs[0].name}: ${fmtBpm(recs[0].bpm)} bpm` : `${recs.length} loops ${f < 1 ? 'halved' : 'doubled'}`);
}
$('#halfBpm').addEventListener('click', () => scaleBpm(0.5));
$('#dblBpm').addEventListener('click', () => scaleBpm(2));
$('#fFav').addEventListener('change', (e) => { state.filt.fav = e.target.checked; refilter(); });

function applyUpdates(recs) {
  for (const r of recs || []) {
    const cur = state.byId.get(r.id);
    if (cur) { Object.assign(cur, r); for (const k of ['kindUser', 'xposeUser', 'fav']) if (!(k in r)) delete cur[k]; prep(cur); }
  }
  render();
}

async function removeSelected() {
  const ids = [...state.sel];
  if (!ids.length) return;
  dropLocal(await window.shelf.remove(ids));
}
function dropLocal(res) {
  if (!res) return;
  if (res.why) { setStatus(res.why); return; }
  const gone = new Set(res.removed);
  if (state.playingId && gone.has(state.playingId)) stop();
  state.all = state.all.filter((r) => !gone.has(r.id));
  for (const id of gone) { state.byId.delete(id); state.sel.delete(id); }
  refilter();
  setStatus(`removed ${n(gone.size)} · deleted ${n(res.deleted)} wav cop${res.deleted === 1 ? 'y' : 'ies'}`);
}

function openTagger() {
  if (!state.sel.size) return;
  const inp = $('#taginput');
  inp.value = '';
  inp.placeholder = `add tags to ${state.sel.size} — comma between`;
  $('#tagger').hidden = false; inp.focus();
}
$('#taginput').addEventListener('keydown', async (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') { $('#tagger').hidden = true; return; }
  if (e.key !== 'Enter') return;
  const tags = e.target.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  $('#tagger').hidden = true;
  if (tags.length) applyUpdates(await window.shelf.update([...state.sel], { addTags: tags }));
});
$('#tagger').addEventListener('mousedown', (e) => { if (e.target.id === 'tagger') $('#tagger').hidden = true; });
list.addEventListener('mousedown', async (e) => {
  if (!e.altKey || !e.target.classList.contains('chip')) return;
  e.stopImmediatePropagation();
  const i = rowIndex(e);
  applyUpdates(await window.shelf.update([state.view[i].id], { removeTag: e.target.textContent }));
}, true);

// ---------- filter bar ----------
$('#fLoop').addEventListener('change', (e) => { state.filt.loop = e.target.checked; refilter(); });
$('#fShot').addEventListener('change', (e) => { state.filt.oneshot = e.target.checked; refilter(); });
function readBpm(el) { const v = parseFloat(el.value); return v > 0 ? v : null; }
let bTimer;
for (const id of ['#bpmMin', '#bpmMax']) {
  $(id).addEventListener('input', () => {
    clearTimeout(bTimer);
    bTimer = setTimeout(() => { state.filt.bpmMin = readBpm($('#bpmMin')); state.filt.bpmMax = readBpm($('#bpmMax')); refilter(); }, 150);
  });
}

// key picker: 12 major on top, 12 minor below, pick as many as you want
const grid = $('#keyGrid');
for (const scale of ['major', 'minor']) {
  for (const root of Keys.PITCHES) {
    const b = document.createElement('button');
    b.textContent = keyLabel(root, scale);
    b.dataset.k = keyId(root, scale);
    b.addEventListener('click', () => {
      const k = b.dataset.k;
      state.filt.keys.has(k) ? state.filt.keys.delete(k) : state.filt.keys.add(k);
      syncKeys(); refilter();
    });
    grid.appendChild(b);
  }
}
function syncKeys() {
  grid.querySelectorAll('button').forEach((b) => b.classList.toggle('on', state.filt.keys.has(b.dataset.k)));
  const chips = [...state.filt.keys].map((k) => {
    const [root, scale] = k.split('|');
    const c = document.createElement('span');
    c.className = 'kchip';
    c.innerHTML = '<span></span><b>×</b>';
    c.firstChild.textContent = keyLabel(root, scale);
    c.addEventListener('click', () => { state.filt.keys.delete(k); syncKeys(); refilter(); });
    return c;
  });
  $('#keyChips').replaceChildren(...chips);
}
$('#keyNone').addEventListener('click', () => { state.filt.keys.clear(); syncKeys(); refilter(); });

// sound picker: kick, snare, hat... as many as you want. the map's legend picks the same ones
const sgrid = $('#soundGrid');
for (const snd of SOUND_NAMES) {
  const b = document.createElement('button');
  b.innerHTML = '<i></i><span></span>';
  b.style.setProperty('--c', COLORS[snd]);
  b.lastChild.textContent = snd;
  b.dataset.s = snd;
  b.addEventListener('click', () => toggleSound(snd));
  sgrid.appendChild(b);
}
function toggleSound(snd) {
  const f = state.filt.sounds;
  f.has(snd) ? f.delete(snd) : f.add(snd);
  syncSounds(); refilter();
}
function syncSounds() {
  const f = state.filt.sounds;
  sgrid.querySelectorAll('button').forEach((b) => b.classList.toggle('on', f.has(b.dataset.s)));
  document.querySelectorAll('#legend span[data-s]').forEach((el) => el.classList.toggle('on', f.has(el.dataset.s)));
  $('#soundChips').replaceChildren(...[...f].map((snd) => {
    const c = document.createElement('span');
    c.className = 'kchip';
    c.innerHTML = '<i></i><span></span><b>×</b>';
    c.style.setProperty('--c', COLORS[snd]);
    c.children[1].textContent = snd;
    c.addEventListener('click', () => toggleSound(snd));
    return c;
  }));
}
$('#soundNone').addEventListener('click', () => { state.filt.sounds.clear(); syncSounds(); refilter(); });
$('#soundBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePop($('#soundPop'), $('#soundBtn')); });

function togglePop(pop, btn) {
  const open = pop.hidden;
  document.querySelectorAll('.pop').forEach((p) => { p.hidden = true; });
  if (!open) return;
  pop.hidden = false;
  // under its button, pushed left if it would run off the window
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12)) + 'px';
  pop.style.top = r.bottom + 8 + 'px';
}
$('#keyBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePop($('#keyPop'), $('#keyBtn')); });
$('#foldersBtn').addEventListener('click', (e) => { e.stopPropagation(); renderFolders(); togglePop($('#foldersPop'), $('#foldersBtn')); });
$('#help').addEventListener('click', (e) => { e.stopPropagation(); togglePop($('#helpbox'), $('#help')); });
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.pop') && !e.target.closest('#keyBtn, #soundBtn, #foldersBtn, #help, #lockKeyBtn, #scan')) document.querySelectorAll('.pop').forEach((p) => { p.hidden = true; });
});

$('#clearFilters').addEventListener('click', () => {
  Object.assign(state.filt, { loop: true, oneshot: true, fav: false, bpmMin: null, bpmMax: null });
  state.filt.keys.clear();
  state.filt.sounds.clear();
  syncSounds();
  $('#fLoop').checked = true; $('#fShot').checked = true; $('#fFav').checked = false; $('#bpmMin').value = ''; $('#bpmMax').value = '';
  syncKeys(); refilter();
});

// ---------- preview settings ----------
function savePrefs() { window.shelf.setPrefs(state.prefs); }
$('#autoplay').addEventListener('change', (e) => { state.prefs.autoplay = e.target.checked; savePrefs(); });
const lockTint = () => {
  $('#lockBpm').classList.toggle('on', state.prefs.sync);
  $('#lockKeyBox').classList.toggle('on', state.prefs.lockKey);
  $('#lockKeyBtn').textContent = fmtKey({ key: state.prefs.lockRoot, scale: state.prefs.lockScale });
  document.body.classList.toggle('keylocked', state.prefs.lockKey);
};
function lockChanged() { lockTint(); savePrefs(); render(); retime(); }
$('#lockKey').addEventListener('change', (e) => { state.prefs.lockKey = e.target.checked; lockChanged(); });
// lock key picker: one key, picking one turns the lock on
const lockGrid = $('#lockGrid');
for (const scale of ['major', 'minor']) {
  for (const root of Keys.PITCHES) {
    const b = document.createElement('button');
    b.textContent = keyLabel(root, scale);
    b.addEventListener('click', () => {
      Object.assign(state.prefs, { lockRoot: root, lockScale: scale, lockKey: true });
      $('#lockKey').checked = true;
      $('#lockKeyPop').hidden = true;
      lockChanged();
    });
    lockGrid.appendChild(b);
  }
}
$('#lockKeyBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  lockGrid.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', Keys.PITCHES[i % 12] === state.prefs.lockRoot && (i < 12 ? 'major' : 'minor') === state.prefs.lockScale));
  togglePop($('#lockKeyPop'), $('#lockKeyBtn'));
});
$('#sync').addEventListener('change', (e) => { state.prefs.sync = e.target.checked; lockTint(); savePrefs(); retime(); });
$('#syncBpm').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  if (v >= 20 && v <= 400) { state.prefs.syncBpm = v; savePrefs(); retime(); }
});
// bpm or key lock changed: the playing loop follows without restarting
function retime() {
  const r = state.playingId && state.byId.get(state.playingId);
  if (r) nowText(r); // may still be loading; startDeck picks up the new settings then
  if (!live || !live.loop || live.rec !== r) return; // one-shots always play as is
  const rate = rateFor(r);
  const semis = semisFor(r);
  if (rate === live.rate && semis === live.semis) return;
  if (live.src || (rate === 1 && semis === 0)) { startDeck(r, live.buf, true); return; } // plain <-> stretched
  const t = ctx.currentTime + lead;
  live.input0 = posAt(live, t);
  live.t0 = t;
  live.rate = rate;
  live.semis = semis;
  live.deck.node.schedule({ rate, semitones: semis, output: t });
}

// ---------- player strip: waveform with playhead, click to play from there, volume ----------
const wave = $('#wave');
const wg = wave.getContext('2d');
let waveRaf = 0;
function peaksOf(buf, cols) {
  const ch = [];
  for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
  const len = ch[0].length;
  const out = new Float32Array(cols);
  for (let i = 0; i < cols; i++) {
    let m = 0;
    for (let j = Math.floor((i * len) / cols), e = Math.floor(((i + 1) * len) / cols); j < e; j++) for (const d of ch) { const v = Math.abs(d[j]); if (v > m) m = v; }
    out[i] = m;
  }
  return out;
}
function drawWave() {
  const dpr = window.devicePixelRatio || 1;
  const w = wave.clientWidth, h = wave.clientHeight;
  if (!w) return;
  if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr); }
  wg.setTransform(dpr, 0, 0, dpr, 0, 0);
  wg.clearRect(0, 0, w, h);
  if (!last) return;
  if (!last.peaks || last.peaks.length !== Math.floor(w)) last.peaks = peaksOf(last.buf, Math.floor(w));
  let top = 0;
  for (const v of last.peaks) top = Math.max(top, v);
  const k = (h / 2 - 2) / (top || 1);
  const playing = live && live.rec === last.rec;
  const at = playing ? posAt(live, Math.max(ctx.currentTime, live.t0)) / live.dur : -1;
  const cut = Math.floor(at * w);
  for (let x = 0; x < last.peaks.length; x++) {
    const a = Math.max(0.5, last.peaks[x] * k);
    wg.fillStyle = x < cut ? '#5ee0ff' : '#3a64a8';
    wg.fillRect(x, h / 2 - a, 1, a * 2);
  }
  if (playing) { wg.fillStyle = '#ffffff'; wg.fillRect(cut, 0, 1.5, h); }
}
function waveLoop() {
  cancelAnimationFrame(waveRaf);
  const tick = () => { drawWave(); if (live) waveRaf = requestAnimationFrame(tick); };
  tick();
}
wave.addEventListener('mousedown', (e) => {
  if (!last) return;
  const at = (e.offsetX / wave.clientWidth) * last.buf.duration;
  // same sound playing: carry on from there. otherwise play the last sound from there
  if (live && live.rec === last.rec) startDeck(last.rec, last.buf, false, at);
  else play(last.rec, { toggle: false, at });
});
$('#pp').addEventListener('click', () => { if (state.playingId) stop(); else play(last ? last.rec : state.view[state.cursor]); });
$('#vol').addEventListener('input', (e) => {
  state.prefs.volume = +e.target.value;
  if (master) master.gain.setTargetAtTime(state.prefs.volume ** 2, ctx.currentTime, 0.02);
  savePrefs();
});
window.addEventListener('resize', () => { if (last) { last.peaks = null; drawWave(); } });

// ---------- folders popover ----------
const TRASH = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
const folderName = (root) => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root;
function renderFolders() {
  const s = state.settings;
  const match = rootMatcher();
  const counts = new Map();
  for (const r of state.all) { const root = match(r._pl); if (root) (counts.get(root) || counts.set(root, new Set()).get(root)).add(r.qhash || r.id); }
  const rows = s.roots.map((root) => {
    const off = s.hidden.includes(root);
    const d = document.createElement('label');
    d.className = 'rootrow' + (off ? ' off' : '');
    d.innerHTML = '<input type="checkbox"><div><div class="rname"></div><div class="rinfo"></div></div><span class="rcount"></span><button class="ghost" title="remove this folder and its samples from the shelf">' + TRASH + '</button>';
    const [box, text, count, del] = d.children;
    box.checked = !off;
    text.firstChild.textContent = folderName(root);
    text.lastChild.textContent = '‎' + root + '‎';
    text.title = root;
    const c = counts.has(root) ? counts.get(root).size : 0;
    count.textContent = state.scanRoot === root ? 'scanning…' : `${n(c)} sample${c === 1 ? '' : 's'}`;
    box.addEventListener('change', () => setHidden(box.checked ? s.hidden.filter((x) => x !== root) : [...s.hidden, root]));
    del.addEventListener('click', async (e) => {
      e.preventDefault();
      const res = await window.shelf.removeRoot(root);
      if (!res) return;
      applySettings(res.settings);
      if (res.res.removed.length) dropLocal(res.res); else refilter();
      renderFolders();
    });
    return d;
  });
  if (!rows.length) { const d = document.createElement('div'); d.className = 'rootrow none'; d.textContent = 'no folders yet'; rows.push(d); }
  $('#rootList').replaceChildren(...rows);
  $('#enableAll').disabled = !s.hidden.length;
  $('#libPath').textContent = s.libDir ? '‎' + s.libDir + '‎' : 'not set yet (asked on first scan)';
  $('#libPath').title = s.libDir || '';
  $('#prune').disabled = !s.roots.length;
}
async function setHidden(list) {
  applySettings(await window.shelf.setHidden(list));
  refilter();
  renderFolders();
}
function applySettings(s) { if (s) state.settings = { ...state.settings, ...s }; }
$('#addRoot').addEventListener('click', async () => { applySettings(await window.shelf.addRoot()); refilter(); renderFolders(); });
$('#enableAll').addEventListener('click', () => setHidden([]));
$('#changeLib').addEventListener('click', async () => { const d = await window.shelf.pickLib(); if (d) { state.settings.libDir = d; renderFolders(); } });
$('#prune').addEventListener('click', async () => dropLocal(await window.shelf.prune()));
$('#clearAll').addEventListener('click', async () => dropLocal(await window.shelf.clear()));

// ---------- keyboard ----------
const MOVES = { ArrowDown: 1, ArrowUp: -1, PageDown: 'page', PageUp: '-page', Home: 'home', End: 'end' };
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = tag === 'INPUT' && !['checkbox', 'range'].includes(document.activeElement.type);
  if (e.key === 'Escape') {
    // closes what's open first; with nothing open it stops the preview
    const open = [...document.querySelectorAll('.pop')].filter((p) => !p.hidden);
    open.forEach((p) => { p.hidden = true; });
    if (document.activeElement === $('#q') && $('#q').value) { $('#q').value = ''; refilter(); return; }
    if (typing) { document.activeElement.blur(); return; }
    if (!open.length) stop();
    return;
  }
  if (state.mode === 'map' && (!typing || document.activeElement === $('#q')) && mapKey(e)) return;
  const mv = MOVES[e.key];
  const inSearch = document.activeElement === $('#q');
  if (mv && (!typing || (inSearch && typeof mv === 'number')) && state.mode === 'list') {
    e.preventDefault();
    if (!state.view.length) return;
    const page = Math.max(1, Math.floor(list.clientHeight / ROW) - 1);
    const to = { page: state.cursor + page, '-page': state.cursor - page, home: 0, end: state.view.length - 1 }[mv] ?? state.cursor + mv;
    const i = Math.max(0, Math.min(state.view.length - 1, to));
    const wasPlaying = !!state.playingId;
    select(i, e.shiftKey ? e : null);
    scrollTo(i);
    if (state.prefs.autoplay || wasPlaying) play(state.view[i], { toggle: false });
    return;
  }
  if (typing) { if (e.key === 'Enter') document.activeElement.blur(); return; }
  if (e.key === ' ') { e.preventDefault(); play(state.view[state.cursor] || (last && last.rec)); }
  else if (e.key === 'Enter') { e.preventDefault(); play(state.view[state.cursor], { toggle: false, at: 0 }); }
  else if (e.key.toLowerCase() === 't') { e.preventDefault(); openTagger(); }
  else if (e.key.toLowerCase() === 'f' && !e.ctrlKey) { e.preventDefault(); favSelected(); }
  else if (e.key === 'Delete') { e.preventDefault(); removeSelected(); }
  else if (e.key.toLowerCase() === 'r' && !e.ctrlKey) { e.preventDefault(); playRandom(); }
  else if (e.key === '/' || (e.ctrlKey && e.key.toLowerCase() === 'f')) { e.preventDefault(); $('#q').focus(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); state.view.forEach((r) => state.sel.add(r.id)); render(); }
});

let qTimer;
$('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(refilter, 120); });
document.querySelectorAll('.head [data-sort]').forEach((el) => el.addEventListener('click', () => {
  const k = el.dataset.sort;
  state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'added' ? -1 : 1) };
  refilter();
}));

// ---------- scanning ----------
function setStatus(t) { $('#status').textContent = t; }
function setScanning(on) {
  state.scanning = on;
  if (state.mode === 'map') mapStatus();
  $('#scan').textContent = on ? 'stop' : 'scan';
  $('#scan').classList.toggle('on', on);
  $('#bar').classList.toggle('busy', on);
}
const MODEL_BYTES = 117528416;
const size = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' gb' : Math.max(1, Math.round(b / 1e6)) + ' mb');
// pressing scan first checks what's new and how much room the wav copies take. it only asks when that's
// 50 mb or more, a folder looks like a program's or holds songs, or the drive would get tight
let checking = false, check = null;
async function toggleScan() {
  if (state.scanning) { await window.shelf.stopScan(); setScanning(false); setStatus('stopped'); return; }
  if (checking) { await window.shelf.stopCheck(); return; }
  checking = true;
  $('#scan').textContent = 'checking…';
  setStatus('checking folders…');
  const c = await window.shelf.scanCheck();
  checking = false;
  $('#scan').textContent = 'scan';
  if (!c.ok) {
    setStatus(c.why || 'stopped');
    if (c.needRoots) { renderFolders(); togglePop($('#foldersPop'), $('#foldersBtn')); }
    return;
  }
  check = c;
  for (const g of c.groups) g.on = !g.skipped && !g.program && !g.factory && !g.long;
  const { bytes } = checkTotals();
  const tight = c.free != null && c.free - bytes - c.model < 5e9 && bytes + c.model > 0;
  if (bytes < 50e6 && !c.model && c.measure < 500 && !tight && !c.groups.some((g) => !g.skipped && (g.program || g.factory || g.long))) { startScan(); return; }
  renderCheck();
  togglePop($('#scanPop'), $('#scan'));
  setStatus('');
}
function checkTotals() {
  let fresh = 0, copy = 0, bytes = 0;
  for (const g of check.groups) if (g.on) { fresh += g.fresh; copy += g.copy; bytes += g.bytes; }
  return { fresh, copy, bytes };
}
function renderCheck() {
  const c = check;
  const rows = c.groups.slice().sort((a, b) => b.bytes - a.bytes).map((g) => {
    const d = document.createElement('label');
    d.className = 'rootrow' + (g.on ? '' : ' off');
    d.innerHTML = '<input type="checkbox"><div><div class="rname"></div><div class="rinfo"></div></div><span class="rcount"></span>';
    const [box, text, count] = d.children;
    box.checked = g.on;
    text.firstChild.textContent = g.path === g.root ? folderName(g.root) + ' (loose files)' : folderName(g.path);
    const why = g.program ? 'has program files' : g.factory ? 'an instrument\'s samples or preset previews?' : g.long ? `long files, songs or mixes? (${Math.round(g.median / 60)} min each)` : g.skipped ? 'skipped before' : '';
    text.lastChild.innerHTML = why ? '<span class="why"></span>' : '';
    if (why) text.lastChild.firstChild.textContent = '‎' + why + '‎'; else text.lastChild.textContent = '‎' + g.path + '‎';
    text.title = g.path;
    count.textContent = `${n(g.fresh)} new` + (g.copy ? ` · ${size(g.bytes)}` : ' · no copies');
    box.addEventListener('change', () => { g.on = box.checked; d.classList.toggle('off', !g.on); checkSummary(); });
    return d;
  });
  $('#scanList').replaceChildren(...rows);
  $('#scanOld').hidden = !c.oldBytes;
  $('#scanOld span').textContent = `${size(c.oldBytes)} of wav copies are for samples outside your scan folders`;
  checkSummary();
}
function checkSummary() {
  const c = check, t = checkTotals();
  $('#scanSum').textContent = `${n(t.fresh)} new sound${t.fresh === 1 ? '' : 's'}` + (t.copy ? ` · ${n(t.copy)} need wav copies, about ${size(t.bytes)}` : ' · all wav already, no copies');
  // about 0.6 s a sound on flah's pc (the sound model takes most of it)
  const secs = (t.fresh + c.measure) * 0.6;
  $('#scanTime').textContent = c.measure ? `${n(c.measure)} on the shelf get measured for the map too. all in, about ${secs > 5400 ? Math.round(secs / 3600) + ' h' : Math.max(1, Math.round(secs / 60)) + ' min'}. stop any time, it carries on next scan` : '';
  const need = t.bytes + c.model;
  const after = c.free - need;
  $('#scanFree').textContent = (c.model ? `first scan also downloads the sound model for the map (${size(c.model)}) · ` : '') +
    (c.free == null ? '' : `free on ${c.drive} ${size(c.free)}` + (need ? ` · ${after < 0 ? 'not enough room' : size(after) + ' after'}` : ''));
  $('#scanFree').classList.toggle('low', c.free != null && need > 0 && after < 5e9);
  $('#scanGo').disabled = c.free != null && after < 0;
}
async function startScan(opts) {
  $('#scan').textContent = 'starting…';
  const r = await window.shelf.scan(opts);
  $('#scan').textContent = 'scan';
  if (!r.ok) { setStatus(r.why); return; }
  setScanning(true); setStatus('starting…');
  applySettings(await window.shelf.init());
}
$('#scan').addEventListener('click', (e) => { e.stopPropagation(); toggleScan(); });
$('#scanGo').addEventListener('click', () => {
  $('#scanPop').hidden = true;
  startScan({ skip: check.groups.filter((g) => !g.on).map((g) => g.path), unskip: check.groups.filter((g) => g.on && g.skipped).map((g) => g.path) });
});
$('#scanCancel').addEventListener('click', () => { $('#scanPop').hidden = true; });
$('#scanPrune').addEventListener('click', async () => {
  const res = await window.shelf.prune();
  if (!res || !res.removed) return;
  const gone = new Set(res.removed);
  check.measure = state.all.filter((r) => !gone.has(r.id) && r.ana !== check.ana && r.wav && !r.error).length;
  dropLocal(res);
  check.oldBytes = 0;
  $('#scanOld').hidden = true;
  checkSummary();
});
$('#emptyBtn').addEventListener('click', (e) => { e.stopPropagation(); renderFolders(); togglePop($('#foldersPop'), $('#foldersBtn')); });

function statLine(s) {
  return `looked at ${n(s.seen)} files · ${n(s.audio)} audio · ${n(s.done)} added · ${n(s.skipped)} unchanged` + (s.analysed ? ` · ${n(s.analysed)} measured for the map` : '') + (s.failed ? ` · ${n(s.failed)} failed` : '');
}
let pending = null;
window.shelf.on('scan:record', (rec) => {
  if (rec.feat) map.zDirty = true;
  const cur = state.byId.get(rec.id);
  if (cur) {
    const stale = cur.wav !== rec.wav || cur.mtime !== rec.mtime;
    Object.assign(cur, rec);
    if (stale) { cur.pk = undefined; cur._pk = null; cur._pkReq = false; }
    prep(cur);
  }
  else { prep(rec); state.all.push(rec); state.byId.set(rec.id, rec); }
  if (!pending) pending = setTimeout(() => { pending = null; refilter(); }, 700);
});
window.shelf.on('scan:progress', (m) => {
  if (m.checking) { setStatus(`checking folders… ${n(m.stats.seen)} files`); return; }
  if (m.model != null) { setStatus(`getting the sound model for the map (${size(MODEL_BYTES)})… ${m.model}%`); return; }
  if (m.modelError) { setStatus(`couldn't get the sound model (${m.modelError}). scanning anyway, the map gets its sounds next scan`); return; }
  setStatus(statLine(m.stats) + '  ·  ' + (m.current || ''));
  const root = m.current ? rootMatcher()(m.current.toLowerCase()) : null;
  if (root !== state.scanRoot) { state.scanRoot = root; if (!$('#foldersPop').hidden) renderFolders(); }
});
window.shelf.on('scan:done', (m) => {
  setScanning(false);
  state.scanRoot = null;
  if (!$('#foldersPop').hidden) renderFolders();
  refilter();
  if (m.type === 'fatal') { setStatus('scan broke: ' + m.error.split('\n')[0]); return; }
  const cd = Object.entries(m.stats.cantDecode || {}).map(([k, v]) => `${n(v)} .${k}`).join(', ');
  setStatus('done · ' + statLine(m.stats) + (cd ? ` · skipped ${cd} (can't decode)` : ''));
});

// ---------- boot ----------
(async () => {
  // map.js loads after this file: wait for it
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r));
  const init = await window.shelf.init();
  applySettings(init);
  state.prefs = { ...state.prefs, ...(init.prefs || {}) };
  $('#autoplay').checked = state.prefs.autoplay;
  $('#sync').checked = state.prefs.sync;
  $('#lockKey').checked = state.prefs.lockKey;
  lockTint();
  $('#syncBpm').value = state.prefs.syncBpm;
  state.all = init.records;
  for (const r of state.all) { prep(r); state.byId.set(r.id, r); }
  setScanning(init.scanning);
  $('#vol').value = state.prefs.volume;
  $('#even').checked = state.prefs.even;
  showTree(state.prefs.tree !== false);
  if (init.mapping) map.progress = 'laying out…';
  syncKeys();
  syncSounds();
  refilter();
  setMode(state.prefs.view === 'map' ? 'map' : 'list');
})();
