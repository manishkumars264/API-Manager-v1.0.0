'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { server: appServer, performRequest, md4, makeNtlmType1, makeNtlmType3 } = require('../server');

async function withFixture(handler, callback) {
  const fixture = http.createServer(handler);
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const address = fixture.address();
  try { return await callback(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise(resolve => fixture.close(resolve)); }
}

function collectBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

test('local proxy sends method, query, headers and body and returns status/headers/body', async () => {
  await withFixture(async (req, res) => {
    const body = await collectBody(req);
    res.writeHead(201, { 'content-type': 'application/json', 'x-fixture': 'present' });
    res.end(JSON.stringify({ method: req.method, url: req.url, body, auth: req.headers.authorization || '' }));
  }, async base => {
    const result = await performRequest({ method: 'POST', url: `${base}/echo?hello=world`, headers: { 'content-type': 'application/json', 'x-test': 'yes' }, body: '{"ok":true}', timeout: 10000 });
    assert.equal(result.status, 201);
    assert.equal(result.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(result.body), { method: 'POST', url: '/echo?hello=world', body: '{"ok":true}', auth: '' });
  });
});

test('local proxy honors redirects and redirect-disabled request settings', async () => {
  await withFixture((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: '/finish' }); res.end('redirect'); }
    else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('finished'); }
  }, async base => {
    const followed = await performRequest({ method: 'GET', url: `${base}/start` });
    assert.equal(followed.status, 200); assert.equal(followed.body, 'finished');
    const stopped = await performRequest({ method: 'GET', url: `${base}/start`, followRedirects: false });
    assert.equal(stopped.status, 302); assert.equal(stopped.headers.location, '/finish');
  });
});

test('Digest challenge is retried with an MD5 Authorization response', async () => {
  let attempts = 0;
  await withFixture((req, res) => {
    attempts++;
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Digest ')) { res.writeHead(401, { 'www-authenticate': 'Digest realm="fixture", nonce="nonce-123", qop="auth", algorithm=MD5' }); res.end('challenge'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(auth);
  }, async base => {
    const result = await performRequest({ method: 'GET', url: `${base}/digest`, auth: { type: 'digest', username: 'api-user', password: 'test-pass' } });
    assert.equal(attempts, 2); assert.equal(result.status, 200);
    assert.match(result.body, /^Digest username="api-user"/); assert.match(result.body, /response="[a-f0-9]{32}"/);
  });
});

test('AWS Signature v4 and HMAC JWT authorization are added at send time', async () => {
  await withFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ authorization: req.headers.authorization, date: req.headers['x-amz-date'], hash: req.headers['x-amz-content-sha256'] }));
  }, async base => {
    const aws = await performRequest({ method: 'GET', url: `${base}/aws?b=2&a=1`, auth: { type: 'aws', accessKey: 'AKIDEXAMPLE', secretKey: 'exampleSecret', region: 'us-east-1', service: 'execute-api' } });
    const awsResult = JSON.parse(aws.body);
    assert.equal(aws.status, 200); assert.match(awsResult.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//); assert.match(awsResult.date, /^\d{8}T\d{6}Z$/);
    const jwt = await performRequest({ method: 'GET', url: `${base}/jwt`, auth: { type: 'jwt', secret: 'local-secret', payload: '{"sub":"api-manager"}', algorithm: 'HS256' } });
    assert.match(JSON.parse(jwt.body).authorization, /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

test('OAuth 1.0 and Hawk signatures are generated locally', async () => {
  await withFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ authorization: req.headers.authorization || '' }));
  }, async base => {
    const oauth = await performRequest({ method: 'GET', url: `${base}/oauth?x=one`, auth: { type: 'oauth1', consumerKey: 'client', consumerSecret: 'client-secret', token: 'token', tokenSecret: 'token-secret' } });
    assert.match(JSON.parse(oauth.body).authorization, /^OAuth oauth_consumer_key="client"/);
    const hawk = await performRequest({ method: 'GET', url: `${base}/hawk`, auth: { type: 'hawk', id: 'client-id', key: 'hawk-secret', algorithm: 'sha256' } });
    assert.match(JSON.parse(hawk.body).authorization, /^Hawk id="client-id"/); assert.match(JSON.parse(hawk.body).authorization, /mac="[A-Za-z0-9+/]+=*"/);
  });
});

test('OAuth 2.0 Client Credentials obtains a token then calls the API', async () => {
  const requests = [];
  await withFixture(async (req, res) => {
    const body = await collectBody(req); requests.push({ url: req.url, authorization: req.headers.authorization, body });
    if (req.url === '/token') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"access_token":"local-access-token","token_type":"Bearer"}'); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ authorization: req.headers.authorization })); }
  }, async base => {
    const result = await performRequest({ method: 'GET', url: `${base}/resource`, auth: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: `${base}/token`, clientId: 'client', clientSecret: 'secret', scope: 'read' } });
    assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).authorization, 'Bearer local-access-token');
    assert.match(requests[0].body, /grant_type=client_credentials/);
  });
});

test('NTLM helpers use the standard MD4 hash and build NTLM messages', () => {
  assert.equal(md4(Buffer.from('password', 'utf16le')).toString('hex'), '8846f7eaee8fb117ad06bdd830b7586c');
  const type1 = Buffer.from(makeNtlmType1('DOMAIN', 'WORKSTATION'), 'base64');
  assert.equal(type1.toString('ascii', 0, 8), 'NTLMSSP\0'); assert.equal(type1.readUInt32LE(8), 1);
  const type2 = Buffer.alloc(48); type2.write('NTLMSSP\0', 0, 'ascii'); type2.writeUInt32LE(2, 8); type2.writeUInt32LE(0x00088201, 20); type2.write('12345678', 24, 'ascii');
  const type3 = Buffer.from(makeNtlmType3(type2.toString('base64'), 'user', 'password', 'DOMAIN', 'WORKSTATION'), 'base64');
  assert.equal(type3.toString('ascii', 0, 8), 'NTLMSSP\0'); assert.equal(type3.readUInt32LE(8), 3);
});

test('Akamai EdgeGrid credentials generate an EG1-HMAC-SHA256 signature', async () => {
  await withFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ authorization: req.headers.authorization || '' }));
  }, async base => {
    const result = await performRequest({ method: 'GET', url: `${base}/edgegrid?name=api`, auth: { type: 'edgegrid', clientToken: 'client-token', clientSecret: 'client-secret', accessToken: 'access-token' } });
    const authorization = JSON.parse(result.body).authorization;
    assert.equal(result.status, 200);
    assert.match(authorization, /^EG1-HMAC-SHA256 client_token=client-token;access_token=access-token;timestamp=\d{8}T\d{2}:\d{2}:\d{2}\+0000;nonce=[a-f0-9-]+;signature=[A-Za-z0-9+/]+=*$/);
  });
});

test('TRACE uses the local HTTP transport for methods Fetch does not permit', async () => {
  await withFixture(async (req, res) => {
    const body = await collectBody(req); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ method: req.method, body }));
  }, async base => {
    const result = await performRequest({ method: 'TRACE', url: `${base}/trace` });
    assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), { method: 'TRACE', body: '' });
  });
});

test('HTTP proxy endpoint returns a JSON result and validates schemes', async () => {
  appServer.listen(0, '127.0.0.1'); await once(appServer, 'listening');
  const address = appServer.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'GET', url: 'file:///etc/passwd' }) });
    assert.equal(response.status, 400); assert.match((await response.json()).error, /HTTP and HTTPS/);
    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`); assert.equal((await health.json()).name, 'API Manager');
  } finally { await new Promise(resolve => appServer.close(resolve)); }
});
