// ── FAQ ───────────────────────────────────────────────────────────────────────

function openFaq() {
  document.getElementById('faq-overlay').classList.add('open');
}
function closeFaq() {
  document.getElementById('faq-overlay').classList.remove('open');
}
function closeFaqOnOverlay(e) {
  if (e.target === document.getElementById('faq-overlay')) closeFaq();
}
function toggleFaq(questionEl) {
  const item = questionEl.closest('.faq-item');
  const isOpen = item.classList.contains('open');
  // Close all open items first
  document.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
  if (!isOpen) item.classList.add('open');
}

// ── Filming guide ─────────────────────────────────────────────────────────────

function openGuide() {
  document.getElementById('guide-overlay').classList.add('open');
}
function closeGuide() {
  document.getElementById('guide-overlay').classList.remove('open');
  localStorage.setItem('hasSeenGuide', '1');
}
function closeGuideOnOverlay(e) {
  if (e.target === document.getElementById('guide-overlay')) closeGuide();
}

// ── Source picker ──────────────────────────────────────────────────────────────

async function pickMacFolder(mode) {
  const filePaths = await window.electronAPI.selectFolder();
  if (!filePaths || !filePaths.length) return;

  let folderPath;

  if (filePaths.length === 1) {
    // Single selection — could be a folder or a single file
    const single = filePaths[0];
    // Check if it's a directory by trying the folder route first;
    // the preload can't do fs.stat, so we use a simple extension check:
    // if it has a video extension it's a file, otherwise treat as folder.
    const VIDEO_EXTS = new Set(['mp4','mov','m4v','avi','mkv','mts','m2ts','webm']);
    const ext = single.split('.').pop().toLowerCase();
    if (VIDEO_EXTS.has(ext)) {
      // Single file — stage it
      const res = await fetch('/api/files/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths }),
      }).then(r => r.json());
      folderPath = res.folderPath;
    } else {
      folderPath = single;
    }
  } else {
    // Multiple selections — stage all files into a temp folder
    const res = await fetch('/api/files/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths }),
    }).then(r => r.json());
    folderPath = res.folderPath;
  }

  if (!folderPath) return;
  if (mode === 'trip') startTrip(folderPath);
  else                 startSession(folderPath);
}

// ── Device picker ──────────────────────────────────────────────────────────────

