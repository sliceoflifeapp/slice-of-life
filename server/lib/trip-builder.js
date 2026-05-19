const fs   = require('fs');
const path = require('path');
const os   = require('os');

function loadApiKey() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.slice-of-life', 'config.json'), 'utf8'));
    if (cfg.anthropicApiKey) return cfg.anthropicApiKey;
  } catch {}
  return process.env.ANTHROPIC_API_KEY || null;
}

// Singleton client — created once, reused for all trip-builder calls
let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = loadApiKey();
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey });
  return _client;
}

async function buildTrip(processedDays) {
  const client = getClient();
  if (!client) return fallbackAssembly(processedDays);

  // Compute per-day clip weight for proportional pacing guidance
  const totalClips = processedDays.reduce((s, d) => s + d.aroll.length + d.broll.length, 0);

  const dayDescriptions = processedDays.map((day, i) => {
    const narration  = day.aroll.map((c, ci) => `  [clip ${ci}] ${c.transcript?.text || '(no transcript)'}`).filter(s => s.trim()).join('\n');
    const brollCount = day.broll.length;
    const arollCount = day.aroll.length;
    const dayClips   = arollCount + brollCount;
    const weight     = totalClips > 0 ? Math.round((dayClips / totalClips) * 100) : Math.round(100 / processedDays.length);
    // Describe broll clips with durations so Claude can judge quality
    const brollDescs = day.broll.map((c, bi) =>
      `  [broll ${bi}] ${(c.duration || 0).toFixed(1)}s${c.isSloMo ? ' (slo-mo)' : ''}${c.isTimeLapse ? ' (time-lapse)' : ''}`
    ).join('\n');
    return `DAY ${i + 1} (${day.dayKey}) — ${weight}% of footage (${dayClips} clips):
  Narrated clips (A-roll, ${arollCount} total):
${narration || '  (none)'}
  B-roll clips (${brollCount} total — skip any shorter than 2s):
${brollDescs || '  (none)'}`;
  }).join('\n\n---\n\n');

  const prompt = `You are assembling a multi-day travel/vlog video from ${processedDays.length} days of footage.

Here is the content from each day:

${dayDescriptions}

Your job:
1. Build a compelling assembly that uses ALL narrated (A-roll) clips — these are the backbone of the story.
2. Interleave B-roll between A-roll sections for visual variety and pacing. Use 1–4 B-roll clips between narrated sections depending on how much the person spoke.
3. Allocate screen time proportionally — days with more footage (higher %) should have more B-roll used. Don't compress a rich day into a single clip.
4. Prefer longer, richer B-roll clips (5s+) over micro-clips. Skip any B-roll clips shorter than 2 seconds entirely.
5. OPEN the video with a strong wide/scenic B-roll establishing shot from Day 1 — not a talking head. This sets the stage for the whole trip.
6. CLOSE the video with a memorable wide/scenic B-roll shot from the last day — not a talking head. End on a beautiful note.
7. Scale the total length naturally to the content — don't compress a 4-day trip into 3 minutes.

Return ONLY a JSON object (no markdown) with:
{
  "assembly": [
    { "day": 0, "type": "aroll", "index": 0 },
    { "day": 0, "type": "broll", "index": 0 },
    ...
  ]
}

day = 0-based day index, index = 0-based clip index within aroll or broll array for that day.`;

  let result;
  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text      = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    result = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('Trip builder Claude error:', err.message);
    return fallbackAssembly(processedDays);
  }

  // Resolve abstract indices to concrete clip objects
  const assembly = [];
  for (const item of result.assembly) {
    const day  = processedDays[item.day];
    if (!day) continue;
    const clip = item.type === 'aroll' ? day.aroll[item.index] : day.broll[item.index];
    if (!clip) continue;
    assembly.push({
      ...clip,
      clipType: item.type === 'aroll' ? 'aroll' : 'broll', // buildJournalVideo uses clipType
    });
  }

  return { assembly };
}

function fallbackAssembly(processedDays) {
  const assembly = [];

  for (let i = 0; i < processedDays.length; i++) {
    const day = processedDays[i];
    const brollPool = [...day.broll];
    for (const clip of day.aroll) {
      assembly.push({ ...clip, clipType: 'aroll' });
      const count = Math.min(2, brollPool.length);
      for (let b = 0; b < count; b++) {
        const bc = brollPool.shift();
        assembly.push({ ...bc, clipType: 'broll' });
      }
    }
    for (const bc of brollPool) {
      assembly.push({ ...bc, clipType: 'broll' });
    }
  }

  return { assembly };
}

module.exports = { buildTrip };
