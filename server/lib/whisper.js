const path        = require('path');
const fs          = require('fs');
const os          = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const ffmpegPath  = require('ffmpeg-static');

const execFileAsync = promisify(execFile);

function getWhisperBin() {
  // Works both in dev and in packaged asar.unpacked
  const base = path.dirname(require.resolve('nodejs-whisper/package.json'));
  return path.join(base, 'cpp', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
}

function getModelPath() {
  const base   = path.dirname(require.resolve('nodejs-whisper/package.json'));
  const models = path.join(base, 'cpp', 'whisper.cpp', 'models');
  // tiny.en is ~5× faster than base.en with ~95% accuracy — better for realtime use
  const preferred = path.join(models, 'ggml-tiny.en.bin');
  const fallback  = path.join(models, 'ggml-base.en.bin');
  return fs.existsSync(preferred) ? preferred : fallback;
}

// Singleton Anthropic client — created once on first use, reused for all calls.
let _anthropicClient = null;
function getClient() {
  if (_anthropicClient) return _anthropicClient;
  const cfgPath = path.join(os.homedir(), '.slice-of-life', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  const key = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  _anthropicClient = new Anthropic({ apiKey: key });
  return _anthropicClient;
}

// Extract 16kHz mono WAV from a video file (what Whisper requires)
async function extractAudio(videoPath, outWav) {
  // Only transcribe the first 90s — enough to classify talking head, much faster
  await execFileAsync(ffmpegPath, [
    '-i', videoPath,
    '-t', '90',
    '-ar', '16000', '-ac', '1',
    '-c:a', 'pcm_s16le',
    '-y', outWav,
  ], { maxBuffer: 200 * 1024 * 1024, timeout: 60000 });
}

// Semantic match between transcript and description using Claude.
// Returns a score 0–1. Synonyms, paraphrases, and related concepts all count.
async function descriptionMatch(transcriptText, description) {
  if (!description || !transcriptText) return null;
  try {
    const client = getClient();
    if (!client) return null;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 5,
      messages: [{
        role: 'user',
        content: `Day description: "${description}"\n\nTranscript: "${transcriptText.slice(0, 300)}"\n\nDoes the transcript relate to the day description? Synonyms and paraphrases count. Reply with a number 0-10 only.`,
      }],
    });

    const score = parseFloat(msg.content[0].text.trim()) / 10;
    return isNaN(score) ? null : Math.min(1, Math.max(0, score));
  } catch {
    return null;
  }
}

// Find the contiguous window of `maxDuration` seconds with the highest word
// density. Used to cap long narration clips to their most talkative section.
// Returns { windowStart, windowEnd } in clip-time seconds, or null if segments
// have no usable timing.
function findDenseWindow(segments, maxDuration) {
  const timed = segments.filter(s => s.end > 0);
  if (!timed.length) return null;

  let bestStart = timed[0].start;
  let bestEnd   = Math.min(timed[0].start + maxDuration, timed[timed.length - 1].end + 0.5);
  let bestWords = 0;

  for (let i = 0; i < timed.length; i++) {
    const wStart = timed[i].start;
    const wEnd   = wStart + maxDuration;
    let words = 0;
    for (const seg of timed) {
      if (seg.start >= wStart && seg.end <= wEnd) {
        words += seg.text.split(/\s+/).filter(Boolean).length;
      }
    }
    if (words > bestWords) {
      bestWords = words;
      bestStart = wStart;
      bestEnd   = Math.min(wEnd, timed[timed.length - 1].end + 0.5);
    }
  }

  return {
    windowStart: Math.max(0, bestStart - 0.3),
    windowEnd:   bestEnd,
  };
}

