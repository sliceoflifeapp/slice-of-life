// B-roll quality scoring using ffmpeg signal analysis (no Claude Vision — fast & free).
// Checks: duration, brightness (YAVG from signalstats).
// Returns { score, reject, reason } per clip.
// scoreBroll(clips) filters rejects and sorts best-first.

const { execFile }  = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const ffmpegPath    = require('ffmpeg-static');

async function scoreClip(clip) {
  const duration = clip.duration || 0;

  // Hard rejects
  if (duration < 1.5) return { score: 0, reject: true, reason: 'too short' };

  // Slo-mo is usually visually interesting — give it a good baseline
  if (clip.isSloMo) return { score: 72, reject: false, reason: 'slo-mo' };

  try {
    // Sample a frame at 20% into the clip for signal analysis
    const seekTo = Math.max(0.5, duration * 0.2);
    const args = [
      '-ss', String(seekTo),
      '-i', clip.path,
      '-vf', 'signalstats',
      '-frames:v', '1',
      '-f', 'null', '-',
    ];

    const { stderr } = await execFileAsync(ffmpegPath, args, { timeout: 10000 });

    // Parse YAVG (luma average brightness 0–255) from signalstats output.
    // ffmpeg prints: [Parsed_signalstats_0 @ ...] YMIN:0 YLOW:0 YAVG:45.2 YHIGH:...
    const yavgMatch = stderr.match(/YAVG:(\d+\.?\d*)/);
    const yavg = yavgMatch ? parseFloat(yavgMatch[1]) : 128;

    let score = 50; // baseline

    // Brightness scoring (ideal range 40–200)
    if (yavg < 15)  return { score: 0, reject: true,  reason: 'too dark' };
    if (yavg > 240) return { score: 5, reject: true,  reason: 'overexposed' };
    if (yavg >= 40 && yavg <= 200) score += 20;
    else if (yavg < 40)  score += Math.round((yavg / 40) * 20);
    else                 score += Math.round(((255 - yavg) / 55) * 10);

    // Duration bonus — longer clips give more editing flexibility
    if (duration >= 10)     score += 20;
    else if (duration >= 5) score += 10;
    else if (duration >= 3) score += 5;

    // Time-lapse clips are usually visually interesting
    if (clip.isTimeLapse) score += 15;

    return { score: Math.min(100, score), reject: false };
  } catch {
    // If analysis fails, give a neutral score rather than reject
    return { score: 50, reject: false, reason: 'analysis failed' };
  }
}

// Score all clips in parallel, filter hard rejects, sort best-first.
async function scoreBroll(clips) {
  const scored = await Promise.all(
    clips.map(async clip => {
      const result = await scoreClip(clip);
      return { ...clip, brollScore: result.score, brollReject: result.reject, brollReason: result.reason };
    })
  );
  return scored
    .filter(c => !c.brollReject)
    .sort((a, b) => b.brollScore - a.brollScore);
}

module.exports = { scoreClip, scoreBroll };
