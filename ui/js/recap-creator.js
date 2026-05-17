let recapOutputPath = null;
let selectedFolder  = null;

async function pickFolder() {
  const result = await window.electronAPI.selectFolder();
  if (!result) return;
  selectedFolder = result;

  const label  = document.getElementById('folder-label');
  const status = document.getElementById('folder-status');
  label.textContent = result.split('/').pop() || result;
  document.getElementById('folder-pick-row').classList.add('has-folder');

  status.textContent = 'Scanning…';
  status.style.color = '#3A6090';
  try {
    const data = await fetch(`/api/recap/scan?folderPath=${encodeURIComponent(result)}`).then(r => r.json());
    if (data.eligible === 0) {
      status.textContent = `⚠ No Slice of Life-organized clips found in this folder — try your Organized folder`;
      status.style.color = '#C06040';
      document.getElementById('generate-btn').disabled = true;
    } else {
      status.textContent = `✓ ${data.eligible} gathered clip${data.eligible === 1 ? '' : 's'} found`;
      status.style.color = '#80A060';
      document.getElementById('generate-btn').disabled = false;
    }
  } catch {
    status.textContent = '';
  }
}

function setPill(el, group) {
  document.querySelectorAll(`.pill[data-group="${group}"]`).forEach(p => p.classList.remove('active'));
  el.classList.add('active');
}

function getPill(group) {
  return document.querySelector(`.pill.active[data-group="${group}"]`)?.dataset.val;
}

let activeRange = 'all';

function setRangePill(el, preset) {
  document.querySelectorAll('[data-group="range"]').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  activeRange = preset;
  document.getElementById('custom-range').style.display = preset === 'custom' ? 'block' : 'none';
  if (preset !== 'custom') applyRangePreset(preset);
}

function applyRangePreset(preset) {
  const now = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  const from = document.getElementById('date-from');
  const to   = document.getElementById('date-to');
  if (preset === 'this-year') {
    from.value = fmt(new Date(now.getFullYear(), 0, 1));
    to.value   = fmt(now);
  } else if (preset === 'last-year') {
    from.value = fmt(new Date(now.getFullYear()-1, 0, 1));
    to.value   = fmt(new Date(now.getFullYear()-1, 11, 1));
  } else if (preset === 'last-6') {
    const d = new Date(now); d.setMonth(d.getMonth() - 6);
    from.value = fmt(d);
    to.value   = fmt(now);
  } else {
    from.value = '1990-01';
    to.value   = fmt(now);
  }
}

function getDateRange() {
  if (activeRange === 'custom') {
    return {
      dateFrom: document.getElementById('date-from').value,
      dateTo:   document.getElementById('date-to').value,
    };
  }
  // For presets, return null/null so server includes everything within range
  const from = document.getElementById('date-from');
  const to   = document.getElementById('date-to');
  return { dateFrom: from.value, dateTo: to.value };
}

async function generate() {
  if (!selectedFolder) {
    alert('Please choose a source folder first.');
    return;
  }

  const { dateFrom, dateTo } = getDateRange();
  const desc     = document.getElementById('recap-desc').value.trim();
  const type     = getPill('type') || 'mix';
  const duration = getPill('dur')  || '1min';
  const cutSpeed = getPill('cut')  || 'normal';

  document.getElementById('generate-btn').disabled = true;
  document.getElementById('progress-area').classList.add('visible');
  document.getElementById('done-area').classList.remove('visible');
  setProgress('Scanning library…', 5);

  try {
    const res  = await fetch('/api/recap/create', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ folderPath: selectedFolder, dateFrom, dateTo, description: desc, recapType: type, duration, cutSpeed }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Unknown error');

    // Poll for progress
    await pollProgress(data.jobId);

  } catch (err) {
    setProgress(`Error: ${err.message}`, 0);
    document.getElementById('generate-btn').disabled = false;
  }
}

async function pollProgress(jobId) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      try {
        const res  = await fetch(`/api/recap/status/${jobId}`);
        const data = await res.json();

        setProgress(data.message || 'Working…', data.progress || 0);

        if (data.status === 'done') {
          clearInterval(interval);
          recapOutputPath = data.outputPath;
          document.getElementById('progress-area').classList.remove('visible');
          document.getElementById('done-area').classList.add('visible');
          document.getElementById('done-sub').textContent = data.outputPath || '';
          resolve();
        } else if (data.status === 'error') {
          clearInterval(interval);
          setProgress(`Error: ${data.error}`, 0);
          document.getElementById('generate-btn').disabled = false;
          reject(new Error(data.error));
        }
      } catch (e) {
        clearInterval(interval);
        reject(e);
      }
    }, 800);
  });
}

function setProgress(label, pct) {
  document.getElementById('progress-label').textContent = label;
  document.getElementById('progress-fill').style.width  = `${pct}%`;
}

function openRecap() {
  if (recapOutputPath) window.electronAPI.openPath(recapOutputPath);
}

function resetForm() {
  recapOutputPath = null;
  document.getElementById('generate-btn').disabled = false;
  document.getElementById('progress-area').classList.remove('visible');
  document.getElementById('done-area').classList.remove('visible');
  setProgress('', 0);
}

// Pre-fill dates to this year on load
document.addEventListener('DOMContentLoaded', () => {
  startOrbs();
  applyRangePreset('all'); // pre-fill hidden date inputs for the default "All time"
});
