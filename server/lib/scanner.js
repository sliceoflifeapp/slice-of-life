const fs   = require('fs');
const path = require('path');

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif', '.avif', '.bmp', '.arw', '.cr2', '.cr3', '.nef', '.dng', '.raf', '.rw2', '.orf', '.psd', '.tiff', '.tif']);
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.3gp', '.wmv', '.flv', '.webm', '.ts', '.mts', '.m2ts']);
const AUDIO_EXTS = new Set(['.mp3', '.wav']);

// Returns every supported file with its path, type, and size — no metadata yet.
function fullScan(folderPath) {
  const files = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);

      const stat2 = entry.isSymbolicLink() ? (() => { try { return fs.statSync(full); } catch { return null; } })() : null;
      if (entry.isDirectory() || stat2?.isDirectory()) {
        walk(full);
      } else if (entry.isFile() || stat2?.isFile()) {
        const ext  = path.extname(entry.name).toLowerCase();
        const type = PHOTO_EXTS.has(ext) ? 'photo' : VIDEO_EXTS.has(ext) ? 'video' : AUDIO_EXTS.has(ext) ? 'audio' : null;
        if (!type) continue;
        let size = 0;
        try { size = (stat2 ?? fs.statSync(full)).size; } catch { /* skip */ }
        files.push({ path: full, name: entry.name, ext, type, size, sourceRoot: folderPath });
      }
    }
  }

  walk(folderPath);
  return files;
}

function quickScan(folderPath) {
  let photoCount = 0;
  let videoCount = 0;
  let totalSize  = 0;

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);

      const stat = entry.isSymbolicLink() ? (() => { try { return fs.statSync(full); } catch { return null; } })() : null;
      const isDir  = entry.isDirectory()  || (stat?.isDirectory()  ?? false);
      const isFile = entry.isFile()       || (stat?.isFile()       ?? false);

      if (isDir) {
        walk(full);
      } else if (isFile) {
        const ext = path.extname(entry.name).toLowerCase();
        if (PHOTO_EXTS.has(ext)) {
          photoCount++;
          try { totalSize += (stat ?? fs.statSync(full)).size; } catch { /* skip */ }
        } else if (VIDEO_EXTS.has(ext)) {
          videoCount++;
          try { totalSize += fs.statSync(full).size; } catch { /* skip */ }
        } else if (AUDIO_EXTS.has(ext)) {
          try { totalSize += fs.statSync(full).size; } catch { /* skip */ }
        }
      }
    }
  }

  walk(folderPath);
  return { photoCount, videoCount, totalSize, fileCount: photoCount + videoCount };
}

module.exports = { quickScan, fullScan, PHOTO_EXTS, VIDEO_EXTS, AUDIO_EXTS };
