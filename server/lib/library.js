// Reads the Organized folder on disk and builds a searchable in-memory index.
// Re-built on every search call so it always reflects the current state on disk.
const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const { execFile }  = require('child_process');
const { promisify } = require('util');
const ffmpegPath    = require('ffmpeg-static');

const execFileAsync = promisify(execFile);
const tagger = require('./tagger');

const JSON_INDEX = path.join(os.homedir(), '.slice-of-life', 'index.json');

function readJsonIndex() {
  try { return JSON.parse(fs.readFileSync(JSON_INDEX, 'utf8')); }
  catch { return []; }
}

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function organizedPath() {
  return path.join(os.homedir(), 'Desktop', 'Organized');
}

function buildIndex() {
  const base = organizedPath();
  if (!fs.existsSync(base)) return [];

  // Load visual descriptions from ~/.slice-of-life/index.json
  const descByPath = new Map(readJsonIndex().map(e => [e.path, e.description]));

  const events = [];

  let topDirs;
  try { topDirs = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()); }
  catch { return []; }

  for (const top of topDirs) {
    const topPath = path.join(base, top.name);

    if (top.name === 'Misc') {
      // Flatten Misc sub-folders into the index
      let subs;
      try { subs = fs.readdirSync(topPath, { withFileTypes: true }).filter(e => e.isDirectory()); }
      catch { continue; }

      for (const sub of subs) {
        const subPath = path.join(topPath, sub.name);
        const fileTokens = fileStems(subPath);
        events.push({
          name:     `Misc · ${sub.name}`,
          count:    fileTokens.fileCount,
          fullPath: subPath,
          tokens:   [...tokens(`misc ${sub.name}`), ...fileTokens.stems],
          misc:     true,
          sortKey:  '0000-00',
        });
      }
      continue;
    }

    const year = top.name;
    if (!/^\d{4}$/.test(year)) continue;

    let eventDirs;
    try { eventDirs = fs.readdirSync(topPath, { withFileTypes: true }).filter(e => e.isDirectory()); }
    catch { continue; }

    for (const ev of eventDirs) {
      const evPath = path.join(topPath, ev.name);

      // Folder format: "July — Beach Trip"
      const dashIdx   = ev.name.indexOf(' — ');
      const monthName = dashIdx >= 0 ? ev.name.slice(0, dashIdx)         : '';
      const label     = dashIdx >= 0 ? ev.name.slice(dashIdx + 3)        : ev.name;
      const monthIdx  = MONTHS.indexOf(monthName);
      const monthNum  = monthIdx >= 0 ? String(monthIdx + 1).padStart(2, '0') : '00';

      const fileTokens = fileStems(evPath);
      events.push({
        name:     monthName ? `${monthName} ${year} · ${label}` : `${year} · ${label}`,
        count:    fileTokens.fileCount,
        fullPath: evPath,
        tokens:   [...tokens(`${year} ${monthName} ${label}`), ...fileTokens.stems],
        misc:     false,
        sortKey:  `${year}-${monthNum}`,
      });
    }
  }

  // Augment tokens with keywords: JSON index first, xattr on files as fallback.
  for (const ev of events) {
    const desc = descByPath.get(ev.fullPath) || tagger.readFolderKeywords(ev.fullPath);
    if (desc) ev.tokens = [...ev.tokens, ...tokens(desc)];
  }

  // Newest events first
  return events.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
}

function search(query) {
  const index = buildIndex();
  const q     = (query || '').trim();

  // Empty query → return 8 most recent events
  if (!q) return index.slice(0, 8);

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);

  return index
    .map(ev => {
      let score = 0;
      for (const term of terms) {
        for (const tok of ev.tokens) {
          if (tok === term)         score += 2; // exact token match
          else if (tok.includes(term)) score += 1; // partial match
        }
      }
      return { ...ev, score };
    })
    .filter(ev => ev.score > 0)
    .sort((a, b) => b.score - a.score || b.sortKey.localeCompare(a.sortKey))
    .slice(0, 6);
}

