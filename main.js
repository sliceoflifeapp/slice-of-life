const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// One-time migration: move data into Electron's guaranteed-writable userData dir.
// Chain: ~/.gather → ~/.slice-of-life → userData (~/Library/Application Support/Slice of Life)
app.whenReady().then(() => {
  const userData   = app.getPath('userData');
  const oldGather  = path.join(os.homedir(), '.gather');
  const oldSlice   = path.join(os.homedir(), '.slice-of-life');

  // Step 1: .gather → .slice-of-life (old migration, keep for anyone still on it)
  if (fs.existsSync(oldGather) && !fs.existsSync(oldSlice)) {
    try { fs.renameSync(oldGather, oldSlice); } catch {}
  }

  // Step 2: .slice-of-life → userData
  if (fs.existsSync(oldSlice)) {
    for (const file of ['config.json', 'exports.json']) {
      const src = path.join(oldSlice, file);
      const dst = path.join(userData, file);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.copyFileSync(src, dst); } catch {}
      }
    }
    const thumbSrc = path.join(oldSlice, 'thumb-cache');
    const thumbDst = path.join(userData, 'thumb-cache');
    if (fs.existsSync(thumbSrc) && !fs.existsSync(thumbDst)) {
      try { fs.renameSync(thumbSrc, thumbDst); } catch {}
    }
  }
});

let mainWindow;

async function init() {
  const { start } = require('./server/index.js');
  const port = await start();
  createWindow(port);
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 820,
    resizable: false,
    frame: false,
    show: false,              // hide until the page is fully painted
    backgroundColor: '#06111F', // matches the app's dark navy background
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Show only once the renderer has painted its first frame — eliminates the
  // brown/white flash that occurs when the window appears before CSS loads.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Grant microphone permission for speech-to-text
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media' || permission === 'microphone') return true;
    return false;
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') return callback(true);
    callback(false);
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  if (process.env.GATHER_DEV) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(init);

ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mp4','mov','m4v','avi','mkv','mts','m2ts','webm'] }],
  });
  return result.canceled ? null : result.filePaths;
});

ipcMain.handle('dialog:selectFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video & Audio', extensions: ['mp4','mov','m4v','avi','mkv','mts','m2ts','webm','mp3','m4a','wav','aiff','aif','flac'] }],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.on('window:control', (_, action) => {
  if (!mainWindow) return;
  if (action === 'close')    mainWindow.close();
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});

ipcMain.handle('shell:openPath', (_, target) => {
  if (target.startsWith('mailto:')) return shell.openExternal(target);
  return shell.openPath(target);
});

ipcMain.handle('shell:showInFinder', (_, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('shell:openExternal', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('photos:libraryPath', async () => {
  const os   = require('os');
  const fs   = require('fs');
  const path = require('path');

  // Standard Photos Library location
  const candidates = [
    path.join(os.homedir(), 'Pictures', 'Photos Library.photoslibrary', 'originals'),
    path.join(os.homedir(), 'Pictures', 'Photos Library.photoslibrary', 'Masters'), // older macOS
  ];

  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch {}
  }
  return null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { require('exiftool-vendored').exiftool.end(); } catch { /* ignore */ }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
