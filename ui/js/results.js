document.addEventListener('DOMContentLoaded', async () => {
  startOrbs();

  let session;
  try {
    session = await fetch('/api/session').then(r => r.json());
  } catch {
    window.location.href = '/';
    return;
  }

  // If somehow we land here without a completed session, go home
  if (!session || session.status !== 'done') {
    window.location.href = '/';
    return;
  }

  // ── Summary strip ──────────────────────────────────────────────────────────

  const events = (session.groups || []).filter(g => !g.misc);
  const misc   = (session.groups || []).filter(g => g.misc);

  document.getElementById('sum-events').textContent = events.length;
  document.getElementById('sum-photos').textContent = session.photoCount?.toLocaleString() ?? '—';
  document.getElementById('sum-videos').textContent = session.videoCount?.toLocaleString() ?? '—';
  document.getElementById('sum-size').textContent   = formatBytes(session.totalSize);

  const total = session.groups?.length ?? 0;
  document.getElementById('success-sub').textContent =
    `${total} event${total !== 1 ? 's' : ''} found across your library`;

  // ── Events list ────────────────────────────────────────────────────────────

  const list = document.getElementById('events-list');
  const allGroups = [...events, ...misc]; // events first, misc at bottom

  allGroups.forEach((g, i) => {
    const row = document.createElement('div');
    row.className = 'event-row';
    row.style.animationDelay = `${i * 60}ms`;
    row.innerHTML = `
      <div class="event-dot${g.misc ? ' misc' : ''}"></div>
      <div class="event-name">${escHtml(g.name)}</div>
      <div class="event-count">${escHtml(g.count)}</div>
    `;
    list.appendChild(row);
  });

  // ── Open in Finder ─────────────────────────────────────────────────────────

  const openBtn = document.getElementById('open-btn');
  if (session.outputPath) {
    openBtn.disabled = false;
    openBtn.title = session.outputPath;
  } else {
    openBtn.title = 'Output folder not yet set — coming in the next step';
  }
});

// ── Actions ────────────────────────────────────────────────────────────────────

async function openFolder() {
  try {
    const session = await fetch('/api/session').then(r => r.json());
    if (session.outputPath) {
      await window.electronAPI.openPath(session.outputPath);
    }
  } catch (err) {
    console.error('openFolder failed:', err);
  }
}

function startNew() {
  fetch('/api/session/cancel', { method: 'POST' })
    .finally(() => { window.location.href = '/'; });
}

async function undoSort() {
  const btn = document.getElementById('undo-btn');
  if (!confirm('This will move all files back to their original locations. Are you sure?')) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader-2" style="font-size:16px;animation:spin 1s linear infinite;display:inline-block"></i> Undoing…';

  try {
    const res  = await fetch('/api/session/undo', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      window.location.href = '/';
    } else {
      alert('Undo failed: ' + (data.error || 'Unknown error'));
      btn.disabled = false;
      btn.innerHTML = '<i class="ti ti-arrow-back-up" style="font-size:16px;"></i> Undo Sort';
    }
  } catch (err) {
    alert('Undo failed: ' + err.message);
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-arrow-back-up" style="font-size:16px;"></i> Undo Sort';
  }
}

const style = document.createElement('style');
style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
document.head.appendChild(style);

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes) return '—';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
