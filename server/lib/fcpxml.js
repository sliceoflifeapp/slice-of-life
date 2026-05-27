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

// Rotation delta for Premiere: what the renderer applied minus what Premiere auto-reads.
// Premiere auto-reads the QuickTime rotate TAG but NOT the display matrix.
// Returns null when no filter needed.
function xmlMotionRotation(clip, clipType) {
  const rotFromTag   = clip.rotFromTag || false;
  const metaRot      = clip.rotation   || 0;
  const premiereAuto = rotFromTag ? metaRot : 0;

  let videoApplied;
  if (clipType === 'aroll') {
    videoApplied = clip.vision?.suggestedRotation ?? metaRot;
  } else if (!rotFromTag) {
    const hasFace = !!(clip.vision?.hasFace || clip.vision?.isTalkingHead);
    videoApplied  = (hasFace && clip.vision?.suggestedRotation != null)
      ? clip.vision.suggestedRotation : 0;
  } else {
    videoApplied = clip.vision?.suggestedRotation ?? metaRot;
  }

  const deltaCW = (videoApplied - premiereAuto + 360) % 360;
  if (deltaCW === 0) return null;
  let val = -deltaCW; // Premiere param is CCW-positive
  if (val <= -180) val += 360;
  return val;
}

function motionRotationXml(degrees) {
  return `<filter>
						<name>Basic Motion</name>
						<effectid>basic</effectid>
						<effectcategory>motion</effectcategory>
						<effecttype>motion</effecttype>
						<mediatype>video</mediatype>
						<parameter>
							<parameterid>rotation</parameterid>
							<name>Rotation</name>
							<value>${degrees}</value>
						</parameter>
					</filter>`;
}

function audioItem(id, clip, timelineStart, timelineEnd, srcIn, srcOut, trackIndex) {
  const fb      = fileBlock(clip);
  const fileXml = fb.xml || `<file id="${fb.id}"/>`;
  const fname   = path.basename(realPath(clip.path));
  return `
					<clipitem id="${id}">
						<name>${escXml(fname)}</name>
						<rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate>
						<start>${timelineStart}</start>
						<end>${timelineEnd}</end>
						<in>${srcIn}</in>
						<out>${srcOut}</out>
						${fileXml}
						<sourcetrack>
							<mediatype>audio</mediatype>
							<trackindex>${trackIndex}</trackindex>
						</sourcetrack>
					</clipitem>`;
}

function clipItem(id, clip, timelineStart, timelineEnd, srcIn, srcOut, seqW, seqH, clipType) {
  const fb      = fileBlock(clip);
  const rp      = realPath(clip.path);
  const fname   = path.basename(rp);
  const fileXml = fb.xml || `<file id="${fb.id}"/>`;

  const colorNote = clip.needsColorConversion
    ? `\n\t\t\t\t\t<!-- HDR/HLG source -- colours baked in MP4; adjust Lumetri colour space in Premiere -->`
    : '';

  const rotDeg    = clipType ? xmlMotionRotation(clip, clipType) : null;
  const rotFilter = rotDeg != null ? motionRotationXml(rotDeg) : '';

  return `
					<clipitem id="${id}">${colorNote}
						<name>${escXml(fname)}</name>
						<rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate>
						<start>${timelineStart}</start>
						<end>${timelineEnd}</end>
						<in>${srcIn}</in>
						<out>${srcOut}</out>
						${fileXml}${rotFilter}
					</clipitem>`;
}

// Build V1/V2 items directly from the renderer's resolved segment list.
// This guarantees the XML matches the MP4 exactly — no re-computation of cut logic.
function buildFromTimeline(resolvedTimeline) {
  const v1 = [];
  const v2 = [];
  let clipId = 1;

  // Each narration section = consecutive entries sharing the same aroll clip path.
  // V1 gets one item per section spanning [narr_start, narr_end] with correct srcIn/srcOut.
  // V2 gets one item per broll entry at its exact timeline position.
  // Overflow brolls (after narr end) go on V2 in the gap — V1 has nothing there.

  let i = 0;
  while (i < resolvedTimeline.length) {
    const entry = resolvedTimeline[i];

    if (entry.clipType === 'aroll') {
      const arollPath    = entry.clip.path;
      const sectionStart = entry.timelineSec;
      let   narrEnd      = entry.timelineSec + entry.dur; // updated as we find more aroll segs
      let   firstSrcIn   = entry.srcIn;
      let   lastSrcOut   = entry.srcOut;

      // Scan ahead: collect all entries for this section
      let j = i + 1;
      while (j < resolvedTimeline.length) {
        const e = resolvedTimeline[j];
        // Stop when a different aroll clip starts (new section)
        if (e.clipType === 'aroll' && e.clip.path !== arollPath) break;
        if (e.clipType === 'aroll') {
          lastSrcOut = e.srcOut;
          narrEnd    = e.timelineSec + e.dur;
        }
        j++;
      }

      // V1: narration clip spans only the narration time (not overflow broll after it)
      v1.push({
        id:   `clipitem-v1-${clipId++}`,
        clip: entry.clip,
        clipType: 'aroll',
        timelineStart: f(sectionStart),
        timelineEnd:   f(narrEnd),
        srcIn:  f(firstSrcIn),
        srcOut: f(lastSrcOut),
      });

      // V2: all broll entries in this section range (cutaways + overflow)
      for (let k = i + 1; k < j; k++) {
        const e = resolvedTimeline[k];
        if (e.clipType !== 'aroll') {
          v2.push({
            id:   `clipitem-v2-${clipId++}`,
            clip: e.clip,
            clipType: 'broll',
            timelineStart: f(e.timelineSec),
            timelineEnd:   f(e.timelineSec + e.dur),
            srcIn:  f(e.srcIn),
            srcOut: f(e.srcOut),
          });
        }
      }

      i = j;
    } else {
      // Broll-only entry (highlight reel or broll before any aroll)
      v2.push({
        id:   `clipitem-v2-${clipId++}`,
        clip: entry.clip,
        clipType: 'broll',
        timelineStart: f(entry.timelineSec),
        timelineEnd:   f(entry.timelineSec + entry.dur),
        srcIn:  f(entry.srcIn),
        srcOut: f(entry.srcOut),
      });
      i++;
    }
  }

  return { v1, v2 };
}

