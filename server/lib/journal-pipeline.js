const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { execFile }  = require('child_process');
const { promisify } = require('util');
const ffmpegPath    = require('ffmpeg-static');

const execFileAsync = promisify(execFile);
const scanner       = require('./scanner');
const whisper       = require('./whisper');

const { buildJournal }     = require('./journal-builder');
const { buildJournalVideo, probe } = require('./journal-video');
const { extractBeats }             = require('./beats');
const { analyzeClip }              = require('./clip-vision');
const { getAppDataDir }            = require('./app-data');

function loadOutputConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(getAppDataDir(), 'config.json'), 'utf8')); } catch { return {}; }
}

function assemblyPath(videoOut) {
  const cacheDir = path.join(getAppDataDir(), 'assembly-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  return path.join(cacheDir, path.basename(videoOut).replace(/\.mp4$/, '.assembly.json'));
}

const VIDEO_EXTS = new Set(['.mp4','.m4v','.mov','.avi','.mkv','.mts','.m2ts','.webm']);
const AUDIO_EXTS = new Set(['.mp3','.m4a','.wav','.aiff','.aif','.flac','.ogg']);

const VERBOSE = process.env.SOL_VERBOSE === '1';
const TALKING_HEAD_MIN_SEC = 4; // clips shorter than this are always b-roll (too short for speech)
const MIN_BROLL_SEC = 3;        // clips shorter than this are dropped entirely — nothing to cut to

// Recommend output duration based on total footage
function recommendDuration(clips) {
  // Clip count is the primary signal — more honest than raw seconds.
  // A single 10-minute GoPro clip shouldn't recommend 3 min; 30 short iPhone
  // clips from a full day should. Cap each clip's contribution at 60s so long
  // continuous recordings don't distort the capped-duration tiebreaker.
  const clipCount = clips.length;
  const cappedSec = clips.reduce((s, c) => s + Math.min(c.duration || 0, 60), 0);

  if (clipCount >= 60 || cappedSec >= 1800) return { label: '10 min', value: '10min', reason: 'Big day' };
  if (clipCount >= 35 || cappedSec >= 900)  return { label: '5 min',  value: '5min',  reason: 'Full day' };
  if (clipCount >= 20 || cappedSec >= 400)  return { label: '3 min',  value: '3min',  reason: 'Solid day' };
  if (clipCount >= 8  || cappedSec >= 180)  return { label: '1 min',  value: '1min',  reason: 'Quick vlog' };
  return                                           { label: '1 min',  value: '1min',  reason: 'Short session' };
}

function makeDebugLog() {
  const logDir  = getAppDataDir();
  const logPath = path.join(logDir, 'debug-last-run.log');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  // Truncate / create fresh for this run
  try { fs.writeFileSync(logPath, ''); } catch {}
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  return {
    write(line) {
      try { fs.appendFileSync(logPath, `[${stamp()}] ${line}\n`); } catch {}
      console.log(`[debug-log] ${line}`);
    },
    path: logPath,
  };
}

// When there are more narration clips than fit in the target duration, ask
// Claude Haiku to pick the best ones based on transcript content and the day
// description.  Clips are returned in their original chronological order so
// the story still flows naturally.  Falls back to first-N when offline.
async function selectBestAroll(aroll, numClips, targetSecs, log) {
  if (aroll.length <= numClips) return aroll;

  const client = whisper.getClient();
  if (!client) {
    log?.write(`[clip-select] no API key — using first ${numClips} clips chronologically`);
    return aroll.slice(0, numClips);
  }

  const clipList = aroll.map((c, i) => {
    const dur  = ((c.trimEnd ?? c.duration) - (c.trimStart ?? 0)).toFixed(1);
    const text = (c.transcript?.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return `[${i + 1}] ${dur}s: "${text || '(no transcript)'}"`;
  }).join('\n');

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content:
          `Narration clips (chronological order):\n${clipList}\n\n` +
          `Pick the ${numClips} clips that together tell the most engaging story for a ${Math.round(targetSecs)}s vlog. ` +
          `Prefer clips that are self-contained complete thoughts and together form a natural narrative arc. ` +
          `Reply with only the clip numbers comma-separated (e.g. "1,4,7").`,
      }],
    });

    const nums   = msg.content[0].text.trim().match(/\d+/g)?.map(Number) || [];
    const unique = [...new Set(nums)].filter(n => n >= 1 && n <= aroll.length);
    const chosen = unique
      .slice(0, numClips)
      .sort((a, b) => a - b)           // keep chronological order
      .map(n => aroll[n - 1]);

    if (chosen.length > 0) {
      log?.write(`[clip-select] Claude selected clips ${unique.slice(0, numClips).join(', ')} from ${aroll.length} available`);
      return chosen;
    }
    throw new Error('no valid clips in response');
  } catch (err) {
    log?.write(`[clip-select] failed (${err.message}) — using first ${numClips} clips`);
    return aroll.slice(0, numClips);
  }
}

