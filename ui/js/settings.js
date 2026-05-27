let _renderLogPath = null;

async function openSettings() {
  try {
    const s = await fetch('/api/settings').then(r => r.json());

    document.getElementById('output-folder-input').value   = s.outputFolder || '';

    _renderLogPath = s.renderLogPath || null;
    const logBtn = document.getElementById('view-render-log-btn');
    if (logBtn) {
      logBtn.disabled = !s.renderLogExists;
      logBtn.title    = s.renderLogExists ? s.renderLogPath : 'No render log yet — run a Slice first';
    }

    const keyInput = document.getElementById('api-key-input');
    keyInput.value = '';
    if (s.hasOwnApiKey) {
      keyInput.placeholder = '••••••••••••••••••••';
      renderApiStatus('own', s.keyHint);
    } else if (s.hasDevKey) {
      keyInput.placeholder = 'sk-ant-api03-…';
      renderApiStatus('dev');
    } else {
      keyInput.placeholder = 'sk-ant-api03-…';
      renderApiStatus('none');
    }
  } catch {}

  document.getElementById('settings-overlay').classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
}

function closeSettingsOnOverlay(e) {
  if (e.target === document.getElementById('settings-overlay')) closeSettings();
}

function renderApiStatus(state, hint) {
  const el = document.getElementById('api-status');
  const hintStr = hint ? ` <span style="opacity:0.5;font-size:11px">(${hint})</span>` : '';
  if (state === 'own') {
    el.innerHTML = `<div class="api-dot ok"></div><span style="color:#60C060">Using your own API key${hintStr}</span>`;
  } else if (state === 'dev') {
    el.innerHTML = '<div class="api-dot ok"></div><span style="color:#60C060">AI powered by Slice of Life credits</span>';
  } else {
    el.innerHTML = '<div class="api-dot bad"></div><span style="color:#C0A080">No API key — offline mode (audio heuristics)</span>';
  }
}

async function pickOutputFolder() {
  try {
    const folder = await window.electronAPI.selectFolder();
    if (folder) document.getElementById('output-folder-input').value = folder;
  } catch {}
}

async function saveSettings() {
  const apiKey       = document.getElementById('api-key-input').value.trim();
  const outputFolder = document.getElementById('output-folder-input').value.trim();

  const body = {
    outputFolder,
  };
  if (apiKey) body.apiKey = apiKey;

  try {
    const saveRes = await fetch('/api/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!saveRes.ok) {
      const errData = await saveRes.json().catch(() => ({}));
      alert(`Settings could not be saved: ${errData.error || saveRes.status}`);
      return;
    }

    const s = await fetch('/api/settings').then(r => r.json());
    document.getElementById('api-key-input').value = '';
    document.getElementById('api-key-input').placeholder = s.hasOwnApiKey ? '••••••••••••••••••••' : 'sk-ant-api03-…';
    if (s.hasOwnApiKey) renderApiStatus('own', s.keyHint);
    else if (s.hasDevKey) renderApiStatus('dev');
    else renderApiStatus('none');

    // Flash "Saved!" so the user knows it worked
    const statusEl = document.getElementById('api-status');
    const prev = statusEl.innerHTML;
    statusEl.innerHTML = '<span style="color:#60C060">✓ Saved!</span>';
    setTimeout(() => { statusEl.innerHTML = prev; closeSettings(); }, 1200);
  } catch (err) {
    console.error('Failed to save settings:', err);
    alert(`Settings could not be saved: ${err.message}`);
  }
}

async function viewRenderLog() {
  if (!_renderLogPath) return;
  try { await window.electronAPI.openPath(_renderLogPath); } catch {}
}

async function clearSlideshow() {
  try {
    await fetch('/api/journals/clear', { method: 'POST' });
    closeSettings();
    if (typeof loadRecentBanner === 'function') loadRecentBanner();
  } catch (err) {
    console.error('Failed to clear slideshow:', err);
  }
}

