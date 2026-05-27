const express    = require('express');
const path       = require('path');
const api        = require('./routes/api');
const analytics  = require('./lib/analytics');

const PORT = 34721;
const app  = express();

app.use(express.json());

// Serve Tabler Icons from node_modules
app.use('/icons', express.static(
  path.join(__dirname, '../node_modules/@tabler/icons-webfont/dist')
));

// Serve UI static assets (css, js, etc.)
app.use(express.static(path.join(__dirname, '../ui')));

// Serve bundled fonts so the UI can load them via @font-face
app.use('/fonts', express.static(path.join(__dirname, '../assets/fonts')));

// Clean URL routes for each screen
app.get('/',          (_, res) => res.sendFile(path.join(__dirname, '../ui/home.html')));
app.get('/configure', (_, res) => res.sendFile(path.join(__dirname, '../ui/configure.html')));
app.get('/journal',   (_, res) => res.sendFile(path.join(__dirname, '../ui/journal.html')));

// API
app.use('/api', api);

function checkWhisper() {
  try {
    const { getWhisperBin, getModelPath } = require('./lib/whisper');
    const fs = require('fs');
    const binPath   = getWhisperBin();
    const modelPath = getModelPath();
    const binOk   = fs.existsSync(binPath);
    const modelOk = fs.existsSync(modelPath);
    console.log(`[startup] whisper-cli: ${binOk ? 'OK' : 'MISSING'} ${binPath}`);
    console.log(`[startup] whisper model: ${modelOk ? 'OK' : 'MISSING'} ${modelPath}`);
    if (!binOk || !modelOk) {
      console.error('[startup] WARNING: Whisper binary or model missing — narration detection will not work');
    }
  } catch (e) {
    console.error('[startup] Whisper check failed:', e.message);
  }
}

function start() {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      analytics.track('app_opened');
      checkWhisper();
      resolve(PORT);
    });
    server.on('error', reject);
  });
}

module.exports = { start, PORT };
