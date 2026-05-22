// Vision router — selects Apple Vision or Claude backend based on config.
//
// Both backends return the same shape:
//   { isTalkingHead, hasFace, qualityScore, contentTags, description,
//     matchesDirectorNotes, suggestedRotation, facePresenceRatio, bestFrame, _source }
//
// Default backend: 'apple'  (full-frame AVFoundation + Vision Framework, on-device)
// Fallback:        'claude' (3-frame Claude Vision API call)
//
// The Apple backend automatically falls back to Claude if vision-cli is missing,
// so no manual switching is needed during development or on fresh installs.

const path = require('path');
const fs   = require('fs');

// Read visionBackend from config once per process
let _backend = null;

function getBackend() {
  if (_backend) return _backend;
  try {
    const cfgPath = path.join(require('./app-data').getAppDataDir(), 'config.json');
    const cfg     = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    _backend      = cfg.visionBackend === 'claude' ? 'claude' : 'apple';
  } catch {
    _backend = 'apple';  // default to Apple Vision
  }
  console.log(`[clip-vision] backend: ${_backend}`);
  return _backend;
}

async function analyzeClip(clip, directorNotes = '', opts = {}) {
  if (getBackend() === 'claude') {
    return require('./clip-vision-claude').analyzeClip(clip, directorNotes, opts);
  }
  // Apple Vision — has its own Claude fallback built in
  return require('./clip-vision-apple').analyzeClip(clip, directorNotes, opts);
}

// Reset cached backend — used by settings save so a config change takes effect
// on the next render without restarting the app.
function resetBackendCache() {
  _backend = null;
}

module.exports = { analyzeClip, resetBackendCache };
