const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shelf', {
  init: () => ipcRenderer.invoke('init'),
  pickLib: () => ipcRenderer.invoke('pick-lib'),
  scan: (roots) => ipcRenderer.invoke('scan', roots),
  stopScan: () => ipcRenderer.invoke('stop-scan'),
  update: (ids, patch) => ipcRenderer.invoke('update', ids, patch),
  drag: (files) => ipcRenderer.send('drag', files),
  reveal: (file) => ipcRenderer.send('reveal', file),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d)),
});
