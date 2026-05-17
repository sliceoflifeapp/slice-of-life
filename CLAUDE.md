# Gather — Slice of Life

Electron + Express video journaling app. Records a day's worth of iPhone/camera footage and auto-edits it into a narrated journal video with b-roll cutaways, captions, and a Premiere XML export.

## Launch

```bash
gather          # shell alias (new terminal tab)
npm start       # from project root
```

## Architecture

- `main.js` — Electron shell, IPC bridges (selectFolder, selectFiles, openPath, getFilePath)
- `server/` — Express API server embedded in Electron
  - `routes/api.js` — all HTTP endpoints
  - `lib/journal-pipeline.js` — orchestrates the full single-day pipeline
  - `lib/journal-video.js` — ffmpeg video assembly (rotation, bg blur, captions, encoding)
  - `lib/face-detect.js` — Claude vision a-roll/b-roll classifier
  - `lib/fcpxml.js` — Premiere Pro xmeml v4 XML generator
  - `lib/trip-pipeline.js` — multi-day trip mode
- `ui/` — plain HTML/CSS/JS frontend
  - `home.html` / `js/home.js` — home screen, source picker, recent slideshow
  - `configure.html` — settings screen (duration, pacing, captions, orientation)
  - `journal.html` — progress/results screen

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
- Video saved to `~/Movies/Gather/`
- XML saved to `~/Downloads/` with HH-MM timestamp in filename
- Export log: `~/.gather/exports.json` — used for recent slideshow thumbnails
- Thumbnail security: both sides use `path.resolve()` before comparing

### Orientation
- Landscape (default): 16:9, detects resolution from clip pool
- Vertical: 1080x1920 output, selected in configure screen
- XML generator scales clips to fit sequence frame (motionScale/motionFilter)

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
- Added `gather` shell alias in ~/.zshrc
- Replaced face-detect.js + score-broll.js with unified `clip-vision.js` (single Claude Vision call per clip returns isTalkingHead, hasFace, qualityScore, contentTags, description, suggestedRotation)
- clip-vision.js: extracts 3 frames at 20/50/80% of clip duration, pre-rotates using metadata before sending to Claude, asks Claude for *additional* correction needed on top
- clip-vision.js: `finalRotation = (metadataRot + additionalRot) % 360`; `suggestedRotation=null` means fall back to metadata probe
- clip-vision.js: bumped max_tokens to 400; added `suggestedRotation` to SAFE_DEFAULTS
- Fixed rotation strategy: aroll always applies rotation (Vision or metadata); broll with rotate TAG applies rotation; broll with display matrix only applies Vision rotation if `hasFace` (person visible) — prevents object-only clips (camera on table) from being mis-rotated
- `rotByPath` / `faceByPath` maps built in buildInterleaved and buildSequential from `clip.vision` data
- `clipRotFrag(info, clipType, suggestedRotation, hasFace)` — final routing function for rotation filter fragment
- `clipIsLandscapeForVertical` updated to use suggestedRotation when available
- Fixed aroll section freeze: root cause was `break` in while loop when `brollAvail < MIN_BROLL_SEG` leaving tail narration uncovered — rewritten with nested ifs, loop never breaks
- Added `[section N]` segment logging (total video vs audio delta) for freeze diagnosis
- Added `fps=30` to section video concat filter output: `concat=n=N:v=1:a=0,fps=30`
- Added `trim=end=narrDur,setpts=PTS-STARTPTS` to section video filter chain to hard-clamp video length
- Added `atrim=end=narrDur,asetpts=PTS-STARTPTS` after loudnorm to hard-clamp audio length
- Added `duration` directives to concat list so demuxer uses computed durations not container metadata
- Fixed sub-frame freeze at section boundaries: `narrDur` now rounded to nearest 1/30s frame boundary — prevents encoder from filling sub-frame gaps with a repeated last frame
- Highlight Reel toggle: title = "Highlight Reel", description = "Skips narration detection, cuts best shots together"
- No-music/no-captions concat: re-encode with `-r 30` + ENCODE_FLAGS (not stream copy)

## Pending / Next Session

- Verify the section-boundary freeze is fully resolved (narrDur frame-rounding fix not yet confirmed)
- Remove or gate the `[section N]` debug segment logging behind a verbose flag