// Transcribe a video file. Returns { text, segments, wordCount, isTalkingHead }
// clipDurationSec: actual clip duration from probe — used for wps calculation
// description: optional day description from configure screen
async function transcribe(videoPath, clipDurationSec, description) {
  const tmpWav = path.join(os.tmpdir(), `yl-${Date.now()}.wav`);
  const outBase = tmpWav.replace('.wav', '');

  try {
    await extractAudio(videoPath, tmpWav);

    await execFileAsync(getWhisperBin(), [
      '-m', getModelPath(),
      '-f', tmpWav,
      '--output-txt',
      '--output-json',
      '-of', outBase,
      '--language', 'en',
      '--threads', '4',
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 180000 });

    let text = '';
    let segments = [];
    try {
      const raw = fs.readFileSync(outBase + '.txt', 'utf8');
      // Strip timestamp lines like "[00:00:00.000 --> 00:00:02.500]" that appear
      // when --no-timestamps is absent, leaving only the spoken words.
      text = raw.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]/g, '')
                .replace(/\n{2,}/g, '\n').trim();
    } catch {}
    try {
      const json = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8'));
      segments = (json.transcription || []).map(s => ({
        start: s.offsets?.from / 1000 || 0,
        end:   s.offsets?.to   / 1000 || 0,
        text:  s.text?.trim() || '',
      }));
    } catch {}

    const wordCount = text.split(/\s+/).filter(Boolean).length;

    // Use the real clip duration for wps. --no-timestamps means segments have
    // no timing, so falling back to segment ends would give 0 and dilute to /30.
    const clipSec     = (clipDurationSec && clipDurationSec > 0) ? clipDurationSec : 30;
    const wordsPerSec = wordCount / clipSec;

    // Description match boosts confidence — if transcript relates to what the
    // user said their day was about (synonyms count), lower the wps threshold.
    const matchScore = await descriptionMatch(text, description);
    // Only lower the wps threshold if Claude thinks the content is genuinely
    // related to the description (4/10+). A weak match like 2/10 is noise.
    const wpsThreshold = (matchScore !== null && matchScore >= 0.4) ? 1.0 : 1.5;

    // Short clips need proportionally more words to confirm intentional narration.
    // A 5s clip needs at least 12 words; longer clips need 10.
    const minWords = clipSec < 8 ? Math.round(clipSec * 2.2) : 10;

    // Short clips with no description match are very likely incidental speech
    // (e.g. someone saying one sentence while doing something else). Require a
    // minimum match score for clips under 8s when a description was provided.
    const matchTooLow = description && matchScore !== null && matchScore < 0.25 && clipSec < 8;

    // Must meet word count AND wps threshold AND not flagged by low match.
    const isTalkingHead = wordCount >= minWords && wordsPerSec >= wpsThreshold && !matchTooLow;

    // Trim bounds — find where speech actually starts and ends.
    // Removes dead air at the beginning (camera fumble before speaking) and
    // at the end (silence after last word). 0.3s head / 0.5s tail padding.
    // Falls back to full clip range if segments have no usable timing.
    let trimStart = 0;
    let trimEnd   = clipSec;
    const timedSegs = segments.filter(s => s.end > 0);
    if (timedSegs.length > 0) {
      trimStart = Math.max(0, timedSegs[0].start - 0.3);
      trimEnd   = Math.min(clipSec, timedSegs[timedSegs.length - 1].end + 0.5);
      // Only apply trim if it actually shortens the clip meaningfully (> 1s saved)
      if (trimStart < 1 && trimEnd > clipSec - 1) {
        trimStart = 0;
        trimEnd   = clipSec;
      }
    }

    console.log(`[whisper] ${require('path').basename(videoPath)}: ${wordCount}w ${wordsPerSec.toFixed(2)}wps match=${matchScore?.toFixed(2)??'n/a'} threshold=${wpsThreshold} trim=[${trimStart.toFixed(1)}s–${trimEnd.toFixed(1)}s] → ${isTalkingHead?'AROLL':'BROLL'}`);

    return { text, segments, wordCount, wordsPerSec: +wordsPerSec.toFixed(2), isTalkingHead, trimStart, trimEnd };
  } catch (err) {
    return { text: '', segments: [], wordCount: 0, isTalkingHead: false };
  } finally {
    for (const ext of ['.wav', '.txt', '.json']) {
      try { fs.unlinkSync(outBase + ext); } catch {}
    }
  }
}

module.exports = { transcribe, findDenseWindow, getWhisperBin, getModelPath };
