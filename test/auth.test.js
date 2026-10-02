'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const A = require('../main/lib/auth.js');
const { md4, hmacMd4 } = require('../main/lib/md4.js');

const FIXED_NOW = new Date('2024-01-02T03:04:05.678Z');
const FIXED_ENV = { now: () => FIXED_NOW, rand: () => 0.42 };

test('MD4 known vectors', () => {
  assert.strictEqual(Buffer.from(md4('')).toString('hex'), '31d6cfe0d16ae931b73c59d7e0c089c0');
  assert.strictEqual(Buffer.from(md4('a')).toString('hex'), 'bde52cb31de33e46245e05fbdbd6fb24');
  assert.strictEqual(Buffer.from(md4('abc')).toString('hex'), 'a448017aaf21d8525fc10ae87aa6729d');
  assert.strictEqual(Buffer.from(md4('message digest')).toString('hex'), 'd9130a8164549fe818874806e1c7014b');
  assert.strictEqual(Buffer.from(md4('abcdefghijklmnopqrstuvwxyz')).toString('hex'), 'd79e1c308aa5bbcdeea8ed63df412da9');
  // 1 million 'a' is the standard long-input vector
  const million = Buffer.alloc(1000000, 0x61);
  // MD4 of 1,000,000 x 'a' (multi-block; the 043f8582… vector belongs to the
  // 62-char uppercase+lowercase+digits string above).
  assert.strictEqual(Buffer.from(md4(million)).toString('hex'), 'bbce80cc6bb65e5c6745e30d4eeca9a4');
});

test('HMAC-MD5 is deterministic and correct-shaped', () => {
  const h1 = Buffer.from(hmacMd4('key', 'msg')).toString('hex');
  const h2 = Buffer.from(hmacMd4('key', 'msg')).toString('hex');
  assert.strictEqual(h1, h2);
  assert.match(h1, /^[0-9a-f]{32}$/);
  assert.notStrictEqual(h1, Buffer.from(hmacMd4('key2', 'msg')).toString('hex'));
});

test('basic and bearer headers', () => {
  assert.deepStrictEqual(A.basicHeaders({ username: 'u', password: 'p' }), [['Authorization', 'Basic dTpw']]);
  assert.deepStrictEqual(A.bearerHeaders({ prefix: 'Bearer', token: 'tok' }), [['Authorization', 'Bearer tok']]);
  assert.deepStrictEqual(A.bearerHeaders({ prefix: '', token: 'raw' }), [['Authorization', 'raw']]);
});

test('API key in header and query', () => {
  const r1 = A.computeAuthHeaders({ type: 'apikey', key: 'X-Api-Key', value: 'k1', in: 'header' }, { method: 'GET', url: 'https://x.test', headers: [] });
  assert.deepStrictEqual(r1.headers, [['X-Api-Key', 'k1']]);
  const r2 = A.computeAuthHeaders({ type: 'apikey', key: 'apiKey', value: 'k2', in: 'query' }, { method: 'GET', url: 'https://x.test', headers: [] });
  assert.deepStrictEqual(r2.extraQuery, [['apiKey', 'k2']]);
  assert.strictEqual(r2.headers.length, 0);
});

test('HMAC JWT HS256/384/512 structure and signature', () => {
  for (const alg of ['HS256', 'HS384', 'HS512']) {
    const [h] = A.jwtHeaders({ type: 'jwt', alg, iss: 'issuer', sub: 'subject', aud: 'aud', expSeconds: '600', secret: 's3cr3t' }, FIXED_ENV);
    assert.strictEqual(h[0], 'Authorization');
    assert.ok(h[1].startsWith('Bearer '));
    const jwt = h[1].slice('Bearer '.length);
    const parts = jwt.split('.');
    assert.strictEqual(parts.length, 3);
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    assert.strictEqual(header.alg, alg);
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const expAlg = alg === 'HS256' ? 'sha256' : alg === 'HS384' ? 'sha384' : 'sha512';
    const expectedSig = crypto.createHmac(expAlg, 's3cr3t').update(parts[0] + '.' + parts[1]).digest('base64url');
    assert.strictEqual(parts[2], expectedSig, alg + ' signature');
    const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
    assert.strictEqual(payload.iss, 'issuer');
    assert.strictEqual(payload.sub, 'subject');
    assert.strictEqual(payload.aud, 'aud');
    assert.strictEqual(payload.exp, nowSec + 600);
    assert.strictEqual(payload.iat, nowSec);
  }
});

