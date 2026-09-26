// Ограниченный мост из веб-интерфейса к закрытию окна Electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('psbees', Object.freeze({
  closeApp: () => ipcRenderer.send('psbees:close-app'),
}));
