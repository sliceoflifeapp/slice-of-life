// Synthesized UI sounds — no audio files needed.
// All sounds are generated with the Web Audio API at runtime.

let _audioCtx = null;
function _ctx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

// Soft cinematic bloom — plays as the intro logo appears.
// Three detuned sine pads + a gentle noise whoosh.
function playIntroSound() {
  try {
    const ctx = _ctx();
    const t   = ctx.currentTime;

    // Pad: three soft sine tones (A2 chord, slightly detuned for warmth)
    [[220, 0], [330, 5], [440, -4]].forEach(([freq, detune]) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type          = 'sine';
      osc.frequency.value = freq;
      osc.detune.value    = detune;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.042, t + 0.5);
      gain.gain.linearRampToValueAtTime(0.027, t + 1.2);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 3.0);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 3.0);
    });

  } catch (e) {}
}

// Satisfying two-note ascending chime — plays when the render is done.
// C5 then G5 (perfect fifth), each with a bell-like exponential decay.
function playDoneSound() {
  try {
    const ctx = _ctx();
    const t   = ctx.currentTime;

    [[523.25, 0, 0.108], [783.99, 0.20, 0.069]].forEach(([freq, delay, vol]) => {
      // Fundamental
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type          = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t + delay);
      gain.gain.linearRampToValueAtTime(vol, t + delay + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 2.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 2.2);

      // Octave harmonic (quieter, shorter) for bell shimmer
      const osc2  = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type           = 'sine';
      osc2.frequency.value = freq * 2;
      gain2.gain.setValueAtTime(0, t + delay);
      gain2.gain.linearRampToValueAtTime(vol * 0.28, t + delay + 0.008);
      gain2.gain.exponentialRampToValueAtTime(0.0001, t + delay + 1.0);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(t + delay);
      osc2.stop(t + delay + 1.0);
    });
  } catch (e) {}
}
