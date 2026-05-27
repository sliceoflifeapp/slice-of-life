const path        = require('path');
const fs          = require('fs');
const os          = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const ffmpegPath  = require('ffmpeg-static');

const execFileAsync = promisify(execFile);

function whisperBase() {
  // require.resolve returns the logical asar path in packaged builds; the actual
  // files live in app.asar.unpacked — replace so execFile can find the binary.
  return path.dirname(require.resolve('nodejs-whisper/package.json'))
    .replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
}

function getWhisperBin() {
  return path.join(whisperBase(), 'cpp', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
}

function getModelPath() {
  const base   = whisperBase();
  const models = path.join(base, 'cpp', 'whisper.cpp', 'models');
  // base.en gives significantly better segment timing accuracy (used for trimStart)
  // and more reliable transcripts. Falls back to tiny.en if base isn't present.
  const preferred = path.join(models, 'ggml-base.en.bin');
  const fallback  = path.join(models, 'ggml-tiny.en.bin');
  return fs.existsSync(preferred) ? preferred : fallback;
}

// Singleton Anthropic client — created once on first use, reused for all calls.
let _anthropicClient = null;
function getClient() {
  if (_anthropicClient) return _anthropicClient;
  const cfgPath = path.join(require('./app-data').getAppDataDir(), 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  const key = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  _anthropicClient = new Anthropic({ apiKey: key });
  return _anthropicClient;
}
function resetClient() { _anthropicClient = null; }

// Extract 16kHz mono WAV from a video file (what Whisper requires)
async function extractAudio(videoPath, outWav) {
  // Only transcribe the first 90s — enough to classify talking head, much faster
  await execFileAsync(ffmpegPath, [
    '-i', videoPath,
    '-t', '90',
    '-ar', '16000', '-ac', '1',
    '-c:a', 'pcm_s16le',
    '-y', outWav,
  ], { maxBuffer: 200 * 1024 * 1024, timeout: 120000 });
}

// Ask Claude whether a transcript represents intentional narration to camera,
// vs ambient/background speech. Returns true/false; falls back to wps >= 1.5.
async function isIntentionalNarration(text, wordsPerSec) {
  const client = getClient();
  if (!client) return wordsPerSec >= 1.5;
  try {
    const msg = await client.messages.create({
      model:     'claude-haiku-4-5-20251001',
      max_tokens: 3,
      messages: [{
        role: 'user',
        content:
          `Transcript: "${text.slice(0, 400)}"\n\n` +
          `Is this person intentionally narrating or journaling to camera — ` +
          `talking about what they're doing, where they are, or what happened? ` +
          `Or is this ambient/background speech not directed at the camera? ` +
          `Answer yes or no.`,
      }],
    });
    return msg.content[0].text.trim().toLowerCase().startsWith('y');
  } catch {
    return wordsPerSec >= 1.5; // fallback on any error
  }
}


// Find the contiguous window of `maxDuration` seconds with the highest word
// density. Used to cap long narration clips to their most talkative section.
// Returns { windowStart, windowEnd } in clip-time seconds, or null if segments
// have no usable timing.

// Extend a window end to the boundary of the last segment that started within
// it — prevents hard cuts mid-sentence.  Grace period capped at 3s so a very
// long segment doesn't blow up the budget.
function extendToSegmentBoundary(timed, windowEnd, maxGrace = 3.0) {
  const lastStarted = timed.filter(s => s.start < windowEnd).pop();
  if (lastStarted && lastStarted.end > windowEnd) {
    return Math.min(lastStarted.end + 0.2, windowEnd + maxGrace);
  }
  return windowEnd;
}

// Find the most natural cut point near targetEnd.
// First scans a ±grace window for a Whisper segment that ends with sentence-
// ending punctuation (. ! ?).  If found, cut after that segment so the last
// word the viewer hears completes a full thought.  Falls back to
// extendToSegmentBoundary when no sentence boundary is found.
function findNaturalCutEnd(timed, targetEnd, maxGrace = 2.0) {
  const candidates   = timed.filter(s => s.end >= targetEnd - 2.0 && s.end <= targetEnd + maxGrace);
  const sentenceEnds = candidates.filter(s => /[.!?](\s*$)/.test(s.text.trim()));

  if (sentenceEnds.length > 0) {
    // Pick the sentence-ending segment closest to targetEnd
    const best = sentenceEnds.reduce((a, b) =>
      Math.abs(a.end - targetEnd) <= Math.abs(b.end - targetEnd) ? a : b
    );
    console.log(`[whisper] natural cut end: "${best.text.trim().slice(-50)}" at ${best.end.toFixed(2)}s (target ${targetEnd.toFixed(2)}s)`);
    return best.end + 0.15;
  }

  // No sentence boundary nearby — at least complete any in-progress segment
  return extendToSegmentBoundary(timed, targetEnd, maxGrace);
}

// Snap a window start to the nearest clean segment boundary.
// If the raw start falls mid-segment, jumps forward to the next segment edge
// so we don't start on a cut word.  Otherwise returns targetStart unchanged.
//
// NOTE: the old version scanned up to 1s ahead for a capital letter (Whisper
// capitalises nearly every segment), which caused it to skip the actual start
// of the desired content — making clips sound like they start mid-sentence.
// Removed that scan: findDenseWindow already starts at segment boundaries so
// no additional snapping is needed.
function findNaturalCutStart(timed, targetStart) {
  // Snap forward if we land inside an existing segment to avoid mid-word starts.
  const midSeg = timed.find(s => s.start < targetStart - 0.05 && s.end > targetStart + 0.1);
  if (midSeg) {
    const nextSeg = timed.find(s => s.start >= midSeg.end - 0.05);
    if (nextSeg) return Math.max(0, nextSeg.start - 0.1);
  }
  return targetStart;
}

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
    windowStart: findNaturalCutStart(timed, Math.max(0, bestStart - 0.3)),
    windowEnd:   findNaturalCutEnd(timed, bestEnd),
  };
}

