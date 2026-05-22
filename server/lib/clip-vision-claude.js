// Unified Claude Vision pass — one API call per clip that returns:
// talking head detection, quality score, content tags, description,
// and optional director's notes matching.
//
// Replaces face-detect.js + score-broll.js with a single Vision call per clip.

const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { execFile }  = require('child_process');
const { promisify } = require('util');
const ffmpegPath    = require('ffmpeg-static');

const execFileAsync = promisify(execFile);

// Safe defaults returned on any error so the pipeline always gets a usable result.
const SAFE_DEFAULTS = {
  isTalkingHead:        false,
  hasFace:              false,
  qualityScore:         50,
  contentTags:          [],
  description:          '',
  matchesDirectorNotes: null,
  suggestedRotation:    null,  // null = fall back to probe metadata
};

// Singleton Anthropic client — created once on first use.
// Mirrors the pattern used in face-detect.js exactly.
let _client = null;
function getClient() {
  if (_client) return _client;
  const cfgPath = path.join(require('./app-data').getAppDataDir(), 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  const key = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey: key });
  return _client;
}


// Build a vf filter string to upright a frame given a rotation angle.
function rotationVf(rotation) {
  if (rotation === 90)  return 'transpose=1';
  if (rotation === 270) return 'transpose=2';
  if (rotation === 180) return 'hflip,vflip';
  return '';
}

// Probe a clip's rotation from metadata — used so Vision receives
// approximately upright frames for accurate talking-head detection.
async function probeRotation(videoPath) {
  try {
    const r = await execFileAsync(ffmpegPath, ['-i', videoPath], { maxBuffer: 2 * 1024 * 1024 }).catch(e => e);
    const out = r.stderr || r.message || '';
    const tagRot = out.match(/rotate\s*:\s*(-?\d+)/);
    const matRot = out.match(/rotation of\s*(-?[\d.]+)\s*degrees/i);
    let rotation = 0;
    if (tagRot)       rotation = ((parseInt(tagRot[1], 10) + 360) % 360);
    else if (matRot)  rotation = ((-parseFloat(matRot[1]) + 360) % 360);
    return Math.round(rotation / 90) * 90 % 360;
  } catch { return 0; }
}

// Extract a single JPEG frame at seekSec, scaled to 512px wide.
// Applies metadata-based rotation so Claude receives approximately upright
// frames — enabling reliable talking-head detection. Claude then reports
// whether additional rotation correction is needed on top of this.
async function grabFrame(videoPath, seekSec, tmpPath, rotation) {
  const vf = rotationVf(rotation);
  const scaleFilter = 'scale=512:-2';
  const combinedVf  = vf ? `${vf},${scaleFilter}` : scaleFilter;
  const args = [
    '-noautorotate',
    '-ss', seekSec.toFixed(2),
    '-i', videoPath,
    '-frames:v', '1', '-q:v', '5',
    '-vf', combinedVf,
    '-y', tmpPath,
  ];
  await execFileAsync(ffmpegPath, args, { timeout: 12000 });
  return fs.readFileSync(tmpPath).toString('base64');
}

// Returns evenly-spaced seek proportions scaled to clip duration.
// More frames for longer clips where temporal precision matters most.
function seekProportions(durationSec) {
  let count;
  if      (durationSec <  60) count = 3;
  else if (durationSec < 180) count = 5;
  else if (durationSec < 480) count = 7;
  else                         count = 9;
  // Place frames at 1/(n+1), 2/(n+1) … n/(n+1) — evenly spaced, never at edges
  return Array.from({ length: count }, (_, i) => (i + 1) / (count + 1));
}

