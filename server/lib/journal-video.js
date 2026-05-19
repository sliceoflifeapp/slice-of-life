const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const ffmpegPath    = require('ffmpeg-static');
const { snapDuration } = require('./beats');

const execFileAsync = promisify(execFile);

// Fallback — overridden at runtime by detectOutputResolution()
const OUTPUT_W  = 1920;
const OUTPUT_H  = 1080;

// Standard landscape resolutions we snap to (width × height).
const STANDARD_RESOLUTIONS = [
  { w: 3840, h: 2160 }, // 4K UHD
  { w: 2560, h: 1440 }, // 2K / 1440p
  { w: 1920, h: 1080 }, // 1080p  ← default
  { w: 1280, h:  720 }, // 720p
];

// Pick the most common clip resolution, snap to nearest standard,
// and return { w, h }. Falls back to 1080p if clips can't be read.
function detectOutputResolution(probed) {
  const tally = new Map();
  for (const info of probed) {
    // After rotation correction, portrait clips swap w/h — use the
    // larger dimension as width so we always get a landscape bucket.
    const w = Math.max(info.storedW || 0, info.storedH || 0);
    const h = Math.min(info.storedW || 0, info.storedH || 0);
    if (w < 640 || h < 360) continue; // skip thumbnails / bad probes
    const key = `${w}x${h}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }

  if (!tally.size) return { w: 1920, h: 1080 };

  // Most common raw resolution
  const [topKey] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const [rawW, rawH] = topKey.split('x').map(Number);

  // Snap to nearest standard by width
  const snapped = STANDARD_RESOLUTIONS.reduce((best, r) =>
    Math.abs(r.w - rawW) < Math.abs(best.w - rawW) ? r : best
  );

  console.log(`[resolution] clips: ${[...tally.entries()].map(([k,v])=>`${k}×${v}`).join(', ')} → snapped to ${snapped.w}×${snapped.h}`);
  return snapped;
}
const FACE_DUR_DEFAULT  = 4;    // seconds of face cam before cutting to b-roll
const BROLL_CUT_DEFAULT = 7;    // seconds per b-roll cutaway during narration

// ── Probe ────────────────────────────────────────────────────────────────────

async function probe(filePath) {
  try {
    const r = await execFileAsync(ffmpegPath, ['-i', filePath], { maxBuffer: 5 * 1024 * 1024 }).catch(e => e);
    const out = r.stderr || r.message || '';

    const hasAudio = /Audio:/.test(out);
    const durM     = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const duration = durM
      ? parseInt(durM[1]) * 3600 + parseInt(durM[2]) * 60 + parseFloat(durM[3])
      : 0;

    // Stored pixel dimensions (before any rotation correction).
    // Match the Video: stream line to avoid false positives from other numbers.
    const dimM  = out.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
    const storedW = dimM ? parseInt(dimM[1], 10) : 0;
    const storedH = dimM ? parseInt(dimM[2], 10) : 0;

    // Rotation metadata — two sources:
    //   rotate tag  : "rotate : 90"  → device was rotated 90° CW from native landscape
    //                  apply same angle CW to correct → transpose=1
    //   display matrix: "rotation of -90 degrees" → ffmpeg reports the angle the
    //                  player applies to stored pixels to show them upright.
    //                  We bake that same angle into the filter (do NOT negate).
    //                  e.g. -90° → CCW 90° (stored as 270°) → transpose=2
    //                       -180° → 180° flip
    // Only narration (face-cam) clips use this correction — b-roll clips are
    // already landscape-correct in their stored pixels regardless of metadata.
    const tagRot = out.match(/rotate\s*:\s*(-?\d+)/);
    const matRot = out.match(/rotation of\s*(-?[\d.]+)\s*degrees/i);
    let rotation = 0;
    let rotFromTag = false; // true = came from 'rotate' metadata tag; false = display matrix only
    if (tagRot) {
      // 'rotate' tag: stored pixels need this many degrees CW to display correctly.
      rotation   = ((parseInt(tagRot[1], 10) + 360) % 360);
      rotFromTag = true;
    } else if (matRot) {
      // Display matrix: ffmpeg reports the angle the PLAYER applies to stored pixels.
      // To bake that correction into the filter we negate: -90° display → apply CW 90°.
      rotation   = ((-parseFloat(matRot[1]) + 360) % 360);
      rotFromTag = false;
    }
    // Snap to nearest 90° — fractional values are metadata noise
    rotation = Math.round(rotation / 90) * 90 % 360;

    // Creation time — use macOS Spotlight (most accurate for iPhone clips)
    let creationTime = null;
    try {
      const mdls = execFileSync('mdls', ['-name', 'kMDItemContentCreationDate', '-raw', filePath], { timeout: 3000 }).toString().trim();
      if (mdls && mdls !== '(null)') {
        const d = new Date(mdls);
        if (!isNaN(d.getTime()) && d.getFullYear() > 2000) creationTime = d;
      }
    } catch {}

    // Fall back to embedded creation_time from ffmpeg
    if (!creationTime) {
      const ctM = out.match(/creation_time\s*:\s*(\S+)/);
      if (ctM) {
        const d = new Date(ctM[1]);
        if (!isNaN(d.getTime()) && d.getFullYear() > 2000) creationTime = d;
      }
    }

    // Frame rate — used to detect slow-motion (≥120fps) and time-lapse (<5fps).
    // iPhone slo-mo records at 120/240fps; time-lapses are very low fps.
    // Both are purely b-roll: no speech, no rotation correction needed.
    const fpsM     = out.match(/Video:.*?(\d+(?:\.\d+)?)\s*fps/);
    const sourceFps = fpsM ? parseFloat(fpsM[1]) : 30;
    const isSloMo    = sourceFps >= 100;
    const isTimeLapse = sourceFps > 0 && sourceFps < 5 && duration > 0;
    if (isSloMo || isTimeLapse) {
      console.log(`[probe] ${path.basename(filePath)}: ${isSloMo ? `slo-mo (${sourceFps}fps)` : `time-lapse (${sourceFps}fps)`}`);
    }

    // Color space — detect HDR transfer function from either:
    //   a) standalone metadata line: "color_transfer : arib-std-b67"
    //   b) inline codec format string: "yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67)"
    // HLG = arib-std-b67, PQ = smpte2084. Only these need tonemapping.
    const colorTrcM = out.match(/color_transfer\s*:\s*(\S+)/);
    const inlineTrcM = out.match(/yuv\d+\w*\([^)]*?(arib-std-b67|smpte2084|smpte428)[^)]*\)/i);
    const trc = colorTrcM?.[1] || inlineTrcM?.[1] || '';
    const needsColorConversion = ['arib-std-b67', 'smpte2084', 'smpte428'].includes(trc);

    if (rotation !== 0) {
      const src = path.basename(filePath);
      console.log(`[probe] ${src}: stored=${storedW}x${storedH} rotation=${rotation}° (tag=${tagRot?.[1] ?? 'none'} matrix=${matRot?.[1] ?? 'none'})`);
    }

    return { rotation, rotFromTag, storedW, storedH, hasAudio, duration, creationTime, needsColorConversion, trc, sourceFps, isSloMo, isTimeLapse };
  } catch {
    return { rotation: 0, storedW: 0, storedH: 0, hasAudio: false, duration: 0, creationTime: null, needsColorConversion: false, trc: '', sourceFps: 30, isSloMo: false, isTimeLapse: false };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Low-level: rotation angle → ffmpeg filter fragment (leading comma, or empty).
// Always pair with -noautorotate on the input — filter_complex never auto-rotates.
function rotFrag(rotation) {
  if (rotation === 270) return ',transpose=2';  // CCW 90°
  if (rotation === 90)  return ',transpose=1';  // CW 90°
  if (rotation === 180) return ',hflip,vflip';
  return '';
}

// High-level: returns the rotation filter fragment for a clip.
//
// Rules:
//   aroll: Vision suggestedRotation if available, else metadata tag.
//
//   broll with face visible (hasFace=true): Vision suggestedRotation if
//     available, else metadata tag. Faces have an unambiguous up/down
//     orientation so Vision is trustworthy.
//
//   broll without face (hasFace=false): metadata tag only for rotate-TAG
//     clips; no rotation for display-matrix clips. Vision is NOT trusted —
//     object-only content is orientation-ambiguous and Vision often guesses
//     wrong, overriding correct metadata.
function clipRotFrag(info, clipType, suggestedRotation, hasFace, src) {
  const tag = require('path').basename(src || '');
  if (clipType === 'aroll') {
    if (suggestedRotation != null) {
      console.log(`[rot] ${tag}: aroll → Vision ${suggestedRotation}°`);
      return rotFrag(suggestedRotation);
    }
    console.log(`[rot] ${tag}: aroll → metadata ${info.rotation}°`);
    return rotFrag(info.rotation);
  }
  // B-roll: only trust Vision when a person is visible
  if (suggestedRotation != null && hasFace) {
    console.log(`[rot] ${tag}: broll → Vision ${suggestedRotation}° (hasFace=true)`);
    return rotFrag(suggestedRotation);
  }
  if (info.rotFromTag) {
    if (suggestedRotation != null)
      console.log(`[rot] ${tag}: broll/tag → metadata ${info.rotation}° (Vision ignored, hasFace=false)`);
    else
      console.log(`[rot] ${tag}: broll/tag → metadata ${info.rotation}°`);
    return rotFrag(info.rotation);
  }
  // Display matrix only — skip rotation
  if (suggestedRotation != null)
    console.log(`[rot] ${tag}: broll/matrix → skip (Vision ignored, hasFace=false)`);
  else
    console.log(`[rot] ${tag}: broll/matrix → skip`);
  return '';
}

// Blurred-background + centred letterbox/pillarbox.
// inputLabel e.g. '[src]', outputLabel e.g. '[v0]', prefix must be unique.
// trc: the source clip's color_transfer string from probe (e.g. 'arib-std-b67').
// If it's HLG or PQ, a proper zscale tonemap converts to BT.709 SDR so the
// player doesn't apply HDR rendering and oversaturate the clip.
//
// isVertical + clipIsLandscape: landscape clip going into 9:16 frame.
// Strategy: scale to fill the full width (1080px), center-crop to 9:16 height,
// then place the blurred version behind it so the top/bottom slivers are filled
// with a soft blur rather than hard black bars.
function bgFilter(inputLabel, outputLabel, prefix, trc = '', outW = OUTPUT_W, outH = OUTPUT_H, clipIsLandscape = false) {
  const isVertical = outW < outH; // 9:16 when outW=1080, outH=1920

  let tonemap = inputLabel;
  if (trc === 'arib-std-b67') {
    tonemap = `${inputLabel}zscale=tin=arib-std-b67:t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p[${prefix}tm];[${prefix}tm]`;
  } else if (trc === 'smpte2084') {
    tonemap = `${inputLabel}zscale=tin=smpte2084:t=linear:npl=1000,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p[${prefix}tm];[${prefix}tm]`;
  }

  if (isVertical && clipIsLandscape) {
    // Landscape clip → 9:16 frame:
    // bg: scale+crop to fill full canvas, blur heavily — fills top+bottom bars
    // fg: scale to 900px tall (47% of 1920), crop sides to outW — zoomed center crop
    //     gives a noticeably larger image than fitting to width (~608px tall)
    const fgH = 900;
    return [
      `${tonemap}split[${prefix}a][${prefix}b]`,
      `[${prefix}a]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},boxblur=50:6,setsar=1[${prefix}bg]`,
      `[${prefix}b]scale=-2:${fgH},crop=${outW}:${fgH},setsar=1[${prefix}fg]`,
      `[${prefix}bg][${prefix}fg]overlay=(W-w)/2:(H-h)/2,fps=30${outputLabel}`,
    ].join(';');
  }

  // Standard: blurred bg fills frame, fg fits inside with letterbox/pillarbox
  return [
    `${tonemap}split[${prefix}a][${prefix}b]`,
    `[${prefix}a]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},boxblur=40:5,setsar=1[${prefix}bg]`,
    `[${prefix}b]scale=${outW}:${outH}:force_original_aspect_ratio=decrease,setsar=1[${prefix}fg]`,
    `[${prefix}bg][${prefix}fg]overlay=(W-w)/2:(H-h)/2,fps=30${outputLabel}`,
  ].join(';');
}

// Music ducking volume expression
function buildMusicVolumeExpr(arollSegs) {
  if (!arollSegs.length) return '0.28';
  const DUCK = 0.07, FULL = 0.28, RAMP = 0.4;
  let expr = String(FULL);
  for (let k = arollSegs.length - 1; k >= 0; k--) {
    const { start, end } = arollSegs[k];
    const lerp = (a, b, f) => `(${a}+(${b}-${a})*${f})`;
    expr =
      `if(between(t,${start.toFixed(3)},${(start+RAMP).toFixed(3)}),${lerp(FULL,DUCK,`(t-${start.toFixed(3)})/${RAMP}`)},` +
      `if(between(t,${(start+RAMP).toFixed(3)},${(end-RAMP).toFixed(3)}),${DUCK},` +
      `if(between(t,${(end-RAMP).toFixed(3)},${end.toFixed(3)}),${lerp(DUCK,FULL,`(t-${(end-RAMP).toFixed(3)})/${RAMP}`)},` +
      `${expr})))`;
  }
  return expr;
}

// Detect VideoToolbox availability once at startup.
// h264_videotoolbox uses Apple Silicon media engine — keeps fan quiet, 3-5× faster.
// Falls back to libx264 if not available (non-Mac or older ffmpeg builds).
function detectVideoToolbox() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(ffmpegPath, ['-encoders'], { encoding: 'utf8', timeout: 5000 });
    return out.includes('h264_videotoolbox');
  } catch { return false; }
}
const USE_VIDEOTOOLBOX = detectVideoToolbox();
console.log(`[encode] using ${USE_VIDEOTOOLBOX ? 'h264_videotoolbox (hardware)' : 'libx264 (software)'}`);

// Shared output encoding flags.
// All pixel data at this point is genuinely BT.709 SDR:
//   - regular iPhone clips: already bt709
//   - HLG/PQ clips: tonemapped to bt709 by bgFilter's zscale chain before encoding
// So we explicitly signal bt709 limited-range in the H.264 SPS/VUI so players
// (QuickTime, VLC) never guess and over-expand or mis-interpret the range.
//
// VideoToolbox bitrate scales with pixel count so quality is consistent across
// resolutions. Uses total pixels so vertical (1080×1920) matches 1080p correctly.
function vtbBitrate(w, h) {
  const px = w * h;
  if (px <= 1280 * 720)   return '8000k';   // 720p
  if (px <= 1920 * 1080)  return '16000k';  // 1080p / vertical 1080×1920
  if (px <= 2560 * 1440)  return '25000k';  // 1440p
  return '40000k';                           // 4K
}

function encodeFlags(w = OUTPUT_W, h = OUTPUT_H) {
  return [
    ...(USE_VIDEOTOOLBOX
      ? ['-c:v', 'h264_videotoolbox', '-b:v', vtbBitrate(w, h), '-realtime', 'false']
      : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']),
    '-r', '30',           // force constant 30fps — prevents freeze at VFR section boundaries
    '-color_range', 'tv',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-max_muxing_queue_size', '9999',
  ];
}

// ── Caption style definitions ─────────────────────────────────────────────────
// forceStyle: SRT force_style string passed to ffmpeg subtitles filter.
// uppercase:  if true, SRT text is uppercased before burn-in (needed for
//             display fonts like Bebas Neue that have no lowercase glyphs).
// Colors use ASS &HAABBGGRR format: AA=alpha (00=opaque, FF=transparent).
const CAPTION_STYLES = {
  // Montserrat — clean white, no decoration
  clean: {
    forceStyle: [
      'FontName=Montserrat', 'FontSize=26', 'Bold=0',
      'PrimaryColour=&H00FFFFFF',
      'BorderStyle=1', 'Outline=0', 'Shadow=0',
      'Alignment=2', 'MarginV=44',
    ].join(','),
    uppercase: false,
  },

  // Bebas Neue — condensed display
  bebas: {
    forceStyle: [
      'FontName=Bebas Neue', 'FontSize=36', 'Bold=0',
      'PrimaryColour=&H00FFFFFF',
      'BorderStyle=1', 'Outline=0', 'Shadow=0',
      'Alignment=2', 'MarginV=44',
    ].join(','),
    uppercase: true,
  },

  // Big Shoulders Stencil — condensed stencil, uppercase
  bigshoulders: {
    forceStyle: [
      'FontName=Big Shoulders Stencil', 'FontSize=30', 'Bold=1',
      'PrimaryColour=&H00FFFFFF',
      'BorderStyle=1', 'Outline=0', 'Shadow=0',
      'Alignment=2', 'MarginV=44',
    ].join(','),
    uppercase: true,
  },

  // Dancing Script — script has lower x-height so slightly larger
  dancing: {
    forceStyle: [
      'FontName=Dancing Script', 'FontSize=30', 'Bold=0',
      'PrimaryColour=&H00FFFFFF',
      'BorderStyle=1', 'Outline=0', 'Shadow=0',
      'Alignment=2', 'MarginV=44',
    ].join(','),
    uppercase: false,
  },

  // Orbitron — very wide font, kept smaller to avoid line wrapping
  orbitron: {
    forceStyle: [
      'FontName=Orbitron', 'FontSize=20', 'Bold=1',
      'PrimaryColour=&H00FFFFFF',
      'BorderStyle=1', 'Outline=0', 'Shadow=0',
      'Alignment=2', 'MarginV=44',
    ].join(','),
    uppercase: true,
  },

  // Permanent Marker — hand-lettered
  marker: {
    forceStyle: [
      'FontName=Permanent Marker', 'FontSize=28', 'Bold=0',
      'PrimaryColour=&H00FFFFFF',
      'BorderStyle=1', 'Outline=0', 'Shadow=0',
      'Alignment=2', 'MarginV=44',
    ].join(','),
    uppercase: false,
  },

  // Playwrite GB S — formal cursive
  playwrite: {
    forceStyle: [
      'FontName=Playwrite GB S', 'FontSize=26', 'Bold=0',
      'PrimaryColour=&H00FFFFFF',
      'BorderStyle=1', 'Outline=0', 'Shadow=0',
      'Alignment=2', 'MarginV=44',
    ].join(','),
    uppercase: false,
  },

  // Sekuya — decorative display
  sekuya: {
    forceStyle: [
      'FontName=Sekuya', 'FontSize=17', 'Bold=0',
      'PrimaryColour=&H00FFFFFF',
      'BorderStyle=1', 'Outline=0', 'Shadow=0',
      'Alignment=2', 'MarginV=44',
    ].join(','),
    uppercase: false,
  },
};

// ── SRT / caption helpers ─────────────────────────────────────────────────────

function srtTime(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  const p2 = n => String(n).padStart(2, '0');
  const p3 = n => String(n).padStart(3, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${p3(ms)}`;
}

