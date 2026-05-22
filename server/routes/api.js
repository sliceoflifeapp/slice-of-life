const router    = require('express').Router();
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const credits   = require('../lib/credits');
const analytics = require('../lib/analytics');
const { getAppDataDir, updateStyleProfile, getStyleDefaults } = require('../lib/app-data');

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
    const ownKey    = cfg.anthropicApiKey || '';
    const logPath   = path.join(getAppDataDir(), 'debug-last-run.log');
    const logExists = fs.existsSync(logPath);
    res.json({
      hasOwnApiKey:    !!cfg.anthropicApiKey,
      hasDevKey:       !!process.env.ANTHROPIC_API_KEY,
      keyHint:         ownKey ? ownKey.slice(0, 8) + '…' : null,
      outputFolder:    cfg.outputFolder || path.join(os.homedir(), 'Movies', 'Slices'),
      openWhenDone:    cfg.openWhenDone !== false,
      isOnline,
      renderLogPath:   logPath,
      renderLogExists: logExists,
      styleDefaults:   getStyleDefaults(),
    });
  });
});

router.post('/settings', (req, res) => {
  try {
    const cfgPath = configPath();
    const cfg = loadConfig();
    const { apiKey, outputFolder, openWhenDone } = req.body;
    if (apiKey        !== undefined) cfg.anthropicApiKey = apiKey;
    if (outputFolder  !== undefined) cfg.outputFolder    = outputFolder;
    if (openWhenDone  !== undefined) cfg.openWhenDone    = openWhenDone;
    if (req.body.visionBackend !== undefined) cfg.visionBackend = req.body.visionBackend;
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    // Reset vision router cache so the new backend takes effect on next render
    try { require('../lib/clip-vision').resetBackendCache(); } catch {}
    console.log(`[settings] saved to ${cfgPath} — hasKey=${!!cfg.anthropicApiKey} vision=${cfg.visionBackend || 'apple'}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[settings] save failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Today's prompt ───────────────────────────────────────────────────────────

const PROMPT_FALLBACKS = [
  { narration: "What's one thing from today you'd want to remember in a year?",        filming: "Where you are right now, anything that felt unremarkable but wasn't" },
  { narration: "Describe where you are like you're reading it back in 10 years.",      filming: "The space around you, details you'd normally walk past" },
  { narration: "What surprised you today — even if it was small?",                     filming: "Something you encountered that you almost didn't notice" },
  { narration: "Who did you spend time with today, and what did you actually talk about?", filming: "The place you were together, something they showed you" },
  { narration: "What are you in the middle of right now — and how is it going?",       filming: "Your workspace, your tools, whatever you're working with" },
  { narration: "What feeling kept coming back today, even if you couldn't name it?",   filming: "Something in your environment that matches that energy" },
  { narration: "What do you want to remember about where you are in life right now?",  filming: "The view from wherever you're standing, something personal nearby" },
  { narration: "What's something you did today that future you will be glad you documented?", filming: "The moment itself, or wherever you are when you think about it" },
];

router.get('/prompt/today', async (req, res) => {
  const todayStr  = new Date().toISOString().slice(0, 10);
  const cacheFile = path.join(getAppDataDir(), 'prompt-cache.json');

  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.date === todayStr) return res.json({ ok: true, ...cached });
  } catch {}

  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  const fallback  = PROMPT_FALLBACKS[dayOfYear % PROMPT_FALLBACKS.length];

  const transcripts = loadExports()
    .filter(e => e.transcriptExcerpt)
    .slice(0, 4)
    .map((e, i) => `Journal ${i + 1}: "${e.transcriptExcerpt}"`);

  const cfg    = loadConfig();
  const apiKey = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

  if (!apiKey || !transcripts.length) {
    return res.json({ ok: true, date: todayStr, ...fallback });
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `You are a warm, professional personal video journal coach. Keep all suggestions encouraging, constructive, and appropriate for a general audience. Never reference sensitive personal topics, health struggles, conflict, or anything that could feel intrusive or uncomfortable. Focus on everyday moments, personal growth, creativity, and visual storytelling. Always maintain a positive, motivating tone.`,
      messages: [{ role: 'user', content:
        `Here are transcript excerpts from someone's recent video journals:\n\n${transcripts.join('\n')}\n\nGenerate a single daily prompt card with two parts:\n1. A narration prompt (what to say to camera) — personal, picks up a thread from their actual life, 1-2 sentences\n2. A filming nudge (what to film) — visual, practical, 1-2 short phrases\n\nRespond ONLY with valid JSON: {"narration": "...", "filming": "..."}\n\nKeep both warm and conversational. The narration should feel like it responds to their specific life, not a generic question.`,
      }],
    });
    const parsed = JSON.parse(msg.content[0].text.trim());
    if (!parsed.narration || !parsed.filming) throw new Error('bad response');
    const result = { date: todayStr, narration: parsed.narration, filming: parsed.filming };
    fs.mkdirSync(getAppDataDir(), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.warn('[prompt] generation failed:', err.message);
    return res.json({ ok: true, date: todayStr, ...fallback });
  }
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
    updateStyleProfile({ pacing: req.body.pacing, brollStyle: req.body.brollStyle, captions: pipelineOpts.captions, captionStyle: pipelineOpts.captionStyle }, 1);
    recordExport(result.videoPath, name, result.assembly, result.thumbPath, folderPath, result.transcriptExcerpt, result.footageDates, result.stats?.rawDurationSec, result.stats?.totalClips);
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
      const logHint = err.debugLogPath ? ` Debug log: ${err.debugLogPath}` : '';
      journalJobs.set(jobId, { status: 'no_aroll', progress: 0, message: `No narration detected.${logHint}`,
        debugLogPath: err.debugLogPath || null,
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
    const outputBase = cfg.outputFolder || path.join(os.homedir(), 'Movies', 'Slices');
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
  const outputBase = cfg.outputFolder || path.join(os.homedir(), 'Movies', 'Slices');
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
  const outputBase = cfg.outputFolder || path.join(os.homedir(), 'Movies', 'Slices');
  if (!path.resolve(textPath).startsWith(outputBase + path.sep)) return res.status(403).end();
  try {
    res.send(fs.readFileSync(textPath, 'utf8'));
  } catch { res.status(404).end(); }
});

