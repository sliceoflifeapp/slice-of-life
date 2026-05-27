const path = require('path');
const os   = require('os');
const fs   = require('fs');

// Returns the guaranteed-writable Electron userData directory.
// Falls back to ~/.slice-of-life for non-Electron contexts (tests, dev scripts).
function getAppDataDir() {
  try {
    return require('electron').app.getPath('userData');
  } catch {
    return path.join(os.homedir(), '.slice-of-life');
  }
}

// ── Style profile ─────────────────────────────────────────────────────────────
// Stores the last MAX_HISTORY render/reedit choices. getStyleDefaults() looks
// at only the most recent WINDOW entries so preferences stay current.
// Re-edits (weight=2) outweigh initial renders (weight=1) within the window.

const WINDOW      = 8;
const MAX_HISTORY = 20;

function readStyleProfile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(getAppDataDir(), 'style-profile.json'), 'utf8'));
  } catch {
    return { history: [] };
  }
}

function updateStyleProfile(opts, weight = 1) {
  try {
    const profile = readStyleProfile();
    const entry = { ts: Date.now(), weight };
    if (opts.pacing)                        entry.pacing       = opts.pacing;
    if (opts.captionStyle && opts.captions) entry.captionStyle = opts.captionStyle;
    if (opts.captions !== undefined)        entry.captionsOn   = !!opts.captions;
    profile.history.push(entry);
    if (profile.history.length > MAX_HISTORY) profile.history = profile.history.slice(-MAX_HISTORY);
    fs.mkdirSync(getAppDataDir(), { recursive: true });
    fs.writeFileSync(path.join(getAppDataDir(), 'style-profile.json'), JSON.stringify(profile, null, 2));
  } catch (err) {
    console.warn('[style-profile] update failed:', err.message);
  }
}

// Returns { pacing, captionStyle, captionsOn } defaults, or null if no history yet.
// captionsOn is null until there are at least 4 entries with a recorded value.
function getStyleDefaults() {
  const { history } = readStyleProfile();
  if (!history.length) return null;
  const window = history.slice(-WINDOW);

  const tally = key => {
    const counts = {};
    for (const e of window) if (e[key]) counts[e[key]] = (counts[e[key]] || 0) + (e.weight || 1);
    const entries = Object.entries(counts);
    if (!entries.length) return null;
    return entries.reduce((best, cur) => cur[1] > best[1] ? cur : best)[0];
  };

  const captionsEntries = window.filter(e => e.captionsOn !== undefined);
  const captionsOn = captionsEntries.length >= 4
    ? captionsEntries.reduce((sum, e) => sum + (e.captionsOn ? (e.weight || 1) : 0), 0) >
      captionsEntries.reduce((sum, e) => sum + (e.weight || 1), 0) / 2
    : null;

  return { pacing: tally('pacing'), captionStyle: tally('captionStyle'), captionsOn };
}

module.exports = { getAppDataDir, updateStyleProfile, getStyleDefaults };
