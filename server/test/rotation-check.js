#!/usr/bin/env node
// Rotation formula regression tests — no footage, no ffmpeg, no network.
// Run with: node server/test/rotation-check.js
// All cases derived from real bugs found in production runs.

const { parseRotation, rotFrag, clipRotFrag } = require('../lib/journal-video');

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ── parseRotation ─────────────────────────────────────────────────────────────
console.log('\nparseRotation:');

{
  const r = parseRotation('Stream #0:0: Video: h264, 1920x1080, 29.97 fps');
  assert('no metadata → rotation=0', r.rotation, 0);
  assert('no metadata → rotFromTag=false', r.rotFromTag, false);
}
{
  const r = parseRotation('Stream #0:0: Video: h264\n  rotate : 90\n  creation_time: 2024');
  assert('rotate tag 90 → rotation=90', r.rotation, 90);
  assert('rotate tag 90 → rotFromTag=true', r.rotFromTag, true);
}
{
  const r = parseRotation('  rotate : 270');
  assert('rotate tag 270 → rotation=270', r.rotation, 270);
  assert('rotate tag 270 → rotFromTag=true', r.rotFromTag, true);
}
{
  const r = parseRotation('  rotate : 180');
  assert('rotate tag 180 → rotation=180', r.rotation, 180);
}
{
  // iPhone portrait (most common case — bugs found here 3 times)
  const r = parseRotation('    displaymatrix: rotation of -90.00 degrees');
  assert('display matrix -90 → rotation=270 (CCW 90°)', r.rotation, 270);
  assert('display matrix -90 → rotFromTag=false', r.rotFromTag, false);
}
{
  const r = parseRotation('    displaymatrix: rotation of -180.00 degrees');
  assert('display matrix -180 → rotation=180', r.rotation, 180);
}
{
  const r = parseRotation('    displaymatrix: rotation of 90.00 degrees');
  assert('display matrix +90 → rotation=90', r.rotation, 90);
}
{
  // Fractional values should snap to nearest 90°
  const r = parseRotation('    displaymatrix: rotation of -89.98 degrees');
  assert('display matrix -89.98 snaps → rotation=270', r.rotation, 270);
}

// ── rotFrag ───────────────────────────────────────────────────────────────────
console.log('\nrotFrag:');
assert('rotation=0 → no filter',   rotFrag(0),   '');
assert('rotation=90 → transpose=1 (CW)',  rotFrag(90),  ',transpose=1');
assert('rotation=270 → transpose=2 (CCW)', rotFrag(270), ',transpose=2');
assert('rotation=180 → hflip,vflip', rotFrag(180), ',hflip,vflip');

// ── clipRotFrag ───────────────────────────────────────────────────────────────
console.log('\nclipRotFrag — aroll:');
{
  // A-roll: Vision is authoritative; fall back to rotate tag; no display-matrix fallback
  const info = { rotation: 0, rotFromTag: false, storedW: 3840, storedH: 2160 };
  assert('aroll no Vision, no tag → empty', clipRotFrag(info, 'aroll', null, false, 'test.MOV'), '');
  assert('aroll Vision=270 → transpose=2', clipRotFrag(info, 'aroll', 270, false, 'test.MOV'), ',transpose=2');

  const tagInfo = { rotation: 90, rotFromTag: true, storedW: 3840, storedH: 2160 };
  assert('aroll no Vision, tag=90 → transpose=1', clipRotFrag(tagInfo, 'aroll', null, false, 'test.MOV'), ',transpose=1');
  assert('aroll Vision=270 overrides tag=90 → transpose=2', clipRotFrag(tagInfo, 'aroll', 270, false, 'test.MOV'), ',transpose=2');
}

console.log('\nclipRotFrag — broll, rotate TAG:');
{
  // rotate TAG is always authoritative for b-roll — Vision ignored
  const info = { rotation: 90, rotFromTag: true, storedW: 3840, storedH: 2160 };
  assert('broll tag=90, Vision=null → transpose=1', clipRotFrag(info, 'broll', null,  false, 'test.MOV'), ',transpose=1');
  assert('broll tag=90, Vision=270  → transpose=1 (tag wins)', clipRotFrag(info, 'broll', 270, false, 'test.MOV'), ',transpose=1');
}

console.log('\nclipRotFrag — broll, display matrix (Vision decides):');
{
  const info = { rotation: 270, rotFromTag: false, storedW: 3840, storedH: 2160 };

  // Vision says rotate → apply it (faces or no faces)
  assert('broll matrix Vision=270 → transpose=2', clipRotFrag(info, 'broll', 270, true, 'test.MOV'), ',transpose=2');
  assert('broll matrix Vision=270 no-face → transpose=2', clipRotFrag(info, 'broll', 270, false, 'test.MOV'), ',transpose=2');
  assert('broll matrix Vision=90 → transpose=1', clipRotFrag(info, 'broll', 90, false, 'test.MOV'), ',transpose=1');

  // Vision has no opinion → keep as-is (no rotation)
  assert('broll matrix Vision=null → empty (keep as-is)', clipRotFrag(info, 'broll', null, false, 'test.MOV'), '');
  assert('broll matrix Vision=null hasFace → empty (keep as-is)', clipRotFrag(info, 'broll', null, true, 'test.MOV'), '');

  // No rotation needed
  const flat = { rotation: 0, rotFromTag: false, storedW: 3840, storedH: 2160 };
  assert('broll matrix Vision=0 → empty', clipRotFrag(flat, 'broll', 0, false, 'test.MOV'), '');
  assert('broll matrix Vision=null no rotation → empty', clipRotFrag(flat, 'broll', null, false, 'test.MOV'), '');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
