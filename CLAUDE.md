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
  - `lib/clip-vision.js` — unified Claude Vision classifier (replaces face-detect.js + score-broll.js)
  - `lib/fcpxml.js` — Premiere Pro xmeml v4 XML generator
  - `lib/trip-pipeline.js` — multi-day trip mode
- `ui/` — plain HTML/CSS/JS frontend
  - `home.html` / `js/home.js` — home screen, source picker, recent slideshow
  - `js/settings.js` — settings panel (API key, output folder, slideshow clear)
  - `configure.html` — configure screen (duration, pacing, captions, orientation)
  - `journal.html` — progress/results screen
  - `css/main.css` — shared styles (Montserrat font, glass button system, ambient glow)
  - `js/orbs.js` — single static ambient light source (upper-right corner, no animation)

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
- Video saved to `~/Movies/Slice of Life/`
- XML saved to `~/Downloads/` with HH-MM timestamp in filename
- Export log: `~/.slice-of-life/exports.json` — used for recent slideshow thumbnails
- Thumbnail security: both sides use `path.resolve()` before comparing

### Data directory
- All app data lives in `~/.slice-of-life/` (config.json, credits.json, exports.json, thumb-cache/)
- Auto-migrated from `~/.gather/` on first launch via `main.js`

### Orientation
- Landscape (default): 16:9, detects resolution from clip pool
- Vertical: 1080x1920 output, selected in configure screen
- XML generator scales clips to fit sequence frame (motionScale/motionFilter)

### Credits
- Stored in `~/.slice-of-life/credits.json`, default 500
- `credits.deduct()` exists but is not yet wired into the pipeline — renders are currently free
- Lemon Squeezy planned as payment processor for future credit top-ups (license key flow for beta)

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

### XML generation details (`fcpxml.js`)
- `buildFromTimeline(resolvedTimeline)`: primary path when resolvedTimeline present; fallback re-computes from assembly for old sidecars
- `xmlMotionRotation(clip, clipType)`: Premiere reads rotate TAG automatically, NOT display matrix. Delta = (videoApplied - premiereAuto + 360) % 360. Returned as CCW-positive degrees.
- Audio: `audioItem()` emits `<sourcetrack><mediatype>audio</mediatype><trackindex>N</trackindex>` — trackIndex is source channel (1=mono/left, 2=right), NOT destination track
- `slimClip` fields needed in resolvedTimeline entries: `path`, `rotation`, `rotFromTag`, `storedW`, `storedH`, `needsColorConversion`, `dayIndex`, `vision.{suggestedRotation, hasFace, isTalkingHead}`

### Worktree / main project sync hazard
All edits must go directly to `/Users/nathangriffey/Desktop/gather/` (main project). The worktree at `.claude/worktrees/cranky-fermi-6e12eb/` is used for Claude Code sessions but `cp`-ing from it to main overwrites fixes made directly in main. Always edit the main project files directly for anything that must survive a session.

## Pending / Next Session

- **Try VideoToolbox encoder** — replace `-c:v libx264 -preset fast -crf 23` in `ENCODE_FLAGS` with `-c:v h264_videotoolbox -b:v 10000k` (with libx264 fallback). Uses Apple Silicon media engine instead of CPU cores — fan stays quiet, 3–5× faster encode. Bitrate-based not CRF; 10 Mbps good for 1080p, 25–40 Mbps for 4K.
- Clip 5153 rotation still wrong in XML — broll + display matrix + no Vision face = no rotation applied in both ffmpeg and XML, so root cause unclear without logging actual `rotFromTag`/`rotation`/`vision` values at export time
- Remove or gate `[section N]` debug segment logging behind a verbose flag
- Wire up Lemon Squeezy credit top-up flow when ready to monetize
