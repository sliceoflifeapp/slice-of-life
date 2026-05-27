// B-roll indexer: shot boundary detection → stable ranges → representative frames → broll_index.json
//
// Uses ffmpeg's built-in scene detection (select=gt(scene,threshold)) instead of PySceneDetect
// so there are zero new dependencies — ffmpeg-static is already bundled.
//
// Public API:
//   indexBrollFolder(inputFolder, outputPath, opts?) → Promise<BrollIndex>
//
// opts defaults:
//   sceneThreshold: 0.35   — ffmpeg scene change sensitivity (0=very sensitive, 1=none)
//   settleOffset:   1.5    — seconds to skip at start of each shot (camera settling fallback)
//   endPad:         0.25   — seconds to skip at end of each shot
//   minUsable:      1.5    — minimum stable duration to consider a shot usable
//   frameQuality:   5      — ffmpeg -q:v for extracted frames (lower = better quality)
//   frameWidth:     512    — extracted frame width (height auto-scaled)

const path          = require('path');
const fs            = require('fs');
const { execFile }  = require('child_process');
const { promisify } = require('util');
const ffmpegPath    = require('ffmpeg-static');

const { fullScan }        = require('./scanner');
const { extractMetadata } = require('./metadata');

const execFileAsync = promisify(execFile);

// Singleton Anthropic client — same pattern as clip-vision-claude.js
let _client = null;
function getClient() {
  if (_client) return _client;
  const cfgPath = require('path').join(require('./app-data').getAppDataDir(), 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8')); } catch {}
  const key = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey: key });
  return _client;
}

// Ask Claude Haiku when the camera finishes settling at the START of a clip.
// Extracts frames at 0.5s, 1.0s, 1.5s and asks which is the first stable frame.
// Returns seconds (0, 0.5, 1.0, or 1.5). Stored at the clip level as settle_start.
async function askSettleStart(client, videoPath, duration, opts) {
  // Don't bother on very short clips
  if (duration < 2.0) return 0;

  const times  = [0.5, 1.0, 1.5].filter(t => t < duration - 0.2);
  if (times.length === 0) return 0;

  const tmpPaths = times.map((t, i) =>
    path.join(require('os').tmpdir(), `sol-settle-${Date.now()}-${i}.jpg`)
  );

  try {
    await Promise.all(times.map((t, i) => extractFrame(videoPath, t, tmpPaths[i], opts)));

    const content = [
      ...tmpPaths.map(p => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(p).toString('base64') },
      })),
      {
        type: 'text',
        text:
          `These ${times.length} frames are from the opening of a video clip at ` +
          `${times.map(t => t + 's').join(', ')}. ` +
          `At what timestamp does the camera become stable — no hands covering the lens, ` +
          `no motion blur, no camera shake? ` +
          `Reply with only one of: 0, ${times.join(', ')}. ` +
          `Reply 0 if the camera is already stable from the very start.`,
      },
    ];

    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 5,
      messages:   [{ role: 'user', content }],
    });

    const raw  = msg.content[0].text.trim();
    const num  = parseFloat(raw.match(/[\d.]+/)?.[0] ?? '');
    const valid = [0, ...times];
    return valid.includes(num) ? num : 0;
  } catch (err) {
    console.warn(`[broll-indexer] askSettleStart failed for ${path.basename(videoPath)}: ${err.message}`);
    return 0;
  } finally {
    for (const p of tmpPaths) { try { fs.unlinkSync(p); } catch {} }
  }
}

// Ask Claude Haiku which of the 3 sampled frames is the earliest point where
// the shot is stable and worth watching. Returns the index (0, 1, or 2).
async function askBestStart(client, sampledFrames) {
  const pcts = ['25%', '50%', '75%'];
  const content = [
    ...sampledFrames.map(f => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(f.path).toString('base64') },
    })),
    {
      type: 'text',
      text:
        `These 3 frames are from a video clip at ${pcts.join(', ')} through a shot. ` +
        `Which percentage is the earliest point where the camera has settled and the shot is worth watching — ` +
        `not a hand, not a lens cap, not motion blur, not a transition? ` +
        `Reply with only the number: 25, 50, or 75.`,
    },
  ];

  const msg = await client.messages.create({
    model:     'claude-haiku-4-5-20251001',
    max_tokens: 5,
    messages:  [{ role: 'user', content }],
  });

  const raw = msg.content[0].text.trim();
  const num = parseInt(raw.match(/\d+/)?.[0] ?? '');
  const valid = [25, 50, 75];
  const idx = valid.indexOf(num);
  return idx >= 0 ? idx : 0; // default to first frame (25%) on any parse failure
}

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.3gp', '.wmv', '.flv', '.webm', '.ts', '.mts', '.m2ts']);

