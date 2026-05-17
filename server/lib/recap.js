const fs               = require('fs');
const path             = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify }    = require('util');
const ffmpegPath       = require('ffmpeg-static');

const execFileAsync = promisify(execFile);

const PHOTO_EXTS = new Set(['.jpg','.jpeg','.png','.heic']);
const VIDEO_EXTS = new Set(['.mp4','.mov','.m4v','.avi','.mkv','.webm','.ts','.mts','.m2ts']);

const PHOTO_DUR = { slow: 8, normal: 5, fast: 2 };
const VIDEO_DUR = { slow: 10, normal: 6, fast: 3 };
const TOTAL_SEC = { '30s': 30, '1min': 60, '3min': 180, '5min': 300 };

const OUTPUT_W = 1280;
const OUTPUT_H = 720;

// ── Keyword scoring ───────────────────────────────────────────────────────────

const HIGH_VALUE = new Set(['face','faces','people','person','child','children','baby','family','crowd','group','friends','couple','wedding','bride','groom','birthday','celebration','party','laugh','laughing','smile','smiling','hug','hugging','dancing','kiss']);
const MED_VALUE  = new Set(['beach','ocean','sunset','sunrise','mountain','hiking','outdoor','nature','swimming','surfing','skiing','sports','action','playing','running','cheering','graduation','holiday','christmas','thanksgiving','travel','vacation','adventure']);
const LOW_VALUE  = new Set(['screenshot','document','whiteboard','spreadsheet','presentation','text','meme','receipt','ticket','qr','barcode','menu','sign']);

