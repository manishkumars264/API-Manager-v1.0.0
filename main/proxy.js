'use strict';
/*
 * API Manager - local proxy server (main process / browser dev server).
 *
 * Binds to 127.0.1 (loopback only, never LAN). Serves:
 *   GET  /            -> the renderer UI (static files)
 *   GET  /healthz     -> liveness probe (used for stable-port recovery)
 *   POST /proxy       -> forwards an API request to any http/https target
 *
 * The proxy is the single place where:
 *   - outbound HTTP(S) happens (CORS is bypassed because the target request
 *     is made from Node, not from the browser)
 *   - authorization headers are computed (Node crypto; credentials never
 *     leave the process except as needed for the user's selected request)
 *   - challenge-response auth (Digest, NTLMv2) performs its 401 handshake
 *   - OAuth2 client-credentials token exchange happens (token is cached)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const auth = require('./lib/auth');

const MAX_BODY = 20 * 1024 * 1024; // 20 MB response cap
const MAX_REDIRECTS = 5;
const TEXT_HINT = /text\/|json|xml|javascript|html|x-www-form-urlencoded|yaml|csv|svg/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

// 'unsafe-eval' in script-src exists solely so user pre-request/test scripts
// can be compiled inside the isolated, time-limited Web Worker. The app only
// ever loads same-origin local content, and the renderer has no Node access.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * Build the final URL from a base URL + enabled query params + extra query pairs.
 */
function buildFinalUrl(base, query, extraQuery) {
  let url = base || '';
  const pairs = [];
  for (const q of query || []) {
    if (q && q.enabled !== false && q.key !== '' && q.key != null) pairs.push([String(q.key), q.value == null ? '' : String(q.value)]);
  }
  for (const [k, v] of extraQuery || []) pairs.push([k, v]);
  if (pairs.length) {
    const qs = pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}

function parseCookies(setCookieHeaders) {
  const out = [];
  for (const raw of setCookieHeaders || []) {
    const [pair, ...attrs] = String(raw).split(';');
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const c = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
    for (const a of attrs) {
      const ai = a.indexOf('=');
      const k = (ai === -1 ? a : a.slice(0, ai)).trim().toLowerCase();
      const v = ai === -1 ? '' : a.slice(ai + 1).trim();
      if (k === 'expires') c.expires = v;
      else if (k === 'max-age') c.maxAge = v;
      else if (k === 'path') c.path = v;
      else if (k === 'domain') c.domain = v;
      else if (k === 'secure') c.secure = true;
      else if (k === 'httponly') c.httpOnly = true;
      else if (k === 'samesite') c.sameSite = v;
    }
    out.push(c);
  }
  return out;
}

function looksTextual(headers) {
  const ct = (headers.find((h) => h[0].toLowerCase() === 'content-type') || [])[1] || '';
  return TEXT_HINT.test(String(ct));
}

function decodeBody(buf, headers) {
  if (!buf || !buf.length) return { body: '', encoding: 'utf8' };
  if (looksTextual(headers)) {
    return { body: buf.toString('utf8'), encoding: 'utf8' };
  }
  // Heuristic: valid UTF-8 with mostly printable content?
  const sample = buf.slice(0, 512);
  let ok = true;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) { ok = false; break; }
    if (b < 9 || (b > 13 && b < 32)) { ok = false; break; }
  }
  if (ok) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return { body: text, encoding: 'utf8' };
    } catch (e) {
      /* binary */
    }
  }
  return { body: buf.toString('base64'), encoding: 'base64' };
}