// Extract one auto-rotated JPEG frame from a video clip at `timeSec`.
// Auto-rotation (no -noautorotate) lets ffmpeg apply the rotate tag so Claude
// sees the frame in its correct upright orientation.
async function extractBrollFrame(videoPath, timeSec, outPath) {
  await execFileAsync(ffmpegPath, [
    '-ss', String(Math.max(0, timeSec)),
    '-i',  videoPath,
    '-frames:v', '1',
    '-vf', 'scale=320:320:force_original_aspect_ratio=decrease',
    '-q:v', '5',
    '-y',  outPath,
  ], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
}

// When running with Apple Vision (no description/contentTags), batch-describe
// every b-roll clip using Claude Haiku vision in groups of BATCH_SIZE.
// Sets clip.vision.description in-place for clips that don't already have one
// (Apple Vision backend). Used by the boundary tiebreaker in assignBrollByPosition.
async function describeBroll(clips, log) {
  const toDescribe = clips.filter(c => !c.vision?.description && !c.vision?.contentTags?.length);
  if (!toDescribe.length) return;

  const client = whisper.getClient();
  if (!client) {
    log?.write('[describe-broll] no API key — b-roll will use timestamp proximity');
    return;
  }

  log?.write(`[describe-broll] describing ${toDescribe.length} b-roll clips in batch...`);
  const BATCH_SIZE = 15;

  for (let batchStart = 0; batchStart < toDescribe.length; batchStart += BATCH_SIZE) {
    const batch    = toDescribe.slice(batchStart, batchStart + BATCH_SIZE);
    const tmpPaths = new Array(batch.length).fill(null);

    try {
      // Extract one frame per clip concurrently
      await Promise.all(batch.map(async (clip, i) => {
        const t = (clip.duration || 4) * 0.45; // slightly before midpoint
        const p = path.join(os.tmpdir(), `broll-desc-${Date.now()}-${i}.jpg`);
        try {
          await extractBrollFrame(clip.path, t, p);
          if (fs.existsSync(p)) tmpPaths[i] = p;
        } catch { /* skip this clip */ }
      }));

      // Build multimodal message — interleave image + label for each clip
      const content    = [];
      const validIdxs  = [];
      for (let i = 0; i < batch.length; i++) {
        if (!tmpPaths[i]) continue;
        try {
          const data = fs.readFileSync(tmpPaths[i]).toString('base64');
          content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
          content.push({ type: 'text', text: `Image ${validIdxs.length + 1}` });
          validIdxs.push(i);
        } catch { /* skip unreadable frame */ }
      }
      if (!validIdxs.length) continue;

      content.push({
        type: 'text',
        text: 'Each image above is a frame from a b-roll video clip. ' +
              'For each image write a 4–6 word description of the main subject, location, and action ' +
              '(e.g. "person walking through office door", "aerial view of city skyline", "coffee on wooden desk"). ' +
              'Reply with ONLY a compact JSON object: {"1":"description","2":"description",...}',
      });

      const msg = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages:   [{ role: 'user', content }],
      });

      const raw  = msg.content[0].text.trim();
      const json = raw.match(/\{[\s\S]*\}/)?.[0];
      if (!json) throw new Error('no JSON in response');
      const descs = JSON.parse(json);

      let described = 0;
      validIdxs.forEach((batchIdx, descIdx) => {
        const d = descs[String(descIdx + 1)];
        if (d && typeof d === 'string') {
          batch[batchIdx].vision.description = d.trim();
          described++;
        }
      });
      const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
      log?.write(`[describe-broll] batch ${batchNum}: described ${described}/${validIdxs.length} clips`);
      batch.forEach(c => {
        if (c.vision?.description) log?.write(`  "${path.basename(c.path)}" → "${c.vision.description}"`);
      });

    } catch (err) {
      log?.write(`[describe-broll] batch failed: ${err.message}`);
    } finally {
      for (const p of tmpPaths) if (p) try { fs.unlinkSync(p); } catch {}
    }
  }
}

// Assigns each b-roll clip to a narration section by its position in the
// sorted clip array. Section boundaries are the midpoints between adjacent
// a-roll clip positions — so b-roll filmed between two narration moments
// lands in the earlier section's window.
//
// Pure position-based: each b-roll clip's index in the sorted clip array
// determines which narration section it belongs to. Boundaries are midpoints
// between adjacent a-roll positions. No tiebreaker — Claude's "A or B?" calls
// consistently override correct primary assignments with wrong answers when the
// clip is near a transition point (e.g. driving footage near a running→aquarium boundary).
async function assignBrollByPosition(aroll, broll, allClips, log) {
  if (!aroll.length || !broll.length) return;

  // Find where each a-roll clip sits in the full sorted clip array
  const arollPos = aroll.map(a => allClips.findIndex(c => c.path === a.path));

  // Section boundaries: midpoint between adjacent a-roll positions
  const boundaries = [];
  for (let i = 0; i < arollPos.length - 1; i++) {
    boundaries.push((arollPos[i] + arollPos[i + 1]) / 2);
  }

  let assigned = 0;
  for (const clip of broll) {
    const pos = allClips.findIndex(c => c.path === clip.path);
    if (pos === -1) continue;

    // Assign to section whose window contains this clip's position
    let section = 0;
    for (let i = 0; i < boundaries.length; i++) {
      if (pos >= boundaries[i]) section = i + 1;
    }

    clip.semanticSection = section;
    assigned++;
  }

  log?.write(`[broll-assign] ${assigned}/${broll.length} clips assigned (${boundaries.length} boundaries, pure position)`);
  broll.forEach(clip => {
    if (clip.semanticSection !== undefined) {
      log?.write(`  "${path.basename(clip.path)}" → section ${clip.semanticSection + 1}`);
    }
  });
}