function scoreFile(filePath) {
  let score = 0;

  // Read AI sidecar scores if available
  try {
    const sidecar = JSON.parse(fs.readFileSync(filePath + '.gather.json', 'utf8'));
    // recapWorthy is the strongest signal
    if (sidecar.recapWorthy === false) return -10;
    score += (sidecar.people  ?? 0.5) * 4;   // people = highest weight
    score += (sidecar.moment  ?? 0.5) * 3;   // genuine moment
    score += (sidecar.quality ?? 0.5) * 1;   // technical quality tiebreak
  } catch {
    // No sidecar — fall back to keyword scoring
    let keywords = '';
    try { keywords = execFileSync('/usr/bin/xattr', ['-p', 'gather.keywords', filePath], { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).toLowerCase(); }
    catch {}
    for (const w of HIGH_VALUE) if (keywords.includes(w)) score += 3;
    for (const w of MED_VALUE)  if (keywords.includes(w)) score += 2;
    for (const w of LOW_VALUE)  if (keywords.includes(w)) score -= 3;
    score += Math.min(keywords.split(',').filter(Boolean).length * 0.2, 2);
  }

  return score;
}

// ── Public entry point ────────────────────────────────────────────────────────

async function generate(labeledGroups, outputBase, settings, onProgress) {
  const recapType = settings.recapType || 'mix';
  const cutSpeed  = settings.cutSpeed  || 'normal';
  const duration  = settings.duration  || '1min';
  const format    = settings.format    || 'mp4';

  const photoDur = PHOTO_DUR[cutSpeed] ?? 5;
  const videoDur = VIDEO_DUR[cutSpeed] ?? 6;
  const totalSec = TOTAL_SEC[duration] ?? 60;

  const avgDur   = recapType === 'photos' ? photoDur : recapType === 'videos' ? videoDur : (photoDur + videoDur) / 2;
  const maxClips = Math.max(1, Math.round(totalSec / avgDur));

  const selected = selectBestFiles(labeledGroups, recapType, maxClips);
  if (!selected.length) throw new Error('No media files found for recap');

  // Ensure strict chronological order regardless of selection scoring
  selected.sort((a, b) => {
    const ta = a.date instanceof Date ? a.date.getTime() : (a.date || 0);
    const tb = b.date instanceof Date ? b.date.getTime() : (b.date || 0);
    return ta - tb;
  });

  onProgress?.(10);

  // Find best moment timestamp for each video (lightweight: no disk writes)
  for (const file of selected) {
    if (file.isVideo) {
      file.startSec = await findBestMoment(file.path);
    }
  }

  onProgress?.(30);

  const mp4Out = settings.outputPath || path.join(outputBase, 'Recap.mp4');
  const xmlOut = mp4Out.replace(/\.mp4$/i, '.fcpxml');

  if (format === 'mp4' || format === 'both') {
    await buildWithFilterComplex(selected, mp4Out, photoDur, videoDur, onProgress);
  }

  if (format === 'xml' || format === 'both') {
    writeFcpxml(selected, xmlOut, { photoDur, videoDur });
  }

  onProgress?.(100);
  return { mp4: format !== 'xml' ? mp4Out : null, xml: format !== 'mp4' ? xmlOut : null };
}

// ── Single-pass ffmpeg with filter_complex (no temp files) ────────────────────

const APP_BG = '#1A0E06';

// Probe a file for rotation, color space, and audio presence.
// Mirrors journal-video.js probe() for consistent handling.
async function probeMedia(filePath) {
  try {
    const result = await execFileAsync(ffmpegPath, ['-i', filePath], { maxBuffer: 5 * 1024 * 1024 }).catch(e => e);
    const out = result.stderr || result.message || '';
    const hasAudio = /Audio:/.test(out);

    // Rotation: prefer rotate tag, then display matrix.
    // Display matrix: ffmpeg reports "rotation of X degrees" — bake the SAME
    // angle into the filter (do NOT negate, which was the old bug).
    let rotation = 0;
    const tagRot = out.match(/rotate\s*:\s*(-?\d+)/);
    const matRot = out.match(/rotation of\s*(-?[\d.]+)\s*degrees/i);
    if (tagRot) rotation = ((parseInt(tagRot[1], 10) + 360) % 360);
    else if (matRot) rotation = ((parseFloat(matRot[1]) + 360) % 360);
    rotation = Math.round(rotation / 90) * 90 % 360;

    // Frame rate for slo-mo / time-lapse detection
    const fpsM      = out.match(/Video:.*?(\d+(?:\.\d+)?)\s*fps/);
    const sourceFps = fpsM ? parseFloat(fpsM[1]) : 30;
    const isSloMo    = sourceFps >= 100;
    const isTimeLapse = sourceFps > 0 && sourceFps < 5;

    // HDR color space — HLG (arib-std-b67) or PQ (smpte2084) need tonemapping
    const colorTrcM  = out.match(/color_transfer\s*:\s*(\S+)/);
    const inlineTrcM = out.match(/yuv\d+\w*\([^)]*?(arib-std-b67|smpte2084|smpte428)[^)]*\)/i);
    const trc = colorTrcM?.[1] || inlineTrcM?.[1] || '';

    return { rotation, hasAudio, trc, isSloMo, isTimeLapse };
  } catch {
    return { rotation: 0, hasAudio: false, trc: '', isSloMo: false, isTimeLapse: false };
  }
}

// Shared output flags — explicit BT.709 signalling so players never guess.
const ENCODE_FLAGS = [
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
  '-color_range', 'tv', '-colorspace', 'bt709',
  '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
];

