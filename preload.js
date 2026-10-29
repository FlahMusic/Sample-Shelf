const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('shelf', {
  init: call('init'),
  pickLib: call('pick-lib'),
  setPrefs: call('set-prefs'),
  addRoot: call('add-root'),
  removeRoot: call('remove-root'),
  setAllDrives: call('set-all-drives'),
  scan: call('scan'),
  stopScan: call('stop-scan'),
  update: call('update'),
  remove: call('remove'),
  prune: call('prune'),
  clear: call('clear'),
  contextMenu: call('context-menu'),
  readAudio: call('read-audio'),
  drag: (files) => ipcRenderer.send('drag', files),
  reveal: (file) => ipcRenderer.send('reveal', file),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d)),
});