// Split a segment's text into chunks of at most maxWords words,
// distributing the segment's duration evenly across chunks.
function chunkSegment(text, startSec, endSec, maxWords = 5) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return [{ text, start: startSec, end: endSec }];

  const dur      = endSec - startSec;
  const chunks   = [];
  let   wordPos  = 0;

  while (wordPos < words.length) {
    const slice     = words.slice(wordPos, wordPos + maxWords);
    const chunkFrac = slice.length / words.length;
    const chunkStart = startSec + (wordPos / words.length) * dur;
    const chunkEnd   = chunkStart + chunkFrac * dur;
    chunks.push({ text: slice.join(' '), start: chunkStart, end: chunkEnd });
    wordPos += maxWords;
  }
  return chunks;
}

// ASS timestamp format: H:MM:SS.cc (centiseconds)
function assTime(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const cs = Math.round((sec % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

// Build an ASS subtitle file with two render layers per caption:
//   Layer 0 — blurred dark shadow, offset 1px right / 2px down
//   Layer 1 — sharp white text on top
// This gives a soft drop shadow without blurring the text itself.
function generateAss(sections) {
  const CX = 960;   // horizontal center of 1920px frame
  const CY = 1046;  // 1080 - 32 (margin) - small baseline offset
  const DX = 1;     // shadow x offset
  const DY = 1;     // shadow y offset (tight)

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Main — white, bold, thin white outline for thickness, no blur
    'Style: Main,Montserrat,20,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00000000,1,0,0,0,100,100,0,0,1,1,0,2,20,20,32,1',
    // Shad — semi-transparent black, same weight, no outline
    'Style: Shad,Montserrat,20,&H55000000,&H55000000,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,2,20,20,32,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const lines = [header];

  for (const { clip, timelineStart } of sections) {
    const segments  = clip.transcript?.segments || [];
    const trimStart = clip.trimStart ?? 0;
    const trimEnd   = clip.trimEnd   ?? clip.duration ?? 999;
    const timed = segments.filter(s => s.end > 0 && s.start < trimEnd && s.end > trimStart);

    for (const seg of timed) {
      const outStart = timelineStart + Math.max(0, seg.start - trimStart);
      const outEnd   = timelineStart + Math.min(trimEnd - trimStart, seg.end - trimStart);
      if (outEnd <= outStart + 0.05) continue;

      const text = seg.text.replace(/\[.*?\]|\(.*?\)/g, '').trim();
      if (!text) continue;

      for (const chunk of chunkSegment(text, outStart, outEnd, 5)) {
        const t0 = assTime(chunk.start);
        const t1 = assTime(chunk.end);
        const escaped = chunk.text.replace(/\{/g, '{\\').replace(/\}/g, '\\}');
        // Shadow layer (blurred, offset)
        lines.push(`Dialogue: 0,${t0},${t1},Shad,,0,0,0,,{\\an2\\blur2\\pos(${CX + DX},${CY + DY})}${escaped}`);
        // Main text layer (sharp)
        lines.push(`Dialogue: 1,${t0},${t1},Main,,0,0,0,,{\\an2\\pos(${CX},${CY})}${escaped}`);
      }
    }
  }

  return lines.join('\n');
}

// Build a merged SRT from an ordered list of { clip, timelineStart } objects.
// clip must have transcript.segments (from Whisper JSON) + trimStart / trimEnd.
function generateSrt(sections) {
  let idx = 1;
  const entries = [];

  for (const { clip, timelineStart } of sections) {
    const segments  = clip.transcript?.segments || [];
    const trimStart = clip.trimStart ?? 0;
    const trimEnd   = clip.trimEnd   ?? clip.duration ?? 999;
    // Only keep segments that have real timing and fall within the trimmed window
    const timed = segments.filter(s => s.end > 0 && s.start < trimEnd && s.end > trimStart);

    for (const seg of timed) {
      const outStart = timelineStart + Math.max(0, seg.start - trimStart);
      const outEnd   = timelineStart + Math.min(trimEnd - trimStart, seg.end - trimStart);
      if (outEnd <= outStart + 0.05) continue; // skip sub-50ms ghosts

      // Strip Whisper noise tokens like [BLANK_AUDIO], [Music], (inaudible)
      const text = seg.text.replace(/\[.*?\]|\(.*?\)/g, '').trim();
      if (!text) continue;

      // Break long segments into short caption chunks (~5 words each)
      for (const chunk of chunkSegment(text, outStart, outEnd, 5)) {
        entries.push(`${idx}\n${srtTime(chunk.start)} --> ${srtTime(chunk.end)}\n${chunk.text}\n`);
        idx++;
      }
    }
  }

  return entries.join('\n');
}

// Escape a file path for use inside an ffmpeg filter string.
// ffmpeg filter values use ':' as separator and '\' as escape — both need escaping.
// Wrapping in single quotes handles spaces; internal single quotes need escaping too.
function escapeFilterPath(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// ── Main entry ───────────────────────────────────────────────────────────────

async function buildJournalVideo(assembly, outPath, onProgress, musicOpts, pacingParams, captionsOpts, orientOpts) {
  if (!assembly.length) throw new Error('No clips to assemble');
  onProgress?.(5);

  const FACE_DUR   = pacingParams?.faceDur  ?? FACE_DUR_DEFAULT;
  const BROLL_CUT  = pacingParams?.brollCut ?? BROLL_CUT_DEFAULT;
  const isVertical = orientOpts?.vertical === true;

  // Detect output resolution from the clips themselves.
  // For vertical output, override to 1080×1920 regardless of clip resolution.
  const allInfos = await Promise.all(assembly.map(c => probe(c.path)));
  const { w: detW, h: detH } = detectOutputResolution(allInfos);
  const outW = isVertical ? 1080 : detW;
  const outH = isVertical ? 1920 : detH;

  // Surface the detected resolution to the UI via the progress callback
  onProgress?.({ pct: 8, message: 'Analysing clips…', detectedResolution: `${outW}×${outH}` });

  const hasAroll    = assembly.some(c => c.clipType === 'aroll');
  const hasBroll    = assembly.some(c => c.clipType === 'broll');
  const hasTitlecard = assembly.some(c => c.clipType === 'titlecard');

  // When title cards are present, preserve assembly order (sequential) so the
  // cards appear at the correct day boundaries rather than being reordered by
  // the timestamp-based interleaving logic in buildInterleaved.
  if (hasAroll && hasBroll && !hasTitlecard) {
    return buildInterleaved(assembly, outPath, onProgress, musicOpts, FACE_DUR, BROLL_CUT, captionsOpts, outW, outH, isVertical);
  }
  return buildSequential(assembly, outPath, onProgress, musicOpts, BROLL_CUT, outW, outH, isVertical);
}

// ── Two-pass interleaved: real broll cutaways over narration audio ────────────
//
// Pass 1 — per section: small filter_complex renders each narration section to
//   a temp .mp4 with video switching face→broll→face while narration audio runs
//   continuously underneath. Overflow broll rendered as separate ambient clips.
// Pass 2 — concat demuxer: a plain text list joins all temp files into the
//   final output. Optional music is mixed in at this stage.
//
// Keeping each section's filter small (2–5 inputs) avoids the SIGKILL that
// killed the old single-giant-filter approach.

// Returns true if the clip's display pixels are wider than tall — i.e. it is
// landscape content. Used to decide whether bgFilter needs blur bars.
// Accepts an optional suggestedRotation from Vision; falls back to probe metadata.
function clipIsLandscapeForVertical(info, suggestedRotation, clipType) {
  const { storedW = 0, storedH = 0, rotation = 0, rotFromTag = false } = info;
  // Broll with display matrix: no rotation applied, use stored dimensions directly.
  if (clipType === 'broll' && !rotFromTag) return storedW > storedH;
  const effectiveRot = suggestedRotation ?? rotation;
  const displayW = (effectiveRot === 90 || effectiveRot === 270) ? storedH : storedW;
  const displayH = (effectiveRot === 90 || effectiveRot === 270) ? storedW : storedH;
  return displayW > displayH;
}

async function buildInterleaved(assembly, outPath, onProgress, musicOpts, FACE_DUR, BROLL_CUT, captionsOpts, outW = OUTPUT_W, outH = OUTPUT_H, isVertical = false) {
  const arollClips = assembly.filter(c => c.clipType === 'aroll');
  const brollClips = assembly.filter(c => c.clipType === 'broll');

  // Vision-supplied rotation per clip path — used in clipRotFrag as ground truth.
  // For broll with display matrix only: trust Vision rotation only if a person is
  // visible (orientation is unambiguous). Object-only content (cameras, tables, etc.)
  // can look correct upside-down so we skip rotation for those.
  const rotByPath = new Map();
  const faceByPath = new Map();
  for (const clip of assembly) {
    const hasFace = !!(clip.vision?.hasFace || clip.vision?.isTalkingHead ||
                       clip.vision?.contentTags?.includes('people'));
    faceByPath.set(clip.path, hasFace);
    const rot = clip.vision?.suggestedRotation ?? clip.suggestedRotation;
    if (rot != null) rotByPath.set(clip.path, rot);
  }

  if (arollClips.length === 0) return buildSequential(assembly, outPath, onProgress, musicOpts, BROLL_CUT, outW, outH, isVertical);

  // ── Match each broll clip to its nearest narration clip by timestamp ────────
  const sectionMap = arollClips.map(aroll => ({ aroll, brolls: [] }));

  for (const br of brollClips) {
    const brTime = br.filledAt || 0;
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < arollClips.length; i++) {
      const dist = Math.abs((arollClips[i].filledAt || 0) - brTime);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    sectionMap[bestIdx].brolls.push(br);
  }
  for (const sec of sectionMap) {
    sec.brolls.sort((a, b) => (a.filledAt || 0) - (b.filledAt || 0));
  }

  // ── Slot budget per narration section ────────────────────────────────────
  // slots = how many face→broll cycles fit during narration (= cutaway count)
  // overflow cap = same number of extra broll clips play AFTER narration ends
  // This keeps each section's total broll count at most 2× its slot count.
  const slotsPerAroll = arollClips.map(c => {
    const dur = c.duration || 0;
    return Math.max(1, Math.floor(Math.max(0, dur - FACE_DUR) / (FACE_DUR + BROLL_CUT)) + 1);
  });

  // ── Quality scoring: abundance mode ──────────────────────────────────────
  // If any section has far more b-roll than it needs, score clips and keep
  // the best ones. Timestamp order is always preserved after filtering.
  // Threshold: a section must have > 2× its slot count to trigger scoring.
  const needsScoring = sectionMap.some((sec, i) => sec.brolls.length > slotsPerAroll[i] * 2);
  if (needsScoring) {
    // Use brollScore already set by clip-vision pass in the pipeline
    for (let i = 0; i < sectionMap.length; i++) {
      const sec   = sectionMap[i];
      const limit = slotsPerAroll[i] * 2;
      if (sec.brolls.length > limit) {
        const ranked = [...sec.brolls].sort((a, b) =>
          (b.brollScore ?? 50) - (a.brollScore ?? 50)
        );
        const topPaths = new Set(ranked.slice(0, limit).map(c => c.path));
        sec.brolls = sec.brolls.filter(c => topPaths.has(c.path));
      }
    }
  }

  // Apply overflow cap
  for (let i = 0; i < sectionMap.length; i++) {
    const maxTotal = slotsPerAroll[i] * 2;
    sectionMap[i].brolls = sectionMap[i].brolls.slice(0, maxTotal);
  }

  console.log('[interleaved] slot distribution:');
  sectionMap.forEach((sec, i) => {
    const cut = sec.brolls.slice(0, slotsPerAroll[i]);
    const ovf = sec.brolls.slice(slotsPerAroll[i]);
    console.log(`  ${path.basename(sec.aroll.path)} (${sec.aroll.duration?.toFixed(1)}s, ${slotsPerAroll[i]} slots): cutaways=[${cut.map(b => path.basename(b.path)).join(', ') || 'none'}]${ovf.length ? ` overflow=[${ovf.map(b => path.basename(b.path)).join(', ')}]` : ''}`);
  });

  // ── Probe all clips upfront ───────────────────────────────────────────────
  const allClips = [...arollClips, ...brollClips];
  const allInfos = await Promise.all(allClips.map(c => probe(c.path)));
  const infoByPath = new Map(allClips.map((c, i) => [c.path, allInfos[i]]));
  onProgress?.(15);

  // ── Pass 1: render each section to temp files (concurrent, limit=3) ──────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yl-'));

  // Helper: render a single narration section. Returns { narrFile, narrDur, overflowFiles } or null on failure.
  async function renderSection(i) {
    const { aroll, brolls } = sectionMap[i];
    const cutaways = brolls.slice(0, slotsPerAroll[i]);
    const overflow  = brolls.slice(slotsPerAroll[i]);
    const narrInfo  = infoByPath.get(aroll.path);

    // Use Whisper trim bounds if available — removes dead air at start/end of narration
    const narrTrimStart = aroll.trimStart ?? 0;
    const narrTrimEnd   = Math.min(
      aroll.duration || narrInfo.duration || 30,
      aroll.trimEnd  ?? (aroll.duration || narrInfo.duration || 30)
    );
    // Round to nearest frame boundary (1/30s) so trim, duration directives,
    // and the 30fps encoder all agree — prevents sub-frame gaps that cause
    // the last frame to be held/repeated at section boundaries.
    const narrDur = Math.round(Math.max(1, narrTrimEnd - narrTrimStart) * 30) / 30;

    // ── Build video segment list ─────────────────────────────────────────
    const segs = [];
    let pos = 0;
    const brollQ = [...cutaways];
    const isFirst = false; // fade-in disabled

    // Minimum durations — clips shorter than these feel jarring as cuts.
    const MIN_FACE_SEG  = 1.5; // don't show face for less than 1.5s
    const MIN_BROLL_SEG = 2.0; // don't cut to broll for less than 2s

    while (pos < narrDur) {
      const remaining  = narrDur - pos;
      const faceEnd    = Math.min(pos + FACE_DUR, narrDur);
      const faceDur    = faceEnd - pos;

      segs.push({
        clip: aroll,
        path: aroll.path,
        startInSrc: narrTrimStart + pos,
        dur: faceDur,
        fadeIn: isFirst && pos === 0,
      });
      pos = faceEnd;

      if (pos < narrDur && brollQ.length > 0) {
        // Always reserve MIN_FACE_SEG at the end so the section never ends on
        // broll (broll clips can run short of their container duration, causing
        // the encoder to freeze on the last frame while audio finishes).
        const brollMax   = narrDur - MIN_FACE_SEG;
        const brollAvail = brollMax - pos; // how much room for broll before face close-out

        if (brollAvail >= MIN_BROLL_SEG) {
          const br        = brollQ.shift();
          const brClipDur = infoByPath.get(br.path)?.duration ?? BROLL_CUT;
          const cutEnd    = Math.min(pos + BROLL_CUT, brollMax, pos + brClipDur);

          if (cutEnd - pos >= MIN_BROLL_SEG) {
            segs.push({ clip: br, path: br.path, startInSrc: 0, dur: cutEnd - pos, fadeIn: false });
            pos = cutEnd;
          } else {
            brollQ.unshift(br); // too short — put back, skip this iteration
          }
        }
        // If no broll was inserted the while loop continues and adds the
        // remaining narration as face cam — no break, no missing frames.
      }
    }

    // Log segments so we can diagnose freeze issues
    console.log(`[section ${i}] segments for ${path.basename(aroll.path)} (narrDur=${narrDur.toFixed(2)}s):`);
    let segTotal = 0;
    for (const seg of segs) {
      console.log(`  ${path.basename(seg.path)} startInSrc=${seg.startInSrc.toFixed(2)} dur=${seg.dur.toFixed(2)} clipDur=${(infoByPath.get(seg.path)?.duration ?? 0).toFixed(2)}`);
      segTotal += seg.dur;
    }
    console.log(`  total video=${segTotal.toFixed(2)}s audio=${narrDur.toFixed(2)}s delta=${(segTotal - narrDur).toFixed(3)}s`);

    // ── filter_complex ───────────────────────────────────────────────────
    const inputPaths = [...new Set(segs.map(s => s.path))];
    const secArgs = [];
    const secIdx  = new Map();
    for (const p of inputPaths) {
      secIdx.set(p, secIdx.size);
      secArgs.push('-noautorotate', '-i', p);
    }

    const fp = [];
    for (let s = 0; s < segs.length; s++) {
      const seg     = segs[s];
      const idx     = secIdx.get(seg.path);
      const info    = infoByPath.get(seg.path) || { rotation: 0, trc: '' };
      const segType = seg.path === aroll.path ? 'aroll' : 'broll';
      const rot     = clipRotFrag(info, segType, rotByPath.get(seg.path), faceByPath.get(seg.path), seg.path);
      const end     = (seg.startInSrc + seg.dur).toFixed(3);
      const fadeFilter = seg.fadeIn ? ',fade=t=in:st=0:d=0.5' : '';
      fp.push(`[${idx}:v]trim=start=${seg.startInSrc.toFixed(3)}:end=${end},setpts=PTS-STARTPTS${rot}${fadeFilter}[sv${s}]`);
      fp.push(bgFilter(`[sv${s}]`, `[svout${s}]`, `sg${i}_${s}`, info.trc, outW, outH, isVertical && clipIsLandscapeForVertical(info, rotByPath.get(seg.path), segType)));
    }
    fp.push(`${segs.map((_, s) => `[svout${s}]`).join('')}concat=n=${segs.length}:v=1:a=0,fps=30,trim=end=${narrDur.toFixed(3)},setpts=PTS-STARTPTS[secv]`);

    // Audio: trimmed narration with loudness normalization.
    // apad ensures audio is at least as long as video — prevents the encoder
    // from holding the last video frame waiting for audio at section end.
    const narrIdx = secIdx.get(aroll.path);
    if (narrInfo.hasAudio) {
      fp.push(`[${narrIdx}:a]atrim=${narrTrimStart.toFixed(3)}:${narrTrimEnd.toFixed(3)},asetpts=PTS-STARTPTS,loudnorm=I=-16:LRA=11:TP=-1.5,atrim=end=${narrDur.toFixed(3)},asetpts=PTS-STARTPTS[seca]`);
    } else {
      fp.push(`aevalsrc=0:c=stereo:s=48000:d=${narrDur.toFixed(3)}[seca]`);
    }

    const sectionFile = path.join(tmpDir, `sec${i}_narr.mp4`);
    try {
      await execFileAsync(ffmpegPath, [
        ...secArgs,
        '-filter_complex', fp.join(';'),
        '-map', '[secv]', '-map', '[seca]',
        ...encodeFlags(outW, outH), '-y', sectionFile,
      ], { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
    } catch (err) {
      console.warn(`[section] narration section ${i} (${path.basename(aroll.path)}) failed: ${err.message}`);
      return null; // caller skips this section
    }

    // ── Overflow b-roll (rendered sequentially within this section) ──────
    const overflowFiles = [];
    for (let j = 0; j < overflow.length; j++) {
      const br     = overflow[j];
      const brInfo = infoByPath.get(br.path);
      if (!brInfo || brInfo.duration < 0.5) continue;
      const brDur = Math.min(BROLL_CUT, brInfo.duration || BROLL_CUT);

      const brFp = [
        `[0:v]trim=0:${brDur.toFixed(3)},setpts=PTS-STARTPTS${clipRotFrag(brInfo, 'broll', rotByPath.get(br.path), faceByPath.get(br.path), br.path)}[brv]`,
        bgFilter('[brv]', '[brout]', `brovf${i}_${j}`, brInfo.trc, outW, outH, isVertical && clipIsLandscapeForVertical(brInfo, rotByPath.get(br.path), 'broll')),
        brInfo.hasAudio
          ? `[0:a]atrim=0:${brDur.toFixed(3)},volume=0.12,asetpts=PTS-STARTPTS[bra]`
          : `aevalsrc=0:c=stereo:s=48000:d=${brDur.toFixed(3)}[bra]`,
      ];

      const brFile = path.join(tmpDir, `sec${i}_ovf${j}.mp4`);
      try {
        await execFileAsync(ffmpegPath, [
          '-noautorotate', '-i', br.path,
          '-filter_complex', brFp.join(';'),
          '-map', '[brout]', '-map', '[bra]',
          ...encodeFlags(outW, outH), '-y', brFile,
        ], { maxBuffer: 100 * 1024 * 1024, timeout: 120000 });
        overflowFiles.push({ file: brFile, dur: brDur, clip: br });
      } catch (err) {
        console.warn(`[section] overflow broll ${path.basename(br.path)} failed: ${err.message}`);
      }
    }

    return { narrFile: sectionFile, narrDur, overflowFiles, segs };
  }

  // Run sections concurrently with a limit of 3 — safe on most Macs without
  // overwhelming the CPU/thermal budget. Results array preserves order.
  const CONCURRENCY = 1;
  const sectionResults = new Array(sectionMap.length).fill(null);

  try {
    for (let start = 0; start < sectionMap.length; start += CONCURRENCY) {
      const chunk = sectionMap.slice(start, start + CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map((_, offset) => renderSection(start + offset))
      );
      chunkResults.forEach((r, offset) => { sectionResults[start + offset] = r; });
      const doneCount = start + chunk.length;
      onProgress?.({ pct: 15 + Math.round((doneCount / sectionMap.length) * 65),
        message: `Rendering section ${doneCount} of ${sectionMap.length}…` });
    }

    // Build ordered concat list from results, computing time offsets
    const sectionFiles = [];
    const arollTimeRanges = [];
    const captionSections = []; // { clip, timelineStart } for SRT generation
    const resolvedTimeline = []; // exact segment list for XML export
    let timeOffset = 0;
    let renderedSections = 0;

    // Strip clip to only fields fcpxml.js needs — transcript/vision arrays are large
    // and serializing them repeatedly into resolvedTimeline bloats the sidecar JSON.
    const slimClip = c => ({
      path: c.path, rotation: c.rotation, rotFromTag: c.rotFromTag,
      storedW: c.storedW, storedH: c.storedH,
      needsColorConversion: c.needsColorConversion || false,
      dayIndex: c.dayIndex ?? 0,
      vision: c.vision ? {
        suggestedRotation: c.vision.suggestedRotation ?? null,
        hasFace: c.vision.hasFace || false,
        isTalkingHead: c.vision.isTalkingHead || false,
      } : null,
    });

    for (let i = 0; i < sectionResults.length; i++) {
      const result = sectionResults[i];
      if (!result) continue; // section failed — skip, continue with others
      renderedSections++;
      sectionFiles.push({ file: result.narrFile, dur: result.narrDur, isAroll: true });
      arollTimeRanges.push({ start: timeOffset, end: timeOffset + result.narrDur });
      captionSections.push({ clip: sectionMap[i].aroll, timelineStart: timeOffset });

      // Collect exact rendered segments for XML generator
      for (const seg of (result.segs || [])) {
        resolvedTimeline.push({
          clip: slimClip(seg.clip),
          clipType: seg.clip === sectionMap[i].aroll ? 'aroll' : 'broll',
          srcIn:  seg.startInSrc,
          srcOut: seg.startInSrc + seg.dur,
          dur:    seg.dur,
          timelineSec: timeOffset,
        });
        timeOffset += seg.dur;
      }

      // Reset timeOffset to narr section start + narrDur for overflow alignment
      const sectionNarrEnd = arollTimeRanges[arollTimeRanges.length - 1].end;
      timeOffset = sectionNarrEnd;

      for (const ovf of result.overflowFiles) {
        sectionFiles.push({ file: ovf.file, dur: ovf.dur, isAroll: false });
        if (ovf.clip) {
          resolvedTimeline.push({
            clip: slimClip(ovf.clip),
            clipType: 'broll',
            srcIn: 0, srcOut: ovf.dur, dur: ovf.dur,
            timelineSec: timeOffset,
          });
        }
        timeOffset += ovf.dur;
      }
    }

    if (sectionFiles.length === 0) throw new Error('No sections rendered successfully');
    if (renderedSections < sectionMap.length) {
      console.warn(`[section] ${sectionMap.length - renderedSections} of ${sectionMap.length} narration sections failed — continuing with ${renderedSections} sections`);
    }

    // Fade out disabled

    // ── Pass 2: concat all section files ─────────────────────────────────
    const concatListPath = path.join(tmpDir, 'concat.txt');
    // Escape single quotes in file paths for the concat list format
    fs.writeFileSync(concatListPath,
      sectionFiles.map(s =>
        `file '${s.file.replace(/'/g, "'\\''")}'\nduration ${s.dur.toFixed(6)}`
      ).join('\n'), 'utf8');

    const totalDuration = timeOffset;

    // ── Captions: write ASS (burn-in) + SRT (sidecar) ────────────────────
    let tmpAssPath = null;
    let subFilter  = null;
    if (captionsOpts?.enabled && captionSections.length > 0) {
      const srtContent = generateSrt(captionSections);
      // SRT burn-in — pick style, apply uppercase if needed, point ffmpeg to bundled fonts
      if (srtContent.trim()) {
        const styleDef  = CAPTION_STYLES[captionsOpts.style] || CAPTION_STYLES.clean;
        const srtText   = styleDef.uppercase ? srtContent.toUpperCase() : srtContent;
        const tmpSrtPath = path.join(tmpDir, 'captions.srt');
        fs.writeFileSync(tmpSrtPath, srtText, 'utf8');
        const fontsDir  = path.join(__dirname, '../../assets/fonts');
        // Vertical: shrink font (1080px wide canvas = less room), set MarginV for
        // bottom-safe-zone placement, and pass original_size so libass uses the
        // correct canvas dimensions (prevents captions landing in wrong half of frame).
        const forceStyle = isVertical
          ? styleDef.forceStyle
              .replace(/FontSize=\d+/, s => `FontSize=${Math.round(parseInt(s.split('=')[1]) * 0.65)}`)
              .replace(/MarginV=\d+/, 'MarginV=80')
          : styleDef.forceStyle;
        const originalSize = isVertical ? `:original_size=${outW}x${outH}` : '';
        subFilter = `subtitles='${escapeFilterPath(tmpSrtPath)}'${originalSize}:fontsdir='${escapeFilterPath(fontsDir)}':force_style='${forceStyle}'`;
      }
    }

    if (!musicOpts?.musicPath && !subFilter) {
      // No music, no captions — re-encode to enforce CFR across section boundaries.
      await execFileAsync(ffmpegPath, [
        '-f', 'concat', '-safe', '0', '-i', concatListPath,
        '-r', '30',
        ...encodeFlags(outW, outH), '-y', outPath,
      ], { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
    } else if (!musicOpts?.musicPath && subFilter) {
      // Captions only — re-encode video to burn subtitles, no audio change.
      // -r 30 forces constant frame rate so the encoder doesn't hold duplicate
      // frames at section boundaries (which causes the freeze between sections).
      await execFileAsync(ffmpegPath, [
        '-f', 'concat', '-safe', '0', '-i', concatListPath,
        '-vf', subFilter, '-r', '30',
        ...encodeFlags(outW, outH), '-y', outPath,
      ], { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
    } else {
      // Music (±captions) — mix audio; burn captions via filter_complex if enabled.
      const volExpr = buildMusicVolumeExpr(arollTimeRanges);
      const audioFc =
        `[1:a]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,volume='${volExpr}'[music];` +
        `[0:a][music]amix=inputs=2:duration=first:dropout_transition=0[outa]`;
      if (subFilter) {
        // Captions + music: burn subs into video, mix audio.
        await execFileAsync(ffmpegPath, [
          '-f', 'concat', '-safe', '0', '-i', concatListPath,
          '-stream_loop', '-1', '-i', musicOpts.musicPath,
          '-filter_complex', `${audioFc};[0:v]${subFilter}[vout]`,
          '-map', '[vout]', '-map', '[outa]',
          '-r', '30',
          ...encodeFlags(outW, outH), '-y', outPath,
        ], { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
      } else {
        // Music only — copy video, re-encode audio with mix.
        await execFileAsync(ffmpegPath, [
          '-f', 'concat', '-safe', '0', '-i', concatListPath,
          '-stream_loop', '-1', '-i', musicOpts.musicPath,
          '-filter_complex', audioFc,
          '-map', '0:v', '-map', '[outa]',
          '-c:v', 'copy',
          '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
          '-movflags', '+faststart',
          '-y', outPath,
        ], { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
      }
    }

    onProgress?.(95);
    return { resolvedTimeline };
  } finally {
    // Clean up all temp files — always, even on error.
    // Walk sectionResults (not the inner sectionFiles which is out of scope here).
    for (const result of sectionResults) {
      if (!result) continue;
      try { fs.unlinkSync(result.narrFile); } catch {}
      for (const ovf of result.overflowFiles) {
        try { fs.unlinkSync(ovf.file); } catch {}
      }
    }
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

// ── Sequential: b-roll only (no narration) ───────────────────────────────────

async function buildSequential(assembly, outPath, onProgress, musicOpts, BROLL_CUT, outW = OUTPUT_W, outH = OUTPUT_H, isVertical = false) {
  BROLL_CUT = BROLL_CUT ?? BROLL_CUT_DEFAULT;
  const infos = await Promise.all(assembly.map(c => probe(c.path)));

  // Vision-supplied rotation per clip path — used as ground truth over metadata.
  const rotByPath = new Map();
  const faceByPath = new Map();
  for (const clip of assembly) {
    const hasFace = !!(clip.vision?.hasFace || clip.vision?.isTalkingHead ||
                       clip.vision?.contentTags?.includes('people'));
    faceByPath.set(clip.path, hasFace);
    const rot = clip.vision?.suggestedRotation ?? clip.suggestedRotation;
    if (rot != null) rotByPath.set(clip.path, rot);
  }

  const clipDurations = [];
  let timeOffset = 0;
  for (let i = 0; i < assembly.length; i++) {
    const clip = assembly[i];
    const info = infos[i];
    if (clip.clipType === 'aroll') {
      const dur = clip.duration || info.duration || 30;
      clipDurations.push(dur);
      timeOffset += dur;
    } else {
      const minDur = 2, maxDur = Math.min(clip.duration || BROLL_CUT, BROLL_CUT);
      const dur = musicOpts?.beats?.length
        ? snapDuration(timeOffset, minDur, maxDur, musicOpts.beats, musicOpts.beatInterval)
        : maxDur;
      clipDurations.push(dur);
      timeOffset += dur;
    }
  }
  const totalDuration = timeOffset;

  const args = [];
  for (let i = 0; i < assembly.length; i++) {
    const clip = assembly[i];
    if (clip.clipType === 'aroll') {
      args.push('-noautorotate', '-i', clip.path);
    } else {
      args.push('-noautorotate', '-ss', String(clip.startSec || 0), '-t', String(clipDurations[i]), '-i', clip.path);
    }
  }
  const musicIdx = musicOpts?.musicPath ? assembly.length : -1;
  if (musicIdx >= 0) args.push('-stream_loop', '-1', '-i', musicOpts.musicPath);

  const fp = [];
  let t = 0;
  const arollSegs = [];

  for (let i = 0; i < assembly.length; i++) {
    const clip = assembly[i];
    const info = infos[i];
    const dur  = clipDurations[i];
    const rot = clipRotFrag(info, clip.clipType, rotByPath.get(clip.path), faceByPath.get(clip.path), clip.path);
    fp.push(`[${i}:v]setpts=PTS-STARTPTS${rot}[vr${i}]`);
    fp.push(bgFilter(`[vr${i}]`, `[v${i}]`, `sbg${i}`, info.trc, outW, outH, isVertical && clipIsLandscapeForVertical(info, rotByPath.get(clip.path), clip.clipType)));

    if (clip.clipType === 'aroll' && info.hasAudio) {
      fp.push(`[${i}:a]apad,atrim=0:${dur},loudnorm=I=-16:LRA=11:TP=-1.5,asetpts=PTS-STARTPTS[a${i}]`);
      arollSegs.push({ start: t, end: t + dur });
    } else if (info.hasAudio) {
      const vol = musicIdx >= 0 ? 0.05 : 0.15;
      fp.push(`[${i}:a]apad,atrim=0:${dur},volume=${vol},asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      fp.push(`aevalsrc=0:c=stereo:s=48000:d=${dur}[a${i}]`);
    }
    t += dur;
  }

  fp.push(`${assembly.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${assembly.length}:v=1:a=1[outv][outaraw]`);

  let finalAudio = '[outaraw]';
  if (musicIdx >= 0) {
    const volExpr = buildMusicVolumeExpr(arollSegs);
    fp.push(`[${musicIdx}:a]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,volume='${volExpr}'[music]`);
    fp.push(`[outaraw][music]amix=inputs=2:duration=first:dropout_transition=0[outa]`);
    finalAudio = '[outa]';
  }

  args.push('-filter_complex', fp.join(';'), '-map', '[outv]', '-map', finalAudio, ...encodeFlags(outW, outH), '-metadata:s:v:0', 'rotate=0', '-y', outPath);

  onProgress?.(30);
  await execFileAsync(ffmpegPath, args, { maxBuffer: 500 * 1024 * 1024, timeout: 600000 });
  onProgress?.(95);
}

module.exports = { buildJournalVideo, probe };
