// ── FAQ (now lives inside Settings) ──────────────────────────────────────────

function toggleFaq(questionEl) {
  const item = questionEl.closest('.faq-item');
  const isOpen = item.classList.contains('open');
  document.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
  if (!isOpen) item.classList.add('open');
}

function toggleSettingsFaq(el) {
  el.classList.toggle('open');
  document.getElementById('settings-faq-items').classList.toggle('open');
}

function toggleLicenses(el) {
  el.classList.toggle('open');
  document.getElementById('licenses-items').classList.toggle('open');
}

async function openAbout() {
  closeSettings();
  document.getElementById('about-overlay').classList.add('open');
  try {
    const v = await window.electronAPI.getAppVersion();
    document.getElementById('about-version').textContent = `Version ${v}`;
  } catch {}
}
function closeAbout() {
  document.getElementById('about-overlay').classList.remove('open');
}
function closeAboutOnOverlay(e) {
  if (e.target === document.getElementById('about-overlay')) closeAbout();
}

// ── Today's Prompt panel ──────────────────────────────────────────────────────

const NOTEPAD_KEY = 'sol-notepad';
let _promptLoaded  = false;
let _notepadMicRecorder = null;
let _notepadMicListening = false;
let _activeMode = null;

function openPrompt() {
  document.getElementById('prompt-overlay').classList.add('open');
  document.getElementById('notepad-textarea').value = localStorage.getItem(NOTEPAD_KEY) || '';
  if (!_promptLoaded) loadTodaysPrompt();
}
function closePrompt() {
  document.getElementById('prompt-overlay').classList.remove('open');
}
function closePromptOnOverlay(e) {
  if (e.target === document.getElementById('prompt-overlay')) closePrompt();
}

async function toggleNotepadMic() {
  const btn = document.getElementById('notepad-mic-btn');
  const ta  = document.getElementById('notepad-textarea');

  if (_notepadMicListening) {
    _notepadMicRecorder?.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    _notepadMicRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    _notepadMicRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

    _notepadMicRecorder.onstart = () => {
      _notepadMicListening = true;
      btn.classList.add('listening');
      btn.innerHTML = '<i class="ti ti-microphone-off"></i>';
    };

    _notepadMicRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      _notepadMicListening = false;
      btn.classList.remove('listening');
      btn.innerHTML = '<i class="ti ti-loader-2"></i>';
      btn.disabled = true;

      try {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const form = new FormData();
        form.append('audio', blob, 'recording.webm');
        const res  = await apiFetch('/api/stt', { method: 'POST', body: form });
        const data = await res.json();
        if (data.text) {
          ta.value = ta.value ? ta.value.trimEnd() + '\n' + data.text : data.text;
          localStorage.setItem(NOTEPAD_KEY, ta.value);
        }
      } catch {}

      btn.innerHTML = '<i class="ti ti-microphone"></i>';
      btn.disabled  = false;
    };

    _notepadMicRecorder.start();
  } catch {
    btn.classList.add('listening');
    setTimeout(() => btn.classList.remove('listening'), 800);
  }
}

// Persist notepad on every keystroke
document.addEventListener('DOMContentLoaded', () => {
  const ta = document.getElementById('notepad-textarea');
  if (ta) ta.addEventListener('input', () => localStorage.setItem(NOTEPAD_KEY, ta.value));
});

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
      const res = await apiFetch('/api/files/stage', {
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
    const res = await apiFetch('/api/files/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths }),
    }).then(r => r.json());
    folderPath = res.folderPath;
  }

  if (!folderPath) return;
  startSession(folderPath);
}

// ── Device picker ──────────────────────────────────────────────────────────────

async function openDevicePicker(mode) {
  // mode stored so device selection knows where to route
  if (mode) _activeMode = mode;

  document.getElementById('device-overlay').classList.add('open');
  const body = document.getElementById('device-body');
  body.innerHTML = '<div style="color:#3A6090;font-size:13px;text-align:center;padding:20px 0;">Scanning for devices…</div>';

  try {
    const { devices } = await apiFetch('/api/devices').then(r => r.json());

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
        startSession(device.scanPath);
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

// ── Today's prompt ────────────────────────────────────────────────────────────

async function loadTodaysPrompt() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const cacheKey = `prompt-${todayStr}`;

  let data = null;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try { data = JSON.parse(cached); } catch {}
  }

  if (!data) {
    try {
      const res = await apiFetch('/api/prompt/today');
      data = await res.json();
      if (data.ok && data.narration) {
        localStorage.setItem(cacheKey, JSON.stringify({ narration: data.narration, filming: data.filming }));
      }
    } catch {}
  }

  if (data?.narration) {
    document.getElementById('prompt-narration').textContent = data.narration;
    document.getElementById('prompt-filming').textContent   = data.filming;
    document.getElementById('prompt-loading').style.display  = 'none';
    document.getElementById('prompt-content').classList.add('visible');
    _promptLoaded = true;
  }
}

// ── DOMContentLoaded ───────────────────────────────────────────────────────────

// ── Recent banner ──────────────────────────────────────────────────────────────

