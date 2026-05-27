# Slice of Life

Electron + Express video journaling app. Records a day's worth of iPhone/camera footage and auto-edits it into a narrated journal video with b-roll cutaways, captions, and a Premiere XML export.

## Launch

```bash
sol             # shell alias (new terminal tab)
gather          # old alias still works
npm start       # from project root
```

## Architecture

- `main.js` — Electron shell, IPC bridges (selectFolder, selectFiles, openPath, getFilePath); runs one-time migration `~/.gather` → `~/.slice-of-life` on first launch
- `server/` — Express API server embedded in Electron
  - `routes/api.js` — all HTTP endpoints
  - `lib/journal-pipeline.js` — orchestrates the full single-day pipeline
  - `lib/journal-video.js` — ffmpeg video assembly (rotation, bg blur, captions, encoding)
  - `lib/clip-vision.js` — unified vision classifier; currently Claude Vision backend; being replaced by Apple Vision Framework binary (see below)
  - `lib/clip-vision-claude.js` — original Claude Vision implementation (3-frame sampling); kept as fallback
  - `lib/clip-vision-apple.js` — Apple Vision Framework backend (in progress); calls `vision-cli` Swift binary; full-frame analysis via AVFoundation
  - `bin/vision-cli` — compiled Swift binary; uses AVFoundation + Vision Framework; returns JSON with `hasFace`, `isTalkingHead`, `qualityScore`, `suggestedRotation`, `facePresenceRatio`
  - `lib/fcpxml.js` — Premiere Pro xmeml v4 XML generator
  - `lib/trip-pipeline.js` — deleted (was retired; removed in dead code purge)
- `ui/` — plain HTML/CSS/JS frontend
  - `home.html` / `js/home.js` — home screen, source picker, recent slideshow
  - `js/settings.js` — settings panel (API key, output folder, slideshow clear)
  - `configure.html` — configure screen (duration, pacing, captions, orientation)
  - `journal.html` — progress/results screen
  - `css/main.css` — shared styles (Montserrat font, glass button system, ambient glow)
  - `js/orbs.js` — ambient light source; `introProgress` lerps position from bottom-left → upper-right on launch; `celebProgress` controls bloom on export; exposes `window.runIntroOrb(onDone)`, `window.celebrateOrb()`, `window.dimOrb(onDone)`

## Key Technical Details

### Video encoding (`journal-video.js`)
- Output: libx264, CRF, preset=fast, `-r 30` (constant frame rate — prevents freeze-at-paragraph-end)
- Captions: ASS format via ffmpeg `subtitles` filter with `force_style` and `original_size=WxH`
  - All styles use `BorderStyle=1, Outline=0, Shadow=0` (no black background box)
  - Sekuya style FontSize=17
- iPhone rotation: `rotate` tag vs display matrix handled separately
  - Display matrix angle is negated before normalizing: `(-matRot + 360) % 360`
  - `rotFromTag` boolean distinguishes the two cases
- Vertical export (9:16): landscape clips get blur bars top/bottom + center crop fg
  - bg: `force_original_aspect_ratio=increase,crop`
  - fg: `scale=-2:900,crop=1080:900`
  - Captions: `original_size=1080x1920`, MarginV=80, font scaled to 65%

### Clip assembly
- A-roll = narration (face detected), B-roll = cutaway footage
- `buildInterleaved`: alternates face/broll slots within each narration section
- B-roll matched to nearest narration section by `filledAt` timestamp
- Overflow b-roll plays after narration section

### Exports
- Video saved to `~/Movies/Slices/` (no date subdirectory — file per render)
- XML saved to `~/Downloads/` with HH-MM timestamp in filename
- Export log: `{userData}/exports.json` — used for recent slideshow thumbnails
- Thumbnail security: both sides use `path.resolve()` before comparing

### Data directory
- All app data lives in `~/Library/Application Support/slice-of-life/` (`app.getPath('userData')`)
  - config.json, exports.json, thumb-cache/, debug-last-run.log
- `server/lib/app-data.js` — centralizes the path: tries `electron.app.getPath('userData')`, falls back to `~/.slice-of-life/` when running outside Electron
- Migration chain runs in `main.js` on startup: `~/.gather/` → `~/.slice-of-life/` → userData
  - Copies config.json + exports.json; renames thumb-cache (move, not copy)

### Orientation
- Landscape (default): 16:9, detects resolution from clip pool
- Vertical: 1080x1920 output, selected in configure screen
- XML generator scales clips to fit sequence frame (motionScale/motionFilter)

### Credits
- Stored in `~/.slice-of-life/credits.json`, default 500
- `credits.deduct()` exists but is not yet wired into the pipeline — renders are currently free
- Lemon Squeezy planned as payment processor for future credit top-ups (license key flow for beta)