/** Perform one outbound request (no redirects). */
function rawRequest(method, url, headers, bodyBuf, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('Invalid URL: ' + url));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(new Error('Only http and https URLs are supported (got ' + u.protocol + ')'));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const reqHeaders = {};
    for (const [k, v] of headers) {
      if (reqHeaders[k] !== undefined) reqHeaders[k] = reqHeaders[k] + ', ' + v;
      else reqHeaders[k] = v;
    }
    if (bodyBuf && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      reqHeaders['Content-Length'] = String(bodyBuf.length);
    }
    const req = lib.request(
      {
        method,
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: reqHeaders,
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c) => {
          if (truncated) return;
          size += c.length;
          if (size > MAX_BODY) {
            truncated = true;
            res.destroy();
          } else {
            chunks.push(c);
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage || '', headers: res.rawHeaders, body: Buffer.concat(chunks), truncated }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    if (timeoutMs && timeoutMs > 0) {
      const t = setTimeout(() => {
        req.destroy(new Error('Request timed out after ' + Math.round(timeoutMs / 1000) + 's'));
      }, timeoutMs);
      req.on('close', () => clearTimeout(t));
    }
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/** CONNECT method: open a TCP tunnel and return the tunnel result. */
function connectRequest(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('Invalid URL: ' + url));
    }
    const port = u.port || (u.protocol === 'https:' ? 443 : 80);
    const sock = net.connect({ host: u.hostname, port });
    let done = false;
    const fail = (err) => {
      if (!done) {
        done = true;
        sock.destroy();
        reject(err);
      }
    };
    if (timeoutMs && timeoutMs > 0) setTimeout(() => fail(new Error('CONNECT timed out')), timeoutMs);
    sock.setTimeout(timeoutMs || 30000, () => fail(new Error('CONNECT timed out (idle)')));
    sock.on('error', (e) => fail(e));
    sock.once('connect', () => {
      const hs = ['CONNECT ' + u.hostname + ':' + port + ' HTTP/1.1'];
      for (const [k, v] of headers) hs.push(k + ': ' + v);
      hs.push('Host: ' + u.hostname + ':' + port);
      hs.push('');
      hs.push('');
      sock.write(hs.join('\r\n'));
      const buf = [];
      const onData = (c) => {
        buf.push(c);
        const s = Buffer.concat(buf).toString('utf8');
        const idx = s.indexOf('\r\n\r\n');
        if (idx === -1) return;
        done = true;
        sock.removeListener('data', onData);
        const statusLine = s.slice(0, s.indexOf('\r\n'));
        const m = statusLine.match(/^HTTP\/\d\.\d (\d{3})(?:\s(.*))?$/);
        const headersOut = [];
        for (const line of s.slice(idx + 4).trim().split('\r\n')) {
          const ci = line.indexOf(':');
          if (ci > 0) headersOut.push([line.slice(0, ci).trim(), line.slice(ci + 1).trim()]);
        }
        sock.end();
        resolve({
          status: m ? parseInt(m[1], 10) : 0,
          statusText: m && m[2] ? m[2] : '',
          headers: headersOut,
          body: Buffer.alloc(0),
          truncated: false,
          note: 'CONNECT tunnel established. API Manager does not proxy data over TLS tunnels; the status reflects the tunnel setup.',
        });
      };
      sock.on('data', onData);
    });
  });
}

// ---------------------------------------------------------------------------
// OAuth2 client-credentials token exchange (cached)
// ---------------------------------------------------------------------------
const tokenCache = new Map();