function hasLibrary() {
  return buildIndex().length > 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokens(str) {
  return str.toLowerCase().split(/[\s\-·—]+/).filter(Boolean);
}

// Returns { fileCount, stems } — stems are tokenised file name parts for search.
function fileStems(dir) {
  try {
    const names = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
    const stems = names.flatMap(f => {
      const stem = path.basename(f, path.extname(f));
      return stem.toLowerCase().split(/[\s_\-]+/).filter(Boolean);
    });
    return { fileCount: names.length, stems };
  } catch { return { fileCount: 0, stems: [] }; }
}

// Falls back to Claude Haiku when keyword search returns nothing.
async function semanticSearch(query) {
  const { getApiKey } = require('./ai');
  const apiKey = getApiKey();
  if (!apiKey) return [];

  const index = buildIndex();
  if (index.length === 0) return [];

  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic({ apiKey });

  // Include visual descriptions when available for richer matching
  const jsonIndex   = readJsonIndex();
  const descByPath  = new Map(jsonIndex.map(e => [e.path, e.description]));
  const list = index.map((ev, i) => {
    const desc = descByPath.get(ev.fullPath);
    return desc ? `${i}: ${ev.name} [${desc}]` : `${i}: ${ev.name}`;
  }).join('\n');

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [{
        role:    'user',
        content: `A user is searching their personal photo library for: "${query}"\n\nEvent folders (with visual descriptions where available):\n${list}\n\nReturn a JSON array of the indices (numbers only) of the best matching events, most relevant first. Return [] if nothing is a reasonable match. Respond with only the JSON array.`,
      }],
    });

    const raw   = response.content[0]?.text?.trim() ?? '[]';
    const match = raw.match(/\[[\d,\s]*\]/);
    if (!match) return [];

    const indices = JSON.parse(match[0]);
    return indices
      .filter(i => Number.isInteger(i) && i >= 0 && i < index.length)
      .slice(0, 6)
      .map(i => index[i]);
  } catch { return []; }
}

const ALL_MEDIA_EXTS = new Set(['.jpg','.jpeg','.png','.heic','.mp4','.mov','.m4v','.avi','.mkv','.webm']);

function photos(folderPath) {
  const organized = organizedPath();
  const resolved  = path.resolve(folderPath);
  if (!resolved.startsWith(organized)) return [];
  try {
    return fs.readdirSync(resolved)
      .filter(f => !f.startsWith('.') && ALL_MEDIA_EXTS.has(path.extname(f).toLowerCase()))
      .map(f => ({
        name: f,
        path: path.join(resolved, f),
        ext:  path.extname(f).toLowerCase(),
        isVideo: VIDEO_EXTS.has(path.extname(f).toLowerCase()),
      }));
  } catch { return []; }
}

function all() {
  const index    = buildIndex();
  const jsonIdx  = readJsonIndex();
  const descMap  = new Map(jsonIdx.map(e => [e.path, e.description]));
  return index.map(ev => ({
    name:        ev.name,
    fullPath:    ev.fullPath,
    fileCount:   ev.count,
    misc:        ev.misc,
    sortKey:     ev.sortKey,
    description: descMap.get(ev.fullPath) || '',
  }));
}

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.ts', '.mts', '.m2ts']);

async function thumbnail(folderPath) {
  let files;
  try { files = fs.readdirSync(folderPath).filter(f => !f.startsWith('.')); }
  catch { return null; }

  const photo = files.find(f => PHOTO_EXTS.has(path.extname(f).toLowerCase()));
  const video = !photo && files.find(f => VIDEO_EXTS.has(path.extname(f).toLowerCase()));
  const src   = photo || video;
  if (!src) return null;

  const srcPath = path.join(folderPath, src);
  const tmp     = path.join(os.tmpdir(), `sol-lib-${Date.now()}.jpg`);
  try {
    const args = video
      ? ['-ss', '2', '-i', srcPath, '-vf', 'scale=320:-1', '-vframes', '1', '-q:v', '5', '-y', tmp]
      : ['-i', srcPath, '-vf', 'scale=320:-1', '-vframes', '1', '-q:v', '5', '-y', tmp];
    await execFileAsync(ffmpegPath, args);
    const data = fs.readFileSync(tmp).toString('base64');
    return `data:image/jpeg;base64,${data}`;
  } catch { return null; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

module.exports = { search, semanticSearch, hasLibrary, organizedPath, all, thumbnail };
