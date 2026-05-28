// Slice of Life — Anthropic API proxy
//
// Every request from the app includes an X-License-Key header.
// The Worker validates it against Lemon Squeezy (cached 24h in KV),
// then forwards the request to Anthropic with the real API key from Secrets.
//
// Nathan's Anthropic key is stored in Cloudflare Secrets — it never lives
// in the app binary.
//
// Required secrets (set via `wrangler secret put`):
//   ANTHROPIC_API_KEY   — Nathan's Anthropic key
//   DEV_BYPASS_SECRET   — arbitrary string; matches GATHER_DEV_KEY in .zshrc
//
// Required KV namespace binding: LICENSE_CACHE

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Public version check — no auth required
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/version') {
      return new Response(
        JSON.stringify({
          version: env.CURRENT_VERSION || '0.0.0',
          downloadUrl: 'https://sliceoflife-app.com/download',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
      );
    }

    const licenseKey = request.headers.get('X-License-Key');
    if (!licenseKey) {
      return jsonError(401, 'Missing X-License-Key header');
    }

    // Dev bypass — skip LS validation for the known dev secret
    const isDevBypass = env.DEV_BYPASS_SECRET && licenseKey === env.DEV_BYPASS_SECRET;

    if (!isDevBypass) {
      const valid = await validateLicense(licenseKey, env, ctx);
      if (!valid) {
        return jsonError(401, 'Invalid or inactive license key');
      }
    }

    // Build the upstream Anthropic URL from the incoming path + query
    const incoming = new URL(request.url);
    const upstream = new URL(incoming.pathname + incoming.search, 'https://api.anthropic.com');

    // Replace the dummy API key with the real one; strip our custom header
    const headers = new Headers(request.headers);
    headers.set('x-api-key', env.ANTHROPIC_API_KEY);
    headers.delete('X-License-Key');
    // Ensure anthropic-version is present (SDK usually sets this)
    if (!headers.has('anthropic-version')) {
      headers.set('anthropic-version', '2023-06-01');
    }

    const resp = await fetch(new Request(upstream.toString(), {
      method: request.method,
      headers,
      body: request.body,
    }));

    const respHeaders = new Headers(resp.headers);
    addCors(respHeaders);
    return new Response(resp.body, { status: resp.status, headers: respHeaders });
  },
};

// ── License validation ────────────────────────────────────────────────────────

async function validateLicense(licenseKey, env, ctx) {
  const cacheKey = `lic:${await sha256short(licenseKey)}`;

  if (env.LICENSE_CACHE) {
    const cached = await env.LICENSE_CACHE.get(cacheKey);
    if (cached === 'valid')   return true;
    if (cached === 'invalid') return false;
  }

  const valid = await checkLemonSqueezy(licenseKey);

  if (env.LICENSE_CACHE) {
    // Cache valid keys for 24h; invalid keys for 1h (user might have just activated)
    ctx.waitUntil(
      env.LICENSE_CACHE.put(cacheKey, valid ? 'valid' : 'invalid', {
        expirationTtl: valid ? 86400 : 3600,
      })
    );
  }

  return valid;
}

async function checkLemonSqueezy(licenseKey) {
  try {
    const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey }),
    });
    const data = await res.json();
    return data.valid === true;
  } catch {
    // If LS is down, fail open so users aren't blocked (err on side of access)
    return true;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sha256short(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-License-Key, anthropic-version, anthropic-beta',
  };
}

function addCors(headers) {
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
}

function jsonError(status, message) {
  return new Response(
    JSON.stringify({ error: { type: 'error', message } }),
    { status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
  );
}