const DEFAULTS = {
  sceneThreshold: 0.35,
  settleOffset:   1.5,
  endPad:         0.25,
  minUsable:      1.5,
  frameQuality:   5,
  frameWidth:     512,
};

// Run ffmpeg scene detection; returns sorted array of scene-change timestamps in seconds.
// Always starts with 0. Duration is appended by the caller to form shot intervals.
async function detectSceneChanges(videoPath, threshold) {
  const args = [
    '-i', videoPath,
    '-vf', `select='gt(scene,${threshold})',showinfo`,
    '-vsync', 'vfr',
    '-f', 'null', '-',
  ];

  // ffmpeg writes showinfo to stderr; we intentionally capture stderr
  const result = await execFileAsync(ffmpegPath, args, {
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  }).catch(e => e); // ffmpeg exits non-zero when output is /dev/null — that's expected

  const stderr = result.stderr || result.message || '';
  const timestamps = [0];

  for (const line of stderr.split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) {
      const t = parseFloat(m[1]);
      if (!isNaN(t) && t > 0) timestamps.push(t);
    }
  }

  return [...new Set(timestamps)].sort((a, b) => a - b);
}

// Build shot intervals [[start, end], ...] from scene-change timestamps + clip duration.
function buildShotIntervals(sceneChanges, duration) {
  const cuts = [...sceneChanges];
  if (cuts[cuts.length - 1] < duration - 0.05) cuts.push(duration);
  const intervals = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    intervals.push([cuts[i], cuts[i + 1]]);
  }
  return intervals.length > 0 ? intervals : [[0, duration]];
}

// Calculate stable range within a shot; returns null if shot is too short to be usable.
function stableRange(shotStart, shotEnd, opts) {
  const stableStart = shotStart + opts.settleOffset;
  const stableEnd   = shotEnd   - opts.endPad;
  const usable      = (stableEnd - stableStart) >= opts.minUsable;
  return { stableStart, stableEnd, usable };
}

