'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { createProxyServer, buildFinalUrl, parseCookies } = require('../main/proxy.js');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

let portBase = 20000 + Math.floor(Math.random() * 40000);
function freshPort() {
  return portBase++;
}

/** Start a mock API target + the proxy on ephemeral loopback ports. */
async function startMock() {
  const targetPort = freshPort();
  const target = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://mock');
      switch (req.url.split('?')[0]) {
        case '/echo': {
          const headers = {};
          for (let i = 0; i < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i].toLowerCase()] = req.rawHeaders[i + 1];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, path: url.pathname, query: url.search, headers, body }));
          return;
        }
        case '/redirect-302':
          res.writeHead(302, { Location: '/echo' });
          res.end();
          return;
        case '/redirect-loop':
          res.writeHead(302, { Location: '/redirect-loop' });
          res.end();
          return;
        case '/slow':
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('slow-ok');
          }, 1500);
          return;
        case '/setcookie':
          res.writeHead(200, { 'Content-Type': 'text/plain', 'Set-Cookie': ['session=abc123; Path=/', 'theme=dark; Max-Age=60; HttpOnly'] });
          res.end('ok');
          return;
        case '/binary':
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x80, 0x7f]));
          return;
        case '/digest': {
          const auth = req.headers.authorization || '';
          if (!/^Digest /.test(auth)) {
            res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="testrealm@host.com", qop="auth", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="op123", algorithm=MD5' });
            res.end('unauthorized');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ auth: 'digest-ok' }));
          return;
        }
        default:
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('no route');
      }
    });
  });
  await new Promise((r) => target.listen(targetPort, '127.0.0.1', r));

  const proxyPort = freshPort();
  const proxy = await createProxyServer({ staticDir: RENDERER_DIR, port: proxyPort, host: '127.0.0.1' });
  return {
    target,
    proxy,
    targetPort,
    targetBase: 'http://127.0.0.1:' + targetPort,
    proxyBase: 'http://127.0.0.1:' + proxyPort,
    stop() {
      for (const srv of [this.target, this.proxy]) {
        try {
          srv.closeAllConnections();
        } catch (e) {
          /* ignore */
        }
        try {
          srv.close();
        } catch (e) {
          /* ignore */
        }
      }
    },
  };
}

test('buildFinalUrl appends query pairs', () => {
  assert.strictEqual(buildFinalUrl('https://x.test/a', [{ key: 'b', value: 'c d', enabled: true }], []), 'https://x.test/a?b=c%20d');
  assert.strictEqual(buildFinalUrl('https://x.test/a?z=1', [{ key: 'b', value: '2', enabled: true }], [['k', 'v']]), 'https://x.test/a?z=1&b=2&k=v');
  assert.strictEqual(buildFinalUrl('https://x.test/a', [{ key: 'off', value: '1', enabled: false }], []), 'https://x.test/a');
});

test('parseCookies decodes attributes', () => {
  const cs = parseCookies(['session=abc123; Path=/; Secure', 'theme=dark; Max-Age=60; HttpOnly']);
  assert.strictEqual(cs[0].name, 'session');
  assert.strictEqual(cs[0].value, 'abc123');
  assert.strictEqual(cs[0].path, '/');
  assert.strictEqual(cs[0].secure, true);
  assert.strictEqual(cs[1].maxAge, '60');
  assert.strictEqual(cs[1].httpOnly, true);
});

test('proxy: static UI, healthz, security headers, path traversal', async () => {
  const m = await startMock();
  try {
    const health = await fetch(m.proxyBase + '/healthz');
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(await health.json(), { ok: true, app: 'API Manager' });

    const index = await fetch(m.proxyBase + '/');
    assert.strictEqual(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.ok(index.headers.get('content-security-policy').includes("default-src 'self'"));
    const html = await index.text();
    assert.ok(html.includes('API Manager'));

    const js = await fetch(m.proxyBase + '/app.js');
    assert.match(js.headers.get('content-type'), /javascript/);
    const worker = await fetch(m.proxyBase + '/worker.js');
    assert.strictEqual(worker.status, 200);
    const shared = await fetch(m.proxyBase + '/shared/pmsubset.js');
    assert.strictEqual(shared.status, 200);

    const traversal = await fetch(m.proxyBase + '/..%2f..%2f..%2fetc%2fpasswd');
    assert.ok([403, 404].includes(traversal.status), 'traversal should be blocked, got ' + traversal.status);
  } finally {
    m.stop();
  }
});

test('proxy: GET with query + headers + apikey in query', async () => {
  const m = await startMock();
  try {
    const res = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'GET',
        url: m.targetBase + '/echo',
        query: [{ key: 'a', value: '1 2', enabled: true }],
        headers: [['X-Client', 'apimanager']],
        auth: { type: 'apikey', key: 'X-Api-Key', value: 'k9', in: 'header' },
      }),
    });
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.status, 200);
    const echo = JSON.parse(data.body);
    assert.strictEqual(echo.method, 'GET');
    assert.strictEqual(echo.query, '?a=1%202');
    assert.strictEqual(echo.headers['x-client'], 'apimanager');
    assert.strictEqual(echo.headers['x-api-key'], 'k9');
    assert.ok(data.headers.some(([k]) => k.toLowerCase() === 'content-type'));
    assert.ok(data.durationMs >= 0);
  } finally {
    m.stop();
  }
});