// Subtle gradient palettes for placeholder cards — all in the app's dark-blue tone
const PLACEHOLDER_GRADIENTS = [
  'linear-gradient(135deg, rgba(18,42,90,0.9) 0%, rgba(8,22,55,0.95) 100%)',
  'linear-gradient(155deg, rgba(12,38,80,0.9) 0%, rgba(25,55,105,0.85) 100%)',
  'linear-gradient(120deg, rgba(8,28,70,0.95) 0%, rgba(20,48,95,0.85) 100%)',
  'linear-gradient(145deg, rgba(22,48,100,0.9) 0%, rgba(10,28,65,0.95) 100%)',
  'linear-gradient(130deg, rgba(15,35,78,0.9) 0%, rgba(30,58,110,0.80) 100%)',
  'linear-gradient(160deg, rgba(10,25,62,0.95) 0%, rgba(18,44,88,0.88) 100%)',
  'linear-gradient(125deg, rgba(20,45,95,0.88) 0%, rgba(8,24,58,0.96) 100%)',
  'linear-gradient(140deg, rgba(14,32,72,0.92) 0%, rgba(26,52,102,0.84) 100%)',
];

function buildPlaceholderThumb(idx) {
  const thumb = document.createElement('div');
  thumb.className = 'banner-thumb banner-thumb-placeholder';
  thumb.style.background = PLACEHOLDER_GRADIENTS[idx % PLACEHOLDER_GRADIENTS.length];
  // Subtle camera icon centered
  thumb.innerHTML = `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0.12;">
    <i class="ti ti-camera" style="font-size:32px;color:#fff;"></i>
  </div>`;
  return thumb;
}

async function loadRecentBanner() {
  try {
    const data     = await apiFetch('/api/journals/recent').then(r => r.json());
    const journals = data.journals || [];

    const section = document.getElementById('recent-section');
    const track   = document.getElementById('banner-items');
    track.innerHTML = '';
    section.classList.add('visible');

    const streakSection = document.getElementById('streak-section');
    const streakLabel   = document.getElementById('streak-label');
    if (streakSection) streakSection.classList.add('visible');
    if (streakLabel) {
      if (data.streak > 0) {
        streakLabel.textContent = `${data.streak}-day streak`;
      } else if (data.hasHistory) {
        streakLabel.textContent = `Start your streak`;
      } else {
        streakLabel.textContent = `Let's make your first Slice`;
      }
    }

    // Build one full "page" of cards: real items padded with placeholders to MIN_CARDS.
    // Then clone the entire page so both halves are identical — guarantees a seamless loop.
    const MIN_CARDS = 8;
    const placeholderCount = Math.max(0, MIN_CARDS - journals.length);

    const buildPage = () => {
      const frag = document.createDocumentFragment();
      for (const j of journals) {
        const thumb = document.createElement('div');
        thumb.className = 'banner-thumb';
        const thumbFile = j.thumbPath ? j.thumbPath.split('/').pop() : null;
        const bust = j.exportedAt ? `&t=${new Date(j.exportedAt).getTime()}` : '';
        const imgSrc = thumbFile
          ? `/api/journals/thumbfile?file=${encodeURIComponent(thumbFile)}${bust}`
          : `/api/journals/thumbnail?videoPath=${encodeURIComponent(j.videoPath)}`;
        thumb.innerHTML = `<img src="${imgSrc}" onerror="this.style.opacity='0'">`;
        frag.appendChild(thumb);
      }
      for (let i = 0; i < placeholderCount; i++) {
        frag.appendChild(buildPlaceholderThumb(i));
      }
      return frag;
    };

    // Append page 1 then page 2 (cloned) — animation scrolls exactly -50% to loop
    track.appendChild(buildPage());
    track.appendChild(buildPage());

    // Only animate if there's enough content to actually scroll
    if (MIN_CARDS < 5) {
      track.style.animation = 'none';
    }
  } catch {}
}

