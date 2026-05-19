const path           = require('path');
const fs             = require('fs');
const os             = require('os');
const { execFile }   = require('child_process');
const { promisify }  = require('util');
const execFileAsync  = promisify(execFile);
const ffmpegPath     = require('ffmpeg-static');
const { clipComparator, filenameNum } = require('./clip-sort');

const VIDEO_EXTS = new Set(['.mp4','.m4v','.mov','.avi','.mkv','.mts','.m2ts','.webm']);
const AUDIO_EXTS = new Set(['.mp3','.m4a','.wav','.aiff','.aif','.flac','.ogg']);

// Remove near-duplicate clips (same scene filmed multiple times).
// Group clips within 4 seconds of each other; keep the longest.
function dedupClips(clips) {
  if (clips.length <= 1) return clips;
  const WINDOW_MS = 4000;
  const groups = [];
  let group = [clips[0]];
  for (let i = 1; i < clips.length; i++) {
    if (Math.abs(clips[i].filledAt - group[0].filledAt) <= WINDOW_MS) {
      group.push(clips[i]);
    } else {
      groups.push(group);
      group = [clips[i]];
    }
  }
  groups.push(group);
  return groups.map(g => g.reduce((best, c) => c.duration > best.duration ? c : best));
}

async function run(folderPath, options, onProgress, pacingParams) {
  const update = (message, progress) => onProgress && onProgress({ message, progress });

  // ── 1. Scan ─────────────────────────────────────────────────────────────────
  update('Scanning footage…', 5);
  const scanner  = require('./scanner');
  const allFiles = scanner.fullScan(folderPath);
  const videoFiles = allFiles.filter(f => VIDEO_EXTS.has(f.ext));
  const audioFiles = allFiles.filter(f => AUDIO_EXTS.has(f.ext));
  if (videoFiles.length === 0) throw new Error('No video files found');

  // ── 2. Probe + date each clip ────────────────────────────────────────────────
  update('Reading clip info…', 10);
  const { probe } = require('./journal-video');
  const clips = [];
  for (const f of videoFiles) {
    const info = await probe(f.path);
    const stat = fs.statSync(f.path);
    let date = (info.creationTime && info.creationTime.getFullYear() > 2000)
      ? info.creationTime
      : (stat.birthtime && stat.birthtime.getFullYear() > 1970 ? stat.birthtime : stat.mtime);
    const filledAt = date.getTime();
    clips.push({ ...f, ...info, date, creationTime: info.creationTime, filledAt });
  }
  clips.sort(clipComparator);

  // Dedup: remove near-duplicate clips within 4-second windows, keep longest
  const dedupedClips = dedupClips(clips);

  // ── 3. Group by calendar day ─────────────────────────────────────────────────
  const dayMap = new Map();
  for (const clip of dedupedClips) {
    const key = clip.date.toISOString().slice(0, 10); // YYYY-MM-DD
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key).push(clip);
  }
  const dayEntries = [...dayMap.entries()];
  const dayCount   = dayEntries.length;
  update(`Found ${dayCount} day${dayCount === 1 ? '' : 's'} of footage…`, 15);

  // ── 4. Transcribe each day ───────────────────────────────────────────────────
  const whisper        = require('./whisper');
  const { analyzeClip } = require('./clip-vision');
  const processedDays  = [];
  const highlightOnly  = !!options.highlightOnly;

  for (let i = 0; i < dayEntries.length; i++) {
    const [dayKey, dayClips] = dayEntries[i];
    const pctStart = 15 + Math.round((i / dayCount) * 45);
    update(`Day ${i + 1} of ${dayCount} — ${highlightOnly ? 'analysing clips…' : 'analysing clips…'}`, pctStart);

    const aroll = [];
    const broll = [];

    const TALKING_HEAD_MIN_SEC = 4;
    const directorNotes = options.description || '';

    // ── Unified Vision pass (trip mode — high sensitivity) ─────────────────
    // Highlight mode: talking-head clips are skipped (no Whisper, no a-roll).
    // Normal mode:    talking-head candidates confirmed with Whisper.
    for (const clip of dayClips) {
      if (clip.duration < TALKING_HEAD_MIN_SEC) {
        broll.push({ ...clip, clipType: 'broll', dayIndex: i });
        continue;
      }
      // Slo-mo and time-lapse are pure b-roll — skip Vision
      if (clip.isSloMo || clip.isTimeLapse) {
        broll.push({ ...clip, clipType: 'broll', dayIndex: i });
        continue;
      }
      try {
        // Trip mode always uses high sensitivity — more clips, more variety
        const vision = await analyzeClip(clip, directorNotes, { highSensitivity: true });

        // Hard reject: shot explicitly conflicts with director's notes
        if (vision.matchesDirectorNotes === false) {
          console.log(`[trip-pipeline] ${require('path').basename(clip.path)}: rejected — conflicts with director notes`);
          continue;
        }

        // Hard reject: unusable shot
        if (vision.qualityScore < 15) {
          console.log(`[trip-pipeline] ${require('path').basename(clip.path)}: rejected — qualityScore=${vision.qualityScore}`);
          continue;
        }

        if (vision.isTalkingHead) {
          if (highlightOnly) {
            // Highlight mode: skip talking heads — b-roll only
            console.log(`[trip-pipeline] highlight: ${require('path').basename(clip.path)}: talking head — skipped`);
            continue;
          }
          const result = await whisper.transcribe(clip.path, clip.duration, directorNotes);
          if (result.isTalkingHead) {
            aroll.push({
              ...clip, clipType: 'aroll', dayIndex: i, transcript: result, vision,
              trimStart: result.trimStart ?? 0,
              trimEnd:   result.trimEnd   ?? clip.duration,
            });
          } else {
            broll.push({ ...clip, clipType: 'broll', dayIndex: i, vision, brollScore: vision.qualityScore });
          }
        } else {
          broll.push({ ...clip, clipType: 'broll', dayIndex: i, vision, brollScore: vision.qualityScore });
        }
      } catch {
        broll.push({ ...clip, clipType: 'broll', dayIndex: i });
      }
    }

    // Sort b-roll by Vision qualityScore (already hard-rejected below 15)
    const scoredDayBroll = broll
      .filter(c => (c.brollScore ?? 50) >= 15)
      .sort((a, b) => (b.brollScore ?? 50) - (a.brollScore ?? 50));
    console.log(`[trip-pipeline] day ${dayKey} b-roll: ${broll.length} in → ${scoredDayBroll.length} kept (sorted by Vision qualityScore)`);

    processedDays.push({ dayKey, aroll, broll: scoredDayBroll });
  }

  // ── 5. Build narrative (or highlight reel) ──────────────────────────────────
  let assembly;

  if (highlightOnly) {
    // Skip Claude entirely — pick top b-roll proportional to dayCount
    update('Building highlight reel…', 62);
    const targetSecs   = options.targetDuration || 180;
    const brollCut     = 7; // seconds per clip max
    const secsPerDay   = Math.max(10, Math.floor(targetSecs / dayCount));
    const pickedAll    = [];
    for (const { dayKey, broll: dayBroll } of processedDays) {
      const candidates = dayBroll; // already sorted best-first by Vision qualityScore
      // Already sorted best-first by Vision qualityScore
      let budget = secsPerDay;
      for (const clip of candidates) {
        if (budget <= 0) break;
        pickedAll.push(clip);
        budget -= Math.min(clip.duration, brollCut);
      }
    }
    // Re-sort chronologically across all days
    pickedAll.sort((a, b) => (a.filledAt || 0) - (b.filledAt || 0));
    assembly = pickedAll.map(c => ({ ...c, clipType: 'broll' }));
  } else {
    update('Building trip assembly…', 62);
    const tripBuilder = require('./trip-builder');
    ({ assembly } = await tripBuilder.buildTrip(processedDays));
  }

  if (assembly.length === 0) throw new Error('No clips could be assembled');

  // ── 5b. Music / beat detection ───────────────────────────────────────────────
  let musicOpts = null;
  if (audioFiles.length) {
    const musicPath = audioFiles[0].path;
    update(`Analysing music (${path.basename(musicPath)})…`, 65);
    try {
      const { extractBeats } = require('./beats');
      const beatInfo = await extractBeats(musicPath);
      musicOpts = { musicPath, ...beatInfo };
      update(`${beatInfo.bpm} BPM — syncing b-roll to beat grid…`, 67);
    } catch (err) {
      console.warn('Beat extraction failed:', err.message);
    }
  }

  // ── 6. Assemble video ────────────────────────────────────────────────────────
  update('Assembling trip video…', 68);
  const cfg        = loadConfig();
  const outputBase = cfg.outputFolder || path.join(os.homedir(), 'Movies', 'Slice of Life');
  const isVertical = options.orientation === 'vertical';
  const orientSlug = isVertical ? '-vertical' : '';
  const tripLabel  = `Trip-${dayEntries[0][0]}${dayCount > 1 ? `-${dayEntries[dayCount-1][0].slice(5)}` : ''}`;
  const outDir     = path.join(outputBase, tripLabel);
  fs.mkdirSync(outDir, { recursive: true });

  // ── Compute day boundaries ───────────────────────────────────────────────────
  const dayBoundaries = [];
  let lastDay = -1;
  for (let ci = 0; ci < assembly.length; ci++) {
    const clip = assembly[ci];
    const di = clip.dayIndex ?? 0;
    if (di !== lastDay) {
      const [dayKey] = dayEntries[di];
      const d = new Date(dayKey);
      const label = `Day ${di + 1} · ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
      dayBoundaries.push({ dayIndex: di, label, clipIndex: ci });
      lastDay = di;
    }
  }

  // ── Generate day title cards (if enabled) ────────────────────────────────────
  if (options.dayTitleCards && dayBoundaries.length > 1) {
    const seqW    = isVertical ? 1080 : 1920;
    const seqH    = isVertical ? 1920 : 1080;
    const fontSize = isVertical ? 48 : 64;
    // Process in reverse order so insertion indices stay valid
    const boundariesToInsert = dayBoundaries.slice(1).reverse();

    for (const boundary of boundariesToInsert) {
      const { dayIndex, label } = boundary;
      const cardName = `titlecard-day${dayIndex + 1}.mp4`;
      const cardPath = path.join(outDir, cardName);

      // Generate title card video if not already present
      if (!fs.existsSync(cardPath)) {
        try {
          await execFileAsync(ffmpegPath, [
            '-f', 'lavfi',
            '-i', `color=black:s=${seqW}x${seqH}:d=2.5:r=30,format=yuv420p`,
            '-vf', `drawtext=text='${label.replace(/'/g, "\\'")}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:font=Arial`,
            '-c:v', 'libx264', '-preset', 'fast', '-an', '-y', cardPath,
          ], { timeout: 30000 });
        } catch (err) {
          console.warn(`[trip-pipeline] title card generation failed for day ${dayIndex + 1}:`, err.message);
          continue;
        }
      }

      const cardClip = {
        clipType: 'titlecard',
        path: cardPath,
        duration: 2.5,
        dayIndex,
        label,
        storedW: seqW,
        storedH: seqH,
        filledAt: 0,
      };

      // Insert the card before this day's first clip
      assembly.splice(boundary.clipIndex, 0, cardClip);
    }

    // Recompute clipIndex values in dayBoundaries after insertions
    let lastDayRecheck = -1;
    for (let ci = 0; ci < assembly.length; ci++) {
      const clip = assembly[ci];
      const di = clip.dayIndex ?? 0;
      if (di !== lastDayRecheck) {
        const boundary = dayBoundaries.find(b => b.dayIndex === di);
        if (boundary) boundary.clipIndex = ci;
        lastDayRecheck = di;
      }
    }
  }

  const captionsOpts = options.captions
    ? { enabled: true, style: options.captionStyle || 'clean' }
    : { enabled: false };
  const orientOpts = { vertical: isVertical };

  const { buildJournalVideo } = require('./journal-video');
  const videoPath = path.join(outDir, `trip${orientSlug}.mp4`);
  await buildJournalVideo(assembly, videoPath, (prog) => {
    const pct = typeof prog === 'object' ? prog.pct : prog;
    const msg = typeof prog === 'object' && prog.message ? prog.message : 'Assembling trip video…';
    update(msg, 68 + Math.round((pct / 100) * 25));
  }, musicOpts, pacingParams, captionsOpts, orientOpts);

  // ── 7. Extract thumbnail ─────────────────────────────────────────────────────
  let thumbPath = null;
  try {
    const thumbDir = path.join(os.homedir(), '.slice-of-life', 'thumb-cache');
    fs.mkdirSync(thumbDir, { recursive: true });
    const thumbFile = path.join(thumbDir, path.basename(videoPath, '.mp4') + '.jpg');
    await execFileAsync(ffmpegPath, [
      '-i', videoPath,
      '-vf', 'thumbnail=300,scale=600:-1',
      '-frames:v', '1', '-q:v', '4', '-y', thumbFile,
    ], { timeout: 30000 });
    thumbPath = thumbFile;
  } catch (e) {
    console.warn('[trip-pipeline] thumbnail extraction failed:', e.message);
  }

  // ── 8b. Probe output duration ────────────────────────────────────────────────
  let outputDurationSec = 0;
  try {
    const { probe } = require('./journal-video');
    const outInfo = await probe(videoPath);
    outputDurationSec = Math.round(outInfo.duration || 0);
  } catch {}

  // ── 9. Compute stats ─────────────────────────────────────────────────────────
  const arollCount     = assembly.filter(c => c.clipType === 'aroll').length;
  const brollCount     = assembly.filter(c => c.clipType === 'broll').length;
  const titlecardCount = assembly.filter(c => c.clipType === 'titlecard').length;
  const stats = { arollCount, brollCount, titlecardCount, totalClips: assembly.length, outputDurationSec };

  // ── 10. Save assembly sidecar for re-edit ───────────────────────────────────
  let assemblyPath = null;
  try {
    assemblyPath = videoPath.replace(/\.mp4$/, '.assembly.json');
    fs.writeFileSync(assemblyPath, JSON.stringify({
      version: 1, videoPath, assembly,
      opts: { captions: options.captions || false, captionStyle: options.captionStyle || 'clean', orientation: options.orientation || 'landscape' },
      createdAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    console.warn('[trip-pipeline] assembly sidecar write failed:', e.message);
    assemblyPath = null;
  }

  return { videoPath, outDir, dayCount, assembly, assemblyPath, thumbPath, stats, dayBoundaries, outputDurationSec };
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.slice-of-life', 'config.json'), 'utf8'));
  } catch { return {}; }
}

module.exports = { run };
