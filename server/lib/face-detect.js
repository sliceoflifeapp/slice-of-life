// Face detection using multiple frame grabs + Claude vision.
// Samples 3 frames spread across the clip so we don't miss a face that
// appears after the first few seconds (e.g. someone who starts talking at 30%).
// Applies rotation correction to frames before sending to Claude — clips stored
// upside down or sideways (display matrix metadata) need to be corrected so
// Claude can recognise the face. Without correction, upside-down faces fail
// detection and the clip is wrongly classified as b-roll.
// Falls back to uncertain=true if no API key, so Whisper still runs.

const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { execFile }  = require('child_process');
const { promisify } = require('util');
const ffmpegPath    = require('ffmpeg-static');

const execFileAsync = promisify(execFile);

// Singleton Anthropic client — created once on first use.
let _client = null;
function getClient() {
  if (_client) return _client;
  const cfgPath = path.join(os.homedir(), '.slice-of-life', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  const key = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey: key });
  return _client;
}

// Probe a video file for its display-matrix rotation (0, 90, 180, 270).
// Duplicates the logic from journal-video.js probe() to avoid a circular dep.
async function probeRotation(videoPath) {
  try {
    const r = await execFileAsync(ffmpegPath, ['-i', videoPath], { maxBuffer: 2 * 1024 * 1024 }).catch(e => e);
    const out = r.stderr || r.message || '';
    const tagRot = out.match(/rotate\s*:\s*(-?\d+)/);
    const matRot = out.match(/rotation of\s*(-?[\d.]+)\s*degrees/i);
    let rotation = 0;
    if (tagRot) {
      // rotate tag: degrees CW the stored pixels need to be corrected
      rotation = ((parseInt(tagRot[1], 10) + 360) % 360);
    } else if (matRot) {
      // display matrix: negate so we apply the same CW correction the player would
      rotation = ((-parseFloat(matRot[1]) + 360) % 360);
    }
    return Math.round(rotation / 90) * 90 % 360;
  } catch {
    return 0;
  }
}

// Build a vf filter string to upright a frame given its rotation angle.
// These are the same transforms used by the main pipeline for aroll clips.
function rotationVf(rotation) {
  if (rotation === 90)  return 'transpose=1';
  if (rotation === 270) return 'transpose=2';
  if (rotation === 180) return 'hflip,vflip';
  return '';
}

// Extract a single JPEG frame at seekSec from videoPath.
// -noautorotate + explicit vf ensures the frame is upright before being sent
// to Claude — necessary so face recognition works on clips stored sideways or
// upside down (e.g. display matrix -180°).
async function grabFrame(videoPath, seekSec, tmpPath, rotation) {
  const vf = rotationVf(rotation);
  const args = [
    '-noautorotate',
    '-ss', seekSec.toFixed(2),
    '-i', videoPath,
    '-frames:v', '1', '-q:v', '4',
  ];
  if (vf) args.push('-vf', vf);
  args.push('-y', tmpPath);
  await execFileAsync(ffmpegPath, args, { timeout: 12000 });
  return fs.readFileSync(tmpPath).toString('base64');
}

// Ask Claude whether any of the provided frames contain a face facing camera.
// Sends all frames in a single message to save latency + cost.
async function askClaude(client, imageDataList) {
  const content = [];
  for (const data of imageDataList) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
  }
  content.push({
    type: 'text',
    text: 'These are frames from the same video clip. Is there a person\'s face clearly visible and facing toward the camera in ANY of these frames? Reply with only YES or NO.',
  });

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 10,
    messages: [{ role: 'user', content }],
  });
  return msg.content[0].text.trim().toUpperCase();
}

// Returns { hasFace: bool, uncertain: bool }
// clipDuration: clip duration in seconds from probe (avoids redundant ffmpeg call).
//   Pass 0 or omit to fall back to internal probing.
async function detectFace(videoPath, clipDuration = 0) {
  const client = getClient();
  if (!client) return { hasFace: false, uncertain: true };

  // Resolve duration — use caller-supplied value if available.
  let dur = clipDuration > 0 ? clipDuration : 0;
  if (!dur) {
    try {
      const r = await execFileAsync(ffmpegPath, ['-i', videoPath], { maxBuffer: 1024 * 1024 }).catch(e => e);
      const out = r.stderr || r.message || '';
      const m = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) dur = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
    } catch {}
  }
  if (!dur || dur < 0.5) dur = 10; // safe fallback

  // Probe rotation so frames are sent upright to Claude.
  // This is fast (just reads metadata) and critical for clips stored upside
  // down or sideways — without it, Claude misses faces and the clip falls
  // through to b-roll with no rotation correction in the final video.
  const rotation = await probeRotation(videoPath);

  // Sample 3 seek points: 20%, 45%, 70% of clip — clamped to valid range.
  const seekPoints = [0.20, 0.45, 0.70]
    .map(pct => Math.min(dur - 0.5, Math.max(0.5, dur * pct)));

  const tmpPaths = seekPoints.map((_, i) =>
    path.join(os.tmpdir(), `yl-face-${Date.now()}-${i}.jpg`));

  try {
    // Grab all frames (parallel — faster than sequential)
    const frameResults = await Promise.allSettled(
      seekPoints.map((sec, i) => grabFrame(videoPath, sec, tmpPaths[i], rotation))
    );

    const imageDataList = frameResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    if (!imageDataList.length) {
      console.warn(`[face-detect] ${path.basename(videoPath)}: all frame grabs failed`);
      return { hasFace: false, uncertain: true };
    }

    const answer  = await askClaude(client, imageDataList);
    const hasFace = answer.startsWith('YES');
    console.log(`[face-detect] ${path.basename(videoPath)}: ${hasFace ? 'FACE' : 'NO FACE'} (${imageDataList.length} frames sampled)`);
    return { hasFace, uncertain: false };

  } catch (err) {
    console.warn('[face-detect] error:', err.message);
    return { hasFace: false, uncertain: true };
  } finally {
    for (const p of tmpPaths) { try { fs.unlinkSync(p); } catch {} }
  }
}

module.exports = { detectFace };
