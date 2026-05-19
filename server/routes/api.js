const router    = require('express').Router();
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const credits   = require('../lib/credits');
const analytics = require('../lib/analytics');

// ── Settings ──────────────────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  const cfg = loadConfig();
  const hasKey = !!(cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  const dns = require('dns');
  const checkOnline = () => new Promise(resolve => {
    if (!hasKey) return resolve(true);
    dns.lookup('api.anthropic.com', err => resolve(!err));
  });
  checkOnline().then(isOnline => {
    res.json({
      hasOwnApiKey: !!cfg.anthropicApiKey,
      hasDevKey:    !!process.env.ANTHROPIC_API_KEY,
      outputFolder: cfg.outputFolder || path.join(os.homedir(), 'Desktop', 'Journals'),
      openWhenDone: cfg.openWhenDone !== false,
      isOnline,
    });
  });
});

router.post('/settings', (req, res) => {
  const cfgPath = configPath();
  const cfg = loadConfig();
  const { apiKey, outputFolder, openWhenDone } = req.body;
  if (apiKey        !== undefined) cfg.anthropicApiKey = apiKey;
  if (outputFolder  !== undefined) cfg.outputFolder    = outputFolder;
  if (openWhenDone  !== undefined) cfg.openWhenDone    = openWhenDone;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  res.json({ ok: true });
});

// ── Connected devices ─────────────────────────────────────────────────────────

router.get('/devices', (req, res) => {
  const IGNORE = new Set(['Macintosh HD', 'com.apple.TimeMachine.localsnapshots']);
  let volumes = [];
  try {
    volumes = fs.readdirSync('/Volumes')
      .filter(name => !IGNORE.has(name))
      .map(name => {
        const fullPath = path.join('/Volumes', name);
        const dcim     = path.join(fullPath, 'DCIM');
        const hasDcim  = fs.existsSync(dcim);
        return { name, fullPath, scanPath: hasDcim ? dcim : fullPath, hasDcim };
      });
  } catch {}
  res.json({ devices: volumes });
});

// ── Credits ───────────────────────────────────────────────────────────────────

router.get('/credits', (req, res) => {
  res.json({ credits: credits.load() });
});

// ── Stage loose files into a temp folder ─────────────────────────────────────
// Accepts an array of absolute file paths, symlinks them into a tmp dir,
// returns { folderPath } so the normal folder-based pipeline can be used.

