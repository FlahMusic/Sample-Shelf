const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const DB_FILE = path.join(app.getPath('userData'), 'shelf.json');
let db = { libDir: null, files: {} };
let win = null;
let worker = null;
let saveTimer = null;

function load() {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch {}
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
    if (prev.bpmSrc === 'user') { rec.bpm = prev.bpm; rec.bpmSrc = 'user'; }
    if (prev.keySrc === 'user') { rec.key = prev.key; rec.scale = prev.scale; rec.keySrc = 'user'; }
  }
  rec.tags = rec.tags || [];
  db.files[rec.id] = rec;
  return rec;
}

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

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 760, minHeight: 420,
    backgroundColor: '#0e0f11',
    title: 'Sample Shelf',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('init', () => ({ libDir: db.libDir, records: Object.values(db.files), scanning: !!worker }));

ipcMain.handle('pick-lib', () => pickLib());

ipcMain.handle('scan', async (_e, roots) => {
  if (worker) return { ok: false, why: 'already scanning' };
  if (!db.libDir && !(await pickLib())) return { ok: false, why: 'no library folder' };
  const known = {};
  for (const [id, r] of Object.entries(db.files)) known[id] = { size: r.size, mtime: r.mtime, error: r.error, wav: r.wav };
  worker = new Worker(path.join(__dirname, 'lib', 'worker.js'));
  worker.on('message', (m) => {
    if (m.type === 'record') { send('scan:record', merge(m.rec)); save(); }
    else if (m.type === 'progress') send('scan:progress', m);
    else if (m.type === 'done' || m.type === 'fatal') {
      save(true);
      send('scan:done', m);
      worker.terminate(); worker = null;
    }
  });
  worker.on('error', (err) => { send('scan:done', { type: 'fatal', error: String(err) }); worker = null; });
  if (!roots && process.env.SHELF_ROOTS) roots = process.env.SHELF_ROOTS.split(';'); // dev/testing only
  worker.postMessage({ type: 'scan', libDir: db.libDir, known, roots });
  return { ok: true };
});

ipcMain.handle('stop-scan', async () => {
  if (worker) { await worker.terminate(); worker = null; save(true); }
  return true;
});

// patch = { tags?, addTags?, removeTag?, bpm?, key?, scale? }
ipcMain.handle('update', (_e, ids, patch) => {
  const out = [];
  for (const id of ids) {
    const r = db.files[id];
    if (!r) continue;
    if (patch.addTags) r.tags = [...new Set([...(r.tags || []), ...patch.addTags])];
    if (patch.removeTag) r.tags = (r.tags || []).filter((t) => t !== patch.removeTag);
    if ('bpm' in patch) { r.bpm = patch.bpm; r.bpmSrc = patch.bpm ? 'user' : null; }
    if ('key' in patch) { r.key = patch.key; r.scale = patch.scale || null; r.keySrc = patch.key ? 'user' : null; }
    out.push(r);
  }
  save();
  return out;
});

const dragIcon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'drag.png'));
ipcMain.on('drag', (e, files) => {
  const ok = files.filter((f) => f && fs.existsSync(f));
  if (!ok.length) return;
  e.sender.startDrag({ file: ok[0], files: ok, icon: dragIcon });
});

ipcMain.on('reveal', (_e, file) => shell.showItemInFolder(file));

app.whenReady().then(() => { load(); createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (worker) worker.terminate(); save(true); });
