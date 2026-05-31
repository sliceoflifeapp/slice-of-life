const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { randomBytes } = require('crypto');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const APP_TOKEN = randomBytes(32).toString('hex');

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
  const port = await start(APP_TOKEN);
  createWindow(port);
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 820,
    resizable: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 20, y: 18 },
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
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    setTimeout(() => checkForUpdates(mainWindow), 5000);
  });

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

ipcMain.handle('app:getToken', () => APP_TOKEN);
ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.on('window:setPosition', (_, x, y) => {
  if (mainWindow) mainWindow.setPosition(x, y);
});

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
  try {
    const proto = new URL(url).protocol;
    if (proto !== 'https:' && proto !== 'mailto:') return;
  } catch { return; }
  shell.openExternal(url);
});


function isNewerVersion(remote, current) {
  const r = remote.replace(/^v/, '').split('.').map(Number);
  const c = current.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (c[i] || 0)) return true;
    if ((r[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

function checkForUpdates(win) {
  const https = require('https');
  const workerUrl = process.env.GATHER_WORKER_URL || 'https://gather-proxy.sliceoflifeapp.workers.dev';
  const url = `${workerUrl}/version`;
  https.get(url, res => {
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
      try {
        const { version, downloadUrl } = JSON.parse(raw);
        if (version && isNewerVersion(version, app.getVersion())) {
          win.webContents.send('update:available', { version, downloadUrl });
        }
      } catch {}
    });
  }).on('error', () => {});
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { require('exiftool-vendored').exiftool.end(); } catch { /* ignore */ }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
