const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder:         ()     => ipcRenderer.invoke('dialog:selectFolder'),
  selectFiles:          ()     => ipcRenderer.invoke('dialog:selectFiles'),
  getFilePath:          (file) => webUtils.getPathForFile(file),
  windowControl:        (action) => ipcRenderer.send('window:control', action),
  openPath:             (path) => ipcRenderer.invoke('shell:openPath', path),
  showInFinder:         (path) => ipcRenderer.invoke('shell:showInFinder', path),
  openExternal:         (url)  => ipcRenderer.invoke('shell:openExternal', url),
  onUpdateAvailable:    (cb)   => ipcRenderer.on('update:available', (_, data) => cb(data)),
  getAppToken:          ()     => ipcRenderer.invoke('app:getToken'),
  getAppVersion:        ()     => ipcRenderer.invoke('app:getVersion'),
  setWindowPosition:    (x, y) => ipcRenderer.send('window:setPosition', x, y),
});
