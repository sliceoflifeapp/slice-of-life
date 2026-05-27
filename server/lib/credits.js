const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DIR     = path.join(os.homedir(), '.slice-of-life');
const FILE    = path.join(DIR, 'credits.json');
const DEFAULT = 500;

function load() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(FILE)) {
      fs.writeFileSync(FILE, JSON.stringify({ credits: DEFAULT }));
      return DEFAULT;
    }
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).credits ?? DEFAULT;
  } catch { return DEFAULT; }
}

module.exports = { load };