// Transcribe a video file. Returns { text, segments, wordCount, isTalkingHead }
// clipDurationSec: actual clip duration from probe — used for wps calculation
async function transcribe(videoPath, clipDurationSec, debugLog) {
  const tmpWav = path.join(os.tmpdir(), `yl-${Date.now()}.wav`);
  const outBase = tmpWav.replace('.wav', '');

  try {
    await extractAudio(videoPath, tmpWav);

    // Log WAV size to catch failed/partial audio extractions
    let wavBytes = 0;
    try { wavBytes = fs.statSync(tmpWav).size; } catch {}
    const expectedMin = Math.min(clipDurationSec || 0, 90) * 16000 * 2 * 0.5; // 50% of expected PCM size
    if (wavBytes < expectedMin) {
      debugLog?.write(`[whisper] WARNING: WAV too small for ${require('path').basename(videoPath)}: ${wavBytes} bytes (expected ≥ ${Math.round(expectedMin)}). Audio extraction may have failed.`);
    } else {
      debugLog?.write(`[whisper] WAV extracted: ${Math.round(wavBytes / 1024)}KB for ${require('path').basename(videoPath)} (${(clipDurationSec || 0).toFixed(1)}s clip)`);
    }

    // Ensure binary is executable and not quarantined (macOS security on distributed builds).
    // Strip quarantine from the whole whisper dir recursively — newer macOS may block
    // individual bundled executables even if the app itself was approved.
    try { fs.chmodSync(getWhisperBin(), 0o755); } catch {}
    try { require('child_process').execFileSync('xattr', ['-r', '-d', 'com.apple.quarantine', whisperBase()]); } catch {}

    // Set DYLD_LIBRARY_PATH so whisper-cli finds all its dylibs in the app bundle.
    // The binary has rpaths hardcoded to the compile machine; these dirs override that.
    const buildBase = path.join(whisperBase(), 'cpp', 'whisper.cpp', 'build');
    const libDir = [
      path.join(buildBase, 'src'),
      path.join(buildBase, 'ggml', 'src'),
      path.join(buildBase, 'ggml', 'src', 'ggml-blas'),
      path.join(buildBase, 'ggml', 'src', 'ggml-metal'),
    ].join(':');
    await execFileAsync(getWhisperBin(), [
      '-m', getModelPath(),
      '-f', tmpWav,
      '--output-txt',
      '--output-json',
      '-of', outBase,
      '--language', 'en',
      '--threads', '4',
    ], {
      env: { ...process.env, DYLD_LIBRARY_PATH: libDir },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 180000,
    });

    let text = '';
    let segments = [];
    try {
      const raw = fs.readFileSync(outBase + '.txt', 'utf8');
      // Strip timestamp lines like "[00:00:00.000 --> 00:00:02.500]" that appear
      // when --no-timestamps is absent, then strip whisper annotation tags like
      // [BLANK_AUDIO], [MUSIC], [NOISE] etc.
      text = raw.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]/g, '')
                .replace(/\[[^\]]*\]/g, '')
                .replace(/\n{2,}/g, '\n').trim();
      // Log raw output for any clip where word count looks suspiciously low
      const rawWordCount = text.split(/\s+/).filter(Boolean).length;
      if (rawWordCount <= 3 && (clipDurationSec || 0) > 10) {
        debugLog?.write(`[whisper] LOW WORD COUNT (${rawWordCount}w) for ${require('path').basename(videoPath)} (${(clipDurationSec||0).toFixed(1)}s). Raw .txt output: ${JSON.stringify(raw.slice(0, 500))}`);
      }
    } catch {}
    try {
      const json = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8'));
      segments = (json.transcription || [])
        .map(s => ({
          start: s.offsets?.from / 1000 || 0,
          end:   s.offsets?.to   / 1000 || 0,
          text:  (s.text?.trim() || '').replace(/\[[^\]]*\]/g, '').trim(),
        }))
        .filter(s => s.text.length > 0);
    } catch {}

    const wordCount = text.split(/\s+/).filter(Boolean).length;

    // Use the real clip duration for wps. --no-timestamps means segments have
    // no timing, so falling back to segment ends would give 0 and dilute to /30.
    const clipSec     = (clipDurationSec && clipDurationSec > 0) ? clipDurationSec : 30;
    const wordsPerSec = wordCount / clipSec;

    // Content-aware narration detection: ask Claude if this is intentional
    // narration vs ambient speech. Falls back to wps >= 1.5 if no API key.
    // Minimum 5 words before calling — avoids burning a call on empty clips.
    const isTalkingHead = wordCount >= 5
      ? await isIntentionalNarration(text, wordsPerSec)
      : false;

    // Trim bounds — find where speech actually starts and ends.
    // Removes dead air at the beginning (camera fumble before speaking) and
    // at the end (silence after last word). 0.3s head / 0.5s tail padding.
    // Falls back to full clip range if segments have no usable timing.
    let trimStart = 0;
    let trimEnd   = clipSec;
    const timedSegs = segments.filter(s => s.end > 0);
    if (timedSegs.length > 0) {
      // 1.0s floor: even when speech starts at t=0 the camera is still physically
      // settling. This trims the visual fumble without cutting real content.
      trimStart = Math.max(1.0, timedSegs[0].start - 0.3);
      trimEnd   = Math.min(clipSec, timedSegs[timedSegs.length - 1].end + 0.5);
    }

    console.log(`[whisper] ${require('path').basename(videoPath)}: ${wordCount}w ${wordsPerSec.toFixed(2)}wps trim=[${trimStart.toFixed(1)}s–${trimEnd.toFixed(1)}s] → ${isTalkingHead?'AROLL':'BROLL'}`);

    return { text, segments, wordCount, wordsPerSec: +wordsPerSec.toFixed(2), isTalkingHead, trimStart, trimEnd };
  } catch (err) {
    console.error(`[whisper] FAILED for ${path.basename(videoPath)}: ${err.message}`);
    return { text: '', segments: [], wordCount: 0, isTalkingHead: false, _failed: true, _error: err.message };
  } finally {
    for (const ext of ['.wav', '.txt', '.json']) {
      try { fs.unlinkSync(outBase + ext); } catch {}
    }
  }
}

module.exports = { transcribe, findDenseWindow, getClient, resetClient, getWhisperBin, getModelPath, whisperBase };
