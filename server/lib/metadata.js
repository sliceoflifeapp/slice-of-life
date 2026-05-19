const { exiftool }          = require('exiftool-vendored');
const fs                    = require('fs');
const path                  = require('path');
const os                    = require('os');
const { execFile }          = require('child_process');
const { promisify }         = require('util');
const execFileAsync         = promisify(execFile);
const ffmpegPath            = require('ffmpeg-static');

// Patterns for dates embedded in filenames
// Matches: 20190415, 2019-04-15, 2019_04_15, IMG_20190415, VID_20190415_123456, Screenshot 2021-03-02, etc.
const FILENAME_DATE_PATTERNS = [
  /(\d{4})[_\-](\d{2})[_\-](\d{2})[_\-T ](\d{2})[_\-:](\d{2})[_\-:](\d{2})/, // full datetime
  /(\d{4})[_\-](\d{2})[_\-](\d{2})/,                                            // date only with separators
  /(?<![0-9])(\d{4})(\d{2})(\d{2})(?![0-9])/,                                   // compact YYYYMMDD
];

function parseDateFromFilename(filePath) {
  const name = path.basename(filePath);
  for (const pattern of FILENAME_DATE_PATTERNS) {
    const m = name.match(pattern);
    if (!m) continue;
    const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
    const year = parseInt(y);
    if (year < 1990 || year > new Date().getFullYear() + 1) continue;
    const date = new Date(year, parseInt(mo) - 1, parseInt(d), parseInt(h), parseInt(mi), parseInt(s));
    if (!isNaN(date.getTime())) return date;
  }
  return null;
}

// Camcorder timestamp patterns burned into video frames
// Matches: 12/25/1998, 25.12.1998, 1998-12-25, with optional time
const BURNED_DATE_PATTERNS = [
  /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/,  // MM/DD/YYYY or DD.MM.YYYY
  /(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/,  // YYYY-MM-DD
  /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})(?!\d)/, // MM/DD/YY
];

async function parseDateFromBurnedIn(filePath) {
  const tmp = path.join(os.tmpdir(), `sol-ocr-${Date.now()}.jpg`);
  try {
    // Extract first frame
    await execFileAsync(ffmpegPath, [
      '-ss', '0', '-i', filePath,
      '-vf', 'scale=640:-1', '-vframes', '1', '-q:v', '3', '-y', tmp,
    ], { timeout: 10000 });

    // Use macOS Vision OCR via a quick shell script
    const ocrResult = await execFileAsync('/usr/bin/python3', ['-c', `
import subprocess, json, sys
result = subprocess.run(
  ['osascript', '-e', '''
    use framework "Vision"
    use scripting additions
    set imgPath to POSIX file "${tmp}"
    set req to current application's VNRecognizeTextRequest's alloc()'s init()
    req's setRecognitionLevel_(1)
    set handler to current application's VNImageRequestHandler's alloc()'s initWithURL_options_(imgPath as POSIX file as «class furl», missing value)
    handler's performRequests_error_({req}, missing value)
    set results to {}
    repeat with obs in req's results()
      set end of results to (obs's topCandidates_(1)'s item 1)'s string() as text
    end repeat
    return results as text
  '''],
  capture_output=True, text=True
)
print(result.stdout)
`], { timeout: 15000 }).catch(() => ({ stdout: '' }));

    const text = ocrResult.stdout || '';
    for (const pattern of BURNED_DATE_PATTERNS) {
      const m = text.match(pattern);
      if (!m) continue;
      // Try to parse — handle both MM/DD/YYYY and YYYY/MM/DD
      let date;
      if (m[1].length === 4) {
        // YYYY-MM-DD
        date = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
      } else {
        const y = parseInt(m[3]);
        const year = y < 100 ? (y > 30 ? 1900 + y : 2000 + y) : y;
        // Try MM/DD first, fall back to DD/MM if month > 12
        const a = parseInt(m[1]), b = parseInt(m[2]);
        if (a <= 12) date = new Date(year, a - 1, b);
        else         date = new Date(year, b - 1, a);
      }
      if (date && !isNaN(date.getTime()) && date.getFullYear() >= 1970) {
        return date;
      }
    }
  } catch { /* OCR failed — not fatal */ }
  finally { try { fs.unlinkSync(tmp); } catch {} }
  return null;
}

function parseDateFromFileStat(filePath) {
  try {
    const stat = fs.statSync(filePath);
    // Prefer birthtime (creation) over mtime (modified) — mtime changes on copy
    const d = stat.birthtime && stat.birthtime.getFullYear() > 1970 ? stat.birthtime : stat.mtime;
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

async function extractMetadata(filePath) {
  try {
    const tags = await exiftool.read(filePath);

    // EXIF date chain: capture date > create date > media create > file modify
    let date = parseDate(
      tags.DateTimeOriginal ?? tags.CreateDate ?? tags.MediaCreateDate ?? tags.TrackCreateDate ?? tags.FileModifyDate
    );

    // Sanity-check: reject dates before 1990 or in the future (likely corrupt metadata)
    if (date && (date.getFullYear() < 1990 || date > new Date())) date = null;

    // Fallback 1: filename
    if (!date) date = parseDateFromFilename(filePath);

    // Fallback 2: burned-in timestamp (old camcorder footage — videos only)
    const isVideo = ['.mp4','.mov','.avi','.m4v','.mkv','.mts','.m2ts','.3gp','.wmv'].includes(path.extname(filePath).toLowerCase());
    if (!date && isVideo) date = await parseDateFromBurnedIn(filePath);

    // Fallback 3: file system birthtime/mtime
    if (!date) date = parseDateFromFileStat(filePath);

    return {
      date,
      dateSource: date ? (tags.DateTimeOriginal || tags.CreateDate ? 'exif' : 'filename_or_stat') : null,
      lat:      typeof tags.GPSLatitude  === 'number' ? tags.GPSLatitude  : null,
      lon:      typeof tags.GPSLongitude === 'number' ? tags.GPSLongitude : null,
      width:    tags.ImageWidth  ?? tags.SourceImageWidth  ?? null,
      height:   tags.ImageHeight ?? tags.SourceImageHeight ?? null,
      duration: typeof tags.Duration === 'number' ? tags.Duration : null,
    };
  } catch {
    // Full fallback if exiftool fails entirely
    const date = parseDateFromFilename(filePath) ?? parseDateFromFileStat(filePath);
    return { date, dateSource: date ? 'fallback' : null, lat: null, lon: null, width: null, height: null, duration: null };
  }
}

function parseDate(tag) {
  if (!tag) return null;
  try {
    const d = typeof tag.toDate === 'function' ? tag.toDate() : new Date(String(tag));
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

module.exports = { extractMetadata };
