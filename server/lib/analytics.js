// PostHog analytics — anonymous event tracking.
// All events are tied to a random per-installation ID stored in ~/.slice-of-life/config.json.
// No personal data is ever sent.

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { randomUUID } = require('crypto');

const POSTHOG_KEY  = 'phc_CPkXBiAaHJCLEoKHgWy9Hiu3m3uPuoH66SQMNUuxLVFr';
const POSTHOG_HOST = 'https://us.i.posthog.com';

// Lazy singleton — only created when we have an API key, so PostHog is never
// initialized (and never attempts network calls) when running offline.
let client = null;
function getPostHogClient() {
  if (client) return client;
  if (isOffline()) return null;
  const { PostHog } = require('posthog-node');
  client = new PostHog(POSTHOG_KEY, { host: POSTHOG_HOST, flushAt: 1, flushInterval: 0 });
  return client;
}

// Lazy-load a stable anonymous ID from config
let _anonId = null;
function getAnonId() {
  if (_anonId) return _anonId;
  try {
    const cfgPath = path.join(os.homedir(), '.slice-of-life', 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
    if (!cfg.anonId) {
      cfg.anonId = randomUUID();
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    }
    _anonId = cfg.anonId;
  } catch {
    _anonId = 'unknown';
  }
  return _anonId;
}

function isOffline() {
  try {
    const cfgPath = path.join(os.homedir(), '.slice-of-life', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return !cfg.anthropicApiKey && !process.env.ANTHROPIC_API_KEY;
  } catch { return true; }
}

function track(event, properties = {}) {
  const c = getPostHogClient();
  if (!c) return;
  try {
    c.capture({ distinctId: getAnonId(), event, properties });
  } catch {}
}

module.exports = { track };
