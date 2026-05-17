// Premiere Pro xmeml v4 generator
// Produces a two-track sequence that mirrors buildInterleaved's actual output:
//   V1 = narration clips (full, sequential)
//   V2 = b-roll clips placed at their actual timeline positions
//
// Broll is assigned to its nearest narration section by timestamp (same logic
// as the video renderer), with cutaway slots filling during narration and
// overflow clips playing immediately after each narration section.

const path = require('path');
const fs   = require('fs');
const FPS  = 30;

function f(seconds) { return Math.round(Number(seconds) * FPS); }

function realPath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function escXml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const fileRegistry = new Map();
let   fileCounter  = 1;

// Detect sequence output resolution from clip pool -- mirrors journal-video.js logic.
const STANDARD_RESOLUTIONS = [
  { w: 3840, h: 2160 },
  { w: 2560, h: 1440 },
  { w: 1920, h: 1080 },
  { w: 1280, h:  720 },
];

function detectResolution(clips) {
  const tally = new Map();
  for (const c of clips) {
    const w = Math.max(c.storedW || 0, c.storedH || 0);
    const h = Math.min(c.storedW || 0, c.storedH || 0);
    if (w < 640 || h < 360) continue;
    const key = `${w}x${h}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  if (!tally.size) return { w: 1920, h: 1080 };
  const [topKey] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const [rawW, rawH] = topKey.split('x').map(Number);
  return STANDARD_RESOLUTIONS.reduce((best, r) =>
    Math.abs(r.w - rawW) < Math.abs(best.w - rawW) ? r : best
  );
}

// Return the stored (pixel) width and height for a clip.
// For clips with 90/270 degree rotation the stored buffer is already the
// correct orientation in Premiere (it reads the rotate tag itself),
// so we give Premiere the stored dimensions as-is.
function clipDims(clip) {
  return {
    w: clip.storedW || 1920,
    h: clip.storedH || 1080,
  };
}

function fileBlock(clip) {
  const rp = realPath(clip.path);
  if (fileRegistry.has(rp)) {
    return { id: fileRegistry.get(rp), xml: null };
  }
  const id   = `file-${fileCounter++}`;
  const name = path.basename(rp);
  const url  = 'file://localhost' + rp.replace(/ /g, '%20');
  const { w, h } = clipDims(clip);
  fileRegistry.set(rp, id);
  return {
    id,
    xml: `
						<file id="${id}">
							<name>${escXml(name)}</name>
							<pathurl>${url}</pathurl>
							<rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate>
							<media>
								<video><samplecharacteristics>
									<rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate>
									<width>${w}</width><height>${h}</height>
								</samplecharacteristics></video>
								<audio><samplecharacteristics>
									<depth>16</depth><samplerate>48000</samplerate>
								</samplecharacteristics></audio>
							</media>
						</file>`,
  };
}

function clipItem(id, clip, timelineStart, timelineEnd, srcIn, srcOut, seqW, seqH) {
  const fb      = fileBlock(clip);
  const rp      = realPath(clip.path);
  const fname   = path.basename(rp);
  const fileXml = fb.xml || `<file id="${fb.id}"/>`;

  // Premiere reads rotation from the QuickTime 'rotate' metadata tag on its own.
  // Providing correct stored dimensions in the file block is all that's needed.
  // We do NOT add a motion rotation filter here because Premiere double-rotates
  // when both the file tag and a manual rotation value are present.

  // Add a comment on HLG clips so editors know colour needs attention.
  const colorNote = clip.needsColorConversion
    ? `\n\t\t\t\t\t<!-- HDR/HLG source -- colours baked in MP4; adjust Lumetri colour space in Premiere -->`
    : '';

  return `
					<clipitem id="${id}">${colorNote}
						<name>${escXml(fname)}</name>
						<rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate>
						<start>${timelineStart}</start>
						<end>${timelineEnd}</end>
						<in>${srcIn}</in>
						<out>${srcOut}</out>
						${fileXml}
					</clipitem>`;
}

function generate({ assembly, title, date, pacingParams, orientation, dayBoundaries }) {
  fileRegistry.clear();
  fileCounter = 1;

  const FACE_DUR  = pacingParams?.faceDur  ?? 4;
  const BROLL_CUT = pacingParams?.brollCut ?? 7;

  const arollClips = assembly.filter(c => c.clipType === 'aroll');
  const brollClips = assembly.filter(c => c.clipType === 'broll');

  // Sequence resolution: vertical overrides to 1080x1920; otherwise detect from clips
  const isVertical = orientation === 'vertical';
  const { w: detW, h: detH } = detectResolution(assembly);
  const seqW = isVertical ? 1080 : detW;
  const seqH = isVertical ? 1920 : detH;

  let clipId = 1;
  const v1 = []; // narration items
  const v2 = []; // broll items

  // Map dayIndex → first timeline frame where that day's first aroll starts (for markers)
  const dayFirstFrame = new Map();

  if (arollClips.length > 0) {
    // Timestamp-based broll matching (mirrors buildInterleaved)
    const sectionMap = arollClips.map(aroll => ({ aroll, brolls: [] }));
    for (const br of brollClips) {
      const brTime = br.filledAt || 0;
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < arollClips.length; i++) {
        const dist = Math.abs((arollClips[i].filledAt || 0) - brTime);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      sectionMap[bestIdx].brolls.push(br);
    }
    for (const sec of sectionMap) {
      sec.brolls.sort((a, b) => (a.filledAt || 0) - (b.filledAt || 0));
    }

    // Slot count mirrors buildInterleaved
    const slotsPerAroll = arollClips.map(c => {
      const dur = c.duration || 0;
      return Math.max(1, Math.floor(Math.max(0, dur - FACE_DUR) / (FACE_DUR + BROLL_CUT)) + 1);
    });

    // Overflow cap mirrors buildInterleaved
    for (let i = 0; i < sectionMap.length; i++) {
      sectionMap[i].brolls = sectionMap[i].brolls.slice(0, slotsPerAroll[i] * 2);
    }

    let timelinePos = 0; // in frames

    for (let ai = 0; ai < sectionMap.length; ai++) {
      const { aroll, brolls }  = sectionMap[ai];
      const narrDur    = aroll.duration || 30; // seconds
      const narrFrames = f(narrDur);
      const cutaways   = brolls.slice(0, slotsPerAroll[ai]);
      const overflow   = brolls.slice(slotsPerAroll[ai]);

      // Track first frame position per day
      const di = aroll.dayIndex ?? 0;
      if (!dayFirstFrame.has(di)) {
        dayFirstFrame.set(di, timelinePos);
      }

      // V1: full narration clip at current timeline position
      v1.push({
        id: `clipitem-v1-${clipId++}`,
        clip: aroll,
        timelineStart: timelinePos,
        timelineEnd:   timelinePos + narrFrames,
        srcIn: 0, srcOut: narrFrames,
      });

      // V2: cutaway broll -- placed OVER the narration (editor can use as-is)
      let brollQ = [...cutaways];
      let posF   = timelinePos;
      let posSec = 0;

      while (posSec < narrDur && brollQ.length > 0) {
        const faceEndSec = Math.min(posSec + FACE_DUR, narrDur);
        posF   += f(faceEndSec - posSec);
        posSec  = faceEndSec;

        if (posSec < narrDur) {
          const br        = brollQ.shift();
          const cutDurSec = Math.min(BROLL_CUT, narrDur - posSec);
          const cutFrames = f(cutDurSec);
          v2.push({
            id: `clipitem-v2-cut-${clipId++}`,
            clip: br,
            timelineStart: posF,
            timelineEnd:   posF + cutFrames,
            srcIn: 0, srcOut: cutFrames,
          });
          posF   += cutFrames;
          posSec += cutDurSec;
        }
      }

      // Advance past the narration section
      timelinePos += narrFrames;

      // V2: overflow broll plays sequentially after narration
      for (const br of overflow) {
        const brDur    = Math.min(BROLL_CUT, br.duration || BROLL_CUT);
        const brFrames = f(brDur);
        v2.push({
          id: `clipitem-v2-ovf-${clipId++}`,
          clip: br,
          timelineStart: timelinePos,
          timelineEnd:   timelinePos + brFrames,
          srcIn: 0, srcOut: brFrames,
        });
        timelinePos += brFrames;
      }
    }
  } else {
    // No narration -- sequential broll on V2
    let t = 0;
    // Use full assembly order for broll-only timelines so day boundaries are correct
    const seqClips = assembly.filter(c => c.clipType !== 'aroll');
    for (const clip of seqClips) {
      const dur    = Math.min(BROLL_CUT, clip.duration || BROLL_CUT);
      const frames = f(dur);
      // Track first frame per day for markers
      const di = clip.dayIndex ?? 0;
      if (!dayFirstFrame.has(di)) dayFirstFrame.set(di, t);
      v2.push({
        id: `clipitem-v2-${clipId++}`,
        clip,
        timelineStart: t, timelineEnd: t + frames,
        srcIn: 0, srcOut: frames,
      });
      t += frames;
    }
  }

  const totalFrames = Math.max(
    v1.length ? v1[v1.length - 1].timelineEnd : 0,
    v2.length ? v2[v2.length - 1].timelineEnd : 0,
  );

  const v1xml = v1.map(e => clipItem(e.id, e.clip, e.timelineStart, e.timelineEnd, e.srcIn, e.srcOut, seqW, seqH)).join('');
  const v2xml = v2.map(e => clipItem(e.id, e.clip, e.timelineStart, e.timelineEnd, e.srcIn, e.srcOut, seqW, seqH)).join('');

  const seqName = escXml(title || `Slice of Life -- ${date || new Date().toISOString().slice(0, 10)}`);

  // Build chapter markers for day boundaries (skip day 0)
  let markersXml = '';
  if (dayBoundaries && dayBoundaries.length > 1) {
    markersXml = dayBoundaries
      .filter(b => b.dayIndex > 0)
      .map(b => {
        const frame = dayFirstFrame.get(b.dayIndex) ?? 0;
        return `
		<marker>
			<name>${escXml(b.label)}</name>
			<in>${frame}</in>
			<out>${frame}</out>
			<comment></comment>
		</marker>`;
      })
      .join('');
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
	<sequence>
		<rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate>
		<name>${seqName}</name>
		<duration>${totalFrames}</duration>${markersXml}
		<media>
			<video>
				<format>
					<samplecharacteristics>
						<rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate>
						<width>${seqW}</width>
						<height>${seqH}</height>
					</samplecharacteristics>
				</format>
				<track>${v1xml}
				</track>
				<track>${v2xml}
				</track>
			</video>
			<audio>
				<track/>
			</audio>
		</media>
	</sequence>
</xmeml>`;
}

module.exports = { generate };
