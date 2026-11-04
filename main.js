const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const K = require('./lib/keys');
const { kindOf } = require('./lib/classify');
const { VERSION: ANA } = require('./lib/features');

const DB_FILE = path.join(app.getPath('userData'), 'shelf.json');
// hidden = scan folders that are unticked: their files stay on the shelf but don't show, and scans skip them
let db = { libDir: null, roots: [], hidden: [], prefs: { autoplay: true, sync: false, syncBpm: 120 }, files: {} };
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
    backgroundColor: '#f1e9fb',
    title: 'Sample Shelf',
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

ipcMain.handle('scan', async () => {
  if (worker) return { ok: false, why: 'already scanning' };
  let roots = db.roots.filter((x) => !db.hidden.includes(x));
  if (process.env.SHELF_ROOTS) roots = process.env.SHELF_ROOTS.split(';'); // dev/testing only
  if (!roots.length) return { ok: false, why: db.roots.length ? 'tick a folder to scan' : 'pick a folder to scan first', needRoots: true };
  if (!db.libDir && !(await pickLib())) return { ok: false, why: 'no library folder' };
  const known = {};
  const hashList = [];
  for (const [id, r] of Object.entries(db.files)) {
    if (r.qhash && r.wav && r.wav !== r.path) hashList.push([r.qhash, r.wav]);
    if (r.redetect) continue; // not "known" = processed again (its wav copy is reused via hashList)
    known[id] = { path: r.path, size: r.size, mtime: r.mtime, error: r.error, wav: r.wav, qhash: r.qhash };
    // not measured for the map yet: the worker does that after it's walked the folders
    if (r.ana !== ANA && !r.error && r.wav) {
      known[id].need = { wav: r.wav, name: r.name, folder: r.folder, ext: r.ext, duration: r.duration, bpm: r.bpm, bpmSrc: r.bpmSrc, acidOneShot: r.acidOneShot, kindUser: r.kindUser, keySrc: r.keySrc };
    }
  }
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
  worker.postMessage({ type: 'scan', libDir: db.libDir, known, roots, hashList });
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

// patch = { addTags?, removeTag?, bpm?, key?, scale?, kindUser?, xposeUser? }. scale alone = set major/minor
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
  const ids = Object.values(db.files).filter((r) => !db.roots.some((root) => under(r.path, root))).map((r) => r.id);
  if (!ids.length) return { removed: [], deleted: 0 };
  const n = samples(ids);
  const ok = await confirm(`remove ${n} sample${n === 1 ? '' : 's'} that aren't in your scan folders?`, 'their wav copies get deleted too. originals stay where they are.', 'remove');
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
