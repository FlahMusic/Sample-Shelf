const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const K = require('./lib/keys');
const { kindOf, statedKind } = require('./lib/classify');
const crypto = require('crypto');
const { peaksOfFile } = require('./lib/peaks');
const { VERSION: ANA, MODEL } = require('./lib/clap');

const DB_FILE = path.join(app.getPath('userData'), 'shelf.json');
// hidden = scan folders that are unticked: their files stay on the shelf but don't show, and scans skip them
// skip = folders inside scan folders that you unticked before a scan: never scanned, nothing copied
let db = { libDir: null, roots: [], hidden: [], skip: [], prefs: { autoplay: true, sync: false, syncBpm: 120 }, files: {} };
let win = null;
let worker = null;
let mapper = null; // map layout worker
let saveTimer = null;

function load() {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch {}
  delete db.allDrives; // gone: add a drive as a folder instead
  // entries from before "added" existed: stamp them with when the shelf was first made
  let first = Date.now();
  try { first = fs.statSync(DB_FILE).birthtimeMs || first; } catch {}
  for (const r of Object.values(db.files)) if (!r.added) r.added = first;
  // numbers from an older way of measuring don't compare with new ones: those samples get measured again,
  // and leave the map until then
  for (const r of Object.values(db.files)) if (r.ana !== ANA && r.feat) { delete r.feat; delete r.mx; delete r.my; delete r.soundGuess; }
  rereadBpm(); // first: loop or one-shot depends on it, and folder keys only go to loops
  rereadKeys();
  // "._" macOS metadata files got onto older shelves as unreadable entries. scans skip them now
  const junk = Object.values(db.files).filter((r) => r.name.startsWith('._')).map((r) => r.id);
  if (junk.length) drop(junk);
}
// keys from file/folder names get re-read every start, so parser fixes reach old records without a rescan.
// a record whose only key came from a name the parser no longer believes gets detected again next scan
// one-shots never take a folder's key (it says nothing about one hit); "C3"-style notes in names count
function rereadKeys() {
  for (const r of Object.values(db.files)) {
    if (r.error || r.keySrc === 'tag' || r.keySrc === 'user') continue;
    const note = K.noteFromName(r.name);
    const fromName = K.keyFromName(r.name) || (note && { root: note, scale: null });
    const k = fromName || (kindOf(r) === 'loop' ? K.keyFromFolder(r.folder) : null);
    if (k) {
      // only the root came from the name: keep a detected scale if it was about the same root
      if (k.scale || r.key !== k.root) r.scale = k.scale;
      r.key = k.root;
      r.keySrc = fromName ? 'name' : 'folder';
    } else if (r.keySrc === 'name' || r.keySrc === 'folder') {
      r.key = null; r.scale = null; r.keySrc = null; r.redetect = true;
    }
  }
}
// same for a bpm read from the name: a lone number has to fit the length now. one that doesn't gets
// its tempo detected again next scan
function rereadBpm() {
  for (const r of Object.values(db.files)) {
    if (r.error || r.bpmSrc !== 'name') continue;
    const v = K.bpmFromName(r.name, r.duration);
    if (v) r.bpm = v;
    else { r.bpm = null; r.bpmSrc = null; r.redetect = true; }
  }
}
let lastSave = Date.now();
function save(now) {
  clearTimeout(saveTimer);
  const write = () => {
    lastSave = Date.now();
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  };
  // during a long scan records never stop coming, so also write at least every 30s
  if (now || Date.now() - lastSave > 30000) write(); else saveTimer = setTimeout(write, 1500);
}

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// keep what the user typed in when a file gets re-scanned
function merge(rec) {
  const prev = db.files[rec.id];
  if (prev) {
    rec.tags = prev.tags;
    rec.added = prev.added;
    if (prev.kindUser) rec.kindUser = prev.kindUser;
    if (prev.xposeUser) rec.xposeUser = prev.xposeUser;
    if (prev.fav) rec.fav = true;
    if (prev.bpmSrc === 'user') { rec.bpm = prev.bpm; rec.bpmSrc = 'user'; }
    if (prev.keySrc === 'user') { rec.key = prev.key; rec.scale = prev.scale; rec.keySrc = 'user'; }
  }
  rec.tags = rec.tags || [];
  rec.added = rec.added || Date.now();
  db.files[rec.id] = rec;
  return rec;
}