// Extract a single JPEG frame from videoPath at seekSec, write to outPath.
async function extractFrame(videoPath, seekSec, outPath, opts) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const args = [
    '-ss', seekSec.toFixed(3),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', `scale=${opts.frameWidth}:-2`,
    '-q:v', String(opts.frameQuality),
    '-y', outPath,
  ];
  await execFileAsync(ffmpegPath, args, { timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
}

// Build a deterministic clip_id from filename without extension.
function clipId(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

// Build a deterministic shot_id: clipId + zero-padded shot index.
function shotId(cId, shotIndex) {
  return `${cId}_shot_${String(shotIndex + 1).padStart(3, '0')}`;
}

// Process a single clip: probe metadata → detect shots → extract frames → return clip entry.
async function processClip(filePath, framesBaseDir, opts) {
  const cId    = clipId(filePath);
  const relPath = filePath; // store absolute path; callers can make relative if needed

  let meta;
  try {
    meta = await extractMetadata(filePath);
  } catch (err) {
    return { clip_id: cId, file_path: relPath, error: `metadata: ${err.message}`, shots: [] };
  }

  const duration = meta.duration;
  if (!duration || duration <= 0) {
    return { clip_id: cId, file_path: relPath, error: 'could not determine duration', shots: [] };
  }

  let fps = 30;
  let width  = meta.width  || null;
  let height = meta.height || null;
  try {
    const probeResult = await execFileAsync(ffmpegPath, ['-i', filePath], {
      timeout: 10000, maxBuffer: 2 * 1024 * 1024,
    }).catch(e => e);
    const info = probeResult.stderr || probeResult.message || '';
    const fpsM = info.match(/(\d+(?:\.\d+)?)\s*(?:tbr|fps)/);
    if (fpsM) fps = parseFloat(fpsM[1]);
    if (!width || !height) {
      const dimM = info.match(/(\d{2,5})x(\d{2,5})/);
      if (dimM) { width = parseInt(dimM[1]); height = parseInt(dimM[2]); }
    }
  } catch { /* non-fatal */ }

  let sceneChanges;
  try {
    sceneChanges = await detectSceneChanges(filePath, opts.sceneThreshold);
  } catch (err) {
    return { clip_id: cId, file_path: relPath, duration, fps, width, height, error: `scene_detect: ${err.message}`, shots: [] };
  }

  const intervals = buildShotIntervals(sceneChanges, duration);
  const shots     = [];

  for (let i = 0; i < intervals.length; i++) {
    const [shotStart, shotEnd] = intervals[i];
    const sId = shotId(cId, i);
    const { stableStart, stableEnd, usable } = stableRange(shotStart, shotEnd, opts);

    const avoidRanges = [];
    if (shotStart < stableStart) {
      avoidRanges.push({ start: shotStart, end: stableStart, reason: 'camera settling / stable_start offset' });
    }
    if (stableEnd < shotEnd) {
      avoidRanges.push({ start: stableEnd, end: shotEnd, reason: 'end padding / stable_end offset' });
    }

    const sampledFrames = [];
    const qualityFlags  = [];

    let bestStart = null; // set by Vision call below

    if (usable) {
      const stableDur = stableEnd - stableStart;
      for (const [pct, label] of [[0.25, '25'], [0.50, '50'], [0.75, '75']]) {
        const ts      = stableStart + stableDur * pct;
        const outPath = path.join(framesBaseDir, cId, sId, `frame_${label}.jpg`);
        try {
          await extractFrame(filePath, ts, outPath, opts);
          sampledFrames.push({ timestamp: parseFloat(ts.toFixed(3)), path: outPath });
        } catch (err) {
          qualityFlags.push('frame_extraction_failed');
          console.warn(`[broll-indexer] frame extraction failed for ${sId} at ${ts.toFixed(2)}s: ${err.message}`);
        }
      }

      // Ask Claude which frame is the earliest stable/watchable point
      if (sampledFrames.length === 3) {
        const client = getClient();
        if (client) {
          try {
            const bestIdx = await askBestStart(client, sampledFrames);
            bestStart = sampledFrames[bestIdx].timestamp;
          } catch (err) {
            console.warn(`[broll-indexer] askBestStart failed for ${sId}: ${err.message}`);
          }
        }
      }
    }

    shots.push({
      shot_id:      sId,
      shot_start:   parseFloat(shotStart.toFixed(3)),
      shot_end:     parseFloat(shotEnd.toFixed(3)),
      stable_start: parseFloat(stableStart.toFixed(3)),
      stable_end:   parseFloat(stableEnd.toFixed(3)),
      best_start:   bestStart !== null ? parseFloat(bestStart.toFixed(3)) : null,
      usable,
      quality_flags: qualityFlags,
      avoid_ranges:  avoidRanges,
      sampled_frames: sampledFrames,
      vision_labels:  [],
      vision_summary: null,
    });
  }

  // Ask Claude when camera finishes settling at the opening of this clip.
  // Stored at clip level (not shot level) — applies to aroll usage.
  let settle_start = 0;
  const clientForSettle = getClient();
  if (clientForSettle) {
    settle_start = await askSettleStart(clientForSettle, filePath, duration, opts);
    if (settle_start > 0) {
      console.log(`[broll-indexer] ${path.basename(filePath)}: settle_start=${settle_start}s`);
    }
  }

  return {
    clip_id:      cId,
    file_path:    relPath,
    duration:     parseFloat(duration.toFixed(3)),
    fps:          parseFloat(fps.toFixed(3)),
    width,
    height,
    settle_start,
    error: null,
    shots,
  };
}

/**
 * Index a folder of B-roll clips.
 *
 * @param {string} inputFolder   — path to folder containing B-roll video files
 * @param {string} outputPath    — where to write broll_index.json
 * @param {object} [opts]        — override DEFAULTS above
 * @returns {Promise<object>}    — the full index object (also written to outputPath)
 */
async function indexBrollFolder(inputFolder, outputPath, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  const framesBaseDir = path.join(path.dirname(outputPath), 'frames');
  fs.mkdirSync(framesBaseDir, { recursive: true });

  const allFiles = fullScan(inputFolder).filter(f => f.type === 'video');
  console.log(`[broll-indexer] found ${allFiles.length} video files in ${inputFolder}`);

  const clips = [];
  for (const file of allFiles) {
    console.log(`[broll-indexer] processing ${file.name}...`);
    try {
      const entry = await processClip(file.path, framesBaseDir, cfg);
      if (entry.error) {
        console.warn(`[broll-indexer] ${file.name}: ${entry.error}`);
      } else {
        const usableShots = entry.shots.filter(s => s.usable).length;
        console.log(`[broll-indexer] ${file.name}: ${entry.shots.length} shot(s), ${usableShots} usable`);
      }
      clips.push(entry);
    } catch (err) {
      // Unexpected error — record but never crash the whole run
      console.error(`[broll-indexer] unexpected error on ${file.name}: ${err.message}`);
      clips.push({
        clip_id:   clipId(file.path),
        file_path: file.path,
        error:     err.message,
        shots:     [],
      });
    }
  }

  const index = {
    _version:      3,
    created_at:    new Date().toISOString(),
    source_folder: inputFolder,
    clips,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(index, null, 2));
  console.log(`[broll-indexer] wrote ${outputPath}`);

  return index;
}

module.exports = { indexBrollFolder };