### Apple Vision Framework migration
- **Goal**: replace Claude Vision for all perception tasks (face detection, talking head classification, rotation, quality scoring) with on-device Apple Vision Framework. Claude retains all understanding tasks (semantic b-roll assignment, best window selection, story arc, thumbnail selection, today's prompt).
- **Why**: full-frame analysis (every frame vs. 3 samples), faster, no API cost for perception, stronger privacy story ("everything runs on your Mac, including the analysis"), more reliable on edge cases (backlit clips, partial faces, mid-clip camera pans).
- **Architecture**: same inputs/outputs as current `clip-vision.js` — `hasFace`, `isTalkingHead`, `qualityScore`, `suggestedRotation`. Drop-in replacement. Pipeline, edit logic, and UI unchanged.
- **Backend selection**: `visionBackend` flag in config (`'apple' | 'claude'`). If `vision-cli` binary fails to load, auto-falls back to Claude. Both backends live side-by-side during transition.
- **Swift binary (`vision-cli`)**: follows same pattern as `whisper-cli` — compiled for arm64, bundled in `app.asar.unpacked`, dylibs alongside binary, quarantine stripped on first run. Returns JSON to stdout.
- **What `vision-cli` detects per clip**:
  - `hasFace` — boolean, face present in any frame
  - `facePresenceRatio` — float 0–1, fraction of frames with a detected face
  - `isTalkingHead` — boolean, face present + forward-facing for majority of clip
  - `suggestedRotation` — 0/90/180/270, inferred from video stream natively (replaces metadata tag + display matrix delta logic)
  - `qualityScore` — float 0–100, based on sharpness, exposure, motion blur per frame
- **Claude Vision tasks that remain**:
  - Semantic b-roll assignment (`clip.semanticSection`)
  - `findBestWindow` transcript excerpt selection
  - Story arc generation for multi-day footage
  - Thumbnail scenic-preference selection
  - Today's Prompt coaching suggestions
- **Distribution**: same `DYLD_LIBRARY_PATH` pattern as Whisper — set all Vision Framework paths in `execFileAsync` env. Test on a second machine before shipping.
- **Files to rename before starting**: `clip-vision.js` → `clip-vision-claude.js`; new `clip-vision-apple.js` written fresh; `clip-vision.js` becomes a thin router that reads `visionBackend` from config and requires the correct backend.

### UI design system
- Font: Montserrat (local, `/fonts/Montserrat-Regular.ttf`), `zoom: 1.1` on `.inner`
- Titles: `font-weight: 700`, `text-transform: uppercase`, `letter-spacing: 0.06em`
- Primary buttons + mode cards: glass style — `rgba(50,110,225,0.52)` fill, bright border `rgba(120,185,255,0.38)`, inset top highlight, blue outer glow
- Background: single static radial glow anchored upper-right (`orbs.js`), replaces old animated orbs

## Recent Work (session log)

- Fixed high CPU: changed encode preset `medium` → `fast`
- Fixed black caption backgrounds: added `BorderStyle=1` to all ASS styles
- Fixed video freeze at paragraph end: added `-r 30` to ENCODE_FLAGS
- Fixed XML stale filenames: added HH-MM timestamp to output filename
- Removed SRT export option
- Reduced Sekuya font size to 17
- Merged "Detecting narration" + "Transcribing" into single "Analysing & transcribing" step
- Added folder memory (localStorage) + "use last folder" chip on home screen
- Added vertical (9:16) export mode with full blur-bar treatment for landscape clips
- Fixed iPhone selfie upside-down: negated display matrix rotation direction
- Fixed portrait b-roll sideways in vertical mode: always apply rotation to broll when isVertical
- Fixed captions in top half of vertical frame: added `original_size` to subtitles filter
- Fixed captions/orientation lost on retry: spread into savedOpts
- Fixed slideshow thumbnails (403): path.resolve on both sides of security check
- Fixed slideshow lazy load in Electron: removed `loading="lazy"` attribute
- Fixed vertical XML sequence dimensions: 1080x1920 when orientation=vertical
- Fixed vertical XML clip zoom: motionScale() computes letterbox scale per clip
- Renamed "Start a new day" to "Start a new Slice"
- Replaced face-detect.js + score-broll.js with unified `clip-vision.js`
- clip-vision.js: extracts 3 frames at 20/50/80%, pre-rotates using metadata, asks Claude for additional correction
- clip-vision.js: `finalRotation = (metadataRot + additionalRot) % 360`; `suggestedRotation=null` falls back to metadata
- Fixed rotation strategy: aroll always applies rotation; broll with display matrix only applies Vision rotation if `hasFace`
- Fixed aroll section freeze: rewritten interleave loop, frame-rounding on narrDur, trim/atrim clamps, fps=30 on concat, duration directives, PCM+MKV intermediate sections
- Highlight Reel toggle: skips narration detection, cuts best shots together
- No-music/no-captions concat: re-encode with `-r 30` + ENCODE_FLAGS
- UI overhaul: replaced animated orbs with single static ambient glow (upper-right corner)
- UI: switched font to Montserrat, zoom: 1.1 on .inner
- UI: primary buttons and mode cards converted to glass style
- UI: titles all-caps, font-weight 700
- UI: removed "Open journal folder when done" setting
- UI: removed day title cards toggle from trip mode
- UI: duration pills show time only (no descriptor labels)
- UI: 1-min pill label changed from "Highlight reel" to "Quick cut"
- UI: "Customise" → "Customize"
- UI: Save button moved below slideshow clear option in settings
- Renamed app throughout: `~/.gather/` → `~/.slice-of-life/`, `~/Movies/Gather/` → `~/Movies/Slice of Life/`
- Auto-migration of `~/.gather/` → `~/.slice-of-life/` added to main.js startup
- Sidecar reads fall back to `.gather.json` if `.slice-of-life.json` not found
- Added `sol` shell alias; `gather` alias retained for compatibility
- Fixed settings.js: removed stale reference to deleted `open-when-done` checkbox
- Built and distributed beta DMG (`dist/Slice of Life-0.1.0-arm64.dmg`) with white camera icon
- **Unified pipeline (v0.1.26)**: Trip mode retired; multi-day detection built into `journal-pipeline.js` — clips grouped by creation date, `dayIndex` tagged per clip, story arc Claude Haiku prompt generated for cross-day footage and passed as context to semantic b-roll assignment. Single "Build Your Slice" mode card replaces Single Day + Trip
- Output folder renamed `Movies/Slices`; exports placed directly in folder (no date subdirectory)
- Slideshow: placeholder gradient cards fill strip when < 8 real renders; banner animation 80.5s; thumbnail seek at 35% of output duration; dedup by `videoPath` + `folderPath`
- Streak counter: always shows line/glow; shows "Let's make your first Slice" on day 0, streak count thereafter; nested inside `.recent-section` for correct vertical centering
- Synthesized sound effects via Web Audio API (`ui/js/sound.js`): `playIntroSound()` (3 sine pads, no whoosh) on intro animation; `playDoneSound()` (two-note chime C5→G5) on export complete
- Finder button on done screen fixed: `-webkit-app-region: no-drag` on `.done-location`; uses `showInFinder(videoPath)` to select file in Finder
- Intro animation click-through fixed: `pointer-events: all` during `.active`, `pointer-events: none` after `.done`
- Added re-edit panel: cut rhythm presets (Tight/Balanced/Relaxed), orientation, captions, caption style
- Re-edit captions toggle: `<button>` with `width:100%; font-family:inherit; text-align:left; -webkit-app-region:no-drag` — MUST stay a `<button>`, plain `<div>` is swallowed by Electron drag region and appears unclickable. This has reverted twice from worktree copies — always verify after any journal.html cp.
- Re-edit caption style cards: `@font-face` + `[data-style]` CSS so each card displays in its actual font
- Added offline mode check: `/api/settings` now DNS-probes `api.anthropic.com` and returns `isOnline`
- Fixed XML broll mismatch: `resolvedTimeline` emitted by `buildInterleaved` passed to `fcpxml.generate()` — broll selection and cut timing now guaranteed to match the MP4
- XML rotation: `xmlMotionRotation(clip, clipType)` computes delta between what ffmpeg applied and what Premiere auto-reads (rotate TAG vs display matrix); `motionRotationXml()` emits Basic Motion filter
- XML audio: track 1 = narration (v1 aroll clips), track 2 = ambient broll (v2 clips); both use sourcetrack index 1
- XML `buildFromTimeline`: groups resolvedTimeline by aroll clip path; V1 spans narr-only, V2 has broll at exact timeline positions
- XML `clipType` now carried through all v1/v2 push calls so rotation filter is applied per clip type
- Fixed XML button broken after re-edits: reedit endpoint now calls `autoExportXML` and returns `xmlPath`
- Sidecar JSON size: `slimClip()` strips clip objects to 8 fcpxml-needed fields before storing in resolvedTimeline — avoids serializing transcript.segments arrays repeatedly
- `CONCURRENCY = 1` in `buildInterleaved` — sections render sequentially; keeps fan manageable. Has reverted to 2 or 3 multiple times from worktree copies — always edit main project directly and verify.
- Highlight reel mode: Vision pass runs on all clips; talking-head clips are demoted to b-roll at reduced score (max 40) rather than skipped — prevents crash when all clips are face-forward. Short clips (< TALKING_HEAD_MIN_SEC) now also run Vision for rotation + quality data.
- Fixed highlight reel upside-down clips: Vision `suggestedRotation` is only applied to b-roll when `hasFace=true`; b-roll with no detected face uses metadata tag only and never trusts Vision rotation.
- Fixed tight-pacing producing almost all a-roll: `MIN_FACE_SEG` and `MIN_BROLL_SEG` now scale with pacing params (`max(0.8, min(1.5, FACE_DUR * 0.5))` and `max(1.0, min(2.0, BROLL_CUT * 0.5))`).
- Fixed re-edit pacing label defaulting to "tight": store `pacing` label explicitly in renderOpts; no longer inferred from brollCut value.
- Fixed caption style cards unclickable in re-edit panel: added `-webkit-app-region: no-drag` to `.reedit-cap-card`.
- Fixed re-render orb animation: added `dimOrb()` to `orbs.js` using `runAnimation()` helper; dim branch easing corrected from `Math.pow(1-t, 2)` (inverted, bloomed) to `t * (2-t)` (ease-out quad); `startReedit()` calls `dimOrb()` before switching to processing state.
- Wired `celebrateOrb()` + `onCelebProgress` text brightening into `trip.html` (was missing).
- **Fixed critical config path mismatch**: `api.js` was writing config/exports/thumb-cache to `~/.gather/` while all lib files (`clip-vision.js`, `whisper.js`, `trip-builder.js`) read from `~/.slice-of-life/`. On fresh installs the API key was never found — Vision fell back to offline audio heuristics and narration detection failed entirely. All six path references in `api.js` now use `~/.slice-of-life/`.
- Built and distributed beta DMG v0.1.2 (`dist/Slice of Life-0.1.2-arm64.dmg`) with config path fix.
- **Beta debugging session (v0.1.10–v0.1.17)** — diagnosed and fixed all issues blocking Whisper on a friend's machine:
  - Added `server/lib/app-data.js`: centralizes userData path, used by all lib files and api.js
  - Migrated all config/exports/thumb-cache paths to `app.getPath('userData')` in api.js and all lib files
  - Extended migration chain in main.js: `~/.gather/` → `~/.slice-of-life/` → userData (copies files, doesn't move)
  - Added persistent debug log `{userData}/debug-last-run.log`: written every run, logs Whisper binary/model EXISTS status, per-clip Vision result with `_source` flag, per-clip Whisper result with word count and isTalkingHead outcome
  - Vision `_source` flag: `'online'` when API used, `'offline:no-key'` when no key, `'offline:<err>'` on API error
  - Whisper catch block: returns `_failed: true, _error: err.message` so log can distinguish crash vs no-speech
  - Quarantine removal changed to recursive: `xattr -r -d com.apple.quarantine whisperBase()`
  - `checkWhisper()` called on server startup — logs binary and model path status
  - Settings UI: API key hint (`sk-ant-ap…`) shown after save; "✓ Saved!" toast flashes 1.2s then closes panel
  - POST /settings: wrapped in try/catch, returns `{ ok: false, error }` on failure; GET /settings returns `keyHint`
  - Narration detection is **Whisper-only** — Vision fallback removed. Vision false positives (e.g. clip looks like talking head visually but person isn't narrating) make it unreliable as a fallback
  - **Root cause of Whisper failure**: `whisper-cli` compiled on dev machine with hardcoded rpaths to `/Users/nathangriffey/Desktop/gather/node_modules/...` — these paths don't exist on any other machine. The 6 required dylibs (`libwhisper.1`, `libggml`, `libggml-base`, `libggml-cpu`, `libggml-blas`, `libggml-metal`) are present in the app bundle at `app.asar.unpacked/node_modules/nodejs-whisper/cpp/whisper.cpp/build/` but the binary couldn't find them
  - **Fix**: set `DYLD_LIBRARY_PATH` to all four build output dirs in `execFileAsync` env in both `whisper.js` and the `/api/stt` endpoint: `build/src`, `build/ggml/src`, `build/ggml/src/ggml-blas`, `build/ggml/src/ggml-metal`
  - Confirmed working on friend's machine in v0.1.17 — MP4 and XML both exported correctly
- Americanized spelling throughout UI and logs: "Analyzing" not "Analysing"; step label → "Analyzing & transcribing"
- Added duration enforcement: a-roll capped to `targetDuration` so 30s selection produces ~30s output
- Added `findBestWindow` in `whisper.js`: Claude Haiku picks best transcript excerpt matching director's notes; falls back to `findDenseWindow` when no API key or description
- Improved thumbnail frame selection: `fps=1,thumbnail=60` samples up to 60s of footage (was first 10s only)
- Fixed vertical mode ffmpeg crash for display-matrix-rotated broll with faces: `clipIsLandscapeForVertical` now accepts `hasFace` param; only uses Vision rotation when `hasFace=true`
- Fixed a-roll budget distribution (v0.1.21): replaced greedy fill with even spread — budget divided equally across `numClips = floor(targetSecs / (faceDur*2))` clips; each clip trimmed to best window via `findBestWindow`; cut frequency scales with pacing (tight faceDur=small → more clips; relaxed faceDur=large → fewer longer clips)
- Fixed recommendation coefficient (v0.1.21): raised `avgClipSec * 0.3` → `avgClipSec * 0.5` so footage with ~19s avg clips breaks above the 7s floor and recommends 1 min instead of 30s
- Added semantic b-roll assignment (v0.1.22): single Claude Haiku call assigns each b-roll clip to best-matching narration section via `clip.semanticSection`; three-layer priority: (1) semantic match, (2) directional routing (filmed after last aroll → last section), (3) timestamp proximity
- Semantic clips sorted to front of each section's broll array — ensures overflow cap `slice(0, maxTotal)` preserves semantically assigned clips over timestamp-proximity ones
- Teaser detection (v0.1.22): full-text concat of all transcript segments, regex scan for last teaser phrase ("let me show you", "check this out", etc.), ≤8 words after guard to avoid mid-clip false positives — trims last a-roll clip before the phrase to avoid cliffhanger endings
- HH-MM added to video output filenames (v0.1.22): both main pipeline (`Journal-YYYY-MM-DD-HHMM.mp4`) and highlight reel — prevents same-day runs from overwriting each other in exports.json
- Fixed slideshow showing old footage (v0.1.22): removed `seenNames` dedup from `/journals/recent` — was dropping same-calendar-day runs from different footage batches
- Fixed caption timing (v0.1.24): changed segment filter from `s.end > trimStart` to `s.start >= trimStart` in both `generateAss` and `generateSrt` — prevents straddling segments showing pre-cut text at t=0 before audible speech; also lowered Whisper dead-air trim threshold from 1s to 0.3s so clips with <1s silence on both sides are trimmed rather than left with up to 0.9s of silent caption roll
- Fixed teaser cut too aggressive (v0.1.25): was cutting at `segs[cutIdx-1].end` (previous segment boundary), which removed content preceding the teaser phrase in the same Whisper segment. Now estimates cut point within the segment using character proportion: `fraction = matchOffsetInSeg / teaserSeg.text.length`, `cutPoint = teaserSeg.start + fraction * segDur`. Guard: skip if `cutPoint <= trimSt + 0.5s`. Confirmed working in testing.
- Fixed slideshow dedup (v0.1.25): restored `seenNames` dedup to `/journals/recent` with newest-first sort (`exportedAt` desc) — most recent render per calendar day wins; prevents same-day re-renders from all appearing in the slideshow at once
- Slideshow thumbnails always use Claude endpoint (v0.1.25): removed `thumbPath` preference — `/api/journals/thumbnail` (Claude Haiku scenic-preference selection) is always used; eliminates face shots from slideshow
- Added opening animation (v0.1.25): on first app launch (`sessionStorage` gated), `#intro-splash` overlay activates full-screen with the logo; orb light sweeps from bottom-left → upper-right over 3s (`runIntroOrb`); logo cross-dissolves in (1.4s ease-out, 0.25s delay, scale 0.94→1), then animates out (0.55s ease-in, scale 1→1.05) before home UI fades in; subsequent navigations back to home skip intro entirely

### XML generation details (`fcpxml.js`)
- `buildFromTimeline(resolvedTimeline)`: primary path when resolvedTimeline present; fallback re-computes from assembly for old sidecars
- `xmlMotionRotation(clip, clipType)`: Premiere reads rotate TAG automatically, NOT display matrix. Delta = (videoApplied - premiereAuto + 360) % 360. Returned as CCW-positive degrees.
- Audio: `audioItem()` emits `<sourcetrack><mediatype>audio</mediatype><trackindex>N</trackindex>` — trackIndex is source channel (1=mono/left, 2=right), NOT destination track
- `slimClip` fields needed in resolvedTimeline entries: `path`, `rotation`, `rotFromTag`, `storedW`, `storedH`, `needsColorConversion`, `dayIndex`, `vision.{suggestedRotation, hasFace, isTalkingHead}`

### Worktree / main project sync hazard
All edits must go directly to `/Users/nathangriffey/Desktop/gather/` (main project). The worktree at `.claude/worktrees/cranky-fermi-6e12eb/` is used for Claude Code sessions but `cp`-ing from it to main overwrites fixes made directly in main. Always edit the main project files directly for anything that must survive a session.

- Built and distributed beta DMG v0.1.26 (`dist/Slice of Life-0.1.26-arm64.dmg`)

### UI overhaul (v0.1.27–v0.1.28)
- Hero layout restructured: horizontal split — logo left (260px, `drop-shadow` glow), headline + CTA right
- Logo glow: `filter: drop-shadow(0 0 50px rgba(50,120,255,0.40)) drop-shadow(0 0 18px rgba(130,180,255,0.50))` — matches orbs.js intro end state at reduced opacity
- Headline: "DOCUMENT YOUR DAY." (gradient-text) + "Watch it back." below; `white-space: nowrap` keeps first line on one line; `font-size: 30px`
- CTA button (`.hero-cta-btn`): glass style, `max-width: 313px` on description text controls button width
- Film grain: `::after` pseudo-element on `.inner` at z-index 999, `opacity: 0.04`, SVG feTurbulence — safe because settings overlays are siblings of `.inner`, not children
- `.gradient-text` utility added to `main.css`
- Section labels (`recent-label`, `notepad-label`, etc.) → `#7FB8FF`; icon placeholders → `#3A6090`
- Dark card style: `background: #061422; border: 1px solid rgba(255,255,255,0.07)`
- All interactive buttons: `cubic-bezier(0.23,1,0.32,1)` transitions, `translateY(-2px)` hover lift, `scale(0.97)` active press
- Removed "Your footage never leaves your Mac" blurb from home footer

### Micro-stats banner (v0.1.28)
- Full-width banner strip between hero and streak section; `background: rgba(0,0,0,0.12)`, hairline borders top/bottom
- Three stats: **Slices made** · **Clips sorted** · **Raw footage** (displays as `14m` or `1h 6m`)
- Always visible even at zero — shows `0` so new users understand the concept; raw footage shows `—` until first render
- `/api/stats` endpoint: reads `exports.json`, sums `clipCount` and `rawDurationSec` stored at render time; falls back to scanning source folder for legacy entries
- `recordExport()` now stores `footageDates` (array of footage shoot dates from `dayKeys`), `rawDurationSec` (total source clip duration), `clipCount` (total input clips) in every exports.json entry
- Pipeline `return` value now includes `footageDates` and `stats.rawDurationSec`
- "Days documented" stat removed — redundant with "Slices made" for typical one-slice-per-day usage
- Raw footage stat uses `Math.max(1, Math.round(...))` so any non-zero footage shows at least 1m; server formats to `Xh Ym` when ≥ 60 min
- `/api/stats` requires `execFile`/`promisify` inline (not top-level imports in api.js — use inline `require` like all other handlers)

### Slideshow loop fix (v0.1.28)
- Old code doubled real journal items but appended placeholders only once — at `-50%` reset the two halves didn't match, causing a jarring jump
- Fix: `buildPage()` function builds one complete page (real items + placeholders to fill MIN_CARDS), called twice so both halves are identical; `-50%` reset is now invisible

### Streak / stats correctness
- Streak counts days where a render actually completed (`exportedAt` written only on successful `recordExport`) — not calendar days
- "Days documented" (removed stat) was based on `exportedAt` render date, not footage shoot date — `footageDates` now stored for accurate future use
- Highlight reel: clips selected by Vision `qualityScore` (best first), then re-sorted chronologically by `filledAt` for playback — no semantic editing, pure quality + time order

### Today's Prompt guardrails (v0.1.28)
- Added `system` prompt to Claude Haiku call: instructs to keep suggestions professional, warm, encouraging, general-audience appropriate; avoid sensitive topics, health, conflict
- Coaching persona moved from user turn to system turn for stronger enforcement

### exports.json schema (current)
Each entry: `{ videoPath, name, thumbPath, folderPath, transcriptExcerpt, footageDates, rawDurationSec, clipCount, exportedAt }`
- `footageDates`: string[] of `YYYY-MM-DD` footage shoot dates (from pipeline `dayKeys`)
- `rawDurationSec`: total source clip duration in seconds
- `clipCount`: total input clips processed

- Built and distributed beta DMG v0.1.28 (`dist/Slice of Life-0.1.28-arm64.dmg`)

## Pending / Next Session

### Apple Vision migration — COMPLETE (v0.1.30)
All steps done. Default backend is now Apple Vision.

**How to rebuild `vision-cli` after editing `main.swift`:**
```bash
swiftc -O server/vision-cli/main.swift \
    -o server/bin/vision-cli \
    -framework AVFoundation -framework Vision \
    -framework CoreImage -framework Foundation
```
(Deprecation warnings about macOS 13+ async APIs are expected and harmless.)

**Files:**
- `server/vision-cli/main.swift` — Swift source; edit here
- `server/bin/vision-cli` — compiled arm64 binary; checked into repo; rebuild after source changes
- `server/lib/clip-vision.js` — router; reads `visionBackend` from config.json (`'apple'`|`'claude'`)
- `server/lib/clip-vision-apple.js` — Apple Vision backend; auto-falls back to Claude if binary missing
- `server/lib/clip-vision-claude.js` — original Claude backend (3-frame sampling); kept as fallback

**Switching backends:** set `visionBackend: 'claude'` in `{userData}/config.json` and restart, or call `POST /settings` with `{ visionBackend: 'claude' }`. Default is `'apple'`.

**Quality score:** luminance standard deviation over a 16×16 thumbnail (CoreGraphics, no CIImage coord issues). stdDev≈50 → score≈63, stdDev≈80 → score=100. Reasonable for b-roll ranking and highlight reel selection.

**Rotation:** read directly from `AVURLAsset` video track `preferredTransform`. Equivalent to the display matrix path in the old ffmpeg probe. `atan2(b,a)` gives visual CW rotation (video Y-down convention).

**Fixed post-launch (v0.1.30):**
- B-roll rotation regression: `rotFromTag` clips were getting Apple Vision rotation applied (Vision reads `preferredTransform` which may be identity for cameras that store rotation only in the rotate tag, not the tkhd matrix). Fix: promote `rotFromTag` check above Vision check in `clipRotFrag` — tag is always authoritative for b-roll.
- A-roll mid-sentence cut: `findDenseWindow` and `findBestWindow` hard-cut at `windowStart + maxDuration`, slicing mid-sentence when the last Whisper segment straddled the boundary. Fix: `extendToSegmentBoundary()` extends window end to the last segment's end, up to 3s grace.

**Still pending:**
- Test on a second machine to verify binary runs without issues
- Update debug-last-run.log to show `_source: 'apple'` vs `'claude'` per clip (currently logged to console only)

### Session fixes (post v0.1.30)

**Bug fixes applied (not yet versioned/distributed):**

- **`??` + `||` syntax error (Node.js 26)**: `(nextAroll.trimEnd ?? nextAroll.duration || 0)` → `SyntaxError`. Fixed with parens: `(nextAroll.trimEnd ?? (nextAroll.duration || 0))`. Same at bridge last-resort line. This was causing "0 files" on folder scan — `require('../lib/journal-video')` failed, scan endpoint returned 500 which configure screen interpreted as 0 clips.

- **Teaser detection removed entirely**: The "let me show you" / "check this out" phrase detection that trimmed the last a-roll clip was causing mid-word cuts (Whisper segments don't align with word boundaries). Feature removed completely from `journal-pipeline.js` — no `TEASER_RE`, no `runTeaserScan`, no if block.

- **B-roll ordering**: `sec.brolls.sort()` was using `filledAt` as secondary key — unreliable for AirDropped clips. Fixed to use `clipComparator` (iPhone filename number IMG_XXXX as primary sort key). Import `clipComparator` from `./clip-sort` was added to `journal-video.js`.

- **B-roll rotation (display-matrix faceless clips)**: Previous fix applied rotation to ALL faceless display-matrix b-roll unconditionally. Too broad — landscape clips with stale non-zero display matrix got incorrectly rotated. Fixed in `clipRotFrag`: only apply display-matrix rotation when `rotation !== 0 && storedW > storedH` (portrait iPhone b-roll case). Clips 5148/5152 may still need investigation.

- **Bridge last-resort guard**: Added `nextNarrDur` check before borrowing next section's only b-roll for a bridge. Only borrows when `nextNarrDur < FACE_DUR * 3`.

**New feature: `selectEndingClip` (`journal-pipeline.js`)**
- Claude Haiku scans narration clips from the last 35% of the shoot day
- Picks the one that sounds most like a natural conclusion ("what a great day", "heading home", "wrapping up")
- Only swaps when the chosen clip is within 1 position of the end (prevents pacing disruption)
- Called just before `assignBrollSemantically` in the pipeline

**L-cut cutaway architecture (`journal-video.js`) — MAJOR CHANGE**

The edit model is now a true two-track documentary cutaway:
- Narration audio is continuous throughout — never replaced by b-roll ambient sound
- B-roll video plays OVER the narration at cut points (L-cut / J-cut technique)
- Before: overflow and bridge b-roll used b-roll's own ambient audio (volume 0.12)
- After: overflow and bridge b-roll use the **next section's narration audio** starting from that section's `trimStart`
- Section N+1's face cam then appears with both video and audio advanced by the consumed duration — lip sync is perfect, viewer hears the narrator start talking during b-roll then sees their face mid-sentence

**Key implementation details:**
- `renderSection(i, narrAudioOffset = 0)` — new param; `adjustedStart = narrTrimStart + narrAudioOffset` offsets both video and audio start
- `renderBrollWithNarrAudio(br, narrClip, narrStart, brDur, tag)` — renders b-roll video + narration audio from another clip (two inputs to ffmpeg)
- `renderBrollSilent(br, brDur, tag)` — used for last section's overflow (no next narration to borrow)
- `audioOffsets[]` array tracks how many seconds of each section's narration were consumed before it renders
- Rendering is sequential (already was CONCURRENCY=1); Pass 1 + concat loop merged into single loop
- Cleanup in `finally` block updated to walk `sectionFiles` (all temp files) instead of `result.overflowFiles` (removed)

### v0.1.30 — Apple Vision deactivated (current)

**Built and distributed:** `dist/Slice of Life-0.1.30-arm64.dmg`

**Only change from v0.1.29:** `server/lib/clip-vision.js` defaults to `'claude'` instead of `'apple'`.

```js
// clip-vision.js — how to switch backends:
_backend = cfg.visionBackend === 'apple' ? 'apple' : 'claude';  // default: claude
```

To re-enable Apple Vision: set `visionBackend: 'apple'` in `{userData}/config.json` and restart. Everything else — the Swift binary, clip-vision-apple.js, clip-vision-claude.js — is untouched.

**Why reverted:** Apple Vision sets `suggestedRotation` on every clip (reads `preferredTransform` unconditionally). This caused `clipRotFrag` to use Vision's rotation for faceless b-roll clips that were previously getting correct rotation from probe metadata. Claude Vision only sets `suggestedRotation` when it actually detects a problem, so fallback behavior is correct.

**Apple Vision strategy for next attempt:**
- The root issue: `suggestedRotation` being always-populated changed clipRotFrag behavior for faceless b-roll
- Fix needed: in `clip-vision-apple.js`, only set `suggestedRotation` when it differs meaningfully from `info.rotation` (the ffmpeg probe value) — i.e. when Vision disagrees with metadata, not just as a passthrough of preferredTransform
- Or: in `clipRotFrag`, for display-matrix b-roll without a face, ignore `suggestedRotation` entirely and always use `info.rotation` from probe — same result, simpler
- B-roll section ordering (wrong section assignment) is a separate issue from Vision and was partially addressed with filename-number proximity matching (not shipped in v0.1.30 — was reverted with journal-video.js)

### Session fixes (B-roll indexer + narration detection)

**New module: `server/lib/broll-indexer.js`**
- Shot boundary detection via ffmpeg scene detection (`select='gt(scene,0.35)',showinfo`, parses `pts_time:` from stderr)
- Builds stable ranges per shot: `stableStart = shotStart + 1.5s`, `stableEnd = shotEnd - 0.25s`
- Extracts 3 representative frames at 25/50/75% of each stable range
- `askBestStart(client, frames)` — sends 3 base64 frames to Claude Haiku, asks which % is earliest stable/watchable frame; returns index 0/1/2. Stored as `best_start` on shot object.
- `askSettleStart(client, videoPath, duration, opts)` — extracts frames at 0.5/1.0/1.5s from clip opening, asks Claude when camera becomes stable (no hands/blur/shake). Returns 0/0.5/1.0/1.5. Stored as `settle_start` at clip level (not shot level) — used for aroll trim start.
- Cache: `broll_index.json` alongside source folder, invalidated by `INDEX_VERSION = 4` and clip mtime check
- `_version: 3` in index file

**`journal-pipeline.js` changes**
- `runBrollIndex()` — builds/caches broll index before Vision loop; `INDEX_VERSION = 4`
- `attachStableStarts()` — reads `best_start ?? stable_start` → `clip.stableStart`; reads `settle_start` → `clip.settleStart`
- `recommendDuration(clips)` — takes clips array, uses clipCount + cappedSec (each clip capped at 60s) to avoid raw-total-seconds inflation from long b-roll clips
- `isIntentionalNarration()` moved to `whisper.js` — Claude Haiku content check replaces WPS gate for talking-head detection; falls back to `wordsPerSec >= 1.5` when no API key
- `vision.isTalkingHead || vision.hasFace` — runs Whisper on any face-visible clip (catches GoPro narration)
- Director-notes rejection moved inside b-roll branch — never rejects talking heads

**`journal-video.js` changes**
- `narrTrimStart = Math.max(aroll.trimStart ?? 0, aroll.settleStart ?? Math.min(aroll.stableStart ?? 0, 1.0))` — uses Vision settle detection for aroll, 1.0s cap as fallback
- Same pattern in `generateAss` and `generateSrt`
- Removed `lastArollTime > brTime` shortcut that dumped AirDrop-timestamped clips to last section; all unassigned b-roll now uses nearest-aroll `filledAt` proximity

**`configure.html` change**
- Client-side `recommendDuration(clipCount, cappedSec)` matches server-side logic

**B-roll section ordering — DO NOT use filenameNum for cross-camera proximity**
- Attempted to replace `filledAt` with `filenameNum` (IMG_XXXX) for section routing. Caused major regression: GoPro clips (GH010001 → num=1) sort before all iPhone clips (IMG_5144 → num=5144), scrambling order for mixed-camera sessions. Reverted.
- `filledAt` remains the cross-camera ordering key; filename numbers are only reliable within the same camera's clips

### Session fixes (B-roll position assignment + rotation + bridges)

**Replaced semantic b-roll assignment with position-based (`journal-pipeline.js`)**
- `assignBrollSemantically` removed; replaced by `assignBrollByPosition`
- Primary assignment: each b-roll clip is assigned to a section based on its array index position relative to section boundaries (midpoints between adjacent a-roll positions)
- Section boundaries computed as `(arollPos[i] + arollPos[i+1]) / 2` (fractional midpoint, NOT Math.floor — Math.floor pushes ambiguous clips to later section causing empty earlier sections)
- AI tiebreaker removed entirely — Claude "A or B?" calls were unreliable and overrode correct primary assignments. Pure position is more accurate.

**Camera group filename correction in main sort (`journal-pipeline.js`)**
- After `probed.sort()`, re-sort within each camera family by filename number:
  - `gopro`: `GX`/`GH` prefix → sort by number
  - `iphone`: `IMG_` prefix → sort by number
  - `dji`: `DJI_` prefix → sort by number
- Fixes AirDrop timestamp corruption within camera groups; cross-camera ordering still uses `filledAt`
- DO NOT use filename numbers for cross-camera ordering — GoPro GH010001=1 vs iPhone IMG_5144=5144 makes them incomparable

**`journal-builder.js` (new file)**
- `buildJournal({ aroll, broll })` — builds flat chronological assembly sorted by `clipComparator`
- Called in pipeline: `const { assembly } = await buildJournal(...)` before `buildJournalVideo`
- Assembly carries full clip objects including `semanticSection` (set by `assignBrollByPosition`)
- `buildInterleaved` in `journal-video.js` reads `semanticSection` to assign brolls to sections, falls back to `filledAt` proximity for unassigned clips

**Rotation system simplified (`journal-video.js`, `clip-vision-claude.js`)**
- Vision receives raw (unrotated) frames via `-noautorotate`; reports TOTAL clockwise rotation needed (0/90/180/270). No pre-rotation, no combining arithmetic.
- `clipRotFrag` rules: a-roll → Vision authoritative, fall back to rotate TAG; b-roll with rotate TAG → tag always wins; b-roll with display matrix → Vision decides only when `hasFace=true`, otherwise keep as-is (conservative: don't rotate if unsure)
- `bestFrame` prompt now factors in director notes + narration context, not just visual quality
- `brollSeekStart()` helper: trims b-roll to most interesting moment using `refinedSeekPct` → `vision.bestFrame` → fallback
- `refineBestFrames()`: single batched Haiku text call after section assignment; picks narration-aware seek % per b-roll clip; stored as `clip.refinedSeekPct`
- B-roll style options (Chronological/Balanced/Story) removed from configure.html

**Bridge start point fix (`journal-video.js`)**
- Old: bridges always started from `trim=0` (camera settling fumble)
- New: bridges use `clip.transcript?.trimStart` as start point — Whisper-detected content start
- Falls back to `Math.max(1.0, brClipDur * 0.15)` if no transcript
- Cap: `Math.min(rawBrStart, brClipDur - brDur - 0.5)` prevents start+dur from exceeding clip length
- Audio atrim updated to match: `atrim=${brStart}:${brEnd}` instead of `atrim=0:${brDur}`
- resolvedTimeline `srcIn`/`srcOut` updated to reflect new start point

**Critical probe() bug fixed (`journal-video.js`)**
- `probe()` had a stale `console.log` referencing `tagRot` and `matRot` — variables that lived inside `parseRotation()` after refactoring, no longer in scope of `probe()`
- When `rotation !== 0`, the ReferenceError was silently caught by the outer try/catch → returned `{ storedW: 0, duration: 0 }` → clip dropped at preflight
- Affected ALL clips with non-zero rotation (most portrait iPhone clips, upside-down clips). Fixed to log `rotFromTag` instead.
- Any future refactor of `parseRotation` must ensure `probe()`'s console.log doesn't reference its internal variables

### Session fixes (rotation conservatism + bridge priority)

**Bridge priority updated (`journal-video.js`)**
- New case added to bridge selection loop: when a section has exactly 1 b-roll clip, donate it as a farewell bridge rather than interleaving it over narration audio. A standalone clip between sections reads better editorially.
- Bridge priority order: (1) curr has exactly 1 clip → farewell bridge; (2) next.brolls.length > 1 → preview clip; (3) curr.brolls.length > 1 → farewell clip; (4) next.brolls.length === 1 → last resort borrow; (5) null → direct cut accepted
- GX010177 (dogs) confirmed working as a standalone bridge between sections 1→2 after this fix

**Vision prompt improvement (`clip-vision-claude.js`)**
- Added face-upright self-check to `suggestedRotation` description: "if a human face is visible, mentally apply your chosen rotation and verify the face would be upright (forehead above chin, eyes above mouth). If the face would be inverted after rotation, add 180° to your answer."
- This fixed IMG_5241 (portrait clip filmed upside-down): Vision now correctly reports 90° instead of 270°, producing correct CW 90° transpose in output

**Auto-rotate experiment reverted — conservative rotation is correct policy**
- Attempted `brAutoRot` flag: auto-applied native ffmpeg rotation (no `-noautorotate`) for all display-matrix b-roll with non-zero rotation. Too broad — fired on landscape clips (jellyfish, aquarium) that were correct as-is, causing ~80% of clips to be wrong.
- All three rendering contexts (cutaway, overflow, bridge) fully reverted to original conservative behavior: `-noautorotate` always, `clipRotFrag` handles decisions
- `clipRotFrag` rules (unchanged, confirmed correct): a-roll → Vision authoritative; b-roll rotate-TAG → tag always wins; b-roll display-matrix → Vision rotation applied only when `hasFace=true`, otherwise keep as-is
- Philosophy: if a clip is filmed sideways, that's user error. The app being predictable (leave clips alone unless confident) is better than being wrong on correctly-oriented clips.

### Other pending
- Wire up Lemon Squeezy credit top-up flow when ready to monetize
- Investigate Whisper returning 1 word on long clips (63s+) — likely audio format or timeout issue
- L-cut / cutaway audio architecture: code was written in a prior session but reverted as untested. Core idea: overflow/bridge b-roll renders with next section's narration audio; section N+1 starts audio+video from `trimStart + consumed`. Needs testing before reshipping.

### Session fixes (v0.1.31 — vlogger pivot + seek point + SRT export)

**Product pivot: daily vlogger focus**
- App is now explicitly designed for daily vloggers who talk to camera (a-roll spine + b-roll cutaways)
- Multi-day footage still works silently (grouped by shoot date, story arc generated)
- Home screen CTA: "Drop in today's footage. We find your best talking-to-camera moments, cut in b-roll, burn captions, and export your vlog — ready to upload."
- Filming guide retitled "How to vlog for best results"; acts renamed "Open to camera" / "Shoot your b-roll" / "Close to camera"
- Notepad placeholder updated to vlog scripting language

**Director's Notes removed entirely**
- Gap between implied capability ("start with the sunset shot") and actual capability (loose semantic bias) was too wide
- Removed from `configure.html`: textarea, mic button, STT JS, CSS
- Removed from `journal-pipeline.js`: `description` param from options, both `analyzeClip` calls now pass `''`, `matchesDirectorNotes` rejection block gone, `selectBestAroll` updated
- Removed from `whisper.js`: `descriptionMatch` function, `transcribe` no longer takes description param, `findBestWindow` simplified to just call `findDenseWindow`
- Removed from `clip-vision-claude.js`: `directorNotes` block from `buildPrompt`, `matchesDirectorNotes` from returned result

**Highlight Reel mode removed from UI**
- `btn-highlight` CSS, "Make Highlight Reel" button, and `makeHighlightReel()` function removed from `journal.html`
- Feature still exists in pipeline but no longer exposed

**No-aroll guidance replaces retry/highlight buttons (`journal.html`)**
- Old: "Try Again (Higher Sensitivity)" button + "Make Highlight Reel" button
- New: guidance box explaining they need a clip speaking to camera, plus "← Start over" button
- `btn-retry` CSS and `retryHighSensitivity()` function removed

**Duration options updated (`configure.html`, `journal-pipeline.js`)**
- Removed 30-second pill (too short for a vlog)
- Added 10-minute pill: `600: { label: '10min', brollCut: 9, faceDur: 7.0, narrBudget: 0.45 }`
- `pillValues = [60, 180, 300, 600]`; `recommendDuration` fallback changed from `return 30` to `return 60`
- Server-side threshold: 60+ clips or 1800+ cappedSec → return 10 min
- Client-side threshold matches server-side

**PACING_MULT now wired into recommendation (`configure.html`)**
- `PACING_MULT = { tight: 0.65, balanced: 1.0, relaxed: 1.5 }`
- `updateRecommendation()` now applies mult: `baseSecs * mult`, snaps to nearest pill
- Previously defined but never used — pacing had no effect on recommendation

**B-roll seek point: Vision `bestFrame` + `frameProportions` (`journal-video.js`, `clip-vision-claude.js`)**
- Root problem: IMG_5236 started with camera being set down because `refineBestFrames` (text-only Haiku) guessed early frame from description "handstand" clip
- `refineBestFrames` removed entirely — was a text-only batched call that didn't see actual frames
- `clip-vision-claude.js` now stores `frameProportions` in returned result for precise timestamp mapping
- `brollSeekStart()` rewritten: uses `frameProportions[bestFrame] * dur` for exact center point; `stableStart` as hard floor; fallback to transcript trimStart or `max(1.0, dur * 0.15)`
- `clip-vision-claude.js` `bestFrame` prompt improved: explicitly avoid camera placement/pickup frames and hands-in-frame; prefer middle frames

**Style learning: `captionsOn` added, `brollStyle` removed (`server/lib/app-data.js`)**
- `brollStyle` was written to style-profile on every render but never read back — removed from both write and read paths
- `captionsOn: boolean` now stored per entry; majority vote with ≥4 entries threshold before committing to a preference
- `applyStyleDefaults` in `configure.html` now toggles captions toggle and shows visible "Your style: ..." indicator

**SRT sidecar export (`journal-video.js`, `journal-pipeline.js`, `journal.html`)**
- SRT file written alongside `.mp4` whenever captions are enabled (clean unprocessed transcript)
- `buildInterleaved` returns `{ resolvedTimeline, srtPath }`
- `srtPath` threaded through pipeline return → api.js job result
- Done screen shows SRT button when `data.srtPath` exists; button calls `window.electronAPI.openPath(srtPath)` to open in default system app
- Addresses the "one bad typo and you're screwed" problem — users can edit SRT before uploading to YouTube

**Version bumped to 0.1.31; DMG built successfully**

### Session — dead code purge + robustness pass

**UI fix**
- Removed "Your style: Balanced" label from configure screen — was overlapping "Configure your edit." header. Deleted `#style-learned` div and its JS population block.

**Dead files deleted**
- `server/lib/face-detect.js` — replaced by clip-vision, unreferenced
- `server/lib/score-broll.js` — replaced by clip-vision quality score, unreferenced
- `server/lib/trip-pipeline.js` — retired multi-day pipeline, unreferenced
- `server/lib/trip-builder.js` — only used by trip-pipeline
- `ui/trip.html`, `ui/journals.html`, `ui/recap.html` — no navigation to any of them
- `ui/js/processing.js`, `ui/js/results.js`, `ui/js/setup.js`, `ui/js/recap-creator.js` — not included in any active HTML

**Dead code removed from active files**
- `api.js`: entire recap block (~90 lines) + `autoExportXML()` + `openWhenDone` setting + `description` param threading + orphaned `/trip`, `/journals`, `/recap` routes in `server/index.js`
- `journal-pipeline.js`: `refineBestFrames()` function (text-only Haiku seek refinement — removed when Vision bestFrame was added)
- `credits.js`: `save()` and `deduct()` — both unwired per CLAUDE.md; simplified to just `load()`
- `configure.html`: director's notes CSS (`.desc-field`, `.desc-textarea`, `.mic-btn`, `@keyframes pulse-mic`), `dayTitleCards` JS variable + toggle function + POST body key
- `journal.html`: dead `xmlPath` variable (server never populates it)
- `clip-vision-claude.js`: stale `face-detect.js` reference comments; `directorNotes` param fully removed from `buildPrompt`, `askClaude`, `analyzeClip` and all callers; `matchesDirectorNotes` log line removed (was always `notes=undefined`)
- `clip-vision.js`, `clip-vision-apple.js`: `directorNotes` param removed from `analyzeClip` signatures
- `journal-video.js`: `isFirst = false` dead variable + `fadeIn` property on segs (fade-in was disabled, code was dead)
- `whisper.js`: `findBestWindow` passthrough wrapper removed; all callers now call `findDenseWindow` directly

**Robustness fixes**
- **API key ignored after save**: `whisper.js` and `clip-vision-claude.js` both had a singleton Anthropic client cached on first use and never cleared. Added `resetClient()` to both, called from `POST /settings` alongside existing `resetBackendCache()`. New users who paste their key don't need to restart.
- **Slo-mo / time-lapse clips now go through Vision**: Previously pushed straight to b-roll with no vision property, skipping quality scoring, rotation detection, and best seek point. Now Vision runs first; clips are still forced to b-roll regardless of result but get proper quality score (affects ranking), rotation (affects orientation in output), and bestFrame (affects seek point). Low-quality slo-mo (score < 15) is now correctly rejected.
- **Temp directory cleanup**: `finally` block used `rmdirSync(tmpDir)` which silently failed because bridge files, `concat.txt`, and `captions.srt` were still inside. Changed to `rmSync(tmpDir, { recursive: true, force: true })`. Every render now fully cleans up its temp folder.
- **Job name always "Slices"**: `path.basename(path.dirname(result.videoPath))` always resolved to the output folder name. Fixed to `path.basename(result.videoPath, '.mp4')` — recent slideshow now shows actual filenames.
- **`targetDuration` validation**: Raw HTTP body value passed directly to pipeline with no guard. Now: `Math.max(60, parseInt(req.body.targetDuration, 10) || 180)` — can never be 0 or NaN which would cause zero-length clip math and ffmpeg crash.
- **`buildSequential` missing return**: Function returned `undefined`; callers assumed `{ resolvedTimeline, srtPath }`. Added `return { resolvedTimeline: null, srtPath: null }` — re-edits now consistent with main render path.

**Pending robustness issues (not yet fixed — start here next session)**
1. **Thumbnail crash after clear** (`api.js` line ~495): `/journals/thumbnail` does `loadExports().map(e => path.resolve(e.videoPath))` — after `/journals/clear`, entries have no `videoPath`, so `path.resolve(undefined)` throws. Fix: add `.filter(e => e.videoPath)` before the map.
2. **Multi-day temp files not cleaned on failure** (`journal-pipeline.js`): Per-day segment files written to `os.tmpdir()` are cleaned inline on the happy path only. If any day fails, the large segment files (200–400MB each) are orphaned in `/tmp`. Needs try/finally wrapping the day loop.
3. **Multi-day concat has no timeout** (`journal-pipeline.js` line ~714): The final ffmpeg stream-copy concat has no `timeout` option. Every other `execFileAsync` call has one. Could hang indefinitely on corrupt segment.
4. **Highlight reel missing stats** (`journal-pipeline.js`): Highlight reel return value doesn't include `footageDates`, `transcriptExcerpt`, or `stats.rawDurationSec`. Those exports show up blank in the stats banner.
5. **Thumbnail model unversioned** (`api.js` line ~578): `/journals/thumbnail` uses `'claude-haiku-4-5'` (no version date). All other calls use `'claude-haiku-4-5-20251001'`. Standardize.
6. **`configureMode` sessionStorage** (`home.js` line ~423): `sessionStorage.setItem('configureMode', 'single')` written on every build start but never read anywhere. Delete it.
7. **`Onboarding` dead reference** (`home.js` lines ~425–427): Checks `typeof Onboarding !== 'undefined'` — `Onboarding` is never defined anywhere. Two dead lines.
8. **Photos Library IPC** (`main.js` + `preload.js`): `photos:libraryPath` handler and `window.electronAPI.getPhotosLibraryPath` are registered but never called from any UI. Dead feature stub.
9. **`_activeMode` implicit global** (`home.js`): Assigned at two locations but never declared with `let`/`const`. Works today, breaks under strict mode.
10. **`dayBoundaries` / day markers in XML** (`fcpxml.js`): `generate()` accepts and processes `dayBoundaries` to build Premiere markers, but no caller ever passes it — the feature is silently a no-op. Wire it up or remove it.
11. **Config read pattern repeated 3×** (`journal-pipeline.js`): Same inline IIFE to read `config.json` appears at lines ~521, ~632, ~840. Should be one function at top of file or moved to `app-data.js`.
12. **`broll-indexer.js` cfg/opts scope bug**: `processClip` calls `askSettleStart(..., cfg)` but variable in scope is `opts`. Causes `scale=undefined:-2` in ffmpeg args, silently produces 0 results for every clip. Fix: pass `opts` not `cfg`.