router.post('/files/stage', (req, res) => {
  const { filePaths } = req.body;
  if (!Array.isArray(filePaths) || !filePaths.length) {
    return res.status(400).json({ error: 'filePaths array required' });
  }
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yl-stage-'));
    for (const fp of filePaths) {
      const dest = path.join(tmpDir, path.basename(fp));
      // Use symlink to avoid copying large video files
      try { fs.symlinkSync(fp, dest); } catch {}
    }
    res.json({ ok: true, folderPath: tmpDir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Journal pipeline ──────────────────────────────────────────────────────────

const journalJobs = new Map();

router.post('/journal/start', (req, res) => {
  const { folderPath, targetDuration, pacingParams, description } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
  const jobId = `journal-${Date.now()}`;
  journalJobs.set(jobId, { status: 'running', progress: 0, message: 'Starting…' });
  res.json({ ok: true, jobId });

  const pipeline = require('../lib/journal-pipeline');
  const pipelineOpts = { targetDuration, description,
    highSensitivity: req.body.highSensitivity || false,
    highlightOnly:   req.body.highlightOnly   || false,
    captions:        req.body.captions        || false,
    captionStyle:    req.body.captionStyle    || 'clean',
    orientation:     req.body.orientation     || 'landscape' };
  analytics.track('render_started', {
    mode: 'single',
    orientation: pipelineOpts.orientation,
    captions: pipelineOpts.captions,
    captionStyle: pipelineOpts.captionStyle,
    targetDuration,
  });

  pipeline.run(folderPath, pipelineOpts, ({ message, progress, detectedResolution }) => {
    const current = journalJobs.get(jobId) || {};
    journalJobs.set(jobId, {
      ...current,
      status: 'running', progress, message,
      // Persist once set — later progress updates won't have it
      detectedResolution: detectedResolution || current.detectedResolution || null,
    });
  }, pacingParams).then(result => {
    const name    = path.basename(path.dirname(result.videoPath));
    const xmlPath = autoExportXML(result, name, pacingParams, pipelineOpts.orientation);
    const renderOpts = { captions: pipelineOpts.captions, captionStyle: pipelineOpts.captionStyle, orientation: pipelineOpts.orientation, pacingParams, pacing: req.body.pacing || null };
    journalJobs.set(jobId, { status: 'done', progress: 100, message: 'Done!', ...result, xmlPath, assemblyPath: result.assemblyPath || null, renderOpts });
    recordExport(result.videoPath, name, result.assembly, result.thumbPath);
    analytics.track('render_completed', {
      mode: 'single',
      orientation: pipelineOpts.orientation,
      captions: pipelineOpts.captions,
      outputDurationSec: result.outputDurationSec,
      arollCount: result.stats?.arollCount,
      brollCount: result.stats?.brollCount,
      totalClips: result.stats?.totalClips,
    });
  }).catch(err => {
    if (err.noAroll) {
      journalJobs.set(jobId, { status: 'no_aroll', progress: 0, message: 'No narration detected.',
        folderPath, savedOpts: { targetDuration, pacingParams, description,
          captions: pipelineOpts.captions, captionStyle: pipelineOpts.captionStyle,
          orientation: pipelineOpts.orientation } });
      analytics.track('render_no_narration', { mode: 'single' });
    } else {
      journalJobs.set(jobId, { status: 'error', progress: 0, message: err.message, error: err.message });
      analytics.track('render_failed', { mode: 'single', error: err.message });
    }
  });
});

router.get('/journal/status/:jobId', (req, res) => {
  const job = journalJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

router.get('/journal/scan', async (req, res) => {
  const { folderPath } = req.query;
  if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
  try {
    const scanner    = require('../lib/scanner');
    const { probe }  = require('../lib/journal-video');
    const VIDEO_EXTS = new Set(['.mp4','.m4v','.mov','.avi','.mkv','.mts','.m2ts','.webm']);
    const files      = scanner.fullScan(folderPath).filter(f => VIDEO_EXTS.has(f.ext));
    const infos      = await Promise.all(files.map(f => probe(f.path)));
    const totalSec   = infos.reduce((s, i) => s + (i.duration || 0), 0);
    res.json({ clipCount: files.length, hasContent: files.length > 0, totalSec });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trip pipeline ─────────────────────────────────────────────────────────────

const tripJobs = new Map();

router.post('/trip/start', (req, res) => {
  const { folderPath, targetDuration, pacingParams, description } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
  const jobId = `trip-${Date.now()}`;
  tripJobs.set(jobId, { status: 'running', progress: 0, message: 'Starting…' });
  res.json({ ok: true, jobId });

  const pipelineOpts = {
    targetDuration, description,
    captions:       req.body.captions       || false,
    captionStyle:   req.body.captionStyle   || 'clean',
    orientation:    req.body.orientation    || 'landscape',
    dayTitleCards:  req.body.dayTitleCards  || false,
    highlightOnly:  req.body.highlightOnly  || false,
  };

  analytics.track('render_started', {
    mode: 'trip',
    orientation: pipelineOpts.orientation,
    captions: pipelineOpts.captions,
    targetDuration,
  });

  const pipeline = require('../lib/trip-pipeline');
  pipeline.run(folderPath, pipelineOpts, ({ message, progress, detectedResolution }) => {
    const current = tripJobs.get(jobId) || {};
    tripJobs.set(jobId, {
      ...current,
      status: 'running', progress, message,
      detectedResolution: detectedResolution || current.detectedResolution || null,
    });
  }, pacingParams).then(result => {
    const name    = path.basename(path.dirname(result.videoPath));
    const xmlPath = autoExportXML(result, name, pacingParams, pipelineOpts.orientation, result.dayBoundaries);
    tripJobs.set(jobId, { status: 'done', progress: 100, message: 'Done!', ...result, xmlPath, assemblyPath: result.assemblyPath || null });
    recordExport(result.videoPath, name, result.assembly, result.thumbPath);
    analytics.track('render_completed', {
      mode: 'trip',
      orientation: pipelineOpts.orientation,
      captions: pipelineOpts.captions,
      outputDurationSec: result.outputDurationSec,
      arollCount: result.stats?.arollCount,
      brollCount: result.stats?.brollCount,
      totalClips: result.stats?.totalClips,
    });
  }).catch(err => {
    tripJobs.set(jobId, { status: 'error', progress: 0, message: err.message, error: err.message });
    analytics.track('render_failed', { mode: 'trip', error: err.message });
  });
});

router.get('/trip/status/:jobId', (req, res) => {
  const job = tripJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Quick scan — returns day count
router.get('/trip/scan', (req, res) => {
  const { folderPath } = req.query;
  if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
  try {
    const scanner    = require('../lib/scanner');
    const VIDEO_EXTS = new Set(['.mp4','.m4v','.mov','.avi','.mkv','.mts','.m2ts','.webm']);
    const files      = scanner.fullScan(folderPath).filter(f => VIDEO_EXTS.has(f.ext));
    const days       = new Set(files.map(f => {
      const stat = require('fs').statSync(f.path);
      const d    = stat.birthtime && stat.birthtime.getFullYear() > 1970 ? stat.birthtime : stat.mtime;
      return d.toISOString().slice(0, 10);
    }));
    res.json({ clipCount: files.length, dayCount: days.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recap ─────────────────────────────────────────────────────────────────────

const recapJobs = new Map();

router.get('/recap/scan', (req, res) => {
  const { folderPath } = req.query;
  if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
  try {
    const scanner  = require('../lib/scanner');
    const files    = scanner.fullScan(folderPath);
    const eligible = files.filter(f =>
      (f.type === 'photo' || f.type === 'video') &&
      fs.existsSync(f.path + '.gather.json')
    );
    res.json({ total: files.length, eligible: eligible.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/recap/create', (req, res) => {
  const { folderPath, dateFrom, dateTo, recapType, duration, cutSpeed } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
  const jobId = `recap-${Date.now()}`;
  recapJobs.set(jobId, { status: 'running', progress: 0, message: 'Starting…' });
  res.json({ ok: true, jobId });
  runRecap({ jobId, folderPath, dateFrom, dateTo, recapType, duration, cutSpeed });
});

router.get('/recap/status/:jobId', (req, res) => {
  const job = recapJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

async function runRecap({ jobId, folderPath, dateFrom, dateTo, recapType, duration, cutSpeed }) {
  const update = (msg, pct, extra = {}) =>
    recapJobs.set(jobId, { ...recapJobs.get(jobId), ...extra, message: msg, progress: pct });

  try {
    const recap   = require('../lib/recap');
    const scanner = require('../lib/scanner');

    update('Scanning folder…', 10);
    const scanned   = scanner.fullScan(folderPath);
    const typeFilter = recapType === 'videos' ? f => f.type === 'video'
                     : recapType === 'photos' ? f => f.type === 'photo'
                     : f => f.type === 'photo' || f.type === 'video';
    const files = scanned.filter(typeFilter);
    if (files.length === 0) throw new Error('No media files found in that folder');

    update('Building file list…', 20);
    const from = dateFrom ? new Date(dateFrom + '-01') : null;
    const to   = dateTo   ? new Date(dateTo   + '-01') : null;
    if (to) to.setMonth(to.getMonth() + 1);

    const dated = [];
    for (const f of files) {
      let date = null;
      try { const s = JSON.parse(fs.readFileSync(f.path + '.gather.json', 'utf8')); if (s.date) date = new Date(s.date); } catch {}
      if (!date) { try { const st = fs.statSync(f.path); date = st.birthtime || st.mtime; } catch {} }
      if (from && date && date < from) continue;
      if (to   && date && date > to)   continue;
      dated.push({ ...f, date });
    }
    if (dated.length === 0) throw new Error('No files found in that date range');

    const byFolder = new Map();
    for (const f of dated) {
      const folder = path.dirname(f.path);
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(f);
    }
    const labeled = [...byFolder.entries()].map(([, files]) => ({
      startDate: files.find(f => f.date)?.date || null,
      misc: false,
      files: files.map(f => ({ path: f.path, type: f.type, date: f.date })),
    }));

    update('Generating recap video…', 30);
    const cfg       = loadConfig();
    const outputBase = cfg.outputFolder || path.join(os.homedir(), 'Desktop', 'Journals');
    fs.mkdirSync(outputBase, { recursive: true });
    const outPath = path.join(outputBase, `Recap-${Date.now()}.mp4`);

    await recap.generate(labeled, outputBase, {
      recap: true, recapType: recapType || 'mix',
      duration: duration || '1min', cutSpeed: cutSpeed || 'normal',
      outputPath: outPath,
    }, (pct) => update('Generating recap video…', 30 + Math.round(pct * 0.65)));

    recapJobs.set(jobId, { status: 'done', progress: 100, message: 'Done!', outputPath: outPath });
  } catch (err) {
    recapJobs.set(jobId, { status: 'error', progress: 0, message: err.message, error: err.message });
  }
}

// ── FCPXML export ─────────────────────────────────────────────────────────────

router.post('/export/fcpxml', (req, res) => {
  const { assembly, title, date, videoPath, pacingParams } = req.body;
  if (!assembly || !assembly.length) return res.status(400).json({ error: 'No assembly data' });

  try {
    const fcpxml  = require('../lib/fcpxml');
    const xml     = fcpxml.generate({ assembly, title, date, pacingParams });
    const now2    = new Date();
    const hhmm2   = `${String(now2.getHours()).padStart(2,'0')}${String(now2.getMinutes()).padStart(2,'0')}`;
    const outName = `${(title || 'Slice of Life').replace(/[^a-z0-9 _-]/gi, '_')}_${hhmm2}.xml`;
    const outPath = path.join(os.homedir(), 'Downloads', outName);
    fs.writeFileSync(outPath, xml, 'utf8');
    res.json({ ok: true, filePath: outPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Journals browser ──────────────────────────────────────────────────────────

router.get('/journals/all', (req, res) => {
  const cfg        = loadConfig();
  const outputBase = cfg.outputFolder || path.join(os.homedir(), 'Desktop', 'Journals');
  try {
    if (!fs.existsSync(outputBase)) return res.json({ journals: [] });
    const journals = fs.readdirSync(outputBase, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const dir      = path.join(outputBase, e.name);
        const mp4s     = fs.readdirSync(dir).filter(f => f.endsWith('.mp4'));
        const txts     = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
        if (!mp4s.length) return null;
        const videoPath = path.join(dir, mp4s[0]);
        const textPath  = txts.length ? path.join(dir, txts[0]) : null;
        const stat      = fs.statSync(videoPath);
        const isTrip    = e.name.startsWith('Trip-');
        return { name: e.name, videoPath, textPath, mtime: stat.mtime, isTrip };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ journals });
  } catch { res.json({ journals: [] }); }
});

router.get('/journals/text', (req, res) => {
  const { textPath } = req.query;
  if (!textPath) return res.status(400).end();
  const cfg        = loadConfig();
  const outputBase = cfg.outputFolder || path.join(os.homedir(), 'Desktop', 'Journals');
  if (!path.resolve(textPath).startsWith(outputBase)) return res.status(403).end();
  try {
    res.send(fs.readFileSync(textPath, 'utf8'));
  } catch { res.status(404).end(); }
});

// ── Recent journals (for home banner) ────────────────────────────────────────

router.get('/journals/recent', (req, res) => {
  try {
    // Start with export-log entries (authoritative, have metadata)
    const fromLog = loadExports()
      .filter(e => { try { return fs.existsSync(e.videoPath); } catch { return false; } });

    // Sort newest first, then deduplicate by name (date folder) so re-renders
    // of the same day's footage only appear once in the slideshow.
    const seenNames = new Set();
    const journals = [...fromLog]
      .sort((a, b) => {
        const ta = a.exportedAt ? new Date(a.exportedAt).getTime() : 0;
        const tb = b.exportedAt ? new Date(b.exportedAt).getTime() : 0;
        return tb - ta;
      })
      .filter(e => {
        if (seenNames.has(e.name)) return false;
        seenNames.add(e.name);
        return true;
      })
      .slice(0, 30)
      .map(e => ({ name: e.name, videoPath: e.videoPath, thumbPath: e.thumbPath || null }));

    res.json({ journals });
  } catch { res.json({ journals: [] }); }
});

// Clear slideshow history (exports log + thumbnails)
router.post('/journals/clear', (req, res) => {
  try {
    const exportsLog = path.join(os.homedir(), '.gather', 'exports.json');
    const thumbDir   = path.join(os.homedir(), '.gather', 'thumb-cache');
    fs.writeFileSync(exportsLog, '[]', 'utf8');
    if (fs.existsSync(thumbDir)) {
      for (const f of fs.readdirSync(thumbDir)) {
        try { fs.unlinkSync(path.join(thumbDir, f)); } catch {}
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve a pre-computed thumbnail by filename (safe: only serves from thumb-cache dir)
router.get('/journals/thumbfile', (req, res) => {
  const { file } = req.query;
  if (!file || file.includes('/') || file.includes('..')) return res.status(400).end();
  const thumbPath = path.join(os.homedir(), '.gather', 'thumb-cache', file);
  if (!fs.existsSync(thumbPath)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'max-age=604800');
  res.sendFile(thumbPath);
});

router.get('/journals/thumbnail', async (req, res) => {
  const { videoPath } = req.query;
  if (!videoPath) return res.status(400).end();

  // Security: only serve thumbnails for app-built journals
  // Only serve thumbnails for videos the app itself exported.
  const knownPaths = loadExports().map(e => path.resolve(e.videoPath));
  const resolved   = path.resolve(videoPath);
  if (!knownPaths.includes(resolved)) return res.status(403).end();

  // ── Disk cache ────────────────────────────────────────────────────────────
  // Cache key = video path hash + file mtime so stale thumbs auto-invalidate.
  const cacheDir = path.join(os.homedir(), '.gather', 'thumb-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  let mtime = 0;
  try { mtime = fs.statSync(videoPath).mtimeMs; } catch {}
  const cacheKey  = Buffer.from(`${videoPath}:${mtime}`).toString('base64').replace(/[/+=]/g, '_').slice(0, 32);
  const cacheFile = path.join(cacheDir, `${cacheKey}.jpg`);

  if (fs.existsSync(cacheFile)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'max-age=604800'); // 1 week — cache key encodes mtime
    return res.sendFile(cacheFile);
  }

  // ── Best-frame selection ──────────────────────────────────────────────────
  // Sample 8 frames spread across the video, send to Claude, pick the most
  // visually interesting/scenic frame — prioritising sense of place over faces.
  const ffmpeg       = require('ffmpeg-static');
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  async function grabThumbFrame(sec, outPath) {
    await execFileAsync(ffmpeg, [
      '-ss', String(sec), '-i', videoPath,
      '-frames:v', '1', '-q:v', '4', '-vf', 'scale=960:-1',
      '-y', outPath,
    ], { timeout: 8000 });
    return fs.readFileSync(outPath).toString('base64');
  }

  // Probe duration so we can spread frames across the video
  let duration = 60;
  try {
    const r   = await execFileAsync(ffmpeg, ['-i', videoPath], { maxBuffer: 1024 * 1024 }).catch(e => e);
    const out = r.stderr || r.message || '';
    const m   = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) duration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  } catch {}

  const FRAME_COUNT = 8;
  const tmpFiles = Array.from({ length: FRAME_COUNT }, (_, i) =>
    path.join(os.tmpdir(), `yl-tsel-${Date.now()}-${i}.jpg`)
  );

  try {
    // Spread seek points evenly, avoiding the very start/end
    const seekPoints = Array.from({ length: FRAME_COUNT }, (_, i) =>
      Math.min(duration - 1, Math.max(1, (duration / (FRAME_COUNT + 1)) * (i + 1)))
    );

    const frameResults = await Promise.allSettled(
      seekPoints.map((sec, i) => grabThumbFrame(sec, tmpFiles[i]))
    );
    const frames = frameResults
      .map((r, i) => ({ ok: r.status === 'fulfilled', data: r.value, idx: i }))
      .filter(f => f.ok);

    let chosenIdx = 0; // default: first frame

    // Ask Claude to pick the most visually interesting frame
    const cfgData  = loadConfig();
    const apiKey   = cfgData.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (apiKey && frames.length > 1) {
      try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client    = new Anthropic({ apiKey });
        const content   = [];
        frames.forEach((f, pos) => {
          content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.data } });
          content.push({ type: 'text', text: `Frame ${pos + 1}` });
        });
        content.push({
          type: 'text',
          text: `These are ${frames.length} frames from a personal video journal. Pick the single most visually interesting frame to use as a thumbnail. Prefer scenic shots, interesting settings, or wide establishing shots that give a sense of place or atmosphere. Avoid blurry, dark, or very similar frames. Reply with ONLY the frame number (e.g. "3").`,
        });
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5', max_tokens: 5,
          messages: [{ role: 'user', content }],
        });
        const picked = parseInt(msg.content[0].text.trim()) - 1;
        if (!isNaN(picked) && picked >= 0 && picked < frames.length) {
          chosenIdx = frames[picked].idx;
        }
      } catch (err) {
        console.warn('[thumbnail] Claude frame selection failed:', err.message);
      }
    }

    // Copy chosen frame to cache
    fs.copyFileSync(tmpFiles[chosenIdx], cacheFile);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'max-age=604800');
    res.sendFile(cacheFile);
  } catch {
    res.status(500).end();
  } finally {
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function configPath() { return path.join(os.homedir(), '.gather', 'config.json'); }
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

// ── Export log ────────────────────────────────────────────────────────────────
const EXPORTS_LOG = path.join(os.homedir(), '.gather', 'exports.json');

function loadExports() {
  try { return JSON.parse(fs.readFileSync(EXPORTS_LOG, 'utf8')); } catch { return []; }
}

function recordExport(videoPath, name, assembly, thumbPath) {
  try {
    const log      = loadExports();
    const filtered = log.filter(e => e.videoPath !== videoPath);
    filtered.unshift({ videoPath, name, thumbPath: thumbPath || null, exportedAt: new Date().toISOString() });
    fs.mkdirSync(path.dirname(EXPORTS_LOG), { recursive: true });
    fs.writeFileSync(EXPORTS_LOG, JSON.stringify(filtered.slice(0, 50), null, 2));
  } catch {}
}

// ── Re-edit ───────────────────────────────────────────────────────────────────
// POST /api/journal/reedit
// Reads a stored assembly.json sidecar and re-renders with new opts.
// Returns a jobId that /api/journal/status/:jobId can track.

router.post('/journal/reedit', (req, res) => {
  const { assemblyPath, captions, captionStyle, orientation, pacingParams } = req.body;
  if (!assemblyPath) return res.status(400).json({ error: 'assemblyPath required' });

  let sidecar;
  try {
    sidecar = JSON.parse(fs.readFileSync(assemblyPath, 'utf8'));
  } catch (err) {
    return res.status(400).json({ error: `Could not read assembly: ${err.message}` });
  }

  const { assembly } = sidecar;
  if (!Array.isArray(assembly) || !assembly.length) {
    return res.status(400).json({ error: 'Assembly is empty or invalid' });
  }

  const jobId = `journal-${Date.now()}`;
  journalJobs.set(jobId, { status: 'running', progress: 0, message: 'Starting re-edit…' });
  res.json({ ok: true, jobId });

  const { buildJournalVideo } = require('../lib/journal-video');
  const isVertical   = orientation === 'vertical';
  const orientSlug   = isVertical ? '-vertical' : '';
  const captionsOpts = captions ? { enabled: true, style: captionStyle || 'clean' } : null;

  // Derive output path from original video path with a re-edit suffix
  const origVideo = sidecar.videoPath || '';
  const dir       = path.dirname(origVideo) || path.join(os.homedir(), 'Desktop', 'Organized', 'Journals');
  const base      = path.basename(origVideo, '.mp4');
  const now       = new Date();
  const ts        = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  const videoOut  = path.join(dir, `${base}-reedit${orientSlug}-${ts}.mp4`);

  buildJournalVideo(assembly, videoOut, prog => {
    const pct = typeof prog === 'object' ? prog.pct : prog;
    const msg = typeof prog === 'object' && prog.message ? prog.message : 'Re-rendering…';
    const current = journalJobs.get(jobId) || {};
    journalJobs.set(jobId, { ...current, status: 'running', progress: Math.round((pct / 100) * 95), message: msg });
  }, null, pacingParams || null, captionsOpts, { vertical: isVertical }).then(async (renderResult) => {
    const resolvedTimeline = renderResult?.resolvedTimeline || null;
    const MIN_OUTPUT_BYTES = 500 * 1024;
    let size = 0;
    try { size = fs.statSync(videoOut).size; } catch {}
    if (size < MIN_OUTPUT_BYTES) throw new Error('Re-render output too small — render likely failed');

    // Extract thumbnail
    let thumbPath = null;
    try {
      const ffmpeg = require('ffmpeg-static');
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const thumbDir  = path.join(os.homedir(), '.gather', 'thumb-cache');
      fs.mkdirSync(thumbDir, { recursive: true });
      const thumbFile = path.join(thumbDir, path.basename(videoOut, '.mp4') + '.jpg');
      await execFileAsync(ffmpeg, ['-i', videoOut, '-vf', 'thumbnail=300,scale=600:-1', '-frames:v', '1', '-q:v', '4', '-y', thumbFile], { timeout: 30000 });
      thumbPath = thumbFile;
    } catch {}

    // Save new assembly sidecar
    const newAssemblyPath = videoOut.replace(/\.mp4$/, '.assembly.json');
    try {
      fs.writeFileSync(newAssemblyPath, JSON.stringify({
        version: 1, videoPath: videoOut, assembly, resolvedTimeline,
        opts: { captions: captions || false, captionStyle: captionStyle || 'clean', orientation: orientation || 'landscape' },
        createdAt: new Date().toISOString(),
      }, null, 2));
    } catch {}

    const name = path.basename(dir);
    recordExport(videoOut, name, assembly, thumbPath);

    const xmlPath = autoExportXML({ assembly, resolvedTimeline, videoPath: videoOut }, name, pacingParams, orientation);
    const renderOpts = { captions: captions || false, captionStyle: captionStyle || 'clean', orientation: orientation || 'landscape', pacingParams: pacingParams || null, pacing: req.body.pacing || null };
    journalJobs.set(jobId, {
      status: 'done', progress: 100, message: 'Done!',
      videoPath: videoOut, thumbPath, assemblyPath: newAssemblyPath,
      outDir: dir, assembly, xmlPath, renderOpts,
    });
  }).catch(err => {
    journalJobs.set(jobId, { status: 'error', progress: 0, message: err.message, error: err.message });
  });
});

function autoExportXML(result, title, pacingParams, orientation, dayBoundaries) {
  try {
    const fcpxml  = require('../lib/fcpxml');
    const xml     = fcpxml.generate({ assembly: result.assembly, resolvedTimeline: result.resolvedTimeline || null, title, pacingParams, orientation, dayBoundaries });
    const now     = new Date();
    const hhmm    = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const outName = `${(title || 'Slice of Life').replace(/[^a-z0-9 _-]/gi, '_')}_${hhmm}.xml`;
    const outPath = path.join(os.homedir(), 'Downloads', outName);
    fs.writeFileSync(outPath, xml, 'utf8');
    return outPath;
  } catch (err) {
    console.warn('Auto XML export failed:', err.message);
    return null;
  }
}

// ── Speech-to-text ────────────────────────────────────────────────────────────
// Accepts a multipart/form-data upload of an audio file (webm/wav/etc.),
// converts to 16kHz WAV with ffmpeg, runs Whisper, returns { text }.
router.post('/stt', (req, res) => {
  const Busboy     = require('busboy');
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  const ffmpegPath = require('ffmpeg-static');

  function getWhisperBin() {
    const base = path.dirname(require.resolve('nodejs-whisper/package.json'));
    return path.join(base, 'cpp', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
  }
  function getModelPath() {
    const base = path.dirname(require.resolve('nodejs-whisper/package.json'));
    return path.join(base, 'cpp', 'whisper.cpp', 'models', 'ggml-tiny.en.bin');
  }

  const bb = Busboy({ headers: req.headers });
  const tmpIn  = path.join(os.tmpdir(), `stt-in-${Date.now()}.webm`);
  const tmpWav = path.join(os.tmpdir(), `stt-${Date.now()}.wav`);
  const outBase = tmpWav.replace('.wav', '');
  let   wrote  = false;

  bb.on('file', (_fieldname, stream, _info) => {
    wrote = true;
    const ws = fs.createWriteStream(tmpIn);
    stream.pipe(ws);
    ws.on('finish', async () => {
      try {
        // Convert to 16kHz mono WAV
        await execFileAsync(ffmpegPath, [
          '-i', tmpIn, '-ar', '16000', '-ac', '1',
          '-c:a', 'pcm_s16le', '-y', tmpWav,
        ], { timeout: 30000 });

        // Run Whisper
        const whisperResult = await execFileAsync(getWhisperBin(), [
          '-m', getModelPath(),
          '-f', tmpWav,
          '--output-txt',
          '-of', outBase,
          '--language', 'en',
          '--no-timestamps',
          '--threads', '4',
        ], { maxBuffer: 5 * 1024 * 1024, timeout: 60000 });
        console.log('[stt] whisper stdout:', whisperResult.stdout?.slice(0, 300));
        console.log('[stt] whisper stderr:', whisperResult.stderr?.slice(0, 300));

        const txtFile = outBase + '.txt';
        const txtExists = fs.existsSync(txtFile);
        console.log('[stt] output file exists:', txtExists, txtFile);
        let text = '';
        try { text = fs.readFileSync(txtFile, 'utf8').trim(); } catch (e) { console.warn('[stt] read failed:', e.message); }
        console.log('[stt] transcribed text:', JSON.stringify(text));
        res.json({ text });
      } catch (err) {
        console.warn('[stt] error:', err.message);
        res.json({ text: '', error: err.message });
      } finally {
        for (const f of [tmpIn, tmpWav, outBase + '.txt']) {
          try { fs.unlinkSync(f); } catch {}
        }
      }
    });
  });

  bb.on('finish', () => {
    if (!wrote) res.json({ text: '', error: 'No audio received' });
  });

  req.pipe(bb);
});

module.exports = router;
