// Shared animated orb background — call once per screen after DOM ready.
function startOrbs() {
  const canvas = document.getElementById('orbs');
  if (!canvas) return;
  const ctx    = canvas.getContext('2d');
  const inner  = canvas.parentElement;

  function resize() {
    canvas.width  = inner.offsetWidth  || canvas.offsetWidth  || 800;
    canvas.height = inner.offsetHeight || canvas.offsetHeight || 800;
  }
  resize();
  new ResizeObserver(resize).observe(inner);

  const orbs = [
    { x: 0.20, y: 0.20, r: 0.45, color: '#0A2A6E', speed: 0.00018, angle: 0.0 },
    { x: 0.80, y: 0.15, r: 0.38, color: '#0D3580', speed: 0.00013, angle: 1.2 },
    { x: 0.50, y: 0.50, r: 0.32, color: '#071E55', speed: 0.00021, angle: 2.4 },
    { x: 0.10, y: 0.70, r: 0.30, color: '#1848A8', speed: 0.00016, angle: 3.8 },
    { x: 0.85, y: 0.60, r: 0.28, color: '#0A2560', speed: 0.00019, angle: 5.0 },
  ];

  let last = 0;
  function draw(ts) {
    const dt = ts - last;
    last = ts;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    for (const o of orbs) {
      o.angle += o.speed * dt;
      const cx  = (o.x + Math.sin(o.angle)       * 0.22) * w;
      const cy  = (o.y + Math.cos(o.angle * 0.7) * 0.18) * h;
      const rad = o.r * Math.max(w, h);

      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, o.color + 'CC');
      g.addColorStop(1, o.color + '00');

      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }

    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}
