const fs = require('fs');
const path = require('path');

const ALLOWED_PATHS = new Set([
  'status',
  'fingerprint',
  'delivery-number',
  'pair',
  'answer',
  'audio-done',
  'trigger',
]);

function loadLocalEnv() {
  for (const filename of ['.env.local', '.env']) {
    const envPath = path.join(process.cwd(), filename);
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      value = value.replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

loadLocalEnv();

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding',
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getProxyPath(req) {
  const value = req.query.path;
  const fromQuery = Array.isArray(value) ? value.join('/') : String(value || '');
  if (fromQuery) return fromQuery.replace(/^\/+/, '');

  const incomingUrl = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const pathname = incomingUrl.pathname.replace(/\/+$/, '');
  const knownPrefixes = ['/api/proxy/', '/sardar2photo/'];
  for (const prefix of knownPrefixes) {
    if (pathname.startsWith(prefix)) return pathname.slice(prefix.length);
  }
  return pathname.replace(/^\/+/, '');
}

module.exports = async function handler(req, res) {
  const boothBase = (process.env.BOOTH_API_BASE || '').replace(/\/+$/, '');
  if (!boothBase) {
    res.status(500).json({
      ok: false,
      error: 'BOOTH_API_BASE is not configured in Vercel.',
    });
    return;
  }

  const proxyPath = getProxyPath(req);
  if (!ALLOWED_PATHS.has(proxyPath)) {
    res.status(404).json({ ok: false, error: 'Unknown booth endpoint.' });
    return;
  }

  const incomingUrl = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  incomingUrl.searchParams.delete('path');
  const targetUrl = `${boothBase}/${proxyPath}${incomingUrl.search}`;

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lower) && value !== undefined) {
      headers[key] = Array.isArray(value) ? value.join(',') : value;
    }
  }
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = 'https';

  const init = {
    method: req.method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(12000),
  };
  if (!['GET', 'HEAD'].includes(req.method)) {
    init.body = await readBody(req);
  }

  try {
    const upstream = await fetch(targetUrl, init);
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.send(body);
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    res.status(timedOut ? 504 : 502).json({
      ok: false,
      error: timedOut ? 'Booth PC tunnel timed out.' : 'Could not reach the booth PC.',
      detail: error.message,
    });
  }
};
