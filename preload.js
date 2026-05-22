const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder:         ()     => ipcRenderer.invoke('dialog:selectFolder'),
  selectFiles:          ()     => ipcRenderer.invoke('dialog:selectFiles'),
  getFilePath:          (file) => webUtils.getPathForFile(file),
  windowControl:        (action) => ipcRenderer.send('window:control', action),
  openPath:             (path) => ipcRenderer.invoke('shell:openPath', path),
  showInFinder:         (path) => ipcRenderer.invoke('shell:showInFinder', path),
  getPhotosLibraryPath: ()     => ipcRenderer.invoke('photos:libraryPath'),
  openExternal:         (url)  => ipcRenderer.invoke('shell:openExternal', url),
});