function generate({ assembly, resolvedTimeline, title, date, pacingParams, orientation }) {
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
  let v1, v2;

  if (resolvedTimeline && resolvedTimeline.length > 0) {
    // Use the renderer's actual segment list — guaranteed to match the MP4.
    ({ v1, v2 } = buildFromTimeline(resolvedTimeline));
  } else {
    // Fallback: re-compute from assembly (for old sidecars without resolvedTimeline).
    v1 = [];
    v2 = [];

    if (arollClips.length > 0) {
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

      const slotsPerAroll = arollClips.map(c => {
        const dur = c.duration || 0;
        return Math.max(1, Math.floor(Math.max(0, dur - FACE_DUR) / (FACE_DUR + BROLL_CUT)) + 1);
      });

      for (let i = 0; i < sectionMap.length; i++) {
        sectionMap[i].brolls = sectionMap[i].brolls.slice(0, slotsPerAroll[i] * 2);
      }

      let timelinePos = 0;
      for (let ai = 0; ai < sectionMap.length; ai++) {
        const { aroll, brolls } = sectionMap[ai];
        const narrDur    = aroll.duration || 30;
        const narrFrames = f(narrDur);
        const cutaways   = brolls.slice(0, slotsPerAroll[ai]);
        const overflow   = brolls.slice(slotsPerAroll[ai]);

        v1.push({ id: `clipitem-v1-${clipId++}`, clip: aroll, timelineStart: timelinePos, timelineEnd: timelinePos + narrFrames, srcIn: 0, srcOut: narrFrames });

        let brollQ = [...cutaways];
        let posF = timelinePos, posSec = 0;
        while (posSec < narrDur && brollQ.length > 0) {
          const faceEndSec = Math.min(posSec + FACE_DUR, narrDur);
          posF += f(faceEndSec - posSec);
          posSec = faceEndSec;
          if (posSec < narrDur) {
            const br = brollQ.shift();
            const cutDurSec = Math.min(BROLL_CUT, narrDur - posSec);
            const cutFrames = f(cutDurSec);
            v2.push({ id: `clipitem-v2-cut-${clipId++}`, clip: br, timelineStart: posF, timelineEnd: posF + cutFrames, srcIn: 0, srcOut: cutFrames });
            posF += cutFrames; posSec += cutDurSec;
          }
        }
        timelinePos += narrFrames;
        for (const br of overflow) {
          const brDur = Math.min(BROLL_CUT, br.duration || BROLL_CUT);
          const brFrames = f(brDur);
          v2.push({ id: `clipitem-v2-ovf-${clipId++}`, clip: br, timelineStart: timelinePos, timelineEnd: timelinePos + brFrames, srcIn: 0, srcOut: brFrames });
          timelinePos += brFrames;
        }
      }
    } else {
      let t = 0;
      for (const clip of assembly.filter(c => c.clipType !== 'aroll')) {
        const dur = Math.min(BROLL_CUT, clip.duration || BROLL_CUT);
        const frames = f(dur);
        v2.push({ id: `clipitem-v2-${clipId++}`, clip, timelineStart: t, timelineEnd: t + frames, srcIn: 0, srcOut: frames });
        t += frames;
      }
    }
  }

  const totalFrames = Math.max(
    v1.length ? v1[v1.length - 1].timelineEnd : 0,
    v2.length ? v2[v2.length - 1].timelineEnd : 0,
  );

  const v1xml = v1.map(e => clipItem(e.id, e.clip, e.timelineStart, e.timelineEnd, e.srcIn, e.srcOut, seqW, seqH, e.clipType || 'aroll')).join('');
  const v2xml = v2.map(e => clipItem(e.id, e.clip, e.timelineStart, e.timelineEnd, e.srcIn, e.srcOut, seqW, seqH, e.clipType || 'broll')).join('');
  const a1xml = v1.map((e, i) => audioItem(`clipitem-a1-${i+1}`, e.clip, e.timelineStart, e.timelineEnd, e.srcIn, e.srcOut, 1)).join('');
  const a2xml = v2.map((e, i) => audioItem(`clipitem-a2-${i+1}`, e.clip, e.timelineStart, e.timelineEnd, e.srcIn, e.srcOut, 1)).join('');

  const seqName = escXml(title || `Slice of Life -- ${date || new Date().toISOString().slice(0, 10)}`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
	<sequence>
		<rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate>
		<name>${seqName}</name>
		<duration>${totalFrames}</duration>
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
				<track>${a1xml}
				</track>
				<track>${a2xml}
				</track>
			</audio>
		</media>
	</sequence>
</xmeml>`;
}

module.exports = { generate };