document.addEventListener('DOMContentLoaded', async () => {
  await initAppToken();

  const firstOpen = !sessionStorage.getItem('introPlayed');
  if (firstOpen) sessionStorage.setItem('introPlayed', '1');

  startOrbs();

  if (firstOpen) {
    const splash = document.getElementById('intro-splash');
    splash.classList.add('active');
    if (typeof playIntroSound === 'function') playIntroSound();
    window.runIntroOrb(() => {
      splash.classList.add('logo-out');
      setTimeout(() => {
        splash.classList.add('done');
        document.getElementById('main-content').classList.add('visible');
      }, 550);
    });
  } else {
    document.getElementById('main-content').classList.add('visible');
  }

  loadRecentBanner();

  // Show filming guide on first launch — delay so intro can finish first
  if (!localStorage.getItem('hasSeenGuide')) {
    setTimeout(openGuide, firstOpen ? 3800 : 600);
  }

  // Load settings — drives offline notice, credit bar, and activation check
  apiFetch('/api/settings').then(r => r.json()).then(s => {
    if (!s.isOnline) {
      document.getElementById('offline-notice').style.display = 'block';
    }
    updateCreditBar(s.creditBalance);
    if (!s.hasLicense) {
      document.getElementById('activation-overlay').classList.add('open');
    }
  }).catch(() => {});

  // Load micro-stats
  document.getElementById('micro-stats').style.display = 'flex';
  apiFetch('/api/stats').then(r => r.json()).then(({ slices, clips, footage }) => {
    document.getElementById('stat-slices').textContent  = slices;
    document.getElementById('stat-clips').textContent   = clips;
    document.getElementById('stat-footage').textContent = footage === '0m' ? '—' : footage;
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

function startSession(folderPath) {
  rememberFolder(folderPath);
  sessionStorage.setItem('configureFolderPath', folderPath);
  window.location.href = '/configure';
}

// ── Credits ────────────────────────────────────────────────────────────────────

function updateCreditBar(balance) {
  const el = document.getElementById('credits-count');
  if (!el) return;
  if (balance === null || balance === undefined) {
    el.textContent = '— remaining';
  } else {
    el.textContent = `${balance.toLocaleString()} remaining`;
  }
}

// ── Feedback ───────────────────────────────────────────────────────────────────

function openFeedback() {
  document.getElementById('feedback-overlay').classList.add('open');
  document.getElementById('feedback-text').value = '';
  setTimeout(() => document.getElementById('feedback-text').focus(), 50);
}
function closeFeedback() {
  document.getElementById('feedback-overlay').classList.remove('open');
}
function closeFeedbackOnOverlay(e) {
  if (e.target === document.getElementById('feedback-overlay')) closeFeedback();
}
function submitFeedback() {
  const msg = document.getElementById('feedback-text').value.trim();
  if (!msg) return;
  const subject = encodeURIComponent('Slice of Life Bug Report');
  const body    = encodeURIComponent(msg);
  window.electronAPI.openExternal(`mailto:sliceoflifetech@gmail.com?subject=${subject}&body=${body}`);
  closeFeedback();
}

function openFeatureRequest() {
  document.getElementById('feature-overlay').classList.add('open');
  document.getElementById('feature-text').value = '';
  setTimeout(() => document.getElementById('feature-text').focus(), 50);
}
function closeFeature() {
  document.getElementById('feature-overlay').classList.remove('open');
}
function closeFeatureOnOverlay(e) {
  if (e.target === document.getElementById('feature-overlay')) closeFeature();
}
function submitFeature() {
  const msg = document.getElementById('feature-text').value.trim();
  if (!msg) return;
  const subject = encodeURIComponent('Slice of Life Feature Request');
  const body    = encodeURIComponent(msg);
  window.electronAPI.openExternal(`mailto:sliceoflifetech@gmail.com?subject=${subject}&body=${body}`);
  closeFeature();
}

function openTopUp() {
  document.getElementById('topup-overlay').classList.add('open');
  document.getElementById('topup-code-input').value = '';
  document.getElementById('topup-error').textContent = '';
  document.getElementById('topup-success').textContent = '';
}
function closeTopUp() {
  document.getElementById('topup-overlay').classList.remove('open');
}
function closeTopUpOnOverlay(e) {
  if (e.target === document.getElementById('topup-overlay')) closeTopUp();
}

async function redeemTopUp() {
  const input = document.getElementById('topup-code-input');
  const errorEl = document.getElementById('topup-error');
  const successEl = document.getElementById('topup-success');
  const btn = document.getElementById('topup-redeem-btn');
  const code = input.value.trim();

  if (!code) { errorEl.textContent = 'Please enter a credit key.'; return; }

  btn.disabled = true;
  btn.textContent = 'Redeeming…';
  errorEl.textContent = '';
  successEl.textContent = '';

  try {
    const res = await apiFetch('/api/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topup_code: code }),
    }).then(r => r.json());

    if (!res.ok) {
      errorEl.textContent = res.error || 'Redemption failed. Please try again.';
      btn.disabled = false;
      btn.textContent = 'Redeem';
      return;
    }

    updateCreditBar(res.newBalance);
    successEl.textContent = `✓ ${res.creditsAdded} credits added. New balance: ${res.newBalance}.`;
    input.value = '';
    setTimeout(closeTopUp, 2000);
  } catch (err) {
    errorEl.textContent = 'Could not connect. Check your internet connection.';
    btn.disabled = false;
    btn.textContent = 'Redeem';
  }
}

async function activateApp() {
  const input = document.getElementById('activation-key-input');
  const errorEl = document.getElementById('activation-error');
  const btn = document.getElementById('activate-btn');
  const key = input.value.trim();

  if (!key) {
    errorEl.textContent = 'Please enter your license key.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Activating…';
  errorEl.textContent = '';

  try {
    const res = await apiFetch('/api/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key }),
    }).then(r => r.json());

    if (!res.ok) {
      errorEl.textContent = res.error || 'Activation failed. Please check your key and try again.';
      btn.disabled = false;
      btn.textContent = 'Activate';
      return;
    }

    document.getElementById('activation-overlay').classList.remove('open');
    updateCreditBar(res.credits);
  } catch (err) {
    errorEl.textContent = 'Could not connect to activation server. Check your internet connection.';
    btn.disabled = false;
    btn.textContent = 'Activate';
  }
}
