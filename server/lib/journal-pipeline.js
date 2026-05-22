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
const { clipComparator }           = require('./clip-sort');
const { analyzeClip }              = require('./clip-vision');
const { getAppDataDir }            = require('./app-data');

function assemblyPath(videoOut) {
  const cacheDir = path.join(getAppDataDir(), 'assembly-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  return path.join(cacheDir, path.basename(videoOut).replace(/\.mp4$/, '.assembly.json'));
}

const VIDEO_EXTS = new Set(['.mp4','.m4v','.mov','.avi','.mkv','.mts','.m2ts','.webm']);
const AUDIO_EXTS = new Set(['.mp3','.m4a','.wav','.aiff','.aif','.flac','.ogg']);

const VERBOSE = process.env.SOL_VERBOSE === '1';
const TALKING_HEAD_MIN_SEC = 4; // clips shorter than this are always b-roll (too short for speech)

// Recommend output duration based on total footage
function recommendDuration(totalSec) {
  if (totalSec < 300)  return { label: '30 sec', value: '30s',  reason: 'Short session' };
  if (totalSec < 900)  return { label: '1 min',  value: '1min', reason: 'Quick journal' };
  if (totalSec < 2700) return { label: '3 min',  value: '3min', reason: 'Full day' };
  if (totalSec < 5400) return { label: '5 min',  value: '5min', reason: 'Big day' };
  return                      { label: '5 min',  value: '5min', reason: 'Best of the day' };
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
async function selectBestAroll(aroll, numClips, targetSecs, description, log) {
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

  const descLine = description ? `Day description: "${description}"\n\n` : '';

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content:
          `${descLine}Narration clips (chronological order):\n${clipList}\n\n` +
          `Pick the ${numClips} clips that together tell the most engaging story for a ${Math.round(targetSecs)}s video. ` +
          `Prefer clips that are self-contained complete thoughts, together form a natural narrative arc, ` +
          `and relate to the day description. ` +
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
// Sets clip.vision.description in-place so assignBrollSemantically can match
// clips to narration sections semantically instead of by timestamp proximity.
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

// Ask Claude Haiku to assign each b-roll clip to the narration section it
// best illustrates, using Vision descriptions + transcript text.
// Writes clip.semanticSection (0-based index) in-place on matching clips.
// Clips without Vision data or when offline fall through to timestamp matching.
async function assignBrollSemantically(aroll, broll, log, style = 'balanced', arcContext = '') {
  if (!aroll.length || !broll.length) return;

  // Chronological: skip semantic assignment entirely — timestamp fallback handles it
  if (style === 'chronological') {
    log?.write('[semantic-broll] skipped — chronological style selected');
    return;
  }

  // Sort by filledAt so [recorded X of N] labels in the prompt reflect
  // actual recording order, not quality score order.  broll arrives sorted
  // by Vision qualityScore (descending) — using that index as a proxy for
  // "when it was filmed" is wrong and the root cause of ordering bugs.
  const assignable = broll
    .filter(b => b.vision?.description || b.vision?.contentTags?.length)
    .sort((a, b) => (a.filledAt || 0) - (b.filledAt || 0));
  if (!assignable.length) return;

  // Compute filledAt range for the chronological guard below.
  const filledAts  = assignable.map(c => c.filledAt || 0).filter(t => t > 0);
  const minFilled  = filledAts.length ? Math.min(...filledAts) : 0;
  const maxFilled  = filledAts.length ? Math.max(...filledAts) : 0;
  const hasTimings = maxFilled > minFilled;

  const client = whisper.getClient();
  if (!client) return;

  const sectionsText = aroll.map((clip, i) => {
    const text = (clip.transcript?.segments || []).map(s => s.text).join(' ')
      .replace(/\s+/g, ' ').slice(0, 250).trim();
    return `Section ${i + 1} of ${aroll.length}: "${text || '(no transcript)'}"`;
  }).join('\n');

  const brollLines = assignable.map((clip, i) => {
    const desc    = clip.vision?.description || '';
    const tags    = (clip.vision?.contentTags || []).join(', ');
    const summary = [desc, tags].filter(Boolean).join('. ').replace(/\s+/g, ' ').slice(0, 200);
    const pos     = style === 'balanced'
      ? ` [recorded ${i + 1} of ${assignable.length}]`
      : '';
    return `B-roll ${i + 1}${pos}: "${summary}"`;
  }).join('\n');

  // 3-act structure: the narration sections form a natural beginning/middle/end arc.
  // B-roll recorded in the first third of the day belongs in the first third of
  // sections; middle footage in the middle; end footage at the end.
  // Semantic content match is a secondary signal — chronological order is primary.
  const chronoInstruction = style === 'balanced'
    ? '\nIMPORTANT: The clips are listed in the order they were recorded. The video has a 3-act structure — beginning, middle, and end. B-roll recorded early in the day should appear in the early sections (Act 1: arrival/setup), mid-day footage in the middle sections (Act 2: main events), and late footage in the final sections (Act 3: wrap-up/reflection). Preserve this chronological arc. Only reassign a clip to a non-chronological section if the content match is dramatically stronger AND the clip is within one act of its natural position.'
    : '';

  const arcLine = arcContext ? `\nStory arc context:\n${arcContext}\n` : '';
  const prompt = [
    'Match each b-roll clip to the narration section whose content it best illustrates.\n',
    'Narration sections:', sectionsText,
    arcLine,
    '\nB-roll clips:', brollLines,
    chronoInstruction,
    '\nReply with ONLY a compact JSON object. Keys are b-roll numbers (as strings "1", "2", …),',
    'values are section numbers (integers). Every b-roll must be assigned.',
    'Example: {"1":2,"2":1,"3":2}',
  ].join('\n');

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw       = msg.content[0].text.trim();
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (!jsonMatch) throw new Error('no JSON in response');
    const assignment = JSON.parse(jsonMatch[0]);
    let assigned = 0;
    assignable.forEach((clip, i) => {
      const sectionNum = assignment[String(i + 1)];
      if (sectionNum !== undefined) {
        const idx = Math.max(0, Math.min(aroll.length - 1, parseInt(sectionNum) - 1));
        if (!isNaN(idx)) { clip.semanticSection = idx; assigned++; }
      }
    });

    // Hard chronological guard — use actual filledAt timestamps (not quality-sort
    // position) so the fraction accurately reflects when each clip was filmed.
    // Threshold: 35% — a clip can shift at most ~1 act (1/3 of the video) from
    // its natural chronological position. Larger jumps are reverted, but instead
    // of falling back to pure timestamp proximity (which ignores content), we
    // store the natural chronological section so a follow-up pass can make a
    // content-aware reassignment within the correct chronological window.
    let reverted = 0;
    const revertedClips = [];
    assignable.forEach((clip, i) => {
      if (clip.semanticSection === undefined) return;
      // Use real timestamp fraction when available; fall back to array index.
      const clipFrac = hasTimings && clip.filledAt
        ? (clip.filledAt - minFilled) / (maxFilled - minFilled)
        : (i + 0.5) / assignable.length;
      const sectionFrac = (clip.semanticSection + 0.5) / aroll.length;
      if (Math.abs(clipFrac - sectionFrac) > 0.35) {
        log?.write(`  [reorder-revert] "${path.basename(clip.path)}" filmed@${Math.round(clipFrac*100)}% → sec ${clip.semanticSection+1}/${aroll.length} (${Math.round(sectionFrac*100)}%) out of chronological order`);
        // Store the natural chronological section for the retry pass below.
        clip._chronoSection = Math.max(0, Math.min(aroll.length - 1, Math.round(clipFrac * (aroll.length - 1))));
        delete clip.semanticSection;
        assigned--;
        reverted++;
        revertedClips.push(clip);
      }
    });

    // Secondary pass: for each reverted clip, ask Claude which of the ±1
    // sections around its natural chronological position fits best.  This gives
    // content-aware placement within the correct act, preventing mismatches
    // like "lily pad garden" appearing during a "lost my hat" narration.
    for (const clip of revertedClips) {
      const chronoSec = clip._chronoSection;
      const secMin    = Math.max(0, chronoSec - 1);
      const secMax    = Math.min(aroll.length - 1, chronoSec + 1);
      delete clip._chronoSection;
      if (secMin === secMax) {
        clip.semanticSection = secMin;
        assigned++;
        log?.write(`  [revert-retry] "${path.basename(clip.path)}" → only section ${secMin + 1} in range`);
        continue;
      }
      const secLabels = [];
      for (let s = secMin; s <= secMax; s++) {
        const txt = (aroll[s].transcript?.segments || []).map(t => t.text).join(' ').slice(0, 150).trim();
        secLabels.push(`Section ${s + 1}: "${txt || '(no transcript)'}"`);
      }
      const desc = clip.vision?.description || '';
      try {
        const retryMsg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 5,
          messages: [{ role: 'user', content: `B-roll clip: "${desc}"\n\nWhich section best fits this clip visually?\n${secLabels.join('\n')}\n\nReply with only the section number (e.g. "5").` }],
        });
        // Parse the first number from the response — handles "5", "Section 5", "5\n", etc.
        const numMatch  = retryMsg.content[0].text.match(/\d+/);
        const sectionNum = numMatch ? parseInt(numMatch[0]) : NaN;
        if (isNaN(sectionNum)) {
          log?.write(`  [revert-retry] "${path.basename(clip.path)}" — no number in response: "${retryMsg.content[0].text.trim().slice(0,40)}"`);
        } else if (sectionNum < secMin + 1 || sectionNum > secMax + 1) {
          log?.write(`  [revert-retry] "${path.basename(clip.path)}" returned ${sectionNum} — out of range ${secMin+1}–${secMax+1}`);
        } else {
          clip.semanticSection = sectionNum - 1;
          assigned++;
          log?.write(`  [revert-retry] "${path.basename(clip.path)}" → section ${sectionNum} (window ${secMin+1}–${secMax+1})`);
        }
      } catch (retryErr) {
        log?.write(`  [revert-retry] "${path.basename(clip.path)}" failed (${retryErr.message}) — falling back to timestamp proximity`);
      }
    }

    log?.write(`[semantic-broll] style=${style} final: ${assigned}/${assignable.length} clips assigned (${reverted} reverted+retried)`);
    assignable.forEach((clip, i) => {
      if (clip.semanticSection !== undefined) {
        log?.write(`  "${path.basename(clip.path)}" → section ${clip.semanticSection + 1}`);
      }
    });
  } catch (err) {
    log?.write(`[semantic-broll] failed (${err.message}) — using timestamp fallback`);
    console.warn('[semantic-broll] failed:', err.message);
  }
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

  probed.sort(clipComparator);
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
  const recommended = recommendDuration(totalSec);

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

  const description      = options.description    || '';
  const highSensitivity  = !!options.highSensitivity;
  const highlightOnly    = !!options.highlightOnly;

  // Log startup info — paths + clip inventory
  log.write(`Run started — ${probed.length} clips, totalSec=${Math.round(totalSec)}s highlightOnly=${highlightOnly} highSensitivity=${highSensitivity}`);
  log.write(`Description: "${description || '(none)'}"`);
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

      if (clip.duration < TALKING_HEAD_MIN_SEC) {
        // Too short to be narration — still run Vision for rotation + quality data
        // so tight-pacing b-roll cuts aren't upside down due to unvalidated tags.
        const vision = await analyzeClip(clip, description, {});
        log.write(`Clip ${checked + 1} [${path.basename(clip.path)}] ${clip.duration.toFixed(1)}s: SKIPPED (too short < ${TALKING_HEAD_MIN_SEC}s) → broll q=${vision.qualityScore}`);
        if (vision.qualityScore >= 15) {
          broll.push({ ...clip, clipType: 'broll', vision, brollScore: vision.qualityScore });
        }
        checked++; continue;
      }

      // Slow-motion (≥120fps) and time-lapse (<5fps) clips are pure b-roll
      if (clip.isSloMo || clip.isTimeLapse) {
        console.log(`[pipeline] ${path.basename(clip.path)}: ${clip.isSloMo ? 'slo-mo' : 'time-lapse'} → broll`);
        log.write(`Clip ${checked + 1} [${path.basename(clip.path)}] ${clip.duration.toFixed(1)}s: ${clip.isSloMo ? 'SLO-MO' : 'TIME-LAPSE'} → broll`);
        broll.push({ ...clip, clipType: 'broll' });
        checked++; continue;
      }

      // Vision pass — sequential to avoid hammering the API
      const vision = await analyzeClip(clip, description, { highSensitivity });

      // Show Vision verdict in the progress bar for diagnostics
      const visionTag = vision.isTalkingHead ? 'talking head' : `b-roll (q=${vision.qualityScore})`;
      update(`Clip ${checked + 1}: Vision → ${visionTag}`, pct);

      const visionSource = vision._source || 'unknown'; // 'online' or 'offline'
      log.write(`Clip ${checked + 1} [${path.basename(clip.path)}] ${clip.duration.toFixed(1)}s: Vision=${visionSource} isTalkingHead=${vision.isTalkingHead} q=${vision.qualityScore} hasFace=${vision.hasFace}`);

      // Hard reject: shot explicitly conflicts with director's notes
      if (vision.matchesDirectorNotes === false) {
        console.log(`[pipeline] ${path.basename(clip.path)}: rejected — conflicts with director notes`);
        log.write(`  → REJECTED: conflicts with director notes`);
        checked++; continue;
      }

      // Hard reject: unusable shot (very low quality)
      if (vision.qualityScore < 15) {
        console.log(`[pipeline] ${path.basename(clip.path)}: rejected — qualityScore=${vision.qualityScore} (unusable)`);
        log.write(`  → REJECTED: qualityScore too low (${vision.qualityScore} < 15)`);
        checked++; continue;
      }

      if (vision.isTalkingHead) {
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
        const transcript = await whisper.transcribe(clip.path, clip.duration, description);
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
        // B-roll — carry qualityScore forward for sorting
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

    const cfg2 = (() => { try { return JSON.parse(fs.readFileSync(path.join(getAppDataDir(), 'config.json'), 'utf8')); } catch { return {}; } })();
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
      stats: {
        totalClips: probed.length, arollCount: 0, brollCount: hlAssembly.length,
        totalSec: Math.round(totalSec), recommended,
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
    const selectedAroll = await selectBestAroll(aroll, numClips, targetSecs, description, log);

    cappedAroll = [];
    for (const clip of selectedAroll) {
      const clipDur = (clip.trimEnd ?? clip.duration) - (clip.trimStart ?? 0);
      if (clipDur <= slicePerClip) {
        log.write(`  [window] ${path.basename(clip.path)}: ${clipDur.toFixed(1)}s fits budget (${slicePerClip.toFixed(1)}s/clip) — using full clip`);
        cappedAroll.push(clip);
      } else {
        const win = await whisper.findBestWindow(clip.transcript?.segments || [], slicePerClip, description);
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
  // the trim back so the video doesn't end on a cliffhanger.
  // Whisper often splits a phrase like "I'll show you" across 2-3 segments,
  // so we search the full concatenated text for the LAST teaser occurrence,
  // then find which segment it falls in and cut before that segment.
  const TEASER_RE = /\b(let me show you|i('?ll| will| am going to| want to) show you|show you|check this out|look at this|watch this|wait until you see|take a look|here it is|i'?m going to show you|you won'?t believe|come (check|see) this)\b/i;

  function runTeaserScan(text, segs) {
    let lastMatchIdx = -1, lastMatchLen = 0;
    const reScan = new RegExp(TEASER_RE.source, 'gi');
    let m;
    while ((m = reScan.exec(text)) !== null) { lastMatchIdx = m.index; lastMatchLen = m[0].length; }
    return { lastMatchIdx, lastMatchLen };
  }

  if (cappedAroll.length) {
    const last     = cappedAroll[cappedAroll.length - 1];
    const trimSt   = last.trimStart ?? 0;
    const trimEnd  = last.trimEnd ?? last.duration;
    const segs     = (last.transcript?.segments || []).filter(s => s.end > 0 && s.start >= trimSt && s.start < trimEnd);

    if (segs.length >= 1) {
      const fullText = segs.map(s => s.text).join(' ');
      const { lastMatchIdx, lastMatchLen } = runTeaserScan(fullText);
      if (lastMatchIdx !== -1) {
        const wordsAfter = fullText.slice(lastMatchIdx + lastMatchLen).trim().split(/\s+/).filter(Boolean).length;
        if (wordsAfter <= 8) {
          // Find which segment contains the match and where within it
          let charPos = 0, teaserSeg = segs[0], charAtSeg = 0;
          for (const seg of segs) {
            const next = charPos + seg.text.length + 1;
            if (lastMatchIdx < next) { teaserSeg = seg; charAtSeg = charPos; break; }
            charPos = next;
          }
          // Cut at the END of the segment that comes just before the teaser
          // phrase's segment — not inside the teaser segment using character
          // proportion. The teaser phrase is often embedded in a run-on sentence
          // ("Anyway, we're in Dreamworks and let me show you this") and a
          // proportion-based cut lands mid-sentence. Cutting at the prior
          // segment boundary gives a complete thought (e.g. "my hat was gone.")
          const segsBeforeTeaser = segs.filter(s => s.end <= teaserSeg.start + 0.05 && s !== teaserSeg);
          const prevSeg = segsBeforeTeaser.length > 0 ? segsBeforeTeaser[segsBeforeTeaser.length - 1] : null;
          const naturalCut = prevSeg ? prevSeg.end + 0.15 : null;

          // Fall back to character proportion if no prior segment or it's too close to trimStart.
          const matchOffsetInSeg = lastMatchIdx - charAtSeg;
          const fraction = Math.max(0, matchOffsetInSeg) / Math.max(1, teaserSeg.text.length);
          const propCut  = teaserSeg.start + fraction * (teaserSeg.end - teaserSeg.start);

          const cutPoint = (naturalCut && naturalCut > trimSt + 0.5) ? naturalCut : propCut;
          if (cutPoint > trimSt + 0.5) {
            log.write(`[teaser] "${fullText.slice(lastMatchIdx, lastMatchIdx + lastMatchLen)}" near end → trim to ${cutPoint.toFixed(1)}s${naturalCut && naturalCut === cutPoint ? ' (segment boundary)' : ' (char proportion)'}`);
            cappedAroll[cappedAroll.length - 1] = { ...last, trimEnd: cutPoint };
          } else {
            log.write(`[teaser] phrase found but estimated cut (${cutPoint.toFixed(1)}s) too close to trimStart — skipping`);
          }
        } else {
          log.write(`[teaser] phrase found but ${wordsAfter} words follow — not trailing, skipping`);
        }
      } else {
        log.write(`[teaser] no match in timed segments — tail: "${fullText.slice(-120).replace(/\n/g,' ')}"`);
      }
    } else {
      const rawText = (last.transcript?.text || '').trim();
      if (rawText) {
        const { lastMatchIdx, lastMatchLen } = runTeaserScan(rawText);
        if (lastMatchIdx !== -1) {
          const wordsAfter = rawText.slice(lastMatchIdx + lastMatchLen).trim().split(/\s+/).filter(Boolean).length;
          if (wordsAfter <= 8) {
            const totalWords = rawText.split(/\s+/).filter(Boolean).length;
            const wordsBefore = rawText.slice(0, lastMatchIdx).trim().split(/\s+/).filter(Boolean).length;
            const estimatedCut = trimSt + (wordsBefore / Math.max(1, totalWords)) * (trimEnd - trimSt);
            if (estimatedCut > trimSt + 1) {
              log.write(`[teaser] "${rawText.slice(lastMatchIdx, lastMatchIdx + lastMatchLen)}" near end (untimed estimate) → trim to ~${estimatedCut.toFixed(1)}s`);
              cappedAroll[cappedAroll.length - 1] = { ...last, trimEnd: estimatedCut };
            }
          } else {
            log.write(`[teaser] phrase found in raw text but ${wordsAfter} words follow — not trailing, skipping`);
          }
        } else {
          log.write(`[teaser] no match in raw text — tail: "${rawText.slice(-120).replace(/\n/g,' ')}"`);
        }
      } else {
        log.write(`[teaser] last clip has no timed segments and no raw text — skipping`);
      }
    }
  }

  // ── Story arc (multi-day only) ────────────────────────────────────────────
  // One Claude Haiku call that reads all narration grouped by day and returns a
  // short narrative description per day. Injected as extra context into the
  // semantic b-roll prompt so cross-day arc shapes clip selection.
  let arcContext = '';
  if (isMultiDay && cappedAroll.length > 0) {
    try {
      const client = whisper.getClient();
      if (client) {
        const byDay = {};
        for (const clip of cappedAroll) {
          const d = dayKeys[clip.dayIndex ?? 0];
          if (!byDay[d]) byDay[d] = [];
          byDay[d].push((clip.transcript?.segments || []).map(s => s.text).join(' ').replace(/\s+/g, ' ').slice(0, 300).trim());
        }
        const dayLines = dayKeys.map((d, i) => {
          const date = new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
          return `Day ${i + 1} (${date}): ${(byDay[d] || []).join(' … ').slice(0, 400) || '(no narration)'}`;
        }).join('\n');
        const arcMsg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: `These are narration excerpts from a ${dayKeys.length}-day personal video journal:\n\n${dayLines}\n\nIn 1–2 sentences per day, describe the emotional tone and main theme of each day to help an editor choose b-roll. Be specific and brief.` }],
        });
        arcContext = arcMsg.content[0].text.trim();
        log.write(`[story-arc] ${arcContext}`);
      }
    } catch (e) {
      log.write(`[story-arc] failed: ${e.message}`);
    }
  }

  // ── Describe b-roll for semantic matching ────────────────────────────────
  // Apple Vision returns no description/contentTags — without this step,
  // assignBrollSemantically has nothing to work with and falls back to
  // timestamp proximity for every clip.  One batched Claude Haiku call
  // per 15 clips gives enough context to match clips to narration sections.
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

  // ── Semantic b-roll assignment ────────────────────────────────────────────
  // Ask Claude Haiku to match each b-roll clip to the narration section it
  // best illustrates (uses Vision description + contentTags vs. transcript).
  // Sets clip.semanticSection (0-based) which buildInterleaved checks first.
  // Falls back to timestamp matching + directional routing when offline.
  const brollStyle = options.brollStyle || 'balanced';
  await assignBrollSemantically(cappedAroll, scoredBroll, log, brollStyle, arcContext);

  const { assembly } = await buildJournal({ aroll: cappedAroll, broll: scoredBroll });

  update('Rendering sections…', 70);

  // Output paths — use actual clip date range (not render date) for the folder slug
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(getAppDataDir(), 'config.json'), 'utf8')); } catch { return {}; } })();
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
