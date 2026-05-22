// Offline fallback for clip-vision.js — no network calls.
// Uses ffmpeg volumedetect to guess whether a clip contains speech (a-roll)
// and derives a quality score from clip duration.
// Returns the same shape as analyzeClip() in clip-vision.js.

const path          = require('path');
const { execFile }  = require('child_process');
const { promisify } = require('util');
const ffmpegPath    = require('ffmpeg-static');

const execFileAsync = promisify(execFile);

function qualityFromDuration(duration) {
  if (duration < 3)  return 15;
  if (duration < 15) return Math.round(30 + ((duration - 3) / 12) * 35);
  return 65;
}

async function analyzeClipOffline(clip) {
  let isTalkingHead = false;

  try {
    const result = await execFileAsync(
      ffmpegPath,
      ['-i', clip.path, '-af', 'volumedetect', '-f', 'null', '/dev/null'],
      { timeout: 15000 }
    ).catch(e => e);

    const out     = result.stderr || result.message || '';
    const meanVol = parseFloat((out.match(/mean_volume:\s*([-\d.]+)\s*dB/) || [])[1]);
    const maxVol  = parseFloat((out.match(/max_volume:\s*([-\d.]+)\s*dB/)  || [])[1]);

    // Pass any clip with non-silent audio through as a talking-head candidate.
    // Whisper's words-per-second check is the real gatekeeper — this just
    // filters out clips with no audio track or completely silent footage.
    if (!isNaN(maxVol)) {
      isTalkingHead = maxVol > -50;
    }
  } catch (err) {
    console.warn(`[clip-vision-offline] volumedetect failed for ${path.basename(clip.path)}: ${err.message}`);
  }

  const qualityScore = qualityFromDuration(clip.duration || 0);

  console.log(
    `[clip-vision-offline] ${path.basename(clip.path)}: ` +
    `${isTalkingHead ? 'TALKING-HEAD' : 'BROLL'} quality=${qualityScore}`
  );

  return {
    isTalkingHead,
    hasFace:              false,
    qualityScore,
    contentTags:          [],
    description:          '',
    matchesDirectorNotes: null,
    suggestedRotation:    null,  // fall back to metadata probe
    _source:              'offline',
  };
}

module.exports = { analyzeClipOffline };
