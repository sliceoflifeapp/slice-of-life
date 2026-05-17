let allEvents    = [];
let currentEvent = null;
let photoList    = [];
let lightboxIdx  = 0;

document.addEventListener('DOMContentLoaded', async () => {
  startOrbs();
  await loadLibrary();

  document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target === document.getElementById('lightbox')) closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('lightbox').classList.contains('open')) return;
    if (e.key === 'Escape')      closeLightbox();
    if (e.key === 'ArrowRight')  lightboxNav(1);
    if (e.key === 'ArrowLeft')   lightboxNav(-1);
  });
});

// ── Library view ──────────────────────────────────────────────────────────────

async function loadLibrary() {
  try {
    allEvents = await fetch('/api/library/all').then(r => r.json());
  } catch { allEvents = []; }
  renderLibrary(allEvents);
  loadThumbnails();
}

function showLibrary() {
  currentEvent = null;
  document.getElementById('back-btn').classList.remove('visible');
  document.getElementById('title-text').textContent = 'Library';
  renderLibrary(allEvents);
  loadThumbnails();
}

function renderLibrary(events, flat = false) {
  const area = document.getElementById('scroll-area');

  if (!events.length) {
    area.innerHTML = `<div class="empty-state"><i class="ti ti-photo-off"></i><p>No events found</p></div>`;
    return;
  }

  if (flat) {
    area.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'event-grid';
    events.forEach((ev, i) => grid.appendChild(buildEventCard(ev, i)));
    area.appendChild(grid);
    return;
  }

  const byYear = new Map();
  for (const ev of events) {
    const year = ev.misc ? 'Misc' : (ev.sortKey?.slice(0, 4) || 'Other');
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(ev);
  }

  area.innerHTML = '';
  let delay = 0;
  for (const [year, evs] of byYear) {
    if (year === 'Misc') continue;
    const group = document.createElement('div');
    group.className = 'year-group';
    group.innerHTML = `<div class="year-label">${year}</div>`;
    const grid = document.createElement('div');
    grid.className = 'event-grid';
    evs.forEach(ev => grid.appendChild(buildEventCard(ev, delay++)));
    group.appendChild(grid);
    area.appendChild(group);
  }

  const misc = events.filter(ev => ev.misc);
  if (misc.length) {
    const group = document.createElement('div');
    group.className = 'year-group';
    group.innerHTML = `<div class="year-label">MISC</div>`;
    const grid = document.createElement('div');
    grid.className = 'event-grid';
    misc.forEach(ev => grid.appendChild(buildEventCard(ev, delay++)));
    group.appendChild(grid);
    area.appendChild(group);
  }
}

function buildEventCard(ev, delayIdx = 0) {
  const card = document.createElement('div');
  card.className = `event-card${ev.misc ? ' misc' : ''}`;
  card.style.animationDelay = `${Math.min(delayIdx * 40, 400)}ms`;
  card.dataset.path = ev.fullPath;

  card.innerHTML = `
    <div class="card-thumb-placeholder" data-thumb-target="${escAttr(ev.fullPath)}">
      <i class="ti ti-photo"></i>
    </div>
    <div class="card-body">
      <div class="card-name">${escHtml(ev.name)}</div>
      <div class="card-meta">${ev.fileCount} file${ev.fileCount !== 1 ? 's' : ''}</div>
      ${ev.description ? `<div class="card-desc">${escHtml(ev.description)}</div>` : ''}
    </div>`;

  card.addEventListener('click', () => openEvent(ev));
  return card;
}

// ── Event / photo grid view ───────────────────────────────────────────────────

async function openEvent(ev) {
  currentEvent = ev;
  document.getElementById('back-btn').classList.add('visible');
  document.getElementById('title-text').textContent = ev.name;

  const area = document.getElementById('scroll-area');
  area.innerHTML = `<div class="loading-row"><i class="ti ti-loader spinning"></i> Loading…</div>`;

  let photos = [];
  try {
    photos = await fetch(`/api/library/photos?folderPath=${encodeURIComponent(ev.fullPath)}`).then(r => r.json());
  } catch {}

  photoList = photos;
  area.innerHTML = '';

  if (ev.description) {
    const hdr = document.createElement('div');
    hdr.className = 'event-header visible';
    hdr.innerHTML = `<div class="event-desc-text">${escHtml(ev.description)}</div>`;
    area.appendChild(hdr);
  }

  if (!photos.length) {
    area.innerHTML += `<div class="empty-state"><i class="ti ti-photo-off"></i><p>No photos found</p></div>`;
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'photo-grid';

  photos.forEach((photo, i) => {
    const cell = document.createElement('div');
    cell.className = `photo-cell${photo.isVideo ? ' video-cell' : ''}`;
    cell.style.animationDelay = `${Math.min(i * 20, 300)}ms`;

    const imgUrl = `/api/media?p=${encodeURIComponent(photo.path)}`;
    cell.innerHTML = `
      <img src="${escAttr(imgUrl)}" alt="${escAttr(photo.name)}" loading="lazy">
      ${photo.isVideo ? '<div class="video-badge"><i class="ti ti-player-play" style="font-size:9px;"></i></div>' : ''}
    `;
    cell.addEventListener('click', () => openLightbox(i));
    grid.appendChild(cell);
  });

  area.appendChild(grid);
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

function openLightbox(idx) {
  lightboxIdx = idx;
  updateLightbox();
  document.getElementById('lightbox').classList.add('open');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
}

function lightboxNav(dir) {
  const visiblePhotos = photoList.filter(p => !p.isVideo);
  const visibleIdx = visiblePhotos.indexOf(photoList[lightboxIdx]);
  const next = (visibleIdx + dir + visiblePhotos.length) % visiblePhotos.length;
  lightboxIdx = photoList.indexOf(visiblePhotos[next]);
  updateLightbox();
}

function updateLightbox() {
  const photo = photoList[lightboxIdx];
  if (!photo) return;
  const imgEl = document.getElementById('lightbox-img');
  imgEl.src = `/api/media?p=${encodeURIComponent(photo.path)}`;
  document.getElementById('lightbox-caption').textContent =
    `${photo.name}  ·  ${lightboxIdx + 1} of ${photoList.length}`;
  const hasMultiple = photoList.filter(p => !p.isVideo).length > 1;
  document.getElementById('lb-prev').style.display = hasMultiple ? '' : 'none';
  document.getElementById('lb-next').style.display = hasMultiple ? '' : 'none';
}

// ── Lazy thumbnails ───────────────────────────────────────────────────────────

async function loadThumbnails() {
  const placeholders = document.querySelectorAll('[data-thumb-target]');
  for (const el of placeholders) {
    const folderPath = el.dataset.thumbTarget;
    try {
      const resp = await fetch(`/api/library/thumbnail?folderPath=${encodeURIComponent(folderPath)}`);
      if (!resp.ok) continue;
      const blob = await resp.blob();
      const img  = document.createElement('img');
      img.className = 'card-thumb';
      img.src = URL.createObjectURL(blob);
      img.alt = '';
      el.replaceWith(img);
    } catch {}
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
  return String(str).replace(/"/g,'&quot;');
}