async function run(folderPath, options = {}, onProgress, pacingParams) {
  const update = (msg, pct) => onProgress?.({ message: msg, progress: pct });
  const log = makeDebugLog();

  update('Scanning footage…', 5);

  // Scan for video + audio files
  const allFiles = scanner.fullScan(folderPath);
  const videos   = allFiles.filter(f => VIDEO_EXTS.has(f.ext));
  const audios   = allFiles.filter(f => AUDIO_EXTS.has(f.ext));

  if (!videos.length) throw new Error('No video files found in this folder');

  update('Analyzing clips…', 10);

  // Probe all videos for duration + sort by timestamp
  const probed = await Promise.all(videos.map(async f => {
    const info = await probe(f.path);
    // Prefer embedded creation_time (accurate for iPhone), fall back to birthtime
    let filledAt = 0;
    if (info.creationTime && info.creationTime.getFullYear() > 2000) {
      filledAt = info.creationTime.getTime();
    } else {
      try { filledAt = fs.statSync(f.path).birthtime.getTime(); } catch {}
    }
    return { ...f, ...info, startSec: 0, filledAt };
  }));

  probed.sort((a, b) => a.filledAt - b.filledAt);

  // AirDrop corrupts file timestamps but preserves filenames. Fix ordering
  // within each camera group by filename number (always recording order).
  // Groups: GoPro (GX/GH prefix), iPhone (IMG prefix), DJI (DJI prefix).
  // Cross-camera ordering still uses filledAt since filename numbers aren't
  // comparable across cameras (GoPro 0177 vs iPhone 5238 are unrelated).
  {
    const numOf = c => { const m = path.basename(c.path).match(/(\d+)/); return m ? parseInt(m[1], 10) : 0; };
    const cameraGroup = c => {
      const n = path.basename(c.path);
      if (/^(GX|GH)\d/i.test(n)) return 'gopro';
      if (/^IMG_\d/i.test(n))    return 'iphone';
      if (/^DJI_\d/i.test(n))    return 'dji';
      return null;
    };
    for (const group of ['gopro', 'iphone', 'dji']) {
      const indices = probed.reduce((acc, c, i) => { if (cameraGroup(c) === group) acc.push(i); return acc; }, []);
      if (indices.length > 1) {
        const sorted = indices.map(i => probed[i]).sort((a, b) => numOf(a) - numOf(b));
        indices.forEach((idx, j) => { probed[idx] = sorted[j]; });
        console.log(`[sort] ${group} clips re-ordered by filename:`, sorted.map(c => path.basename(c.path)).join(', '));
      }
    }
  }

  if (VERBOSE) {
    console.log('[sort] clip order after sort:');
    probed.forEach((c, i) => console.log(`  ${i + 1}. ${path.basename(c.path)}  creationTime=${c.creationTime?.toISOString() ?? 'none'}  filledAt=${c.filledAt}`));
  }

  // Pre-flight: drop clips ffprobe couldn't read (zero duration or no video stream)
  const unreadable = probed.filter(c => c.duration === 0 || c.storedW === 0);
  if (unreadable.length) {
    unreadable.forEach(c => {
      console.warn(`[preflight] skipping unreadable clip: ${path.basename(c.path)}`);
      log.write(`[preflight] skipping unreadable clip: ${c.path}`);
    });
    probed.splice(0, probed.length, ...probed.filter(c => c.duration > 0 && c.storedW > 0));
    if (!probed.length) throw new Error('No readable video clips found — all clips failed to probe');
    update(`Warning: ${unreadable.length} clip${unreadable.length > 1 ? 's' : ''} could not be read and will be skipped`, 10);
  }

  const totalSec = probed.reduce((s, f) => s + f.duration, 0);
  const recommended = recommendDuration(probed);

  // ── Multi-day detection ──────────────────────────────────────────────────────
  // Group clips by calendar day using clip creation time. Tag each clip with its
  // dayIndex so semantic assignment and arc prompts can use it downstream.
  const dayMap = new Map();
  for (const clip of probed) {
    const day = new Date(clip.filledAt).toISOString().slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day).push(clip);
  }
  const dayKeys    = [...dayMap.keys()].sort();
  const isMultiDay = dayKeys.length > 1;
  if (isMultiDay) {
    let idx = 0;
    for (const day of dayKeys) {
      for (const clip of dayMap.get(day)) clip.dayIndex = idx;
      idx++;
    }
    update(`Found ${dayKeys.length} days of footage…`, 12);
  }

  update('Analyzing clips…', 20);

  const highSensitivity  = !!options.highSensitivity;
  const highlightOnly    = !!options.highlightOnly;

  // Log startup info — paths + clip inventory
  log.write(`Run started — ${probed.length} clips, totalSec=${Math.round(totalSec)}s highlightOnly=${highlightOnly} highSensitivity=${highSensitivity}`);
  try {
    const { getWhisperBin, getModelPath } = require('./whisper');
    const binPath   = getWhisperBin();
    const modelPath = getModelPath();
    log.write(`Whisper bin:   ${binPath} [${fs.existsSync(binPath)   ? 'EXISTS' : 'MISSING'}]`);
    log.write(`Whisper model: ${modelPath} [${fs.existsSync(modelPath) ? 'EXISTS' : 'MISSING'}]`);
  } catch (e) {
    log.write(`Whisper paths error: ${e.message}`);
  }
  probed.forEach((c, i) => log.write(`  Clip ${i + 1}: ${path.basename(c.path)} (${c.duration?.toFixed(1)}s)`));

  // Classify: talking head (a-roll) vs b-roll
  const aroll = [];
  const broll = [];
  const hlFallback = []; // talking-head clips saved as last-resort for highlight reel
  let checked = 0;

  {
    // ── Unified Vision pass — one Claude call per clip ───────────────────────
    // Highlight mode: talking-head clips are skipped (no Whisper, no a-roll).
    // Normal mode:    talking-head candidates confirmed with Whisper.
    for (const clip of probed) {
      const pct = 20 + Math.round((checked / probed.length) * 40);
      update(`Analyzing clip ${checked + 1} of ${probed.length}…`, pct);

      if (clip.duration < MIN_BROLL_SEC) {
        // Too short to be useful as b-roll — drop entirely, no Vision call needed.
        log.write(`Clip ${checked + 1} [${path.basename(clip.path)}] ${clip.duration.toFixed(1)}s: DROPPED (< ${MIN_BROLL_SEC}s min)`);
        checked++; continue;
      }

      if (clip.duration < TALKING_HEAD_MIN_SEC) {
        // Too short to be narration — still run Vision for rotation + quality data
        // so tight-pacing b-roll cuts aren't upside down due to unvalidated tags.
        const vision = await analyzeClip(clip, {});
        log.write(`Clip ${checked + 1} [${path.basename(clip.path)}] ${clip.duration.toFixed(1)}s: SKIPPED (too short < ${TALKING_HEAD_MIN_SEC}s) → broll q=${vision.qualityScore}`);
        if (vision.qualityScore >= 15) {
          broll.push({ ...clip, clipType: 'broll', vision, brollScore: vision.qualityScore });
        }
        checked++; continue;
      }

      // Vision pass — sequential to avoid hammering the API
      const vision = await analyzeClip(clip, { highSensitivity });

      // Slow-motion (≥120fps) and time-lapse (<5fps) are always b-roll —
      // Vision still runs above for quality score, rotation, and best seek point.
      if (clip.isSloMo || clip.isTimeLapse) {
        const label = clip.isSloMo ? 'SLO-MO' : 'TIME-LAPSE';
        console.log(`[pipeline] ${path.basename(clip.path)}: ${label.toLowerCase()} → broll (q=${vision.qualityScore})`);
        log.write(`Clip ${checked + 1} [${path.basename(clip.path)}] ${clip.duration.toFixed(1)}s: ${label} → broll q=${vision.qualityScore}`);
        if (vision.qualityScore >= 15) {
          broll.push({ ...clip, clipType: 'broll', vision, brollScore: vision.qualityScore });
        }
        checked++; continue;
      }

      // Show Vision verdict in the progress bar for diagnostics
      const visionTag = vision.isTalkingHead ? 'talking head' : `b-roll (q=${vision.qualityScore})`;
      update(`Clip ${checked + 1}: Vision → ${visionTag}`, pct);

      const visionSource = vision._source || 'unknown'; // 'online' or 'offline'
      log.write(`Clip ${checked + 1} [${path.basename(clip.path)}] ${clip.duration.toFixed(1)}s: Vision=${visionSource} isTalkingHead=${vision.isTalkingHead} q=${vision.qualityScore} hasFace=${vision.hasFace}`);

      // Hard reject: unusable shot (very low quality)
      if (vision.qualityScore < 15) {
        console.log(`[pipeline] ${path.basename(clip.path)}: rejected — qualityScore=${vision.qualityScore} (unusable)`);
        log.write(`  → REJECTED: qualityScore too low (${vision.qualityScore} < 15)`);
        checked++; continue;
      }

      if (vision.isTalkingHead || vision.hasFace) {
        if (highlightOnly) {
          // Highlight mode: exclude talking-head clips — they look like a-roll
          // in the reel. Saved in hlFallback so if broll pool is empty we can
          // still produce something rather than throwing.
          console.log(`[pipeline] highlight: ${path.basename(clip.path)}: talking head → excluded (saved as fallback)`);
          log.write(`  → highlight mode: talking head excluded (hlFallback)`);
          hlFallback.push({ ...clip, clipType: 'broll', vision, brollScore: Math.min(vision.qualityScore, 40) });
          checked++; continue;
        }
        // Normal mode: confirm with Whisper
        update(`Transcribing clip ${checked + 1} of ${probed.length}…`, pct);
        const transcript = await whisper.transcribe(clip.path, clip.duration, log);
        const whisperSummary = transcript._failed
          ? `Whisper ERROR: ${transcript._error || 'unknown'}`
          : transcript.wordCount > 0
            ? `${transcript.wordCount} words, ${transcript.wordsPerSec} wps → ${transcript.isTalkingHead ? 'narration' : 'rejected'}`
            : 'no speech detected';
        update(`Clip ${checked + 1}: ${whisperSummary}`, pct);
        console.log(`[pipeline] whisper result for ${path.basename(clip.path)}: isTalkingHead=${transcript.isTalkingHead} words=${transcript.wordCount} wps=${transcript.wordsPerSec} failed=${!!transcript._failed}`);
        if (transcript._failed) {
          log.write(`  → Whisper FAILED: ${transcript._error || 'unknown error'}`);
        } else {
          log.write(`  → Whisper: words=${transcript.wordCount} wps=${transcript.wordsPerSec} isTalkingHead=${transcript.isTalkingHead} → ${transcript.isTalkingHead ? 'AROLL' : 'broll'}`);
        }

        if (transcript.isTalkingHead) {
          aroll.push({
            ...clip, clipType: 'aroll', transcript, vision,
            trimStart: transcript.trimStart ?? 0,
            trimEnd:   transcript.trimEnd   ?? clip.duration,
          });
        } else {
          broll.push({ ...clip, clipType: 'broll', transcript, vision, brollScore: vision.qualityScore });
        }
      } else {
        log.write(`  → broll`);
        broll.push({ ...clip, clipType: 'broll', vision, brollScore: vision.qualityScore });
      }

      checked++;
    }
  }

  log.write(`SUMMARY: ${probed.length} clips → ${aroll.length} aroll, ${broll.length} broll, ${hlFallback.length} hlFallback`);
  log.write(`Log saved to: ${log.path}`);

  // ── No narration found: stop with a recoverable error ─────────────────────
  if (aroll.length === 0 && !highlightOnly) {
    log.write(`ERROR: NO_AROLL — no narration clips detected. Check Vision results and Whisper paths above.`);
    const err = new Error('NO_AROLL');
    err.noAroll = true;
    err.debugLogPath = log.path;
    throw err;
  }

  // ── Sort b-roll by Vision qualityScore (already filtered above) ───────────
  update('Sorting b-roll clips…', 62);
  const scoredBroll = broll
    .filter(c => (c.brollScore ?? 50) >= 15)           // belt-and-suspenders guard
    .sort((a, b) => (b.brollScore ?? 50) - (a.brollScore ?? 50));
  console.log(`[pipeline] b-roll: ${broll.length} in → ${scoredBroll.length} kept (sorted by Vision qualityScore)`);

  // ── Highlight reel: build assembly from best b-roll only ──────────────────
  if (highlightOnly) {
    // Use real broll pool; fall back to talking-head clips only if nothing else exists
    const hlSource = scoredBroll.length > 0 ? scoredBroll : hlFallback;
    if (hlSource === hlFallback && hlFallback.length > 0) {
      console.log('[pipeline] highlight: no pure b-roll found — falling back to talking-head clips');
    }

    const targetSecs  = options.targetDuration || 180;
    const brollCut    = pacingParams?.brollCut ?? 7;
    const clipCap     = brollCut;
    let budgetLeft    = targetSecs;
    const picked = [];
    for (const clip of hlSource) {
      const contrib = Math.min(clip.duration, clipCap);
      if (budgetLeft <= 0) break;
      picked.push(clip);
      budgetLeft -= contrib;
    }
    picked.sort((a, b) => a.filledAt - b.filledAt);

    const hlAssembly = picked.map(clip => ({ ...clip, clipType: 'broll' }));
    if (!hlAssembly.length) throw new Error('No usable b-roll clips found for highlight reel');

    update('Rendering highlight reel…', 70);

    const cfg2 = loadOutputConfig();
    const outputBase2 = cfg2.outputFolder || path.join(os.homedir(), 'Movies', 'Slices');
    const dateSlug2   = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(outputBase2, { recursive: true });

    const isVertical2  = options.orientation === 'vertical';
    const orientSlug2  = isVertical2 ? '-vertical' : '';
    const videoOut2    = path.join(outputBase2, `${dateSlug2}-highlight${orientSlug2}.mp4`);

    const captionsOpts2 = options.captions
      ? { enabled: true, style: options.captionStyle || 'clean' }
      : null;

    // Music / beat detection for highlight reel
    let musicOpts2 = null;
    if (audios.length) {
      const musicPath2 = audios[0].path;
      try {
        const beatInfo2 = await extractBeats(musicPath2);
        musicOpts2 = { musicPath: musicPath2, ...beatInfo2 };
      } catch {}
    }

    await buildJournalVideo(hlAssembly, videoOut2, prog => {
      const pct = typeof prog === 'object' ? prog.pct : prog;
      const msg = typeof prog === 'object' && prog.message ? prog.message : 'Rendering…';
      onProgress?.({ message: msg, progress: 70 + Math.round((pct / 100) * 25) });
    }, musicOpts2, pacingParams, captionsOpts2, { vertical: isVertical2 });

    const MIN_OUTPUT_BYTES = 500 * 1024;
    let outputSize2 = 0;
    try { outputSize2 = fs.statSync(videoOut2).size; } catch {}
    if (outputSize2 < MIN_OUTPUT_BYTES) {
      throw new Error(`Render produced a file that is too small (${Math.round(outputSize2 / 1024)} KB)`);
    }

    update('Done!', 100);

    let outputDurationSec2 = 0;
    try { const info2 = await probe(videoOut2); outputDurationSec2 = Math.round(info2.duration || 0); } catch {}

    let thumbPath2 = null;
    try {
      const thumbDir2 = path.join(getAppDataDir(), 'thumb-cache');
      fs.mkdirSync(thumbDir2, { recursive: true });
      const thumbFile2 = path.join(thumbDir2, path.basename(videoOut2, '.mp4') + '.jpg');
      const seekSec2 = outputDurationSec2 > 10 ? Math.floor(outputDurationSec2 * 0.35) : 5;
      await execFileAsync(ffmpegPath, [
        '-ss', String(seekSec2), '-i', videoOut2,
        '-frames:v', '1', '-q:v', '4', '-vf', 'scale=600:-1', '-y', thumbFile2,
      ], { timeout: 10000 });
      thumbPath2 = thumbFile2;
    } catch (e) {
      console.warn('[pipeline] highlight thumbnail failed:', e.message);
    }

    // Save assembly sidecar for re-edit
    const assemblyPath2 = assemblyPath(videoOut2);
    try {
      fs.writeFileSync(assemblyPath2, JSON.stringify({
        version: 1, videoPath: videoOut2, assembly: hlAssembly,
        opts: { captions: options.captions || false, captionStyle: options.captionStyle || 'clean', orientation: options.orientation || 'landscape' },
        createdAt: new Date().toISOString(),
      }, null, 2));
    } catch {}

    return {
      videoPath: videoOut2, thumbPath: thumbPath2, outDir: outputBase2,
      assembly: hlAssembly, pacingParams,
      outputDurationSec: outputDurationSec2,
      assemblyPath: assemblyPath2,
      footageDates: dayKeys,
      transcriptExcerpt: null,
      stats: {
        totalClips: probed.length, arollCount: 0, brollCount: hlAssembly.length,
        totalSec: Math.round(totalSec), rawDurationSec: Math.round(totalSec), recommended,
        outputDurationSec: outputDurationSec2, hlgClipCount: 0,
      },
    };
  }

  // ── Music / beat detection ─────────────────────────────────────────────────
  let musicOpts = null;
  if (audios.length) {
    const musicPath = audios[0].path; // use first audio file found
    update(`Analyzing music (${path.basename(musicPath)})…`, 63);
    try {
      const beatInfo = await extractBeats(musicPath);
      musicOpts = { musicPath, ...beatInfo };
      update(`Beat grid: ${beatInfo.bpm} BPM — syncing b-roll to music…`, 64);
    } catch (err) {
      console.warn('Beat extraction failed, continuing without music sync:', err.message);
    }
  }

  // ── B-roll-only days: per-day render then concat ─────────────────────────
  // In a multi-day shoot, days with no narration are treated like a highlight
  // reel: best clips, quality-sorted then re-sorted chronologically, rendered
  // as their own segment and placed at the correct day position in the output.
  const narratedDaySet = new Set(aroll.map(c => c.dayIndex ?? 0));
  const allDayOrder = isMultiDay
    ? [...new Set(probed.map(c => c.dayIndex ?? 0))].sort((a, b) => a - b)
    : [0];
  const hlDaySet = new Set(allDayOrder.filter(i => !narratedDaySet.has(i)));

  if (isMultiDay && hlDaySet.size > 0) {
    const targetSecs   = options.targetDuration || 180;
    const brollCut     = pacingParams?.brollCut ?? 7;
    const faceDur      = pacingParams?.faceDur ?? 4;
    const targetPerDay = targetSecs / allDayOrder.length;
    const isVertical   = options.orientation === 'vertical';
    const captionsOpts = options.captions ? { enabled: true, style: options.captionStyle || 'clean' } : null;

    const cfg2 = loadOutputConfig();
    const outputBase2 = cfg2.outputFolder || path.join(os.homedir(), 'Movies', 'Slices');
    const dateSlug2   = `${dayKeys[0]}-to-${dayKeys[dayKeys.length - 1].slice(5)}`;
    fs.mkdirSync(outputBase2, { recursive: true });
    const orientSlug2 = isVertical ? '-vertical' : '';
    const videoOut2   = path.join(outputBase2, `${dateSlug2}${orientSlug2}.mp4`);

    // Describe all b-roll once before splitting so descriptions are available
    update('Describing b-roll…', 66);
    await describeBroll(scoredBroll, log);

    const tmpDir2 = os.tmpdir();
    const tempSegs = [];
    let concatList2 = null;
    let combinedAssembly2 = [];

    try {
    for (let di = 0; di < allDayOrder.length; di++) {
      const dayIdx = allDayOrder[di];
      const segPath = path.join(tmpDir2, `slice-seg${dayIdx}-${Date.now()}.mp4`);
      const pct0 = 68 + Math.round((di / allDayOrder.length) * 24);
      const pct1 = 68 + Math.round(((di + 1) / allDayOrder.length) * 24);
      const dayLabel = `Day ${di + 1}/${allDayOrder.length}`;
      const progFn = prog => {
        const p = typeof prog === 'object' ? prog.pct : prog;
        const msg = typeof prog === 'object' && prog.message ? prog.message : 'Rendering…';
        onProgress?.({ message: `${dayLabel}: ${msg}`, progress: pct0 + Math.round((p / 100) * (pct1 - pct0)) });
      };

      if (hlDaySet.has(dayIdx)) {
        // Highlight day — pick best clips, re-sort chronological
        const maxClips = Math.ceil(targetPerDay / brollCut);
        const dayClips = scoredBroll
          .filter(c => (c.dayIndex ?? 0) === dayIdx)
          .slice(0, maxClips)
          .sort((a, b) => (a.filledAt || 0) - (b.filledAt || 0))
          .map(c => ({ ...c, clipType: 'broll' }));
        console.log(`[pipeline] ${dayLabel} (highlight): ${dayClips.length} clips`);
        if (dayClips.length > 0) {
          await buildJournalVideo(dayClips, segPath, progFn, musicOpts, pacingParams, captionsOpts, { vertical: isVertical });
          tempSegs.push(segPath);
          combinedAssembly2 = combinedAssembly2.concat(dayClips);
        }
      } else {
        // Narrated day — standard pipeline scoped to this day's clips
        const dayAroll  = aroll.filter(c => (c.dayIndex ?? 0) === dayIdx);
        const dayBroll  = scoredBroll.filter(c => (c.dayIndex ?? 0) === dayIdx);
        const dayProbed = probed.filter(c => (c.dayIndex ?? 0) === dayIdx);

        const dayNarrDur = dayAroll.reduce((s, c) => s + ((c.trimEnd ?? c.duration) - (c.trimStart ?? 0)), 0);
        let cappedDayAroll = dayAroll;
        if (dayNarrDur > targetPerDay * 1.05) {
          const minPerClip   = faceDur * 2;
          const numClips     = Math.min(dayAroll.length, Math.max(1, Math.floor(targetPerDay / minPerClip)));
          const slicePerClip = targetPerDay / numClips;
          const selected     = await selectBestAroll(dayAroll, numClips, targetPerDay, log);
          cappedDayAroll = [];
          for (const clip of selected) {
            const clipDur = (clip.trimEnd ?? clip.duration) - (clip.trimStart ?? 0);
            if (clipDur <= slicePerClip) {
              cappedDayAroll.push(clip);
            } else {
              const win = await whisper.findDenseWindow(clip.transcript?.segments || [], slicePerClip);
              if (win) cappedDayAroll.push({ ...clip, trimStart: win.windowStart, trimEnd: win.windowEnd });
              else cappedDayAroll.push({ ...clip, trimEnd: (clip.trimStart ?? 0) + slicePerClip });
            }
          }
        }

        await assignBrollByPosition(cappedDayAroll, dayBroll, dayProbed, log);
        const { assembly: dayAssembly } = await buildJournal({ aroll: cappedDayAroll, broll: dayBroll });
        console.log(`[pipeline] ${dayLabel} (narrated): ${cappedDayAroll.length} aroll, ${dayBroll.length} broll`);
        await buildJournalVideo(dayAssembly, segPath, progFn, musicOpts, pacingParams, captionsOpts, { vertical: isVertical });
        tempSegs.push(segPath);
        combinedAssembly2 = combinedAssembly2.concat(dayAssembly);
      }
    }

    if (tempSegs.length === 0) throw new Error('No day segments rendered');

    // Concat all day segments in chronological order
    update('Joining days…', 93);
    concatList2 = path.join(tmpDir2, `concat-${Date.now()}.txt`);
    fs.writeFileSync(concatList2, tempSegs.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    await execFileAsync(ffmpegPath, ['-f', 'concat', '-safe', '0', '-i', concatList2, '-c', 'copy', '-y', videoOut2], { timeout: 300000 });
    for (const f of tempSegs) { try { fs.unlinkSync(f); } catch {} }
    tempSegs.length = 0;
    try { fs.unlinkSync(concatList2); } catch {}
    concatList2 = null;
    } finally {
      for (const f of tempSegs) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} }
      if (concatList2) { try { if (fs.existsSync(concatList2)) fs.unlinkSync(concatList2); } catch {} }
    }

    const MIN2 = 500 * 1024;
    let sz2 = 0;
    try { sz2 = fs.statSync(videoOut2).size; } catch {}
    if (sz2 < MIN2) throw new Error(`Render too small (${Math.round(sz2 / 1024)} KB)`);

    update('Done!', 100);
    let outDur2 = 0;
    try { const i2 = await probe(videoOut2); outDur2 = Math.round(i2.duration || 0); } catch {}

    let thumb2 = null;
    try {
      const td2 = path.join(getAppDataDir(), 'thumb-cache');
      fs.mkdirSync(td2, { recursive: true });
      const tf2 = path.join(td2, path.basename(videoOut2, '.mp4') + '.jpg');
      await execFileAsync(ffmpegPath, ['-ss', String(outDur2 > 10 ? Math.floor(outDur2 * 0.35) : 5), '-i', videoOut2, '-frames:v', '1', '-q:v', '4', '-vf', 'scale=600:-1', '-y', tf2], { timeout: 10000 });
      thumb2 = tf2;
    } catch (e) { console.warn('[pipeline] thumbnail failed:', e.message); }

    let savedAsmPath2 = null;
    try {
      savedAsmPath2 = assemblyPath(videoOut2);
      fs.writeFileSync(savedAsmPath2, JSON.stringify({ version: 1, videoPath: videoOut2, assembly: combinedAssembly2, opts: { captions: options.captions || false, captionStyle: options.captionStyle || 'clean', orientation: options.orientation || 'landscape' }, createdAt: new Date().toISOString() }, null, 2));
    } catch {}

    const excerpt2 = aroll.map(c => (c.transcript?.segments || []).map(s => s.text).join(' ').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 600).trim();

    return {
      videoPath: videoOut2, thumbPath: thumb2, outDir: outputBase2,
      assembly: combinedAssembly2, assemblyPath: savedAsmPath2,
      resolvedTimeline: null, pacingParams, outputDurationSec: outDur2,
      footageDates: dayKeys, transcriptExcerpt: excerpt2 || null,
      stats: { totalClips: probed.length, arollCount: aroll.length, brollCount: broll.length, totalSec: Math.round(totalSec), rawDurationSec: Math.round(totalSec), recommended, outputDurationSec: outDur2, hlgClipCount: probed.filter(c => c.needsColorConversion).length },
    };
  }

  // ── Cap a-roll to target duration ─────────────────────────────────────────
  // Narration is the spine of the video. If total a-roll exceeds the target,
  // greedily take clips in order until the budget is spent. The clip that
  // overflows gets trimmed to its densest speech window using findDenseWindow.
  const targetSecs   = options.targetDuration || 180;
  const brollCut     = pacingParams?.brollCut ?? 7;
  const faceDur      = pacingParams?.faceDur ?? 4;

  const narrTimeline = aroll.reduce((s, c) => s + ((c.trimEnd ?? c.duration) - (c.trimStart ?? 0)), 0);

  let cappedAroll = aroll;
  if (narrTimeline > targetSecs * 1.05) {
    // Spread budget evenly across clips so every a-roll clip contributes a
    // meaningful beat. Minimum slice is faceDur*2 (pacing-adjusted) so no
    // clip is trimmed to just a sentence fragment.
    const minPerClip   = faceDur * 2;
    const numClips     = Math.min(aroll.length, Math.max(1, Math.floor(targetSecs / minPerClip)));
    const slicePerClip = targetSecs / numClips;

    // When we have more clips than slots, ask Claude to pick the best ones
    // based on transcript content and the day description.  This ensures a 30s
    // video gets the most engaging content, not just the first N clips.
    const selectedAroll = await selectBestAroll(aroll, numClips, targetSecs, log);

    cappedAroll = [];
    for (const clip of selectedAroll) {
      const clipDur = (clip.trimEnd ?? clip.duration) - (clip.trimStart ?? 0);
      if (clipDur <= slicePerClip) {
        log.write(`  [window] ${path.basename(clip.path)}: ${clipDur.toFixed(1)}s fits budget (${slicePerClip.toFixed(1)}s/clip) — using full clip`);
        cappedAroll.push(clip);
      } else {
        const win = await whisper.findDenseWindow(clip.transcript?.segments || [], slicePerClip);
        if (win) {
          const winDur = (win.windowEnd - win.windowStart).toFixed(1);
          log.write(`  [window] ${path.basename(clip.path)}: ${clipDur.toFixed(1)}s → [${win.windowStart.toFixed(1)}s–${win.windowEnd.toFixed(1)}s] (${winDur}s)`);
          cappedAroll.push({ ...clip, trimStart: win.windowStart, trimEnd: win.windowEnd });
        } else {
          log.write(`  [window] ${path.basename(clip.path)}: ${clipDur.toFixed(1)}s → hard trim to ${slicePerClip.toFixed(1)}s (no segments)`);
          cappedAroll.push({ ...clip, trimEnd: (clip.trimStart ?? 0) + slicePerClip });
        }
      }
    }
    const cappedDur = cappedAroll.reduce((s, c) => s + ((c.trimEnd ?? c.duration) - (c.trimStart ?? 0)), 0);
    console.log(`[duration] capped: ${narrTimeline.toFixed(1)}s → ${cappedDur.toFixed(1)}s (target=${targetSecs}s, ${numClips}/${aroll.length} clips selected, ${slicePerClip.toFixed(1)}s/clip)`);
  }

  const solobudgetSecs = Math.max(0, targetSecs - narrTimeline);
  const maxSoloBroll   = Math.max(3, Math.floor(solobudgetSecs / brollCut));
  let cutawaysNeeded = 0;
  for (const clip of cappedAroll) {
    cutawaysNeeded += Math.max(1, Math.floor(((clip.trimEnd ?? clip.duration) - (clip.trimStart ?? 0)) / (faceDur + brollCut)));
  }

  console.log(`[duration] target=${targetSecs}s narrTimeline=${narrTimeline.toFixed(1)}s cappedAroll=${cappedAroll.length}/${aroll.length} cutawaysNeeded=${cutawaysNeeded} soloBudget=${solobudgetSecs.toFixed(1)}s maxSolo=${maxSoloBroll} brollTotal=${broll.length}`);

  update('Finishing up…', 65);

  // ── Teaser-aware ending ───────────────────────────────────────────────────
  // Detect open/setup phrases near the end of the last a-roll clip and pull
  // ── Describe b-roll for content tiebreaker ───────────────────────────────
  // Claude Vision already provides descriptions, but Apple Vision does not.
  // This fill-in pass ensures every b-roll has a description available for
  // the boundary tiebreaker in assignBrollByPosition.
  update('Describing b-roll…', 67);
  await describeBroll(scoredBroll, log);

  // ── Log narration sections (transcript excerpt per a-roll clip) ──────────
  // Printed to debug-last-run.log so you can read the story arc without
  // watching the video, and verify semantic b-roll placement makes sense.
  log.write(`[transcript] ${cappedAroll.length} narration sections:`);
  cappedAroll.forEach((clip, i) => {
    const segs = clip.transcript?.segments || [];
    const text = segs.map(s => s.text).join(' ').replace(/\s+/g, ' ').slice(0, 300).trim();
    log.write(`  Section ${i + 1}: [${path.basename(clip.path)}] "${text || '(no transcript)'}"`);
  });

  // ── B-roll section assignment ─────────────────────────────────────────────
  // Assign each b-roll clip to a narration section by its position in the
  // sorted clip array. Clips near section boundaries get a content tiebreaker
  // (small Claude Haiku call) to handle transitions gracefully.
  await assignBrollByPosition(cappedAroll, scoredBroll, probed, log);

  const { assembly } = await buildJournal({ aroll: cappedAroll, broll: scoredBroll });

  update('Rendering sections…', 70);

  // Output paths — use actual clip date range (not render date) for the folder slug
  const cfg = loadOutputConfig();
  const outputBase = cfg.outputFolder || path.join(os.homedir(), 'Movies', 'Slices');
  const dateSlug   = isMultiDay
    ? `${dayKeys[0]}-to-${dayKeys[dayKeys.length - 1].slice(5)}`
    : dayKeys[0] || new Date().toISOString().slice(0, 10);
  fs.mkdirSync(outputBase, { recursive: true });

  const isVertical  = options.orientation === 'vertical';
  const orientSlug  = isVertical ? '-vertical' : '';
  const videoOut    = path.join(outputBase, `${dateSlug}${orientSlug}.mp4`);

  const captionsOpts = options.captions
    ? { enabled: true, style: options.captionStyle || 'clean' }
    : null;

  const renderResult = await buildJournalVideo(assembly, videoOut, prog => {
    // prog may be a plain number (0–100) or { pct, message, detectedResolution }
    const pct = typeof prog === 'object' ? prog.pct : prog;
    const msg = typeof prog === 'object' && prog.message
      ? prog.message
      : (pct < 90 ? 'Rendering sections…' : 'Joining and exporting…');
    const res = typeof prog === 'object' ? prog.detectedResolution : null;
    onProgress?.({ message: msg, progress: 70 + Math.round((pct / 100) * 25), detectedResolution: res });
  }, musicOpts, pacingParams, captionsOpts, { vertical: isVertical });
  const resolvedTimeline = renderResult?.resolvedTimeline || null;
  const srtPath          = renderResult?.srtPath || null;

  // Sanity-check the output — a partial render leaves a file that's too small
  // to be a real video (concat demuxer writes a valid header even if it fails
  // mid-stream, so size is a more reliable signal than file existence alone).
  const MIN_OUTPUT_BYTES = 500 * 1024; // 500 KB — anything smaller is corrupt
  let outputSize = 0;
  try { outputSize = fs.statSync(videoOut).size; } catch {}
  if (outputSize < MIN_OUTPUT_BYTES) {
    throw new Error(`Render produced a file that is too small (${Math.round(outputSize / 1024)} KB) — the export likely failed mid-stream.`);
  }

  update('Done!', 100);

  // Probe output duration first so thumbnail can seek past opening narration
  let outputDurationSec = 0;
  try {
    const outInfo = await probe(videoOut);
    outputDurationSec = Math.round(outInfo.duration || 0);
  } catch {}

  // Extract thumbnail at 35% in — well past the opening narration/a-roll,
  // into the b-roll section where scene content is more representative.
  let thumbPath = null;
  try {
    const thumbDir = path.join(getAppDataDir(), 'thumb-cache');
    fs.mkdirSync(thumbDir, { recursive: true });
    const thumbFile = path.join(thumbDir, path.basename(videoOut, '.mp4') + '.jpg');
    const seekSec = outputDurationSec > 10 ? Math.floor(outputDurationSec * 0.35) : 5;
    await execFileAsync(ffmpegPath, [
      '-ss', String(seekSec), '-i', videoOut,
      '-frames:v', '1', '-q:v', '4', '-vf', 'scale=600:-1', '-y', thumbFile,
    ], { timeout: 10000 });
    thumbPath = thumbFile;
  } catch (e) {
    console.warn('[pipeline] thumbnail extraction failed:', e.message);
  }

  // Save assembly sidecar for re-edit (stored in app data, not next to the video)
  let savedAssemblyPath = null;
  try {
    savedAssemblyPath = assemblyPath(videoOut);
    fs.writeFileSync(savedAssemblyPath, JSON.stringify({
      version: 1, videoPath: videoOut, assembly, resolvedTimeline,
      opts: { captions: options.captions || false, captionStyle: options.captionStyle || 'clean', orientation: options.orientation || 'landscape' },
      createdAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    console.warn('[pipeline] assembly sidecar write failed:', e.message);
    savedAssemblyPath = null;
  }

  const transcriptExcerpt = aroll
    .map(c => (c.transcript?.segments || []).map(s => s.text).join(' ').trim())
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 600).trim();

  return {
    videoPath: videoOut,
    srtPath,
    thumbPath,
    outDir: outputBase,
    assembly,
    assemblyPath: savedAssemblyPath,
    resolvedTimeline,
    pacingParams,
    outputDurationSec,
    footageDates: dayKeys,
    transcriptExcerpt: transcriptExcerpt || null,
    stats: {
      totalClips:   probed.length,
      arollCount:   aroll.length,
      brollCount:   broll.length,
      totalSec:     Math.round(totalSec),
      rawDurationSec: Math.round(totalSec),
      recommended,
      outputDurationSec,
      hlgClipCount: probed.filter(c => c.needsColorConversion).length,
    },
  };
}

module.exports = { run, recommendDuration };
