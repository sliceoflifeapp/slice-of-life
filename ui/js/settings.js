async function openSettings() {
  try {
    const s = await fetch('/api/settings').then(r => r.json());

    document.getElementById('output-folder-input').value   = s.outputFolder || '';

    const keyInput = document.getElementById('api-key-input');
    keyInput.value = '';
    if (s.hasOwnApiKey) {
      keyInput.placeholder = '••••••••••••••••••••';
      renderApiStatus('own');
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

function renderApiStatus(state) {
  const el = document.getElementById('api-status');
  if (state === 'own') {
    el.innerHTML = '<div class="api-dot ok"></div><span style="color:#60C060">Using your own API key</span>';
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
    await fetch('/api/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    const s = await fetch('/api/settings').then(r => r.json());
    document.getElementById('api-key-input').value = '';
    document.getElementById('api-key-input').placeholder = s.hasOwnApiKey ? '••••••••••••••••••••' : 'sk-ant-api03-…';
    if (s.hasOwnApiKey) renderApiStatus('own');
    else if (s.hasDevKey) renderApiStatus('dev');
    else renderApiStatus('none');

    closeSettings();
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

async function clearSlideshow() {
  try {
    await fetch('/api/journals/clear', { method: 'POST' });
    // Hide the banner section immediately
    const section = document.getElementById('recent-section');
    const track   = document.getElementById('banner-items');
    if (section) section.classList.remove('visible');
    if (track)   track.innerHTML = '';
    closeSettings();
  } catch (err) {
    console.error('Failed to clear slideshow:', err);
  }
}

