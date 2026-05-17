// ── Clip chronological sort ───────────────────────────────────────────────────
// iPhone filenames (IMG_5144, IMG_5146, etc.) are a strictly incrementing
// counter that is always reliable — more so than embedded timestamps which
// can be wrong (e.g. 5144.mov showed a creation time AFTER 5149.mov).
//
// Sort priority:
//   1. Filename numeric component — always correct for iPhone clips
//   2. Creation timestamp — for non-iPhone files without a clear counter
//   3. filledAt (birthtime fallback) — last resort

const path = require('path');

function filenameNum(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const m = base.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function clipComparator(a, b) {
  const na = filenameNum(a.path);
  const nb = filenameNum(b.path);

  // Both have numeric filenames → sort by number (most reliable for iPhone)
  if (na !== null && nb !== null) return na - nb;

  // One or both lack numeric filenames → fall back to creation timestamp
  const hasTimeA = a.creationTime instanceof Date && a.creationTime.getFullYear() > 2000;
  const hasTimeB = b.creationTime instanceof Date && b.creationTime.getFullYear() > 2000;
  if (hasTimeA && hasTimeB) return a.creationTime.getTime() - b.creationTime.getTime();

  // Final fallback
  return (a.filledAt || 0) - (b.filledAt || 0);
}

module.exports = { clipComparator, filenameNum };