// ── Lifetime stats (for home micro-stats row) ────────────────────────────────
// Returns slices (unique rendered videos still on disk), days (unique calendar
// days with at least one export), and minutes (sum of output video durations).

router.get('/stats', async (req, res) => {
  try {
    const allExports = loadExports();
    const existing   = allExports.filter(e => { try { return e.videoPath && fs.existsSync(e.videoPath); } catch { return false; } });

    const slices = existing.length;

    // Clips sorted = sum of totalClips stored at render time.
    // Old entries fall back to counting files in the source folder.
    const scannerStats = require('../lib/scanner');
    const VIDEO_EXTS_COUNT = new Set(['.mp4','.m4v','.mov','.avi','.mkv','.mts','.m2ts','.webm']);
    let totalClips = 0;
    for (const e of allExports) {
      if (e.clipCount) {
        totalClips += e.clipCount;
      } else if (e.folderPath) {
        try {
          const files = scannerStats.fullScan(e.folderPath).filter(f => VIDEO_EXTS_COUNT.has(f.ext));
          totalClips += files.length;
        } catch {}
      }
    }

    // Raw footage = sum of rawDurationSec stored at render time.
    // New entries have it; old entries fall back to probing the output file.
    const ffmpeg = require('ffmpeg-static');
    const { execFile: execFileStats } = require('child_process');
    const { promisify: promisifyStats } = require('util');
    const execFileStatsAsync = promisifyStats(execFileStats);
    let totalRawSec = 0;
    const VIDEO_EXTS_STATS = new Set(['.mp4','.m4v','.mov','.avi','.mkv','.mts','.m2ts','.webm']);
    const scanner = require('../lib/scanner');
    await Promise.all(allExports.map(async e => {
      if (e.rawDurationSec) {
        totalRawSec += e.rawDurationSec;
      } else if (e.folderPath) {
        // Older entry — probe all source clips in the original folder
        try {
          const clips = scanner.fullScan(e.folderPath).filter(f => VIDEO_EXTS_STATS.has(f.ext));
          await Promise.all(clips.map(async f => {
            try {
              const r = await execFileStatsAsync(ffmpeg, ['-i', f.path], { timeout: 4000 }).catch(err => err);
              const m = (r.stderr || r.message || '').match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
              if (m) totalRawSec += parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
            } catch {}
          }));
        } catch {}
      }
    }));
    const rawMin = totalRawSec > 0 ? Math.max(1, Math.round(totalRawSec / 60)) : 0;
    const footage = rawMin >= 60
      ? `${Math.floor(rawMin / 60)}h ${rawMin % 60}m`
      : `${rawMin}m`;

    res.json({ slices, clips: totalClips, footage });
  } catch { res.json({ slices: 0, clips: 0, footage: '0m' }); }
});

