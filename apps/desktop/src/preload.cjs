const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('islandDesktop', Object.freeze({
  invoke: (action, data) => ipcRenderer.invoke('island-desktop', action, data),
  onProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('island-progress', (_event, progress) => callback(progress));
  },
}));
