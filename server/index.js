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
app.get('/trip',      (_, res) => res.sendFile(path.join(__dirname, '../ui/trip.html')));
app.get('/journals',  (_, res) => res.sendFile(path.join(__dirname, '../ui/journals.html')));
app.get('/recap',     (_, res) => res.sendFile(path.join(__dirname, '../ui/recap.html')));

// API
app.use('/api', api);

function start() {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      analytics.track('app_opened');
      resolve(PORT);
    });
    server.on('error', reject);
  });
}

module.exports = { start, PORT };