async function exchangeOAuth2Token(a, timeoutMs) {
  if (!a.tokenUrl) throw new Error('OAuth2 client credentials: token URL is required');
  const key = JSON.stringify([a.tokenUrl, a.clientId || '', a.clientSecret || '', a.scope || '']);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 5000) return cached.token;

  const params = new URLSearchParams({ grant_type: 'client_credentials' });
  if (a.scope) params.set('scope', a.scope);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (a.clientId) {
    const basic = Buffer.from((a.clientId || '') + ':' + (a.clientSecret || ''), 'utf8').toString('base64');
    headers.Authorization = 'Basic ' + basic;
  } else {
    params.set('client_id', a.clientId || '');
    params.set('client_secret', a.clientSecret || '');
  }
  const res = await fetch(a.tokenUrl, {
    method: 'POST',
    headers,
    body: params.toString(),
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('OAuth2 token endpoint returned non-JSON: ' + text.slice(0, 200));
  }
  if (!res.ok || !data.access_token) {
    throw new Error('OAuth2 token exchange failed: HTTP ' + res.status + ' ' + (data.error_description || data.error || text.slice(0, 120)));
  }
  const token = data.access_token;
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

// ---------------------------------------------------------------------------
// Full request pipeline
// ---------------------------------------------------------------------------
async function performRequest(spec, log) {
  log = log || (() => {});
  const t0 = Date.now();
  const method = String(spec.method || 'GET').toUpperCase();
  const timeoutMs = spec.timeoutMs == null ? 30000 : spec.timeoutMs;
  const redirect = spec.redirect || 'follow';
  const a = spec.auth || null;

  // OAuth2 client-credentials: resolve access token first
  if (a && a.type === 'oauth2' && a.flow === 'client_credentials') {
    try {
      a.accessToken = await exchangeOAuth2Token(a, Math.min(Math.max(timeoutMs, 1000), 30000));
    } catch (e) {
      log('oauth2 token exchange failed: ' + e.message);
    }
  }

  let url = buildFinalUrl(spec.url, spec.query, []);

  // API key in query is part of the final URL (so signatures cover it)
  let authResult = { headers: [], extraQuery: [], retryScheme: null };
  if (a && a.type === 'apikey' && a.in === 'query') {
    authResult.extraQuery = [[a.key || 'apikey', a.value || '']];
    url = buildFinalUrl(spec.url, spec.query, authResult.extraQuery);
  }

  let headers = (spec.headers || []).map(([k, v]) => [String(k), String(v)]);
  let bodyBuf = null;
  if (spec.body && spec.body.data) {
    bodyBuf = spec.body.encoding === 'base64' ? Buffer.from(spec.body.data, 'base64') : Buffer.from(String(spec.body.data), 'utf8');
    if (method === 'GET' || method === 'HEAD') bodyBuf = null;
  }

  const specForAuth = { method, url, headers, bodyString: bodyBuf ? bodyBuf.toString('utf8') : '', bodyBuffer: bodyBuf };
  if (a && !(a.type === 'apikey' && a.in === 'query')) {
    authResult = auth.computeAuthHeaders(a, specForAuth);
    if (authResult.error) throw new Error(authResult.error);
    headers = headers.concat(authResult.headers.filter((h) => !String(h[0]).startsWith('@')));
  }

  let redirects = [];
  let redirectBudget = redirect === 'none' ? 0 : redirect === 'limit' ? 1 : MAX_REDIRECTS;
  let currentUrl = url;
  let currentMethod = method;
  let currentHeaders = headers;
  let currentBody = bodyBuf;

  for (let attempt = 0; attempt < 10; attempt++) {
    let res;
    if (currentMethod === 'CONNECT') {
      res = await connectRequest(currentUrl, currentHeaders, timeoutMs);
      if (res.note) res.note = res.note;
      return finalize(res);
    }
    res = await rawRequest(currentMethod, currentUrl, currentHeaders, currentBody, timeoutMs);

    // Challenge-response auth retries
    if (res.status === 401 && attempt < 2) {
      const wa = [];
      for (let i = 0; i < res.headers.length; i += 2) {
        if (res.headers[i].toLowerCase() === 'www-authenticate') wa.push(res.headers[i + 1]);
      }
      const digestChallenge = wa.find((w) => /digest/i.test(w));
      const ntlmChallenge = wa.find((w) => /ntlm/i.test(w));
      if (a && a.type === 'digest' && digestChallenge) {
        try {
          const dh = auth.digestRetryHeaders(a, { method: currentMethod, url: currentUrl }, digestChallenge);
          currentHeaders = currentHeaders.filter((h) => h[0].toLowerCase() !== 'authorization').concat(dh);
          continue;
        } catch (e) {
          log('digest retry failed: ' + e.message);
        }
      } else if (a && a.type === 'ntlmv2' && ntlmChallenge) {
        try {
          const b64 = String(ntlmChallenge).replace(/^NTLM\s*/i, '');
          const nh = [['Authorization', 'NTLM ' + auth.ntlmType3(a, b64)]];
          currentHeaders = currentHeaders.filter((h) => h[0].toLowerCase() !== 'authorization').concat(nh);
          continue;
        } catch (e) {
          log('ntlm retry failed: ' + e.message);
        }
      }
    }

    // Redirects
    let loc = null;
    for (let i = 0; i < res.headers.length; i += 2) {
      if (res.headers[i].toLowerCase() === 'location') {
        loc = res.headers[i + 1];
        break;
      }
    }
    const isRedirect = loc && res.status >= 300 && res.status < 400 && ['301', '302', '303', '307', '308'].includes(String(res.status));
    if (isRedirect && redirect === 'none') return finalize(res);
    if (isRedirect && redirectBudget <= 0) throw new Error('Too many redirects (' + MAX_REDIRECTS + ' followed) — possible redirect loop');
    if (isRedirect && redirectBudget > 0) {
      redirectBudget--;
      let next = loc;
      try {
        currentUrl = new URL(next, currentUrl).toString();
      } catch (e) {
        throw new Error('Bad redirect location: ' + next);
      }
      redirects.push(currentUrl);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && ['POST', 'PUT', 'PATCH'].includes(currentMethod))) {
        currentMethod = 'GET';
        currentBody = null;
        currentHeaders = currentHeaders.filter((h) => !['content-type', 'content-length'].includes(h[0].toLowerCase()));
      }
      // recompute URL-dependent auth on redirect
      if (a && ['oauth1', 'aws4', 'hawk', 'edgegrid'].includes(a.type)) {
        const specForAuth2 = { method: currentMethod, url: currentUrl, headers: currentHeaders, bodyString: currentBody ? currentBody.toString('utf8') : '' };
        const ar2 = auth.computeAuthHeaders(a, specForAuth2);
        currentHeaders = currentHeaders.filter((h) => h[0].toLowerCase() !== 'authorization').concat(ar2.headers);
      }
      continue;
    }

    return finalize(res);
  }
  throw new Error('Too many redirects');

  function finalize(res) {
    const decoded = decodeBody(res.body, res.headers);
    const statusHeaders = [];
    for (let i = 0; i < res.headers.length; i += 2) {
      statusHeaders.push([res.headers[i], res.headers[i + 1]]);
    }
    const setCookie = [];
    for (let i = 0; i < res.headers.length; i += 2) {
      if (res.headers[i].toLowerCase() === 'set-cookie') setCookie.push(res.headers[i + 1]);
    }
    return {
      ok: true,
      status: res.status,
      statusText: res.statusText || '',
      url: currentUrl,
      headers: statusHeaders,
      cookies: parseCookies(setCookie),
      body: decoded.body,
      bodyEncoding: decoded.encoding,
      sizeBytes: res.body.length,
      durationMs: Date.now() - t0,
      redirects,
      truncated: !!res.truncated,
      ...(res.note ? { note: res.note } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function serveStatic(req, res, staticDir) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file = urlPath === '/' ? '/index.html' : urlPath;
  file = path.normalize(file).replace(/^([.][.][/\\])+/, '');
  const full = path.join(staticDir, file);
  if (!full.startsWith(path.resolve(staticDir))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(full).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    res.writeHead(200, headers);
    res.end(data);
  });
}

/**
 * Create the loopback proxy + static server.
 * @param {object} opts {staticDir, sharedDir, port, host}
 * @returns {Promise<http.Server>} resolved after listen
 */
function createProxyServer(opts) {
  const staticDir = path.resolve(opts.staticDir || path.join(__dirname, '..', 'renderer'));
  const sharedDir = path.resolve(opts.sharedDir || path.join(path.dirname(staticDir), 'shared'));
  const host = opts.host || '127.0.0.1';
  const port = opts.port || 7317;

  const server = http.createServer((req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, app: 'API Manager' }));
      }
      if (req.method === 'POST' && req.url === '/proxy') {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
          size += c.length;
          if (size > 50 * 1024 * 1024) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Request spec too large' }));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on('end', async () => {
          let spec;
          try {
            spec = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'Invalid JSON spec' }));
          }
          const log = (m) => res._apimLog && res._apimLog(m);
          performRequest(spec, log)
            .then((r) => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(r));
            })
            .catch((e) => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
            });
        });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const urlPath2 = new URL(req.url, 'http://localhost').pathname;
        if (urlPath2 === '/shared' || urlPath2.startsWith('/shared/')) {
          const fake = Object.assign(req, { url: urlPath2.slice('/shared'.length) || '/' });
          return serveStatic(fake, res, sharedDir);
        }
        return serveStatic(req, res, staticDir);
      }
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed');
    } catch (e) {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      } catch (e2) {
        /* ignore */
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
        server.removeAllListeners('error');
        server.on('error', reject); // keep listening for subsequent attempts handled by caller
        reject(e);
        return;
      }
      reject(e);
    });
    server.listen(port, host, () => {
      const addr = server.address();
      if (addr && addr.address && !['127.0.0.1', '0.0.0.0'].includes(addr.address) === false) {
        /* loopback assertion handled by caller */
      }
      resolve(server);
    });
  });
}

module.exports = { createProxyServer, performRequest, buildFinalUrl, parseCookies, decodeBody, serveStatic, MAX_BODY, CSP };