test('OAuth 1.0a matches the RFC 5849 example signature', () => {
  const spec = {
    method: 'POST',
    url: 'https://api.example.com/method',
    headers: [['Content-Type', 'application/x-www-form-urlencoded']],
    bodyString: 'email=Adam%20Hunter&access_token=adfh6j6',
  };
  const a = {
    type: 'oauth1',
    consumerKey: 'kd94hf93k423hf493k4',
    consumerSecret: 'wfjwf34490934jjf934',
    token: 'adfh6j6',
    tokenSecret: 'sh39efj483',
    signatureMethod: 'HMAC-SHA1',
  };
  const env = Object.assign({}, FIXED_ENV, { now: () => new Date(137131200000), nonce: '1254406065' });
  const [h] = A.oauth1Headers(a, spec, env);
  assert.strictEqual(h[0], 'Authorization');
  assert.ok(h[1].startsWith('OAuth '));
  assert.ok(h[1].includes('oauth_signature_method="HMAC-SHA1"'));
  assert.ok(h[1].includes('oauth_timestamp="137131200"'));
  assert.ok(h[1].includes('oauth_nonce="1254406065"'));
  // Independent verification: recompute the signature over the documented base string
  const baseString =
    'POST&' +
    'https%3A%2F%2Fapi.example.com%2Fmethod&' +
    'access_token%3Dadfh6j6%26email%3DAdam%2520Hunter%26oauth_consumer_key%3Dkd94hf93k423hf493k4%26oauth_nonce%3D1254406065%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131200%26oauth_token%3Dadfh6j6%26oauth_version%3D1.0';
  const expectedSig = crypto.createHmac('sha1', 'wfjwf34490934jjf934&sh39efj483').update(baseString).digest('base64');
  // the header percent-encodes the base64 signature
  assert.ok(h[1].includes('oauth_signature="' + encodeURIComponent(expectedSig) + '"'), 'signature mismatch: ' + h[1]);
});

test('OAuth 1.0a PLAINTEXT', () => {
  const [h] = A.oauth1Headers(
    { type: 'oauth1', consumerKey: 'ck', consumerSecret: 'cs', token: 'tk', tokenSecret: 'ts', signatureMethod: 'PLAINTEXT' },
    { method: 'GET', url: 'https://x.test/a', headers: [] },
    Object.assign({}, FIXED_ENV, { nonce: 'n1' })
  );
  assert.ok(h[1].includes('oauth_signature="cs%26ts"'));
});

test('AWS Signature v4 produces a well-formed signature', () => {
  const spec = {
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt?prefix=logs%2F',
    headers: [],
  };
  const r = A.computeAuthHeaders(
    { type: 'aws4', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3' },
    spec,
    FIXED_ENV
  );
  assert.strictEqual(r.error, undefined);
  const headers = Object.fromEntries(r.headers.map(([k, v]) => [k.toLowerCase(), v]));
  assert.match(headers['x-amz-date'], /^\d{8}T\d{6}Z$/);
  assert.ok(headers['x-amz-date'].startsWith('20240102'));
  const m = headers.authorization.match(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.ok(m, 'auth header malformed: ' + headers.authorization);
  // Deterministic for fixed env; sensitive to secret
  const r2 = A.computeAuthHeaders(
    { type: 'aws4', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'OTHERSECRET', region: 'us-east-1', service: 's3' },
    spec,
    FIXED_ENV
  );
  assert.notDeepStrictEqual(Object.fromEntries(r2.headers.map(([k, v]) => [k.toLowerCase(), v])).authorization, headers.authorization);
});

test('AWS SigV4 signs session tokens', () => {
  const r = A.computeAuthHeaders(
    { type: 'aws4', accessKeyId: 'A', secretAccessKey: 'B', sessionToken: 'STOKEN', region: 'eu-west-1', service: 'sqs' },
    { method: 'GET', url: 'https://sqs.eu-west-1.amazonaws.com/123/q', headers: [] },
    FIXED_ENV
  );
  const headers = Object.fromEntries(r.headers);
  assert.strictEqual(headers['x-amz-security-token'], 'STOKEN');
  assert.ok(headers.Authorization.includes('SignedHeaders=host;x-amz-date;x-amz-security-token'));
});

test('EdgeGrid signature is deterministic and well-formed', () => {
  const spec = { method: 'POST', url: 'https://api.example.com/v1/data', headers: [['Content-Type', 'application/json']] };
  const r1 = A.computeAuthHeaders({ type: 'edgegrid', clientToken: 'CT', clientSecretKey: 'SK' }, spec, FIXED_ENV);
  const r2 = A.computeAuthHeaders({ type: 'edgegrid', clientToken: 'CT', clientSecretKey: 'SK' }, spec, FIXED_ENV);
  assert.deepStrictEqual(r1.headers, r2.headers);
  const [h] = r1.headers;
  assert.ok(h[1].startsWith('EdgeGrid ts="'), h[1]);
  assert.ok(h[1].includes('client_token="CT"'));
  assert.match(h[1], /signature="[0-9a-f]{64}"/);
  // Independent recomputation per Akamai spec
  const ts = FIXED_NOW.toISOString();
  const nonce = require('../main/lib/auth.js') && r1.headers[0][1].match(/nonce="([^"]+)"/)[1];
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
  const key = hmac('SK', ts);
  const key1 = hmac(key, nonce);
  const key2 = hmac(key1, '/v1/data');
  // Akamai EdgeGrid: string-to-sign = method\nhost\npath\nquery\nsortedHeaders\n
  // — the host has its own line; sortedHeaders contains only the sent request
  // headers (content-type, customs), not the host itself.
  const headerStr = 'content-type:application/json';
  const key3 = hmac(key2, 'POST\napi.example.com\n/v1/data\n\n' + headerStr + '\n');
  const sig = hmac(key3, '').toString('hex');
  assert.ok(h[1].includes('signature="' + sig + '"'), 'edgegrid sig mismatch');
});

test('Hawk header format and MAC recomputation', () => {
  const spec = { method: 'GET', url: 'https://api.example.com/resource?x=1', headers: [] };
  const r = A.computeAuthHeaders({ type: 'hawk', id: 'di3nm', key: 'werx9qb2rtpN/areTfh+Pw==\n' }, spec, FIXED_ENV);
  const [h] = r.headers;
  assert.ok(h[1].startsWith('Hawk id="di3nm", ts="'), h[1]);
  const ts = h[1].match(/ts="(\d+)"/)[1];
  const nonce = h[1].match(/nonce="([^"]+)"/)[1];
  const mac = h[1].match(/mac="([^"]+)"/)[1];
  const canonical = ['hawk.1.header', ts, nonce, 'GET', '/resource?x=1', 'api.example.com', '443'].join('\n') + '\n';
  const expected = crypto.createHmac('sha1', 'werx9qb2rtpN/areTfh+Pw==\n').update(canonical).digest('base64');
  assert.strictEqual(mac, expected);
});

