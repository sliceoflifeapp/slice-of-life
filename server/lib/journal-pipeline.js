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

const VIDEO_EXTS = new Set(['.mp4','.m4v','.mov','.avi','.mkv','.mts','.m2ts','.webm']);
const AUDIO_EXTS = new Set(['.mp3','.m4a','.wav','.aiff','.aif','.flac','.ogg']);
const TALKING_HEAD_MIN_SEC = 4; // clips shorter than this are always b-roll (too short for speech)

// Recommend output duration based on total footage
function recommendDuration(totalSec) {
  if (totalSec < 300)  return { label: '30 sec', value: '30s',  reason: 'Short session' };
  if (totalSec < 900)  return { label: '1 min',  value: '1min', reason: 'Quick journal' };
  if (totalSec < 2700) return { label: '3 min',  value: '3min', reason: 'Full day' };
  if (totalSec < 5400) return { label: '5 min',  value: '5min', reason: 'Big day' };
  return                      { label: '5 min',  value: '5min', reason: 'Best of the day' };
}

async function run(folderPath, options = {}, onProgress, pacingParams) {
  const update = (msg, pct) => onProgress?.({ message: msg, progress: pct });

  update('Scanning footage…', 5);

  // Scan for video + audio files
  const allFiles = scanner.fullScan(folderPath);
  const videos   = allFiles.filter(f => VIDEO_EXTS.has(f.ext));
  const audios   = allFiles.filter(f => AUDIO_EXTS.has(f.ext));

  if (!videos.length) throw new Error('No video files found in this folder');

  update('Analysing clips…', 10);

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
  console.log('[sort] clip order after sort:');
  probed.forEach((c, i) => console.log(`  ${i + 1}. ${path.basename(c.path)}  creationTime=${c.creationTime?.toISOString() ?? 'none'}  filledAt=${c.filledAt}`));

  const totalSec = probed.reduce((s, f) => s + f.duration, 0);
  const recommended = recommendDuration(totalSec);

  update('Analysing clips…', 20);

  const description      = options.description    || '';
  const highSensitivity  = !!options.highSensitivity;
  const highlightOnly    = !!options.highlightOnly;

  // Classify: talking head (a-roll) vs b-roll
  const aroll = [];
  const broll = [];
  let checked = 0;

  {
    // ── Unified Vision pass — one Claude call per clip ───────────────────────
    // Highlight mode: talking-head clips are skipped (no Whisper, no a-roll).
    // Normal mode:    talking-head candidates confirmed with Whisper.
    for (const clip of probed) {
      const pct = 20 + Math.round((checked / probed.length) * 40);
      update(`Analysing clip ${checked + 1} of ${probed.length}…`, pct);

      if (clip.duration < TALKING_HEAD_MIN_SEC) {
        // Too short to be narration — still run Vision for rotation + quality data
        // so tight-pacing b-roll cuts aren't upside down due to unvalidated tags.
        const vision = await analyzeClip(clip, description, {});
        if (vision.qualityScore >= 15) {
          broll.push({ ...clip, clipType: 'broll', vision, brollScore: vision.qualityScore });
        }
        checked++; continue;
      }

      // Slow-motion (≥120fps) and time-lapse (<5fps) clips are pure b-roll
      if (clip.isSloMo || clip.isTimeLapse) {
        console.log(`[pipeline] ${path.basename(clip.path)}: ${clip.isSloMo ? 'slo-mo' : 'time-lapse'} → broll`);
        broll.push({ ...clip, clipType: 'broll' });
        checked++; continue;
      }

      // Vision pass — sequential to avoid hammering the API
      const vision = await analyzeClip(clip, description, { highSensitivity });

      // Hard reject: shot explicitly conflicts with director's notes
      if (vision.matchesDirectorNotes === false) {
        console.log(`[pipeline] ${path.basename(clip.path)}: rejected — conflicts with director notes`);
        checked++; continue;
      }

      // Hard reject: unusable shot (very low quality)
      if (vision.qualityScore < 15) {
        console.log(`[pipeline] ${path.basename(clip.path)}: rejected — qualityScore=${vision.qualityScore} (unusable)`);
        checked++; continue;
      }

      if (vision.isTalkingHead) {
        if (highlightOnly) {
          // Highlight mode: skip talking heads — b-roll only
          console.log(`[pipeline] highlight: ${path.basename(clip.path)}: talking head — skipped`);
          checked++; continue;
        }
        // Normal mode: confirm with Whisper
        update(`Transcribing clip ${checked + 1} of ${probed.length}…`, pct);
        const transcript = await whisper.transcribe(clip.path, clip.duration, description);
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
        broll.push({ ...clip, clipType: 'broll', vision, brollScore: vision.qualityScore });
      }

      checked++;
    }
  }

  // ── No narration found: stop with a recoverable error ─────────────────────
  if (aroll.length === 0 && !highlightOnly) {
    const err = new Error('NO_AROLL');
    err.noAroll = true;
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
    const targetSecs  = options.targetDuration || 180;
    const brollCut    = pacingParams?.brollCut ?? 7;
    const clipCap     = brollCut; // max seconds we take from each clip
    let budgetLeft    = targetSecs;
    // Pick top clips (already sorted best-first) that fit within targetDuration.
    // Re-sort chronologically for natural storytelling after selection.
    const picked = [];
    for (const clip of scoredBroll) {
      const contrib = Math.min(clip.duration, clipCap);
      if (budgetLeft <= 0) break;
      picked.push(clip);
      budgetLeft -= contrib;
    }
    picked.sort((a, b) => a.filledAt - b.filledAt);

    const hlAssembly = picked.map(clip => ({ ...clip, clipType: 'broll' }));
    if (!hlAssembly.length) throw new Error('No usable b-roll clips found for highlight reel');

    update('Rendering highlight reel…', 70);

    const cfg2 = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.gather', 'config.json'), 'utf8')); } catch { return {}; } })();
    const outputBase2 = cfg2.outputFolder || path.join(os.homedir(), 'Desktop', 'Organized');
    const dateSlug2   = new Date().toISOString().slice(0, 10);
    const outDir2     = path.join(outputBase2, 'Journals', dateSlug2);
    fs.mkdirSync(outDir2, { recursive: true });

    const isVertical2  = options.orientation === 'vertical';
    const orientSlug2  = isVertical2 ? '-vertical' : '';
    const videoOut2    = path.join(outDir2, `Highlight-${dateSlug2}${orientSlug2}.mp4`);

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

    let thumbPath2 = null;
    try {
      const thumbDir2 = path.join(os.homedir(), '.gather', 'thumb-cache');
      fs.mkdirSync(thumbDir2, { recursive: true });
      const thumbFile2 = path.join(thumbDir2, path.basename(videoOut2, '.mp4') + '.jpg');
      await execFileAsync(ffmpegPath, [
        '-i', videoOut2, '-vf', 'thumbnail=300,scale=600:-1',
        '-frames:v', '1', '-q:v', '4', '-y', thumbFile2,
      ], { timeout: 30000 });
      thumbPath2 = thumbFile2;
    } catch (e) {
      console.warn('[pipeline] highlight thumbnail failed:', e.message);
    }

    let outputDurationSec2 = 0;
    try { const info2 = await probe(videoOut2); outputDurationSec2 = Math.round(info2.duration || 0); } catch {}

    // Save assembly sidecar for re-edit
    try {
      const assemblyPath2 = videoOut2.replace(/\.mp4$/, '.assembly.json');
      fs.writeFileSync(assemblyPath2, JSON.stringify({
        version: 1, videoPath: videoOut2, assembly: hlAssembly,
        opts: { captions: options.captions || false, captionStyle: options.captionStyle || 'clean', orientation: options.orientation || 'landscape' },
        createdAt: new Date().toISOString(),
      }, null, 2));
    } catch {}

    return {
      videoPath: videoOut2, thumbPath: thumbPath2, outDir: outDir2,
      assembly: hlAssembly, pacingParams,
      outputDurationSec: outputDurationSec2,
      assemblyPath: videoOut2.replace(/\.mp4$/, '.assembly.json'),
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
    update(`Analysing music (${path.basename(musicPath)})…`, 63);
    try {
      const beatInfo = await extractBeats(musicPath);
      musicOpts = { musicPath, ...beatInfo };
      update(`Beat grid: ${beatInfo.bpm} BPM — syncing b-roll to music…`, 64);
    } catch (err) {
      console.warn('Beat extraction failed, continuing without music sync:', err.message);
    }
  }

  // ── Trim clips to fit target duration ─────────────────────────────────────
  // Narration audio is the spine — its total duration sets the base length.
  // Broll cutaways play DURING narration (no extra time added).
  // Only SOLO broll (clips that don't fit as cutaways) adds time after narration.
  // So: pass ALL broll through as cutaways. Only cap solo broll.
  const targetSecs  = options.targetDuration || 180;
  const brollCut    = pacingParams?.brollCut ?? 7;

  const narrTimeline = aroll.reduce((s, c) => s + (c.duration || 0), 0);

  // Pass ALL broll to buildInterleaved — it uses timestamp-based matching to
  // assign each clip to its nearest narration section. We only cap the total
  // solo broll count (clips that don't fit as cutaways) to keep duration sane.
  const solobudgetSecs = Math.max(0, targetSecs - narrTimeline);
  const maxSoloBroll   = Math.max(3, Math.floor(solobudgetSecs / brollCut));
  const faceDur        = pacingParams?.faceDur ?? 4;
  let cutawaysNeeded = 0;
  for (const clip of aroll) {
    cutawaysNeeded += Math.max(1, Math.floor((clip.duration || 0) / (faceDur + brollCut)));
  }
  // Use scored broll (rejects filtered, sorted best-first).
  // IMPORTANT: buildInterleaved matches clips by filledAt timestamp, so the
  // sort order here only affects which clips win when there are more candidates
  // than slots — the best-scored clips get used first.
  const trimmedBroll = scoredBroll;

  console.log(`[duration] target=${targetSecs}s narrTimeline=${narrTimeline.toFixed(1)}s cutawaysNeeded=${cutawaysNeeded} soloBudget=${solobudgetSecs.toFixed(1)}s maxSolo=${maxSoloBroll} brollTotal=${broll.length}`);

  update('Finishing up…', 65);

  const { assembly } = await buildJournal({ aroll, broll: trimmedBroll });

  update('Rendering sections…', 70);

  // Output paths
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.gather', 'config.json'), 'utf8')); } catch { return {}; } })();
  const outputBase = cfg.outputFolder || path.join(os.homedir(), 'Desktop', 'Organized');
  const dateSlug   = new Date().toISOString().slice(0, 10);
  const outDir     = path.join(outputBase, 'Journals', dateSlug);
  fs.mkdirSync(outDir, { recursive: true });

  const isVertical  = options.orientation === 'vertical';
  const orientSlug  = isVertical ? '-vertical' : '';
  const videoOut    = path.join(outDir, `Journal-${dateSlug}${orientSlug}.mp4`);

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

  // Extract a thumbnail from the finished video and save it to disk.
  // Uses ffmpeg's thumbnail filter to pick the most representative frame.
  let thumbPath = null;
  try {
    const thumbDir = path.join(os.homedir(), '.gather', 'thumb-cache');
    fs.mkdirSync(thumbDir, { recursive: true });
    const thumbFile = path.join(thumbDir, path.basename(videoOut, '.mp4') + '.jpg');
    await execFileAsync(ffmpegPath, [
      '-i', videoOut,
      '-vf', 'thumbnail=300,scale=600:-1',
      '-frames:v', '1',
      '-q:v', '4',
      '-y', thumbFile,
    ], { timeout: 30000 });
    thumbPath = thumbFile;
  } catch (e) {
    console.warn('[pipeline] thumbnail extraction failed:', e.message);
  }

  // Probe the output file to get actual rendered duration
  let outputDurationSec = 0;
  try {
    const outInfo = await probe(videoOut);
    outputDurationSec = Math.round(outInfo.duration || 0);
  } catch {}

  // Save assembly sidecar for re-edit
  let assemblyPath = null;
  try {
    assemblyPath = videoOut.replace(/\.mp4$/, '.assembly.json');
    fs.writeFileSync(assemblyPath, JSON.stringify({
      version: 1, videoPath: videoOut, assembly, resolvedTimeline,
      opts: { captions: options.captions || false, captionStyle: options.captionStyle || 'clean', orientation: options.orientation || 'landscape' },
      createdAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    console.warn('[pipeline] assembly sidecar write failed:', e.message);
    assemblyPath = null;
  }

  return {
    videoPath: videoOut,
    thumbPath,
    outDir,
    assembly,
    assemblyPath,
    resolvedTimeline,
    pacingParams,
    outputDurationSec,
    stats: {
      totalClips:   probed.length,
      arollCount:   aroll.length,
      brollCount:   broll.length,
      totalSec:     Math.round(totalSec),
      recommended,
      outputDurationSec,
      hlgClipCount: probed.filter(c => c.needsColorConversion).length,
    },
  };
}

module.exports = { run, recommendDuration };
