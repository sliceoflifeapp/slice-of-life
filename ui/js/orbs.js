// Single off-center ambient light source — drawn once, redrawn on resize.
function startOrbs() {
  const canvas = document.getElementById('orbs');
  if (!canvas) return;
  const ctx   = canvas.getContext('2d');
  const inner = canvas.parentElement;

  let celebProgress = 0; // 0 = normal, 1 = fully celebrated
  let introProgress = 1; // 0 = bottom-left start, 1 = settled upper-right

  function draw() {
    const w = canvas.width  = inner.offsetWidth  || 800;
    const h = canvas.height = inner.offsetHeight || 600;

    ctx.clearRect(0, 0, w, h);

    const endCx = w * 0.82, endCy = h * 0.08;
    const startCx = w * 0.15, startCy = h * 0.92;
    const cx = startCx + (endCx - startCx) * introProgress;
    const cy = startCy + (endCy - startCy) * introProgress;

    const rad = Math.max(w, h) * (1.1 + celebProgress * 1.2);
    const op0 = 0.38 + celebProgress * 0.42;
    const op1 = 0.15 + celebProgress * 0.22;

    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0,    `rgba(40, 100, 220, ${op0})`);
    g.addColorStop(0.35, `rgba(20,  60, 150, ${op1})`);
    g.addColorStop(1,    'rgba(0,   0,   0,  0)');

    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  draw();
  new ResizeObserver(draw).observe(inner);

  let animFrame = null;

  function runAnimation(fromVal, toVal, duration, onTick, onDone) {
    if (animFrame) cancelAnimationFrame(animFrame);
    const start = performance.now();
    function step(now) {
      const t = Math.min((now - start) / duration, 1);
      // eased always goes 0→1 so the lerp progresses fromVal→toVal
      const eased = toVal > fromVal
        ? 1 - Math.pow(1 - t, 3)   // ease-out cubic (bloom — fast then slow)
        : t * (2 - t);              // ease-out quad  (dim  — fast then slow)
      celebProgress = fromVal + (toVal - fromVal) * eased;
      draw();
      if (typeof onTick === 'function') onTick(celebProgress);
      if (t < 1) {
        animFrame = requestAnimationFrame(step);
      } else {
        celebProgress = toVal;
        draw();
        if (typeof onDone === 'function') onDone();
      }
    }
    animFrame = requestAnimationFrame(step);
  }

  window.celebrateOrb = function () {
    runAnimation(celebProgress, 1, 3500, window.onCelebProgress);
  };

  window.dimOrb = function (onDone) {
    runAnimation(celebProgress, 0, 1200, window.onDimProgress, onDone);
  };

  window.runIntroOrb = function (onDone) {
    introProgress = 0;
    draw();
    const duration = 3000;
    const startTime = performance.now();
    const logo = document.getElementById('intro-logo');
    function step(now) {
      const t = Math.min((now - startTime) / duration, 1);
      introProgress = 1 - Math.pow(1 - t, 2.5); // ease-out

      // Drive logo brightness off orb position — dark while orb is far away,
      // brightens as orb sweeps into the upper-right corner near the logo.
      if (logo) {
        const p       = introProgress;
        const opacity = Math.pow(p, 1.8);
        const glow    = Math.pow(p, 2.5);
        const blur    = 14 * Math.pow(1 - p, 2);   // clears faster than glow builds
        logo.style.opacity = opacity.toFixed(3);
        // Two-layer glow: wide soft halo + tight bright core
        const halo = `drop-shadow(0 0 ${(glow * 70).toFixed(0)}px rgba(50, 120, 255, ${(glow * 0.75).toFixed(2)}))`;
        const core = `drop-shadow(0 0 ${(glow * 25).toFixed(0)}px rgba(130, 180, 255, ${(glow * 0.9).toFixed(2)}))`;
        logo.style.filter  = `blur(${blur.toFixed(1)}px) ${halo} ${core}`;
      }

      draw();
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        introProgress = 1;
        if (logo) { logo.style.opacity = '1'; logo.style.filter = 'blur(0px) drop-shadow(0 0 70px rgba(50, 120, 255, 0.75)) drop-shadow(0 0 25px rgba(130, 180, 255, 0.90))'; }
        draw();
        if (typeof onDone === 'function') onDone();
      }
    }
    requestAnimationFrame(step);
  };
}