test('Digest auth: challenge parsing and response computation', () => {
  const challenge = 'Digest realm="testrealm@host.com", qop="auth", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9511f9067b", algorithm=MD5';
  const c = A.parseDigestChallenge(challenge);
  assert.strictEqual(c.realm, 'testrealm@host.com');
  assert.strictEqual(c.qop, 'auth');
  assert.strictEqual(c.nonce, 'dcd98b7102dd2f0e8b11d0f600bfb0c093');
  const [h] = A.digestRetryHeaders(
    { type: 'digest', username: 'alice', password: 'password' },
    { method: 'GET', url: 'https://host.com/dir/index.html' },
    challenge
  );
  assert.ok(h[1].startsWith('Digest '));
  assert.ok(h[1].includes('username="alice"'));
  assert.ok(h[1].includes('uri="/dir/index.html"'));
  const response = h[1].match(/response="([0-9a-f]{32})"/);
  assert.ok(response, 'digest response missing: ' + h[1]);
  // independent recomputation
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const ha1 = md5('alice:testrealm@host.com:password');
  const ha2 = md5('GET:/dir/index.html');
  const nonce = 'dcd98b7102dd2f0e8b11d0f600bfb0c093';
  const cnonce = h[1].match(/cnonce="([^"]+)"/)[1];
  const expected = md5(ha1 + ':' + nonce + ':00000001:' + cnonce + ':auth:' + ha2);
  assert.strictEqual(response[1], expected);
});

test('Digest auth without qop (RFC 2069)', () => {
  const challenge = 'Digest realm="Realm", nonce="abc123", algorithm=MD5';
  const [h] = A.digestRetryHeaders(
    { type: 'digest', username: 'u', password: 'p' },
    { method: 'GET', url: 'https://h/x' },
    challenge
  );
  const response = h[1].match(/response="([0-9a-f]{32})"/);
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const expected = md5(md5('u:Realm:p') + ':' + 'abc123' + ':' + md5('GET:/x'));
  assert.strictEqual(response[1], expected);
});