// Build the Vision prompt. frameProportions is the actual array sent so the
// description matches what Claude sees.
function buildPrompt(frameProportions, directorNotes, highSensitivity) {
  const n         = frameProportions.length;
  const frameDesc = frameProportions.map((p, i) => `frame ${i} at ${Math.round(p * 100)}%`).join(', ');
  let prompt =
    `Analyze these ${n} frames sampled from a video clip (${frameDesc}) and return ONLY a JSON object with no markdown:\n` +
    '{\n' +
    '  "isTalkingHead": boolean — true if a person is looking toward camera and appears to be speaking/narrating,\n' +
    '  "hasFace": boolean — true if any face is visible,\n' +
    '  "qualityScore": number 0-100 — visual quality (composition, sharpness, lighting, interest; 0=unusable, 50=average, 100=excellent),\n' +
    '  "contentTags": array of applicable tags from: ["food","landscape","people","action","architecture","text","indoor","outdoor","animal","vehicle","water","night"],\n' +
    '  "description": "one brief sentence describing what\'s in this clip",\n' +
    '  "suggestedRotation": number — additional degrees clockwise (0, 90, 180, or 270) needed to correct orientation. These frames have already been pre-rotated using device metadata. If they still appear sideways or upside-down, specify the additional correction needed. Use 0 if correctly oriented,\n' +
    `  "bestFrame": number 0-${n - 1} — which frame index contains the most visually interesting moment for a short cutaway shot\n` +
    '}';

  if (directorNotes) {
    prompt +=
      '\n\nAlso add: "matchesDirectorNotes": boolean — does this shot match or support these instructions: "' +
      directorNotes.replace(/"/g, '\\"') +
      '"';
  }

  if (highSensitivity) {
    prompt +=
      '\n\nNote: be generous in classifying talking heads — include uncertain cases.';
  }

  return prompt;
}

// Send frames to Claude and parse the JSON response.
async function askClaude(client, imageDataArray, frameProportions, directorNotes, highSensitivity) {
  const content = [
    ...imageDataArray.map(imageData => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: imageData },
    })),
    {
      type: 'text',
      text: buildPrompt(frameProportions, directorNotes, highSensitivity),
    },
  ];

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 450,
    messages: [{ role: 'user', content }],
  });

  const raw = msg.content[0].text.trim();

  // Strip any accidental markdown fences before parsing.
  const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed  = JSON.parse(jsonStr);

  const rawRot = parsed.suggestedRotation;
  const validRotations = new Set([0, 90, 180, 270]);
  const suggestedRotation = validRotations.has(rawRot) ? rawRot : null;

  return {
    isTalkingHead:        !!parsed.isTalkingHead,
    hasFace:              !!parsed.hasFace,
    qualityScore:         typeof parsed.qualityScore === 'number'
                            ? Math.max(0, Math.min(100, Math.round(parsed.qualityScore)))
                            : 50,
    contentTags:          Array.isArray(parsed.contentTags) ? parsed.contentTags : [],
    description:          typeof parsed.description === 'string' ? parsed.description : '',
    matchesDirectorNotes: 'matchesDirectorNotes' in parsed
                            ? !!parsed.matchesDirectorNotes
                            : null,
    suggestedRotation,
    bestFrame: typeof parsed.bestFrame === 'number' && parsed.bestFrame >= 0 && parsed.bestFrame < frameProportions.length
                 ? Math.round(parsed.bestFrame) : null,
  };
}

/**
 * analyzeClip(clip, directorNotes, opts)
 *
 * Performs a single Claude Vision call on one frame extracted from the clip.
 *
 * @param {object} clip          — clip object with .path and .duration
 * @param {string} directorNotes — optional director's notes / description
 * @param {object} [opts]
 * @param {boolean} [opts.highSensitivity] — trip mode: be generous with talking heads
 *
 * @returns {Promise<{
 *   isTalkingHead: boolean,
 *   hasFace: boolean,
 *   qualityScore: number,
 *   contentTags: string[],
 *   description: string,
 *   matchesDirectorNotes: boolean|null
 * }>}
 */
async function analyzeClip(clip, directorNotes = '', opts = {}) {
  const client = getClient();
  if (!client) {
    console.warn('[clip-vision] no API key — using offline heuristics');
    const { analyzeClipOffline } = require('./clip-vision-offline');
    const r = await analyzeClipOffline(clip, directorNotes, opts);
    r._source = 'offline:no-key';
    return r;
  }

  const dur         = clip.duration > 0 ? clip.duration : 10;
  const proportions = seekProportions(dur);
  const seekPoints  = proportions.map(p => Math.min(dur - 0.5, Math.max(0.5, dur * p)));
  const tmpPaths    = seekPoints.map(() =>
    path.join(os.tmpdir(), `clip-vision-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`)
  );

  try {
    const metadataRot    = await probeRotation(clip.path);
    const imageDataArray = await Promise.all(
      seekPoints.map((seekSec, i) => grabFrame(clip.path, seekSec, tmpPaths[i], metadataRot))
    );
    const result = await askClaude(client, imageDataArray, proportions, directorNotes || '', !!opts.highSensitivity);

    // Compute final rotation: metadata pre-rotation + any additional correction Claude detected.
    // e.g. metadata=90° applied to frame, Claude sees landscape content sideways → additional=270°
    // → finalRotation = (90 + 270) % 360 = 0° → no rotation applied → stored pixels shown as-is ✓
    if (result.suggestedRotation != null) {
      result.suggestedRotation = (metadataRot + result.suggestedRotation) % 360;
    }

    console.log(
      `[clip-vision] ${path.basename(clip.path)}: ` +
      `${result.isTalkingHead ? 'TALKING-HEAD' : result.hasFace ? 'FACE/BROLL' : 'BROLL'} ` +
      `quality=${result.qualityScore} rot=${result.suggestedRotation ?? 'meta'} ` +
      `tags=[${result.contentTags.join(',')}] ` +
      (result.matchesDirectorNotes !== null ? `notes=${result.matchesDirectorNotes} ` : '') +
      `"${result.description}"`
    );

    result._source = 'online';
    return result;
  } catch (err) {
    // Any API failure (network down, timeout, server error) — offline heuristics
    // are always better than flat SAFE_DEFAULTS which mark every clip as b-roll.
    console.warn(`[clip-vision] ${path.basename(clip.path)}: API error (${err.name || err.message}) — using offline heuristics`);
    const { analyzeClipOffline } = require('./clip-vision-offline');
    const r2 = await analyzeClipOffline(clip, directorNotes, opts);
    r2._source = `offline:${err.name || 'api-error'}`;
    return r2;
  } finally {
    for (const p of tmpPaths) { try { fs.unlinkSync(p); } catch {} }
  }
}

module.exports = { analyzeClip };