// ── Recent journals (for home banner) ────────────────────────────────────────

router.get('/journals/recent', (req, res) => {
  try {
    // Start with export-log entries (authoritative, have metadata)
    const allExports = loadExports();
    const fromLog = allExports
      .filter(e => { try { return fs.existsSync(e.videoPath); } catch { return false; } });

    // Sort newest first, then deduplicate:
    // - Same exact videoPath → same file, keep newest only
    // - Same source folderPath → same footage re-rendered, keep newest only
    // - Different folderPath → genuinely different footage, show both even if same day
    const seenVideoPaths  = new Set();
    const seenSrcFolders  = new Set();
    const journals = [...fromLog]
      .sort((a, b) => {
        const ta = a.exportedAt ? new Date(a.exportedAt).getTime() : 0;
        const tb = b.exportedAt ? new Date(b.exportedAt).getTime() : 0;
        return tb - ta;
      })
      .filter(e => {
        const vp = path.resolve(e.videoPath);
        if (seenVideoPaths.has(vp)) return false;
        if (e.folderPath && seenSrcFolders.has(e.folderPath)) return false;
        seenVideoPaths.add(vp);
        if (e.folderPath) seenSrcFolders.add(e.folderPath);
        return true;
      })
      .slice(0, 30)
      .map(e => ({ name: e.name, videoPath: e.videoPath, thumbPath: e.thumbPath || null }));

    res.json({ journals, streak: calcStreak(allExports), hasHistory: allExports.some(e => e.exportedAt) });
  } catch { res.json({ journals: [], streak: 0, hasHistory: false }); }
});

