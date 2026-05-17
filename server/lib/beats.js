// Beat detection from an audio/music file
// Uses ffmpeg to extract raw PCM, then energy-based onset detection + autocorrelation BPM
// No external dependencies beyond ffmpeg-static

const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { execFile }  = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const ffmpegPath    = require('ffmpeg-static');

const SAMPLE_RATE = 22050;
const HOP         = 512;   // ~23ms per frame
const WINDOW      = 1024;  // ~46ms energy window

async function extractBeats(audioPath) {
  // ── 1. Extract mono float32 PCM ──────────────────────────────────────────
  const tmpPcm = path.join(os.tmpdir(), `yl-beats-${Date.now()}.raw`);
  try {
    await execFileAsync(ffmpegPath, [
      '-i', audioPath,
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 'f32le',
      '-y', tmpPcm,
    ], { maxBuffer: 200 * 1024 * 1024 });
  } catch (err) {
    console.error('Beat extraction failed:', err.message);
    return { beats: [], bpm: 120 };
  }

  const buf     = fs.readFileSync(tmpPcm);
  try { fs.unlinkSync(tmpPcm); } catch {}
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));

  // ── 2. Energy envelope ───────────────────────────────────────────────────
  const energies = [];
  for (let i = 0; i + WINDOW < samples.length; i += HOP) {
    let sum = 0;
    for (let j = 0; j < WINDOW; j++) sum += samples[i + j] ** 2;
    energies.push(Math.sqrt(sum / WINDOW));
  }

  // ── 3. Onset detection function (positive energy flux) ───────────────────
  const onset = new Float32Array(energies.length);
  for (let i = 1; i < energies.length; i++) {
    onset[i] = Math.max(0, energies[i] - energies[i - 1]);
  }

  // ── 4. Adaptive peak picking ─────────────────────────────────────────────
  const CONTEXT = 43; // ~1 second of context frames
  const MULT    = 1.4;
  const MIN_GAP = Math.round(0.25 * SAMPLE_RATE / HOP); // min 250ms between beats

  const rawBeats = [];
  let   lastPeak = -MIN_GAP;

  for (let i = CONTEXT; i < onset.length - CONTEXT; i++) {
    if (i - lastPeak < MIN_GAP) continue;

    // Local adaptive threshold
    let localSum = 0;
    for (let j = i - CONTEXT; j <= i + CONTEXT; j++) localSum += onset[j];
    const threshold = (localSum / (CONTEXT * 2 + 1)) * MULT;

    if (onset[i] < threshold) continue;

    // Local maximum check
    let isMax = true;
    for (let j = i - 3; j <= i + 3; j++) {
      if (j !== i && onset[j] >= onset[i]) { isMax = false; break; }
    }
    if (!isMax) continue;

    rawBeats.push((i * HOP) / SAMPLE_RATE);
    lastPeak = i;
  }

  if (rawBeats.length < 4) return { beats: rawBeats, bpm: 120 };

  // ── 5. BPM from median inter-beat interval ───────────────────────────────
  const intervals = [];
  for (let i = 1; i < rawBeats.length; i++) intervals.push(rawBeats[i] - rawBeats[i - 1]);
  intervals.sort((a, b) => a - b);
  const medianIBI  = intervals[Math.floor(intervals.length / 2)];
  let   bpm        = 60 / medianIBI;

  // Snap to musically sensible BPM range (60–200), allow doubling/halving
  while (bpm < 60)  bpm *= 2;
  while (bpm > 200) bpm /= 2;
  const beatInterval = 60 / bpm;

  // ── 6. Regularize to a clean beat grid anchored at first raw beat ────────
  const totalDuration = samples.length / SAMPLE_RATE;
  const beats = [];
  let t = rawBeats[0];
  while (t < totalDuration) {
    beats.push(parseFloat(t.toFixed(4)));
    t += beatInterval;
  }

  return { beats, bpm: Math.round(bpm), beatInterval };
}

// Given a target minimum duration and a beat grid starting from offsetSec,
// return the clip duration that snaps to the nearest beat boundary.
// Prefers multiples of 2 beats, min 2 beats, max whatever fits.
function snapDuration(offsetSec, minDur, maxDur, beats, beatInterval) {
  const bi = beatInterval || 0.5;

  // Find beats that fall within [offsetSec+minDur, offsetSec+maxDur]
  const candidates = beats.filter(b => {
    const rel = b - offsetSec;
    return rel >= minDur && rel <= maxDur;
  });

  if (candidates.length > 0) {
    // Prefer even-numbered beat multiples for musical phrasing
    const evenBeats = candidates.filter((b, idx) => {
      const beatCount = Math.round((b - offsetSec) / bi);
      return beatCount % 2 === 0;
    });
    const pool = evenBeats.length ? evenBeats : candidates;
    return parseFloat((pool[0] - offsetSec).toFixed(4));
  }

  // Fallback: snap to nearest beat multiple of minDur
  const numBeats = Math.max(2, Math.round(minDur / bi));
  return parseFloat(Math.min(maxDur, numBeats * bi).toFixed(4));
}

module.exports = { extractBeats, snapDuration };