async function openDevicePicker(mode) {
  // mode stored so device selection knows where to route
  if (mode) _activeMode = mode;

  document.getElementById('device-overlay').classList.add('open');
  const body = document.getElementById('device-body');
  body.innerHTML = '<div style="color:#3A6090;font-size:13px;text-align:center;padding:20px 0;">Scanning for devices…</div>';

  try {
    const { devices } = await fetch('/api/devices').then(r => r.json());

    if (!devices.length) {
      body.innerHTML = `
        <div class="album-fallback">
          No connected devices found.
          <br><br>
          Plug in your phone, camera, or SD card reader and try <strong style="color:#6A9FD4">Refresh</strong>.
          <br><br>
          For iPhone: connect via USB and tap <strong style="color:#6A9FD4">Trust</strong> on your phone first.
          <br><br>
          <button onclick="openDevicePicker()">Refresh</button>
        </div>`;
      return;
    }

    body.innerHTML = '';
    for (const device of devices) {
      const row = document.createElement('div');
      row.className = 'album-row';
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          <i class="ti ti-${device.hasDcim ? 'camera' : 'device-usb'}" style="font-size:16px;color:#6A9FD4;"></i>
          <span class="album-name">${escHtml(device.name)}</span>
        </div>
        <span class="album-count">${device.hasDcim ? 'Camera / Phone' : 'Drive'}</span>`;
      row.addEventListener('click', () => {
        closeDevicePicker();
        if (_activeMode === 'trip') startTrip(device.scanPath);
        else                        startSession(device.scanPath);
      });
      body.appendChild(row);
    }
  } catch (err) {
    body.innerHTML = `<div class="album-fallback">Failed to scan devices: ${err.message}</div>`;
  }
}

function closeDevicePicker() {
  document.getElementById('device-overlay').classList.remove('open');
}

function closeDevicePickerOnOverlay(e) {
  if (e.target === document.getElementById('device-overlay')) closeDevicePicker();
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── DOMContentLoaded ───────────────────────────────────────────────────────────

// ── Recent banner ──────────────────────────────────────────────────────────────

async function loadRecentBanner() {
  try {
    const { journals } = await fetch('/api/journals/recent').then(r => r.json());
    if (!journals || journals.length === 0) return;

    const section = document.getElementById('recent-section');
    const track   = document.getElementById('banner-items');
    section.classList.add('visible');

    // Duplicate items for seamless infinite scroll — but only if the list is
    // long enough that it needs repeating to fill the track width. With only
    // 1–2 journals, duplicating just looks like a bug; a static strip is fine.
    const MIN_FOR_LOOP = 5;
    const shouldLoop   = journals.length >= MIN_FOR_LOOP;
    const items        = shouldLoop ? [...journals, ...journals] : journals;
    if (!shouldLoop) track.style.animation = 'none';
    for (const j of items) {
      const thumb = document.createElement('div');
      thumb.className = 'banner-thumb';
      const imgSrc = j.thumbPath
        ? `/api/journals/thumbfile?file=${encodeURIComponent(j.thumbPath.split('/').pop())}`
        : `/api/journals/thumbnail?videoPath=${encodeURIComponent(j.videoPath)}&t=${Date.now()}`;
      thumb.innerHTML = `<img src="${imgSrc}" onerror="this.style.opacity='0'">`;
      track.appendChild(thumb);
    }
  } catch {}
}

document.addEventListener('DOMContentLoaded', async () => {
  startOrbs();
  loadRecentBanner();

  // Show filming guide on first launch
  if (!localStorage.getItem('hasSeenGuide')) {
    setTimeout(openGuide, 600);
  }

  // Show offline notice when no internet or no API key.
  // Server does a real DNS probe so this works even when a key is configured.
  fetch('/api/settings').then(r => r.json()).then(s => {
    if (!s.isOnline) {
      document.getElementById('offline-notice').style.display = 'block';
    }
  }).catch(() => {});

  // Load credits
  fetch('/api/credits').then(r => r.json()).then(data => {
    document.getElementById('credits-count').textContent =
      `${data.credits.toLocaleString()} remaining`;
  }).catch(() => {});

  // ── Drag and drop onto either mode card ───────────────────────────────────
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop',     e => e.preventDefault());

  const dropZone = document.getElementById('drop-zone');

  dropZone.addEventListener('dragenter', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));

  dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) {
      _activeMode = 'single';
      await startSession(window.electronAPI.getFilePath(file));
    }
  });
});

// ── Route to configure screen ──────────────────────────────────────────────────

function rememberFolder(folderPath) {
  try { localStorage.setItem('lastFolderPath', folderPath); } catch {}
  renderLastFolder();
}

function renderLastFolder() {
  const chip = document.getElementById('last-folder-chip');
  if (!chip) return;
  const last = localStorage.getItem('lastFolderPath');
  if (last) {
    const name = last.split('/').filter(Boolean).pop() || last;
    chip.style.display = 'flex';
    document.getElementById('last-folder-name').textContent = name;
  } else {
    chip.style.display = 'none';
  }
}

function useLastFolder() {
  const last = localStorage.getItem('lastFolderPath');
  if (last) startSession(last);
}

function startTrip(folderPath) {
  rememberFolder(folderPath);
  sessionStorage.setItem('configureFolderPath', folderPath);
  sessionStorage.setItem('configureMode', 'trip');
  window.location.href = '/configure';
}

function startSession(folderPath) {
  rememberFolder(folderPath);
  sessionStorage.setItem('configureFolderPath', folderPath);
  sessionStorage.setItem('configureMode', 'single');
  // Advance onboarding to step 1 (configure build button)
  if (typeof Onboarding !== 'undefined' && sessionStorage.getItem('onboardingStep') === '0') {
    sessionStorage.setItem('onboardingStep', '1');
  }
  window.location.href = '/configure';
}
