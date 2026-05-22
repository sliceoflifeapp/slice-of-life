// Apple Vision Framework backend for clip analysis.
// Spawns the compiled `vision-cli` Swift binary which uses AVFoundation +
// Vision Framework to analyze every frame of the clip — rather than sampling
// 3 still images and asking Claude.
//
// Returns the same shape as clip-vision-claude.js so the pipeline is unchanged.
// Fields that Apple Vision doesn't produce (contentTags, description,
// matchesDirectorNotes) are returned as empty/null — Claude still handles
// those semantic tasks via journal-pipeline.js.

const path          = require('path');
const fs            = require('fs');
const { execFile }  = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// MARK: — Binary path

// In a packaged Electron build, server/ is inside app.asar.  The binary must
// live in app.asar.unpacked (configured via asarUnpack in package.json).
function visionCliBin() {
  return path.join(__dirname, '..', 'bin', 'vision-cli')
    .replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
}

// Strip quarantine once so macOS doesn't block the binary on first run.
// Mirrors the approach used for whisper-cli.
let _quarantineStripped = false;
function stripQuarantine() {
  if (_quarantineStripped) return;
  _quarantineStripped = true;
  try {
    require('child_process').execFileSync('xattr', [
      '-d', 'com.apple.quarantine', visionCliBin()
    ]);
  } catch { /* already clean or file missing */ }
}

// MARK: — Safe defaults (mirrors clip-vision.js SAFE_DEFAULTS)

const SAFE_DEFAULTS = {
  isTalkingHead:        false,
  hasFace:              false,
  qualityScore:         50,
  contentTags:          [],
  description:          '',
  matchesDirectorNotes: null,
  suggestedRotation:    null,
  bestFrame:            null,
  facePresenceRatio:    0,
};

// MARK: — Binary availability check (cached)

let _binChecked  = false;
let _binAvailable = false;

function binAvailable() {
  if (_binChecked) return _binAvailable;
  _binChecked   = true;
  _binAvailable = fs.existsSync(visionCliBin());
  if (!_binAvailable) {
    console.warn('[clip-vision-apple] vision-cli binary not found at', visionCliBin());
  }
  return _binAvailable;
}

// MARK: — analyzeClip

/**
 * analyzeClip(clip, directorNotes, opts)
 *
 * Runs vision-cli on the clip. Returns the same shape as clip-vision-claude.js.
 *
 * directorNotes and opts.highSensitivity are accepted for API compatibility
 * but are not passed to the binary — those semantic tasks stay with Claude.
 */
async function analyzeClip(clip, _directorNotes = '', _opts = {}) {
  if (!binAvailable()) {
    // Binary missing — fall back to Claude backend automatically.
    console.warn('[clip-vision-apple] falling back to Claude backend (binary unavailable)');
    const { analyzeClip: claudeAnalyze } = require('./clip-vision-claude');
    const r = await claudeAnalyze(clip, _directorNotes, _opts);
    r._source = 'claude:apple-fallback';
    return r;
  }

  stripQuarantine();

  try {
    const { stdout, stderr } = await execFileAsync(
      visionCliBin(),
      [clip.path],
      { timeout: 60_000, maxBuffer: 64 * 1024 }
    );

    if (stderr) {
      console.warn(`[clip-vision-apple] ${path.basename(clip.path)}: stderr: ${stderr.trim()}`);
    }

    const parsed = JSON.parse(stdout.trim());

    // Validate rotation — only accept 0/90/180/270
    const validRotations = new Set([0, 90, 180, 270]);
    const suggestedRotation =
      typeof parsed.suggestedRotation === 'number' && validRotations.has(parsed.suggestedRotation)
        ? parsed.suggestedRotation
        : null;

    const result = {
      isTalkingHead:        !!parsed.isTalkingHead,
      hasFace:              !!parsed.hasFace,
      qualityScore:         typeof parsed.qualityScore === 'number'
                              ? Math.max(0, Math.min(100, Math.round(parsed.qualityScore)))
                              : 50,
      contentTags:          [],       // Claude handles semantic tags
      description:          '',       // Claude handles descriptions
      matchesDirectorNotes: null,     // Claude handles this
      suggestedRotation,
      facePresenceRatio:    typeof parsed.facePresenceRatio === 'number'
                              ? parsed.facePresenceRatio : 0,
      bestFrame:            typeof parsed.bestFrame === 'number' ? parsed.bestFrame : null,
      _source:              'apple',
    };

    console.log(
      `[clip-vision] ${path.basename(clip.path)}: ` +
      `${result.isTalkingHead ? 'TALKING-HEAD' : result.hasFace ? 'FACE/BROLL' : 'BROLL'} ` +
      `quality=${result.qualityScore} rot=${result.suggestedRotation ?? 'meta'} ` +
      `faceRatio=${result.facePresenceRatio.toFixed(2)} [apple]`
    );

    return result;
  } catch (err) {
    console.warn(
      `[clip-vision-apple] ${path.basename(clip.path)}: binary error (${err.message}) — ` +
      `falling back to Claude`
    );
    const { analyzeClip: claudeAnalyze } = require('./clip-vision-claude');
    const r = await claudeAnalyze(clip, _directorNotes, _opts);
    r._source = `claude:apple-error:${err.message}`;
    return r;
  }
}

module.exports = { analyzeClip, visionCliBin, binAvailable };