// Build per-clip video filter: optional HLG/PQ tonemapping + blurred background.
// Rotation is applied to ALL clips — both aroll and broll can be physically
// stored upside-down or sideways (display matrix metadata must always be honoured).
function buildClipFilter(i, info) {
  // Tonemapping for HDR sources → BT.709 SDR
  let tonemapIn = `[${i}:v]`;
  let tonemapOut = '';
  if (info.trc === 'arib-std-b67') {
    tonemapOut = `[tm${i}]`;
    tonemapIn  = `[${i}:v]zscale=tin=arib-std-b67:t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=mobius,zscale=t=bt709:m=bt709:r=tv,format=yuv420p${tonemapOut};${tonemapOut}`;
  } else if (info.trc === 'smpte2084') {
    tonemapOut = `[tm${i}]`;
    tonemapIn  = `[${i}:v]zscale=tin=smpte2084:t=linear:npl=1000,format=gbrpf32le,zscale=p=bt709,tonemap=mobius,zscale=t=bt709:m=bt709:r=tv,format=yuv420p${tonemapOut};${tonemapOut}`;
  }

  // Rotation — 180° always applied (physically upside-down); 90°/270° only for aroll
  let rotF = '';
  if (info.rotation === 180) {
    rotF = 'hflip,vflip,';
  } else if (clipType === 'aroll') {
    if (info.rotation === 270) rotF = 'transpose=2,';
    if (info.rotation === 90)  rotF = 'transpose=1,';
  }

  return [
    `${tonemapIn}${rotF}split[raw${i}a][raw${i}b]`,
    `[raw${i}a]scale=${OUTPUT_W}:${OUTPUT_H}:force_original_aspect_ratio=increase,crop=${OUTPUT_W}:${OUTPUT_H},boxblur=40:5,setsar=1[bg${i}]`,
    `[raw${i}b]scale=${OUTPUT_W}:${OUTPUT_H}:force_original_aspect_ratio=decrease,setsar=1[fg${i}]`,
    `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,fps=30[v${i}]`,
  ].join(';');
}