// remove entries; delete the wav copies we made for them (never an original file)
function drop(ids) {
  const gone = new Set(ids);
  const inUse = new Set();
  for (const r of Object.values(db.files)) {
    if (gone.has(r.id)) continue;
    if (r.wav) inUse.add(r.wav.toLowerCase());
    inUse.add(r.path.toLowerCase());
  }
  let deleted = 0;
  for (const id of gone) {
    const r = db.files[id];
    if (!r) continue;
    if (r.wav && r.wav !== r.path && !inUse.has(r.wav.toLowerCase())) {
      try {
        fs.rmSync(r.wav, { force: true });
        deleted++;
        inUse.add(r.wav.toLowerCase());
        const dir = path.dirname(r.wav);
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {}
    }
    delete db.files[id];
  }
  save(true);
  return { removed: [...gone], deleted };
}

// same audio in two places is one sample
const samples = (ids) => new Set(ids.map((id) => db.files[id].qhash || id)).size;

const under = (p, root) => {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

async function pickLib() {
  const r = await dialog.showOpenDialog(win, {
    title: 'pick a library folder (wav copies go here)',
    defaultPath: db.libDir || path.join(app.getPath('music'), 'Sample Shelf'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  db.libDir = r.filePaths[0];
  save(true);
  return db.libDir;
}

async function confirm(message, detail, okLabel) {
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: [okLabel, 'cancel'], defaultId: 1, cancelId: 1, message, detail });
  return r.response === 0;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 820, minWidth: 900, minHeight: 460,
    backgroundColor: '#050c1f',
    title: 'Sample Shelf',
    // the header is the title bar: windows draws its buttons on top, in the header's colours
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#081733', symbolColor: '#8fb6e0', height: 40 },
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

const settings = () => ({ libDir: db.libDir, roots: db.roots, hidden: db.hidden, prefs: db.prefs });

ipcMain.handle('init', () => ({ ...settings(), records: Object.values(db.files), scanning: !!worker, mapping: !!mapper }));
ipcMain.handle('pick-lib', () => pickLib());
ipcMain.handle('set-prefs', (_e, prefs) => { db.prefs = { ...db.prefs, ...prefs }; save(); return db.prefs; });

ipcMain.handle('add-root', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'add a folder to scan', properties: ['openDirectory', 'multiSelections'] });
  if (!r.canceled) for (const f of r.filePaths) {
    if (!db.roots.includes(f)) db.roots.push(f);
    db.hidden = db.hidden.filter((x) => x !== f);
  }
  save(true);
  return settings();
});
// removing a folder takes its files off the shelf too (unless another folder still holds them)
ipcMain.handle('remove-root', async (_e, root) => {
  const rest = db.roots.filter((x) => x !== root);
  const ids = Object.values(db.files).filter((r) => under(r.path, root) && !rest.some((o) => under(r.path, o))).map((r) => r.id);
  const n = samples(ids);
  if (ids.length && !(await confirm(`remove ${root} and its ${n.toLocaleString()} sample${n === 1 ? '' : 's'} from the shelf?`, 'the wav copies made for them get deleted too. your original files stay where they are.', 'remove'))) return null;
  db.roots = rest;
  db.hidden = db.hidden.filter((x) => x !== root);
  let res = { removed: [], deleted: 0 };
  if (ids.length) res = drop(ids); else save(true);
  return { settings: settings(), res };
});
ipcMain.handle('set-hidden', (_e, hidden) => { db.hidden = hidden.filter((x) => db.roots.includes(x)); save(true); return settings(); });

function scanRoots() {
  if (process.env.SHELF_ROOTS) return process.env.SHELF_ROOTS.split(';'); // dev/testing only
  return db.roots.filter((x) => !db.hidden.includes(x));
}
const underSkip = (p) => db.skip.some((x) => p.toLowerCase() === x.toLowerCase() || under(p, x));
// on the shelf but not in a scan folder (or in one you skipped)
const outside = (r) => !db.roots.some((root) => under(r.path, root)) || underSkip(r.path);

// before a scan: what's new under each folder and roughly how big its wav copies get, plus free space.
// nothing gets converted here
let surveyor = null;
ipcMain.handle('scan-check', async () => {
  if (worker || surveyor) return { ok: false, why: 'already scanning' };
  const roots = scanRoots();
  if (!roots.length) return { ok: false, why: db.roots.length ? 'tick a folder to scan' : 'pick a folder to scan first', needRoots: true };
  const lib = db.libDir || path.join(app.getPath('music'), 'Sample Shelf');
  let free = null;
  for (let d = lib; d; d = path.dirname(d) === d ? null : path.dirname(d)) {
    try { const st = await fs.promises.statfs(d); free = st.bavail * st.bsize; break; } catch {}
  }
  const wavs = [...new Set(Object.values(db.files).filter((r) => r.wav && r.wav !== r.path && outside(r)).map((r) => r.wav))];
  surveyor = new Worker(path.join(__dirname, 'lib', 'worker.js'));
  const res = await new Promise((resolve) => {
    surveyor.on('message', (m) => {
      if (m.type === 'progress') send('scan:progress', { stats: { seen: m.seen }, checking: true });
      else resolve(m);
    });
    surveyor.on('error', (err) => resolve({ type: 'fatal', error: String(err) }));
    surveyor.postMessage({ type: 'survey', libDir: db.libDir, known: knownFiles(true).known, roots, wavs });
  });
  if (surveyor) surveyor.terminate();
  surveyor = null;
  if (res.type === 'fatal') return { ok: false, why: 'check broke: ' + res.error.split('\n')[0] };
  for (const g of res.groups) g.skipped = underSkip(g.path);
  // already on the shelf, not measured with the sound model yet: the scan does them after the folders
  const measure = Object.values(db.files).filter((r) => r.ana !== ANA && r.wav && !r.error).length;
  return { ok: true, ...res, free, drive: path.parse(lib).root, skip: db.skip, model: haveModel() ? 0 : MODEL.size, measure, ana: ANA };
});
ipcMain.handle('stop-check', () => { if (surveyor) { surveyor.terminate(); surveyor = null; } return true; });

// the sound model for the map, downloaded once into the app's folder (not the library folder)
const modelFile = () => path.join(app.getPath('userData'), 'models', MODEL.file);
const haveModel = () => { try { return fs.statSync(modelFile()).size === MODEL.size; } catch { return false; } };
let downloading = false;
async function getModel() {
  if (haveModel()) return true;
  downloading = true;
  const part = modelFile() + '.part';
  try {
    fs.mkdirSync(path.dirname(part), { recursive: true });
    const res = await fetch(MODEL.url);
    if (!res.ok) throw new Error('http ' + res.status);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    let got = 0, last = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      got += chunk.length;
      if (Date.now() - last > 300) { last = Date.now(); send('scan:progress', { model: Math.round((100 * got) / MODEL.size) }); }
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    if (hash.digest('hex') !== MODEL.sha256) throw new Error('download came out wrong');
    fs.renameSync(part, modelFile());
    return true;
  } catch (err) {
    fs.rmSync(part, { force: true });
    send('scan:progress', { modelError: String(err.message || err) });
    return false;
  } finally { downloading = false; }
}

// what the worker needs to know about the shelf: unchanged files get skipped, copies get reused
// all = also files waiting to be detected again (they count as on the shelf, for the check)
function knownFiles(all) {
  const model = haveModel();
  const known = {};
  const hashList = [];
  for (const [id, r] of Object.entries(db.files)) {
    if (r.qhash && r.wav && r.wav !== r.path) hashList.push([r.qhash, r.wav]);
    if (r.redetect && !all) continue; // not "known" = processed again (its wav copy is reused via hashList)
    known[id] = { path: r.path, size: r.size, mtime: r.mtime, error: r.error, wav: r.wav, qhash: r.qhash };
    // not measured for the map yet, or a detected tempo whose onsets weren't counted: the worker does
    // that after it's walked the folders
    if (((model && r.ana !== ANA) || (r.bpmSrc === 'auto' && r.onsets == null && statedKind(r) !== 'loop')) && !r.error && r.wav) {
      known[id].need = { wav: r.wav, name: r.name, folder: r.folder, ext: r.ext, duration: r.duration, bpm: r.bpm, bpmSrc: r.bpmSrc, acidOneShot: r.acidOneShot, kindUser: r.kindUser, keySrc: r.keySrc, ana: r.ana, onsets: r.onsets };
    }
  }
  return { known, hashList };
}

// skip / unskip = folders from the check you unticked / ticked
ipcMain.handle('scan', async (_e, opts = {}) => {
  if (worker || downloading) return { ok: false, why: 'already scanning' };
  const roots = scanRoots();
  if (!roots.length) return { ok: false, why: db.roots.length ? 'tick a folder to scan' : 'pick a folder to scan first', needRoots: true };
  if (!db.libDir && !(await pickLib())) return { ok: false, why: 'no library folder' };
  const low = (a) => (a || []).map((x) => x.toLowerCase());
  const unskip = low(opts.unskip);
  db.skip = [...new Set([...db.skip.filter((x) => !unskip.includes(x.toLowerCase())), ...(opts.skip || [])])];
  save(true);
  // no model (offline?): scan anyway, the map numbers come next scan
  const model = (await getModel()) ? modelFile() : null;
  const { known, hashList } = knownFiles();
  worker = new Worker(path.join(__dirname, 'lib', 'worker.js'));
  worker.on('message', (m) => {
    if (m.type === 'record') { send('scan:record', merge(m.rec)); save(); }
    else if (m.type === 'patch') {
      const r = db.files[m.id];
      if (r) { Object.assign(r, m.patch); send('scan:record', r); save(); }
    }
    else if (m.type === 'progress') send('scan:progress', m);
    else if (m.type === 'done' || m.type === 'fatal') {
      save(true);
      send('scan:done', m);
      worker.terminate(); worker = null;
      layout(false);
    }
  });
  worker.on('error', (err) => { send('scan:done', { type: 'fatal', error: String(err) }); worker = null; });
  worker.postMessage({ type: 'scan', libDir: db.libDir, known, roots, hashList, skip: db.skip, model });
  return { ok: true };
});

ipcMain.handle('stop-scan', async () => {
  if (worker) { await worker.terminate(); worker = null; save(true); layout(false); }
  return true;
});

// map positions. rebuild = lay everything out again; otherwise only samples without a spot get one
function layout(rebuild) {
  if (mapper) return false;
  const items = Object.values(db.files).filter((r) => r.feat && !r.error);
  if (!items.length || (!rebuild && items.every((r) => r.mx != null))) return false;
  const slim = items.map((r) => ({ id: r.id, feat: r.feat, mx: rebuild ? null : r.mx, my: r.my, name: r.name, folder: r.folder, ext: r.ext, duration: r.duration, bpm: r.bpm, bpmSrc: r.bpmSrc, acidOneShot: r.acidOneShot, kindUser: r.kindUser }));
  mapper = new Worker(path.join(__dirname, 'lib', 'layout.js'), { workerData: { items: slim, rebuild } });
  mapper.on('message', (m) => {
    if (m.type === 'progress') { send('map:progress', m); return; }
    for (const [id, [x, y]] of Object.entries(m.pos)) { const r = db.files[id]; if (r) { r.mx = x; r.my = y; } }
    for (const r of Object.values(db.files)) { if (m.sound[r.id]) r.soundGuess = m.sound[r.id]; else delete r.soundGuess; }
    save(true);
    send('map:done', { pos: m.pos, sound: m.sound });
  });
  const end = () => { mapper = null; };
  mapper.on('error', (err) => { end(); send('map:progress', { what: 'map broke: ' + String(err.message || err) }); });
  mapper.on('exit', end);
  return true;
}
ipcMain.handle('rebuild-map', () => layout(true));

// row waveforms: worked out the first time a row shows, kept with the sample until its wav changes
ipcMain.handle('peaks', async (_e, ids) => {
  const out = {};
  let changed = false;
  for (const id of ids) {
    const r = db.files[id];
    if (!r || !r.wav) continue;
    const tag = r.wav + ':' + r.mtime;
    if (r.pk !== undefined && r.pkw === tag) { out[id] = r.pk; continue; }
    try { r.pk = await peaksOfFile(r.wav); } catch { r.pk = null; }
    r.pkw = tag;
    changed = true;
    out[id] = r.pk;
  }
  if (changed) save();
  return out;
});

// patch = { addTags?, removeTag?, bpm?, key?, scale?, kindUser?, xposeUser?, fav? }. scale alone = set major/minor
ipcMain.handle('update', (_e, ids, patch) => {
  const out = [];
  for (const id of ids) {
    const r = db.files[id];
    if (!r) continue;
    if (patch.addTags) r.tags = [...new Set([...(r.tags || []), ...patch.addTags])];
    if (patch.removeTag) r.tags = (r.tags || []).filter((t) => t !== patch.removeTag);
    if ('bpm' in patch) { r.bpm = patch.bpm; r.bpmSrc = patch.bpm ? 'user' : null; }
    if ('key' in patch) { r.key = patch.key; r.scale = patch.scale || null; r.keySrc = patch.key ? 'user' : null; }
    if ('kindUser' in patch) { if (patch.kindUser) r.kindUser = patch.kindUser; else delete r.kindUser; }
    // just major/minor: keeps the root it has (no root, nothing to set)
    if ('scale' in patch && !('key' in patch) && r.key) { r.scale = patch.scale; r.keySrc = 'user'; }
    if ('xposeUser' in patch) { if (patch.xposeUser) r.xposeUser = patch.xposeUser; else delete r.xposeUser; }
    if ('fav' in patch) { if (patch.fav) r.fav = true; else delete r.fav; }
    out.push(r);
  }
  save();
  return out;
});

ipcMain.handle('remove', async (_e, ids) => {
  if (!ids.length) return null;
  const n = samples(ids);
  const ok = await confirm(`remove ${n} sample${n === 1 ? '' : 's'} from the shelf?`, 'the wav copies made for them get deleted too. your original files stay where they are. if they sit inside a scan folder they come back next scan.', 'remove');
  return ok ? drop(ids) : null;
});

ipcMain.handle('prune', async () => {
  if (!db.roots.length) return { removed: [], deleted: 0, why: 'add a folder first' };
  const ids = Object.values(db.files).filter(outside).map((r) => r.id);
  if (!ids.length) return { removed: [], deleted: 0 };
  const n = samples(ids);
  const ok = await confirm(`remove ${n} sample${n === 1 ? '' : 's'} that aren't in your scan folders?`, 'that counts folders you skipped. their wav copies get deleted too. originals stay where they are.', 'remove');
  return ok ? drop(ids) : null;
});

ipcMain.handle('clear', async () => {
  const ids = Object.keys(db.files);
  if (!ids.length) return { removed: [], deleted: 0 };
  const ok = await confirm(`clear the whole shelf (${samples(ids)} samples)?`, 'every wav copy this app made gets deleted, and your tags and fixes are gone. originals stay where they are.', 'clear');
  return ok ? drop(ids) : null;
});

ipcMain.handle('context-menu', (_e, info) => new Promise((resolve) => {
  let picked = null;
  const pick = (a) => () => { picked = a; };
  const n = info.count;
  const menu = Menu.buildFromTemplate([
    { label: 'show in explorer', click: pick('reveal'), enabled: n === 1 },
    { label: 'show similar on the map', click: pick('similar'), enabled: n === 1 && !!info.measured },
    { label: info.allFav ? 'unfavourite (f)' : 'favourite (f)', click: pick('fav') },
    { type: 'separator' },
    { label: n > 1 ? `mark ${n} as loop` : 'mark as loop', click: pick('loop') },
    { label: n > 1 ? `mark ${n} as one-shot` : 'mark as one-shot', click: pick('oneshot') },
    { label: 'let the app decide loop/one-shot', click: pick('autokind') },
    { type: 'separator' },
    { label: 'set major', click: pick('major'), enabled: !!info.hasRoot },
    { label: 'set minor', click: pick('minor'), enabled: !!info.hasRoot },
    { type: 'separator' },
    { label: 'transpose with the key lock', click: pick('xposeOn') },
    { label: 'never transpose', click: pick('xposeOff') },
    { label: 'let the app decide transposing', click: pick('xposeAuto') },
    { type: 'separator' },
    { label: n > 1 ? `remove ${n} from shelf` : 'remove from shelf', click: pick('remove') },
  ]);
  menu.popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) });
}));

const dragIcon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'drag.png'));
ipcMain.on('drag', (e, files) => {
  const ok = files.filter((f) => f && fs.existsSync(f));
  if (!ok.length) return;
  e.sender.startDrag({ file: ok[0], files: ok, icon: dragIcon });
});

ipcMain.on('reveal', (_e, file) => shell.showItemInFolder(file));

// preview bytes for the audio engine. only wavs that are on the shelf
ipcMain.handle('read-audio', (_e, file) => {
  if (!Object.values(db.files).some((r) => r.wav === file)) throw new Error('not on the shelf');
  return fs.promises.readFile(file);
});

app.whenReady().then(() => { load(); createWindow(); win.webContents.once('did-finish-load', () => layout(false)); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (worker) worker.terminate(); if (mapper) mapper.terminate(); save(true); });