// Clear slideshow history (thumbnails + display data) but preserve streak dates
router.post('/journals/clear', (req, res) => {
  try {
    const thumbDir = path.join(getAppDataDir(), 'thumb-cache');
    // Strip display fields from each entry — keeps exportedAt/name for streak
    const stripped = loadExports().map(e => ({ name: e.name, exportedAt: e.exportedAt }));
    fs.writeFileSync(EXPORTS_LOG, JSON.stringify(stripped, null, 2));
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
// Falls back to generating the thumbnail live if the cached file is missing.
router.get('/journals/thumbfile', async (req, res) => {
  const { file } = req.query;
  if (!file || file.includes('/') || file.includes('..')) return res.status(400).end();
  const thumbPath = path.join(getAppDataDir(), 'thumb-cache', file);

  if (!fs.existsSync(thumbPath)) {
    // Try to regenerate from the matching export entry
    const entry = loadExports().find(e => e.videoPath && path.basename(e.videoPath, '.mp4') + '.jpg' === file);
    if (!entry || !entry.videoPath || !fs.existsSync(entry.videoPath)) return res.status(404).end();
    try {
      const ffmpeg = require('ffmpeg-static');
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
      // Fast seek to 20% into the video — avoids the slow thumbnail=300 filter
      // which reads hundreds of frames and reliably times out on large files.
      let seekSec = 5;
      try {
        const probe = await promisify(execFile)(ffmpeg, ['-i', entry.videoPath], { timeout: 5000 }).catch(e => e);
        const m = (probe.stderr || probe.message || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) seekSec = Math.max(1, (parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])) * 0.35);
      } catch {}
      await promisify(execFile)(ffmpeg, ['-ss', String(seekSec), '-i', entry.videoPath, '-frames:v', '1', '-q:v', '4', '-vf', 'scale=600:-1', '-y', thumbPath], { timeout: 10000 });
    } catch { return res.status(404).end(); }
  }

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
  const cacheDir = path.join(getAppDataDir(), 'thumb-cache');
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

    if (frames.length === 0) { res.status(404).end(); return; }
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

function configPath() { return path.join(getAppDataDir(), 'config.json'); }
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

// ── Export log ────────────────────────────────────────────────────────────────
const EXPORTS_LOG = path.join(getAppDataDir(), 'exports.json');

function loadExports() {
  try { return JSON.parse(fs.readFileSync(EXPORTS_LOG, 'utf8')); } catch { return []; }
}

function calcStreak(exports) {
  const toStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const days = new Set(exports.filter(e => e.exportedAt).map(e => toStr(new Date(e.exportedAt))));
  if (!days.size) return 0;
  const check = new Date();
  // Allow streak to stay alive if user hasn't filmed today yet
  if (!days.has(toStr(check))) check.setDate(check.getDate() - 1);
  if (!days.has(toStr(check))) return 0;
  let streak = 0;
  while (days.has(toStr(check))) { streak++; check.setDate(check.getDate() - 1); }
  return streak;
}

function recordExport(videoPath, name, assembly, thumbPath, folderPath, transcriptExcerpt, footageDates, rawDurationSec, clipCount) {
  try {
    const log      = loadExports();
    const filtered = log.filter(e => e.videoPath !== videoPath);
    filtered.unshift({ videoPath, name, thumbPath: thumbPath || null, folderPath: folderPath || null, transcriptExcerpt: transcriptExcerpt || null, footageDates: footageDates || null, rawDurationSec: rawDurationSec || null, clipCount: clipCount || null, exportedAt: new Date().toISOString() });
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

  // Restrict reads to the assembly-cache directory — prevents arbitrary file reads
  // from a malicious process posting a crafted assemblyPath.
  const assemblyCache = path.join(getAppDataDir(), 'assembly-cache');
  if (!path.resolve(assemblyPath).startsWith(assemblyCache + path.sep)) {
    return res.status(403).json({ error: 'Invalid assembly path' });
  }

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

  // Derive output path from original video — same folder, same date, categories at end
  const origVideo   = sidecar.videoPath || '';
  const dir         = path.dirname(origVideo) || path.join(os.homedir(), 'Movies', 'Slices');
  const dateMatch   = path.basename(origVideo).match(/(\d{4}-\d{2}-\d{2})/);
  const datePart    = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
  const isHighlight = /highlight/i.test(path.basename(origVideo));
  const hlSlug      = isHighlight ? '-highlight' : '';
  const videoOut    = path.join(dir, `${datePart}${hlSlug}${orientSlug}.mp4`);

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
      const thumbDir  = path.join(getAppDataDir(), 'thumb-cache');
      fs.mkdirSync(thumbDir, { recursive: true });
      const thumbFile = path.join(thumbDir, path.basename(videoOut, '.mp4') + '.jpg');
      await execFileAsync(ffmpeg, ['-i', videoOut, '-vf', 'fps=1,thumbnail=60,scale=600:-1', '-frames:v', '1', '-q:v', '4', '-y', thumbFile], { timeout: 30000 });
      thumbPath = thumbFile;
    } catch {}

    // Save new assembly sidecar
    const assemblyCache   = path.join(getAppDataDir(), 'assembly-cache');
    fs.mkdirSync(assemblyCache, { recursive: true });
    const newAssemblyPath = path.join(assemblyCache, path.basename(videoOut).replace(/\.mp4$/, '.assembly.json'));
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
    updateStyleProfile({ pacing: req.body.pacing, captions, captionStyle }, 2);
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

  function whisperBase() {
    return path.dirname(require.resolve('nodejs-whisper/package.json'))
      .replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
  }
  function getWhisperBin() {
    return path.join(whisperBase(), 'cpp', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
  }
  function getModelPath() {
    return path.join(whisperBase(), 'cpp', 'whisper.cpp', 'models', 'ggml-tiny.en.bin');
  }

  const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 100 * 1024 * 1024 } });
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

        // Set DYLD_LIBRARY_PATH so whisper-cli finds all its dylibs in the app bundle
        const buildBase = path.join(whisperBase(), 'cpp', 'whisper.cpp', 'build');
        const libDir = [
          path.join(buildBase, 'src'),
          path.join(buildBase, 'ggml', 'src'),
          path.join(buildBase, 'ggml', 'src', 'ggml-blas'),
          path.join(buildBase, 'ggml', 'src', 'ggml-metal'),
        ].join(':');
        const whisperResult = await execFileAsync(getWhisperBin(), [
          '-m', getModelPath(),
          '-f', tmpWav,
          '--output-txt',
          '-of', outBase,
          '--language', 'en',
          '--no-timestamps',
          '--threads', '4',
        ], {
          env: { ...process.env, DYLD_LIBRARY_PATH: libDir },
          maxBuffer: 5 * 1024 * 1024,
          timeout: 60000,
        });
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
