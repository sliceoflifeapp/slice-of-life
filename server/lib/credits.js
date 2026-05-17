const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DIR     = path.join(os.homedir(), '.gather');
const FILE    = path.join(DIR, 'credits.json');
const DEFAULT = 500;

function load() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(FILE)) { save(DEFAULT); return DEFAULT; }
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).credits ?? DEFAULT;
  } catch { return DEFAULT; }
}

function save(amount) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ credits: amount }));
  } catch { /* non-fatal */ }
}

function deduct(amount) {
  const next = Math.max(0, load() - amount);
  save(next);
  return next;
}

module.exports = { load, save, deduct };
