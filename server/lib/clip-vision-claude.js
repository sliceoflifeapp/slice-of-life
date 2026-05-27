// Unified Claude Vision pass — one API call per clip that returns:
// talking head detection, quality score, content tags, description,
// and suggested rotation.

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
  suggestedRotation:    null,  // null = fall back to probe metadata
};

// Singleton Anthropic client — created once on first use.
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
function resetClient() { _client = null; }


// Extract a single JPEG frame at seekSec, scaled to 512px wide.
// Frames are sent raw (no pre-rotation) — Claude reports the TOTAL clockwise
// rotation needed to upright the clip from raw pixels.
async function grabFrame(videoPath, seekSec, tmpPath) {
  const args = [
    '-noautorotate',
    '-ss', seekSec.toFixed(2),
    '-i', videoPath,
    '-frames:v', '1', '-q:v', '5',
    '-vf', 'scale=512:-2',
    '-y', tmpPath,
  ];
  await execFileAsync(ffmpegPath, args, { timeout: 12000 });
  return fs.readFileSync(tmpPath).toString('base64');
}

// Returns evenly-spaced seek proportions scaled to clip duration.
// More frames for longer clips where temporal precision matters most.
function seekProportions(durationSec) {
  let count;
  if      (durationSec <  60) count = 6;
  else if (durationSec < 180) count = 8;
  else if (durationSec < 480) count = 10;
  else                         count = 12;
  // Place frames at 1/(n+1), 2/(n+1) … n/(n+1) — evenly spaced, never at edges
  return Array.from({ length: count }, (_, i) => (i + 1) / (count + 1));
}

// Build the Vision prompt. frameProportions is the actual array sent so the
// description matches what Claude sees.
function buildPrompt(frameProportions, highSensitivity) {
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
    '  "suggestedRotation": number — total clockwise degrees (0, 90, 180, or 270) needed to upright this clip from raw pixels. Frames are unrotated — if the image appears sideways or upside-down, specify the full correction needed. IMPORTANT: if a human face is visible, mentally apply your chosen rotation and verify the face would be upright (forehead above chin, eyes above mouth). If the face would be inverted after rotation, add 180° to your answer. Use 0 if already correctly oriented,\n' +
    `  "bestFrame": number 0-${n - 1} — which frame works best as a documentary cutaway. Prioritise: (1) stable camera, sharp subject, good composition; (2) avoid frames where the camera is clearly being placed/picked up, hands are in frame, or the subject is blurry/transitioning; (3) prefer frames from the middle of the clip over the first or last frame unless those are clearly the best\n` +
    '}';

  if (highSensitivity) {
    prompt +=
      '\n\nNote: be generous in classifying talking heads — include uncertain cases.';
  }

  return prompt;
}

// Send frames to Claude and parse the JSON response.
async function askClaude(client, imageDataArray, frameProportions, highSensitivity) {
  const content = [
    ...imageDataArray.map(imageData => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: imageData },
    })),
    {
      type: 'text',
      text: buildPrompt(frameProportions, highSensitivity),
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
    suggestedRotation,
    bestFrame: typeof parsed.bestFrame === 'number' && parsed.bestFrame >= 0 && parsed.bestFrame < frameProportions.length
                 ? Math.round(parsed.bestFrame) : null,
    frameProportions,
  };
}

/**
 * analyzeClip(clip, opts)
 *
 * Performs a single Claude Vision call on frames extracted from the clip.
 *
 * @param {object} clip — clip object with .path and .duration
 * @param {object} [opts]
 * @param {boolean} [opts.highSensitivity] — be generous with talking head classification
 *
 * @returns {Promise<{
 *   isTalkingHead: boolean,
 *   hasFace: boolean,
 *   qualityScore: number,
 *   contentTags: string[],
 *   description: string,
 *   suggestedRotation: number|null,
 *   bestFrame: number|null
 * }>}
 */
async function analyzeClip(clip, opts = {}) {
  const client = getClient();
  if (!client) {
    console.warn('[clip-vision] no API key — using offline heuristics');
    const { analyzeClipOffline } = require('./clip-vision-offline');
    const r = await analyzeClipOffline(clip, opts);
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
    const imageDataArray = await Promise.all(
      seekPoints.map((seekSec, i) => grabFrame(clip.path, seekSec, tmpPaths[i]))
    );
    const result = await askClaude(client, imageDataArray, proportions, !!opts.highSensitivity);

    console.log(
      `[clip-vision] ${path.basename(clip.path)}: ` +
      `${result.isTalkingHead ? 'TALKING-HEAD' : result.hasFace ? 'FACE/BROLL' : 'BROLL'} ` +
      `quality=${result.qualityScore} rot=${result.suggestedRotation ?? 'meta'} ` +
      `tags=[${result.contentTags.join(',')}] ` +
      `"${result.description}"`
    );

    result._source = 'online';
    return result;
  } catch (err) {
    // Any API failure (network down, timeout, server error) — offline heuristics
    // are always better than flat SAFE_DEFAULTS which mark every clip as b-roll.
    console.warn(`[clip-vision] ${path.basename(clip.path)}: API error (${err.name || err.message}) — using offline heuristics`);
    const { analyzeClipOffline } = require('./clip-vision-offline');
    const r2 = await analyzeClipOffline(clip, opts);
    r2._source = `offline:${err.name || 'api-error'}`;
    return r2;
  } finally {
    for (const p of tmpPaths) { try { fs.unlinkSync(p); } catch {} }
  }
}

module.exports = { analyzeClip, resetClient };