test('proxy: POST body passthrough and base64 body', async () => {
  const m = await startMock();
  try {
    const res = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'POST',
        url: m.targetBase + '/echo',
        headers: [['Content-Type', 'application/json']],
        body: { encoding: 'utf8', data: '{"n":7}' },
      }),
    });
    const data = await res.json();
    assert.strictEqual(data.status, 200);
    assert.strictEqual(JSON.parse(data.body).body, '{"n":7}');

    const res2 = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'POST',
        url: m.targetBase + '/echo',
        body: { encoding: 'base64', data: Buffer.from('binary\x00payload').toString('base64') },
      }),
    });
    const data2 = await res2.json();
    assert.strictEqual(JSON.parse(data2.body).body, 'binary\x00payload');
  } finally {
    m.stop();
  }
});

test('proxy: redirect follow vs none', async () => {
  const m = await startMock();
  try {
    const follow = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: m.targetBase + '/redirect-302', redirect: 'follow' }),
    });
    const fd = await follow.json();
    assert.strictEqual(fd.status, 200);
    assert.strictEqual(fd.redirects.length, 1);
    assert.ok(fd.redirects[0].endsWith('/echo'));

    const none = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: m.targetBase + '/redirect-302', redirect: 'none' }),
    });
    const nd = await none.json();
    assert.strictEqual(nd.status, 302);
    assert.strictEqual(nd.redirects.length, 0);
    const loc = nd.headers.find(([k]) => k.toLowerCase() === 'location');
    assert.strictEqual(loc[1], '/echo');

    // redirect loop must fail cleanly
    const loop = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: m.targetBase + '/redirect-loop', redirect: 'follow' }),
    });
    const ld = await loop.json();
    assert.strictEqual(ld.ok, false);
    assert.match(ld.error, /redirect/i);
  } finally {
    m.stop();
  }
});

test('proxy: timeout is enforced', async () => {
  const m = await startMock();
  try {
    const t0 = Date.now();
    const res = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: m.targetBase + '/slow', timeoutMs: 300 }),
    });
    const data = await res.json();
    assert.strictEqual(data.ok, false);
    assert.match(data.error, /timed out/i);
    assert.ok(Date.now() - t0 < 1400);
  } finally {
    m.stop();
  }
});

test('proxy: cookies and binary detection', async () => {
  const m = await startMock();
  try {
    const res = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: m.targetBase + '/setcookie' }),
    });
    const data = await res.json();
    assert.strictEqual(data.cookies.length, 2);
    assert.strictEqual(data.cookies[0].name, 'session');
    assert.strictEqual(data.cookies[0].value, 'abc123');

    const bin = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: m.targetBase + '/binary' }),
    });
    const bd = await bin.json();
    assert.strictEqual(bd.bodyEncoding, 'base64');
    assert.strictEqual(bd.sizeBytes, 8);
    assert.strictEqual(Buffer.from(bd.body, 'base64').length, 8);
  } finally {
    m.stop();
  }
});

test('proxy: digest auth 401 handshake completes', async () => {
  const m = await startMock();
  try {
    const res = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'GET',
        url: m.targetBase + '/digest',
        auth: { type: 'digest', username: 'alice', password: 'password' },
      }),
    });
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.status, 200);
    assert.strictEqual(JSON.parse(data.body).auth, 'digest-ok');
  } finally {
    m.stop();
  }
});

test('proxy: JWT auth header reaches the target', async () => {
  const m = await startMock();
  try {
    const res = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'GET',
        url: m.targetBase + '/echo',
        auth: { type: 'jwt', alg: 'HS256', iss: 'app', expSeconds: '60', secret: 's' },
      }),
    });
    const data = await res.json();
    const echo = JSON.parse(data.body);
    assert.ok(echo.headers.authorization.startsWith('Bearer '));
    assert.strictEqual(echo.headers.authorization.split('.').length, 3);
  } finally {
    m.stop();
  }
});

test('proxy: OAuth2 client credentials token exchange', async () => {
  const tokenServer = http.createServer((req, res) => {
    if (req.url === '/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        assert.strictEqual(req.headers.authorization, 'Basic ' + Buffer.from('cid:sec', 'utf8').toString('base64'));
        assert.match(body, /grant_type=client_credentials/);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'tok-123', token_type: 'Bearer', expires_in: 3600 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => tokenServer.listen(0, '127.0.0.1', r));
  const m = await startMock();
  try {
    const res = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'GET',
        url: m.targetBase + '/echo',
        auth: { type: 'oauth2', flow: 'client_credentials', tokenUrl: 'http://127.0.0.1:' + tokenServer.address().port + '/token', clientId: 'cid', clientSecret: 'sec' },
      }),
    });
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    const echo = JSON.parse(data.body);
    assert.strictEqual(echo.headers.authorization, 'Bearer tok-123');
  } finally {
    try { tokenServer.closeAllConnections(); } catch (e) {}
    tokenServer.close();
    m.stop();
  }
});

test('proxy: rejects non-http schemes and bad JSON', async () => {
  const m = await startMock();
  try {
    const res = await fetch(m.proxyBase + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: 'file:///etc/passwd' }),
    });
    const data = await res.json();
    assert.strictEqual(data.ok, false);
    assert.match(data.error, /http and https/);

    const bad = await fetch(m.proxyBase + '/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
    assert.strictEqual(bad.status, 400);
  } finally {
    m.stop();
  }
});

test('proxy binds to loopback only', async () => {
  const proxy = await createProxyServer({ staticDir: RENDERER_DIR, port: 0, host: '127.0.0.1' });
  try {
    assert.strictEqual(proxy.address().address, '127.0.0.1');
  } finally {
    try { proxy.closeAllConnections(); } catch (e) {}
    proxy.close();
  }
});