async function buildWithFilterComplex(selected, outPath, photoDur, videoDur, onProgress) {
  const args = [];

  // Probe all files for dimensions/rotation
  const infos = await Promise.all(selected.map(f => probeMedia(f.path)));

  // Build inputs — -noautorotate so rotation is handled by filter_complex
  for (const file of selected) {
    if (file.isVideo) {
      args.push('-noautorotate', '-ss', String(file.startSec ?? 0), '-t', String(videoDur), '-i', file.path);
    } else {
      args.push('-loop', '1', '-t', String(photoDur), '-i', file.path);
    }
  }

  // Build filter_complex
  const filterParts = [];
  for (let i = 0; i < selected.length; i++) {
    const file     = selected[i];
    const dur      = file.isVideo ? videoDur : photoDur;
    filterParts.push(buildClipFilter(i, infos[i], file.clipType || 'broll'));
    if (file.isVideo && infos[i].hasAudio) {
      filterParts.push(`[${i}:a]apad,atrim=0:${dur},asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      filterParts.push(`aevalsrc=0:c=stereo:s=48000:d=${dur}[a${i}]`);
    }
  }
  const concatInputs = selected.map((_, i) => `[v${i}][a${i}]`).join('');
  filterParts.push(`${concatInputs}concat=n=${selected.length}:v=1:a=1[outv][outa]`);

  args.push(
    '-filter_complex', filterParts.join(';'),
    '-map', '[outv]',
    '-map', '[outa]',
    ...ENCODE_FLAGS,
    '-y', outPath,
  );

  onProgress?.(40);
  await execFileAsync(ffmpegPath, args, { maxBuffer: 200 * 1024 * 1024 });
  onProgress?.(95);
}

// ── Video best-moment detection ───────────────────────────────────────────────
// Combines audio energy peaks with visual complexity to find the most
// interesting moment in a video, skipping the first 15% and last 30%.

async function getVideoDuration(videoPath) {
  try {
    const result = await execFileAsync(ffmpegPath, ['-i', videoPath], { maxBuffer: 10 * 1024 * 1024 }).catch(e => e);
    const m = (result.stderr || result.message || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  } catch {}
  return 10;
}

// Returns array of { time, rms } sorted by loudness descending.
// Uses ffmpeg astats filter to measure RMS level across short windows.
async function getAudioPeaks(videoPath, duration) {
  const windowSec = Math.max(2, Math.round(duration / 10));
  try {
    const result = await execFileAsync(ffmpegPath, [
      '-i', videoPath,
      '-af', `asetnsamples=${windowSec * 48000}:p=0,astats=metadata=1:reset=1`,
      '-f', 'null', '-',
    ], { maxBuffer: 20 * 1024 * 1024, timeout: 15000 }).catch(e => e);

    const output = result.stderr || result.message || '';
    const peaks  = [];
    const timeRe = /pts_time:([\d.]+)/g;
    const rmsRe  = /RMS level dB:([-\d.]+)/g;
    const times  = [...output.matchAll(timeRe)].map(m => parseFloat(m[1]));
    const rmses  = [...output.matchAll(rmsRe)].map(m => parseFloat(m[1]));

    for (let i = 0; i < Math.min(times.length, rmses.length); i++) {
      if (!isFinite(rmses[i])) continue;
      peaks.push({ time: times[i], rms: rmses[i] });
    }
    return peaks;
  } catch { return []; }
}

async function findBestMoment(videoPath) {
  const duration   = await getVideoDuration(videoPath);
  const clipDur    = 6; // max clip duration — ensure bestTime + clipDur stays in safe zone
  const rangeStart = duration * 0.15;
  const rangeEnd   = Math.max(rangeStart + 1, duration * 0.80 - clipDur);

  // Score each candidate window: audio energy (primary) + visual complexity (tiebreak)
  const SAMPLES = 6;
  const candidates = [];

  for (let i = 0; i < SAMPLES; i++) {
    const t = rangeStart + ((rangeEnd - rangeStart) / (SAMPLES + 1)) * (i + 1);
    candidates.push({ t, visualScore: 0, audioScore: 0 });
  }

  // Visual complexity — pipe frames to stdout, larger JPEG = more detail
  await Promise.all(candidates.map(async c => {
    try {
      const { stdout } = await execFileAsync(ffmpegPath, [
        '-ss', String(c.t), '-i', videoPath,
        '-vframes', '1', '-q:v', '8', '-vf', 'scale=160:-1',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
      ], { encoding: 'buffer', maxBuffer: 5 * 1024 * 1024 });
      c.visualScore = stdout.length;
    } catch {}
  }));

  // Audio energy — find peaks in the valid range
  const peaks = await getAudioPeaks(videoPath, duration);
  const validPeaks = peaks.filter(p => p.time >= rangeStart && p.time <= rangeEnd);

  if (validPeaks.length > 0) {
    // Normalize RMS scores (higher dB = louder = more interesting)
    const maxRms = Math.max(...validPeaks.map(p => p.rms));
    const minRms = Math.min(...validPeaks.map(p => p.rms));
    const rmsRange = maxRms - minRms || 1;

    // For each candidate, find the nearest audio peak and blend scores
    for (const c of candidates) {
      const nearest = validPeaks.reduce((best, p) =>
        Math.abs(p.time - c.t) < Math.abs(best.time - c.t) ? p : best
      );
      // Normalize audio: 0–1 scale. Weight audio 60%, visual 40%.
      c.audioScore = (nearest.rms - minRms) / rmsRange;
    }

    const maxVisual = Math.max(...candidates.map(c => c.visualScore)) || 1;
    const best = candidates.reduce((a, b) => {
      const scoreA = (a.audioScore * 0.6) + (a.visualScore / maxVisual * 0.4);
      const scoreB = (b.audioScore * 0.6) + (b.visualScore / maxVisual * 0.4);
      return scoreA >= scoreB ? a : b;
    });
    return best.t;
  }

  // No audio — fall back to visual only
  return candidates.reduce((a, b) => a.visualScore >= b.visualScore ? a : b).t;
}

// ── Smart selection: coverage + quality ───────────────────────────────────────

function selectBestFiles(labeledGroups, recapType, maxClips) {
  // Collect all eligible candidates, grouped by their immediate parent subfolder
  const byFolder = new Map();

  for (const group of labeledGroups) {
    if (group.misc) continue;
    for (const file of (group.files || [])) {
      const ext = path.extname(file.path).toLowerCase();
      const isPhoto = PHOTO_EXTS.has(ext);
      const isVideo = VIDEO_EXTS.has(ext);
      if (!isPhoto && !isVideo) continue;
      if (recapType === 'photos' && !isPhoto) continue;
      if (recapType === 'videos' && !isVideo) continue;

      // Only include files that have a Gather sidecar (processed by Gather)
      if (!fs.existsSync(file.path + '.gather.json')) continue;

      const folder = path.dirname(file.path);
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push({
        path:    file.path,
        date:    file.date || group.startDate,
        isVideo,
        score:   scoreFile(file.path),
      });
    }
  }

  if (!byFolder.size) return [];

  // Deduplicate near-identical files within each folder
  // (burst shots / duplicates within 3 seconds of each other — keep best score)
  for (const [folder, files] of byFolder) {
    files.sort((a, b) => {
      const ta = a.date instanceof Date ? a.date.getTime() : 0;
      const tb = b.date instanceof Date ? b.date.getTime() : 0;
      return ta - tb;
    });
    const deduped = [];
    for (const f of files) {
      const prev = deduped[deduped.length - 1];
      const tA = prev?.date instanceof Date ? prev.date.getTime() : null;
      const tB = f.date instanceof Date ? f.date.getTime() : null;
      if (prev && tA !== null && tB !== null && Math.abs(tB - tA) < 3000) {
        // Keep whichever scores higher
        if (f.score > prev.score) deduped[deduped.length - 1] = f;
      } else {
        deduped.push(f);
      }
    }
    byFolder.set(folder, deduped);
  }

  // Proportional allocation across subfolders — min 1 per folder, cap at maxClips
  const folders = [...byFolder.entries()];
  const totalFiles = folders.reduce((s, [, f]) => s + f.length, 0);
  const allocs = folders.map(([folder, files]) => ({
    files,
    slots: Math.max(1, Math.round((files.length / totalFiles) * maxClips)),
  }));

  // Trim back to maxClips by shrinking the largest allocations first
  let totalSlots = allocs.reduce((s, a) => s + a.slots, 0);
  while (totalSlots > maxClips) {
    allocs.reduce((a, b) => b.slots > a.slots ? b : a).slots--;
    totalSlots--;
  }

  // Pick top-scored clips from each folder
  const selected = [];
  for (const alloc of allocs) {
    const top = [...alloc.files].sort((a, b) => b.score - a.score).slice(0, alloc.slots);
    selected.push(...top);
  }

  // Final sort: chronological
  selected.sort((a, b) => {
    const ta = a.date instanceof Date ? a.date.getTime() : (a.date || 0);
    const tb = b.date instanceof Date ? b.date.getTime() : (b.date || 0);
    return ta - tb;
  });
  return selected;
}

// ── FCPXML export ─────────────────────────────────────────────────────────────

function writeFcpxml(files, outPath, { photoDur, videoDur }) {
  const fps = 30;
  let offset = 0;
  const clips = files.map(f => {
    const dur    = f.isVideo ? videoDur : photoDur;
    const frames = Math.round(dur * fps);
    const clip   = `      <asset-clip name="${path.basename(f.path)}" offset="${offset}/${fps}s" duration="${frames}/${fps}s" start="0s"/>`;
    offset += frames;
    return clip;
  }).join('\n');

  fs.writeFileSync(outPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
${files.map((f, i) => `    <asset id="r${i+1}" name="${path.basename(f.path)}" src="file://${f.path}" hasVideo="1" hasAudio="${f.isVideo ? '1' : '0'}"/>`).join('\n')}
  </resources>
  <library>
    <event name="Slice of Life Recap">
      <project name="Recap">
        <sequence duration="${offset}/${fps}s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`);
}

module.exports = { generate };
