let totalCredits  = 500;
let recapOn       = false;
let selectedCreds = 180;

document.addEventListener('DOMContentLoaded', async () => {
  startOrbs();
  await Promise.all([loadSession(), loadCredits(), loadDefaults()]);
});

async function loadDefaults() {
  try {
    const s = await fetch('/api/settings').then(r => r.json());

    if (s.defaultAccuracy) {
      document.querySelectorAll('.accuracy-card').forEach(c => {
        c.classList.toggle('active', c.dataset.val === s.defaultAccuracy);
      });
      const card = document.querySelector(`.accuracy-card[data-val="${s.defaultAccuracy}"]`);
      if (card) selectedCreds = parseInt(card.dataset.credits, 10);
    }

    const pillMap = {
      'type-group': s.defaultRecapType,
      'dur-group':  s.defaultRecapDuration,
      'fmt-group':  s.defaultRecapFormat,
    };
    for (const [groupId, value] of Object.entries(pillMap)) {
      if (!value) continue;
      document.querySelectorAll(`#${groupId} .pill`).forEach(p => {
        p.classList.toggle('active', p.dataset.val === value);
      });
    }
  } catch {}
}

// ── Data loading ───────────────────────────────────────────────────────────────

async function loadSession() {
  try {
    const s = await fetch('/api/session').then(r => r.json());

    if (!s.folderPath) {
      window.location.href = '/';
      return;
    }

    document.getElementById('found-folder').textContent  = s.folderPath;
    document.getElementById('stat-photos').textContent   = s.photoCount.toLocaleString();
    document.getElementById('stat-videos').textContent   = s.videoCount.toLocaleString();
    document.getElementById('stat-size').textContent     = formatBytes(s.totalSize);
  } catch (err) {
    console.error('Failed to load session:', err);
  }
}

async function loadCredits() {
  try {
    const { credits } = await fetch('/api/credits').then(r => r.json());
    totalCredits = credits;
    updateCreditsNote();
  } catch { /* non-fatal */ }
}

// ── Recap toggle ───────────────────────────────────────────────────────────────

function toggleRecap() {
  recapOn = !recapOn;
  document.getElementById('recap-switch').classList.toggle('on', recapOn);
  document.getElementById('recap-panel').classList.toggle('open', recapOn);
  document.getElementById('toggle-row').classList.toggle('open', recapOn);
  document.getElementById('toggle-sub').textContent = recapOn
    ? 'On — highlight reel will be created'
    : 'Off — skip the recap this session';
  updateCreditsNote();
}

// ── Pill / accuracy selection ─────────────────────────────────────────────────

function selectPill(el, group) {
  el.closest('.pill-group').querySelectorAll('.pill')
    .forEach(p => p.classList.remove('active'));
  el.classList.add('active');
}

function selectAccuracy(el) {
  document.querySelectorAll('.accuracy-card')
    .forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  selectedCreds = parseInt(el.dataset.credits, 10);
  updateCreditsNote();
}

function updateCreditsNote() {
  const note = document.getElementById('credits-note');
  if (recapOn) {
    note.textContent =
      `This session will use approx. ${selectedCreds} AI credits · ${totalCredits.toLocaleString()} remaining`;
  } else {
    note.textContent = `${totalCredits.toLocaleString()} AI credits remaining`;
  }
}

// ── Start gathering ───────────────────────────────────────────────────────────

async function startBuilding() {
  const btn = document.getElementById('start-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader-2" style="font-size:16px;animation:spin 1s linear infinite;display:inline-block"></i> Starting…';

  const settings = {
    recap:       recapOn,
    recapType:   activePill('type-group') || 'mix',
    cutSpeed:    activePill('cut-group')  || 'normal',
    duration:    activePill('dur-group'),
    format:      activePill('fmt-group'),
    accuracy:    activeAccuracy(),
    includeMisc: activePill('misc-group') === 'true',
  };

  try {
    await fetch('/api/session/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(settings),
    });

    await fetch('/api/session/process', { method: 'POST' });

    window.location.href = '/processing';
  } catch (err) {
    console.error('Failed to start:', err);
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-sparkles" style="font-size:16px;"></i> Start Building';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function activePill(groupId) {
  const el = document.querySelector(`#${groupId} .pill.active`);
  return el ? el.dataset.val : null;
}

function activeAccuracy() {
  const el = document.querySelector('.accuracy-card.active');
  return el ? el.dataset.val : 'balanced';
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1e6;
  return `${mb.toFixed(0)} MB`;
}

// Keyframe spin used inline on the loading icon
const style = document.createElement('style');
style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
document.head.appendChild(style);
