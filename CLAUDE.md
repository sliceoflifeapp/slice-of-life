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
  - `lib/trip-pipeline.js` — retired (no longer called); kept on disk for reference
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

**Still pending:**
- Test on a second machine to verify binary runs without issues
- Update debug-last-run.log to show `_source: 'apple'` vs `'claude'` per clip (currently logged to console only)

### Other pending
- Remove or gate `[section N]` debug segment logging behind a verbose flag
- Wire up Lemon Squeezy credit top-up flow when ready to monetize
- Investigate Whisper returning 1 word on long clips (63s+) — likely audio format or timeout issue; output still usable but narration audio from that clip may be lost