test('NTLM Type1 and Type3 message structure', () => {
  const t1 = Buffer.from(A.ntlmType1(FIXED_ENV), 'base64');
  // MS-NLMP: 8-byte signature "NTLMSSP" + NUL, message type at offset 8.
  assert.strictEqual(t1.toString('ascii', 0, 7), 'NTLMSSP');
  assert.strictEqual(t1[7], 0);
  assert.strictEqual(t1.readUInt32LE(8), 1);

  // Build a Type2 message (MS-NLMP 2.2.2.4): signature, type=2, target name
  // fields @12, flags @20, challenge @24, target info fields @36.
  const targetName = Buffer.from('TEST', 'utf16le');
  const targetInfo = Buffer.from('TEST', 'utf16le');
  const t2 = Buffer.alloc(72);
  t2.write('NTLMSSP', 0, 'ascii');
  t2.writeUInt32LE(2, 8);
  t2.writeUInt16LE(targetName.length, 12);
  t2.writeUInt16LE(targetName.length, 14);
  t2.writeUInt32LE(56, 16);
  t2.writeUInt32LE(0x00000001 | 0x00000002, 20); // flags
  for (let i = 0; i < 8; i++) t2.writeUInt8(i + 1, 24 + i); // server challenge 1..8
  t2.writeUInt16LE(targetInfo.length, 36);
  t2.writeUInt16LE(targetInfo.length, 38);
  t2.writeUInt32LE(64, 40);
  targetName.copy(t2, 56);
  targetInfo.copy(t2, 64);
  const t2b64 = t2.toString('base64');

  const parsed = A.parseNtlmType2(t2b64);
  assert.deepStrictEqual(Array.from(parsed.serverChallenge), [1, 2, 3, 4, 5, 6, 7, 8]);

  const t3 = A.ntlmType3({ type: 'ntlmv2', username: 'alice', password: 'secret', domain: 'CORP' }, t2b64, FIXED_ENV);
  const b3 = Buffer.from(t3, 'base64');
  assert.strictEqual(b3.toString('ascii', 0, 7), 'NTLMSSP');
  assert.strictEqual(b3[7], 0);
  assert.strictEqual(b3.readUInt32LE(8), 3);
  // MS-NLMP Type 3: LMv2@12 and NT@20 are each NTProof(16) || blob(64) = 80 bytes
  assert.strictEqual(b3.readUInt16LE(12), 80);
  assert.strictEqual(b3.readUInt16LE(20), 80);
  assert.strictEqual(b3.readUInt16LE(28), 8); // 'CORP' utf-16
  assert.strictEqual(b3.readUInt16LE(36), 10); // 'alice' utf-16
  assert.strictEqual(b3.readUInt32LE(40), 72); // user offset (after domain at 64)
  assert.strictEqual(b3.toString('utf16le', 64, 72), 'CORP');
  assert.strictEqual(b3.toString('utf16le', 72, 82), 'alice');
  assert.ok(b3.readUInt32LE(44) & 0x00000010); // NEGOTIATE_UNICODE
  // determinism with fixed env
  const t3b = A.ntlmType3({ type: 'ntlmv2', username: 'alice', password: 'secret', domain: 'CORP' }, t2b64, FIXED_ENV);
  assert.strictEqual(t3, t3b);
  // different password → different message
  const t3c = A.ntlmType3({ type: 'ntlmv2', username: 'alice', password: 'other', domain: 'CORP' }, t2b64, FIXED_ENV);
  assert.notStrictEqual(t3, t3c);
});

test('computeAuthHeaders dispatch and error reporting', () => {
  const inherit = A.computeAuthHeaders({ type: 'inherit' }, { method: 'GET', url: 'https://x', headers: [] });
  assert.strictEqual(inherit.headers.length, 0);
  assert.strictEqual(inherit.retryScheme, null);
  const none = A.computeAuthHeaders({ type: 'none' }, { method: 'GET', url: 'https://x', headers: [] });
  assert.strictEqual(none.headers.length, 0);
  assert.strictEqual(none.retryScheme, null);
  const digest = A.computeAuthHeaders({ type: 'digest', username: 'u', password: 'p' }, { method: 'GET', url: 'https://x', headers: [] });
  assert.strictEqual(digest.retryScheme, 'digest');
  const ntlm = A.computeAuthHeaders({ type: 'ntlmv2', username: 'u', password: 'p' }, { method: 'GET', url: 'https://x', headers: [] });
  assert.strictEqual(ntlm.retryScheme, 'ntlm');
  assert.ok(ntlm.headers[0][1].startsWith('NTLM '));
  const bad = A.computeAuthHeaders({ type: 'bogus' }, { method: 'GET', url: 'https://x', headers: [] });
  assert.match(bad.error, /Unknown auth type/);
  const cc = A.computeAuthHeaders({ type: 'oauth2', flow: 'client_credentials', accessToken: 'tok' }, { method: 'GET', url: 'https://x', headers: [] });
  assert.deepStrictEqual(cc.headers, [['Authorization', 'Bearer tok']]);
});
