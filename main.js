const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const DB_FILE = path.join(app.getPath('userData'), 'shelf.json');
let db = { libDir: null, roots: [], allDrives: false, prefs: { autoplay: true, sync: false, syncBpm: 120 }, files: {} };
let win = null;
let worker = null;
let saveTimer = null;

function load() {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch {}
  // entries from before "added" existed: stamp them with when the shelf was first made
  let first = Date.now();
  try { first = fs.statSync(DB_FILE).birthtimeMs || first; } catch {}
  for (const r of Object.values(db.files)) if (!r.added) r.added = first;
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

const under = (p, root) => {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

async function pickLib() {
  const r = await dialog.showOpenDialog(win, {
    title: 'pick a folder for converted wavs',
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
    backgroundColor: '#14161a',
    title: 'Sample Shelf',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

const settings = () => ({ libDir: db.libDir, roots: db.roots, allDrives: db.allDrives, prefs: db.prefs });

ipcMain.handle('init', () => ({ ...settings(), records: Object.values(db.files), scanning: !!worker }));
ipcMain.handle('pick-lib', () => pickLib());
ipcMain.handle('set-prefs', (_e, prefs) => { db.prefs = { ...db.prefs, ...prefs }; save(); return db.prefs; });

ipcMain.handle('add-root', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'add a folder to scan', properties: ['openDirectory', 'multiSelections'] });
  if (!r.canceled) for (const f of r.filePaths) if (!db.roots.includes(f)) db.roots.push(f);
  save(true);
  return settings();
});
ipcMain.handle('remove-root', (_e, root) => { db.roots = db.roots.filter((x) => x !== root); save(true); return settings(); });
ipcMain.handle('set-all-drives', (_e, on) => { db.allDrives = !!on; save(true); return settings(); });

ipcMain.handle('scan', async () => {
  if (worker) return { ok: false, why: 'already scanning' };
  let roots = db.allDrives ? null : db.roots;
  if (process.env.SHELF_ROOTS) roots = process.env.SHELF_ROOTS.split(';'); // dev/testing only
  if (roots && !roots.length) return { ok: false, why: 'pick a folder to scan first', needRoots: true };
  if (!db.libDir && !(await pickLib())) return { ok: false, why: 'no library folder' };
  const known = {};
  const hashList = [];
  for (const [id, r] of Object.entries(db.files)) {
    known[id] = { path: r.path, size: r.size, mtime: r.mtime, error: r.error, wav: r.wav, qhash: r.qhash };
    if (r.qhash && r.wav && r.wav !== r.path) hashList.push([r.qhash, r.wav]);
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
    }
  });
  worker.on('error', (err) => { send('scan:done', { type: 'fatal', error: String(err) }); worker = null; });
  worker.postMessage({ type: 'scan', libDir: db.libDir, known, roots, hashList });
  return { ok: true };
});

ipcMain.handle('stop-scan', async () => {
  if (worker) { await worker.terminate(); worker = null; save(true); }
  return true;
});

// patch = { addTags?, removeTag?, bpm?, key?, scale?, kindUser? }
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
    out.push(r);
  }
  save();
  return out;
});

ipcMain.handle('remove', async (_e, ids) => {
  if (!ids.length) return null;
  const ok = await confirm(`remove ${ids.length} from the shelf?`, 'the wav copies made for them get deleted too. your original files stay where they are. if they sit inside a scan folder they come back next scan.', 'remove');
  return ok ? drop(ids) : null;
});

ipcMain.handle('prune', async () => {
  if (db.allDrives) return { removed: [], deleted: 0, why: 'scanning all drives, nothing is outside' };
  const ids = Object.values(db.files).filter((r) => !db.roots.some((root) => under(r.path, root))).map((r) => r.id);
  if (!ids.length) return { removed: [], deleted: 0 };
  const ok = await confirm(`remove ${ids.length} files that aren't in your scan folders?`, 'their wav copies get deleted too. originals stay where they are.', 'remove');
  return ok ? drop(ids) : null;
});

ipcMain.handle('clear', async () => {
  const ids = Object.keys(db.files);
  if (!ids.length) return { removed: [], deleted: 0 };
  const ok = await confirm(`clear the whole shelf (${ids.length} files)?`, 'every wav copy this app made gets deleted, and your tags and fixes are gone. originals stay where they are.', 'clear');
  return ok ? drop(ids) : null;
});

ipcMain.handle('context-menu', (_e, info) => new Promise((resolve) => {
  let picked = null;
  const pick = (a) => () => { picked = a; };
  const n = info.count;
  const menu = Menu.buildFromTemplate([
    { label: 'show in explorer', click: pick('reveal'), enabled: n === 1 },
    { type: 'separator' },
    { label: n > 1 ? `mark ${n} as loop` : 'mark as loop', click: pick('loop') },
    { label: n > 1 ? `mark ${n} as one-shot` : 'mark as one-shot', click: pick('oneshot') },
    { label: 'let the app decide loop/one-shot', click: pick('autokind') },
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

app.whenReady().then(() => { load(); createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (worker) worker.terminate(); save(true); });
