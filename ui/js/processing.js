const STAGE_MAP = {
  metadata: {
    icon:  'ti-file-search',
    title: 'Reading metadata',
    sub:   'Extracting dates, locations, and file info',
  },
  grouping: {
    icon:  'ti-calendar-event',
    title: 'Grouping by date & location',
    sub:   'Clustering files into events',
  },
  ai: {
    icon:  'ti-cpu',
    title: 'Running AI analysis',
    sub:   'Identifying activities and scenes',
  },
  sorting: {
    icon:  'ti-folders',
    title: 'Sorting files',
    sub:   'Writing to organized folder structure',
  },
  recap: {
    icon:  'ti-movie',
    title: 'Creating recap video',
    sub:   'Selecting best moments and exporting',
  },
  done: {
    icon:  'ti-circle-check',
    title: 'All done!',
    sub:   'Your memories have been organized',
  },
  error: {
    icon:  'ti-alert-circle',
    title: 'Something went wrong',
    sub:   'Please go back and try again',
  },
};

const PILL_ORDER = ['metadata', 'grouping', 'ai', 'sorting', 'recap'];

let knownGroups = 0;
let evtSource;

document.addEventListener('DOMContentLoaded', () => {
  startOrbs();
  connectSSE();
});

// ── SSE connection ─────────────────────────────────────────────────────────────

function connectSSE() {
  evtSource = new EventSource('/api/session/events');

  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      updateUI(data);
    } catch { /* skip malformed */ }
  };

  evtSource.onerror = () => {
    // Reconnect silently after a brief pause
    setTimeout(connectSSE, 2000);
  };
}

// ── UI update ─────────────────────────────────────────────────────────────────

function updateUI(s) {
  const stage = s.stage || 'metadata';
  const map   = STAGE_MAP[stage] || STAGE_MAP.metadata;

  // Stage icon + text
  const icon = document.getElementById('stage-icon');
  icon.className = `ti ${map.icon} stage-icon`;

  document.getElementById('stage-title').textContent = map.title;
  document.getElementById('stage-sub').textContent   = map.sub;

  // Progress bar
  const pct = Math.round(s.progress || 0);
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('progress-pct').textContent  = `${pct}%`;

  if (s.fileCount > 0) {
    const done = Math.round((pct / 100) * s.fileCount);
    document.getElementById('progress-count').textContent =
      `${done.toLocaleString()} of ${s.fileCount.toLocaleString()} files`;
  }

  // Stage pills
  const pillIdx = PILL_ORDER.indexOf(stage);
  document.querySelectorAll('.stage-pill').forEach((pill, i) => {
    pill.classList.remove('done', 'active');
    if (i < pillIdx) {
      pill.classList.add('done');
      pill.innerHTML = `<i class="ti ti-check" style="font-size:10px;margin-right:3px;"></i>${pill.dataset.stage === 'metadata' ? 'Reading metadata' : pill.textContent.trim()}`;
    } else if (i === pillIdx) {
      pill.classList.add('active');
    }
  });

  // Groups list — only append new ones
  if (Array.isArray(s.groups) && s.groups.length > knownGroups) {
    const list = document.getElementById('groups-list');
    for (let i = knownGroups; i < s.groups.length; i++) {
      list.appendChild(buildGroupRow(s.groups[i]));
    }
    knownGroups = s.groups.length;
  }

  // Done state
  if (s.status === 'done') {
    evtSource.close();
    document.getElementById('cancel-btn').textContent = 'View results';
    document.getElementById('cancel-btn').onclick = () => {
      window.location.href = '/results';
    };
  }

  // Error state
  if (s.status === 'error') {
    evtSource.close();
    showError(s.error, s);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildGroupRow(g) {
  const el = document.createElement('div');
  el.className = 'group-item';
  const thumbHtml = g.thumbnail
    ? `<img class="group-thumb" src="${g.thumbnail}" alt="">`
    : `<div class="group-dot${g.misc ? ' misc' : ''}"></div>`;
  el.innerHTML = `
    ${thumbHtml}
    <div class="group-name">${escHtml(g.name)}</div>
    <div class="group-count">${escHtml(g.count)}</div>
  `;
  return el;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function cancelProcessing() {
  await fetch('/api/session/cancel', { method: 'POST' });
  evtSource?.close();
  window.location.href = '/';
}

function showError(errorMsg, session) {
  const icon  = document.getElementById('stage-icon');
  icon.className = 'ti ti-alert-circle stage-icon';
  icon.style.color = '#C06060';

  document.getElementById('stage-title').textContent = 'Something went wrong';
  document.getElementById('stage-sub').textContent   = errorMsg || 'An unexpected error occurred';

  const btn = document.getElementById('cancel-btn');
  btn.textContent = 'Go back';
  btn.onclick = () => { window.location.href = '/'; };

  // Inject report button below the cancel button if not already there
  if (!document.getElementById('report-btn')) {
    const reportBtn = document.createElement('button');
    reportBtn.id        = 'report-btn';
    reportBtn.className = 'cancel-btn';
    reportBtn.style.cssText = 'margin-top:10px;background:rgba(192,96,96,0.15);border-color:rgba(192,96,96,0.3);color:#C08080;';
    reportBtn.innerHTML = '<i class="ti ti-send" style="font-size:15px;"></i> Send Error Report';
    reportBtn.onclick   = () => sendErrorReport(errorMsg, session);
    btn.parentNode.insertBefore(reportBtn, btn.nextSibling);
  }
}

function sendErrorReport(errorMsg, session) {
  const body = [
    `Error: ${errorMsg || 'Unknown error'}`,
    `Stage: ${session?.stage || '—'}`,
    `Files: ${session?.fileCount || 0}`,
    `Folder: ${session?.folderPath || '—'}`,
    `Groups found: ${session?.groups?.length || 0}`,
    `Progress: ${session?.progress || 0}%`,
    `Platform: macOS`,
    `Time: ${new Date().toISOString()}`,
  ].join('\n');

  const subject = encodeURIComponent('Slice of Life Error Report');
  const bodyEnc = encodeURIComponent(body);
  window.electronAPI.openPath(`mailto:sliceoflifetech@gmail.com?subject=${subject}&body=${bodyEnc}`);
}
