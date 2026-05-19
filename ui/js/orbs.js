// Single off-center ambient light source — drawn once, redrawn on resize.
function startOrbs() {
  const canvas = document.getElementById('orbs');
  if (!canvas) return;
  const ctx   = canvas.getContext('2d');
  const inner = canvas.parentElement;

  let celebProgress = 0; // 0 = normal, 1 = fully celebrated

  function draw() {
    const w = canvas.width  = inner.offsetWidth  || 800;
    const h = canvas.height = inner.offsetHeight || 600;

    ctx.clearRect(0, 0, w, h);

    const cx  = w * 0.82;
    const cy  = h * 0.08;

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

  window.celebrateOrb = function () {
    const duration = 3500;
    const start    = performance.now();

    function animate(now) {
      const t = Math.min((now - start) / duration, 1);
      celebProgress = 1 - Math.pow(1 - t, 3); // ease-out cubic
      draw();
      if (typeof window.onCelebProgress === 'function') window.onCelebProgress(celebProgress);
      if (t < 1) requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
  };
}
