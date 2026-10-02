'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4173);
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'
};

function json(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const err = new Error('Request payload is too large (maximum 2 MB).');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('The request body must be valid JSON.');
    err.statusCode = 400;
    throw err;
  }
}

function hmac(algorithm, key, data, encoding) {
  const result = crypto.createHmac(algorithm, key).update(data).digest();
  return encoding ? result.toString(encoding) : result;
}
function sha256(data, encoding = 'hex') {
  return crypto.createHash('sha256').update(data).digest(encoding);
}
function md5(data, encoding = 'hex') {
  return crypto.createHash('md5').update(data).digest(encoding);
}
function pct(value) { return encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); }

function sortedQuery(url) {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [pct(key), pct(value)])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    .map(([key, value]) => `${key}=${value}`).join('&');
}

function applyAwsV4(url, method, headers, body, auth) {
  const accessKey = String(auth.accessKey || '').trim();
  const secretKey = String(auth.secretKey || '');
  if (!accessKey || !secretKey) throw new Error('AWS Signature requires an access key and secret key.');
  const region = String(auth.region || 'us-east-1').trim();
  const service = String(auth.service || 'execute-api').trim();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body || '');
  const host = url.host.toLowerCase();
  headers.host = host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = payloadHash;
  if (auth.sessionToken) headers['x-amz-security-token'] = String(auth.sessionToken);

  const canonicalHeaderMap = new Map();
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase().trim();
    if (name === 'authorization' || name === 'connection' || name === 'content-length') continue;
    if (name === 'host' || name.startsWith('x-amz-')) canonicalHeaderMap.set(name, String(value).trim().replace(/\s+/g, ' '));
  }
  canonicalHeaderMap.set('host', host);
  const names = [...canonicalHeaderMap.keys()].sort();
  const canonicalHeaders = names.map(name => `${name}:${canonicalHeaderMap.get(name)}\n`).join('');
  const canonicalRequest = [method.toUpperCase(), url.pathname || '/', sortedQuery(url), canonicalHeaders, names.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const kDate = hmac('sha256', `AWS4${secretKey}`, dateStamp);
  const kRegion = hmac('sha256', kDate, region);
  const kService = hmac('sha256', kRegion, service);
  const kSigning = hmac('sha256', kService, 'aws4_request');
  const signature = hmac('sha256', kSigning, stringToSign, 'hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

function canonicalOAuthUrl(url) {
  const port = url.port && !((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) ? `:${url.port}` : '';
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}${url.pathname || '/'}`;
}

function applyOAuth1(url, method, headers, body, auth) {
  const consumerKey = String(auth.consumerKey || '');
  const consumerSecret = String(auth.consumerSecret || '');
  if (!consumerKey) throw new Error('OAuth 1.0 requires a consumer key.');
  const signatureMethod = String(auth.signatureMethod || 'HMAC-SHA1').toUpperCase();
  if (!['HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT', 'RSA-SHA1'].includes(signatureMethod)) throw new Error(`OAuth 1.0 signature method ${signatureMethod} is not supported.`);
  if (signatureMethod === 'RSA-SHA1' && !auth.privateKey) throw new Error('OAuth 1.0 RSA-SHA1 requires a private key.');
  if (signatureMethod !== 'RSA-SHA1' && !consumerSecret) throw new Error('OAuth 1.0 requires a consumer secret for this signature method.');
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: signatureMethod,
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0'
  };
  if (auth.token) oauth.oauth_token = String(auth.token);
  if (auth.callback) oauth.oauth_callback = String(auth.callback);
  if (auth.verifier) oauth.oauth_verifier = String(auth.verifier);
  const params = [...url.searchParams.entries()];
  if (/application\/x-www-form-urlencoded/i.test(headers['content-type'] || '') && body) {
    for (const [k, v] of new URLSearchParams(body)) params.push([k, v]);
  }
  for (const [key, value] of Object.entries(oauth)) params.push([key, value]);
  const normalized = params.map(([k, v]) => [pct(k), pct(v)]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])).map(([k, v]) => `${k}=${v}`).join('&');
  const base = `${method.toUpperCase()}&${pct(canonicalOAuthUrl(url))}&${pct(normalized)}`;
  const signingKey = `${pct(consumerSecret)}&${pct(auth.tokenSecret || '')}`;
  if (signatureMethod === 'HMAC-SHA1') oauth.oauth_signature = hmac('sha1', signingKey, base, 'base64');
  else if (signatureMethod === 'HMAC-SHA256') oauth.oauth_signature = hmac('sha256', signingKey, base, 'base64');
  else if (signatureMethod === 'PLAINTEXT') oauth.oauth_signature = signingKey;
  else oauth.oauth_signature = crypto.sign('RSA-SHA1', Buffer.from(base), auth.privateKey).toString('base64');
  const oauthPairs = Object.entries(oauth).map(([k, v]) => `${pct(k)}="${pct(v)}"`);
  if (auth.realm) oauthPairs.unshift(`realm="${pct(auth.realm)}"`);
  headers.authorization = `OAuth ${oauthPairs.join(', ')}`;
}

function applyHawk(url, method, headers, body, auth) {
  const id = String(auth.id || '');
  const key = String(auth.key || '');
  if (!id || !key) throw new Error('Hawk authentication requires an ID and a key.');
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(6).toString('hex');
  const resource = `${url.pathname || '/'}${url.search}`;
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const ext = String(auth.ext || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  let hash = '';
  if (body && auth.hashPayload) {
    const contentType = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const normalizedPayload = `hawk.1.payload\n${contentType}\n${body}\n`;
    hash = crypto.createHash(String(auth.algorithm || 'sha256')).update(normalizedPayload).digest('base64');
  }
  const normalized = `hawk.1.header\n${ts}\n${nonce}\n${method.toUpperCase()}\n${resource}\n${host}\n${port}\n${hash}\n${ext}\n`;
  const mac = hmac(String(auth.algorithm || 'sha256'), key, normalized, 'base64');
  const values = [`id="${pct(id)}"`, `ts="${ts}"`, `nonce="${nonce}"`];
  if (hash) values.push(`hash="${hash}"`);
  if (auth.ext) values.push(`ext="${ext.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  values.push(`mac="${mac}"`);
  headers.authorization = `Hawk ${values.join(', ')}`;
}

function applyEdgeGrid(url, method, headers, body, auth) {
  const clientToken = String(auth.clientToken || '');
  const clientSecret = String(auth.clientSecret || '');
  const accessToken = String(auth.accessToken || '');
  if (!clientToken || !clientSecret || !accessToken) throw new Error('Akamai EdgeGrid requires a client token, client secret, and access token.');
  const timestamp = new Date().toISOString().replace(/-/g, '').replace(/\.\d{3}Z$/, '+0000');
  const nonce = crypto.randomUUID();
  const canonical = [method.toUpperCase(), url.host.toLowerCase(), url.pathname || '/', url.search.replace(/^\?/, ''), '', body || ''].join('\t');
  const signingKey = hmac('sha256', clientSecret, timestamp);
  const signature = hmac('sha256', signingKey, canonical, 'base64');
  headers.authorization = `EG1-HMAC-SHA256 client_token=${clientToken};access_token=${accessToken};timestamp=${timestamp};nonce=${nonce};signature=${signature}`;
}

function applyJwt(url, headers, auth) {
  const secret = String(auth.secret || '');
  if (!secret) throw new Error('JWT Bearer requires a signing secret.');
  const alg = String(auth.algorithm || 'HS256').toUpperCase();
  const hashName = ({ HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' })[alg];
  if (!hashName) throw new Error('This local JWT signer supports HS256, HS384, and HS512.');
  let claims;
  try { claims = JSON.parse(auth.payload || '{}'); } catch { throw new Error('JWT payload must be valid JSON.'); }
  if (!claims.iat && auth.addIat !== false) claims.iat = Math.floor(Date.now() / 1000);
  let headerOverrides = {};
  if (auth.header) {
    try { headerOverrides = JSON.parse(auth.header); } catch { throw new Error('JWT header overrides must be valid JSON.'); }
    if (!headerOverrides || typeof headerOverrides !== 'object' || Array.isArray(headerOverrides)) throw new Error('JWT header overrides must be a JSON object.');
  }
  const header = { ...headerOverrides, typ: headerOverrides.typ || 'JWT', alg };
  const base64url = value => Buffer.from(value).toString('base64url');
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const token = `${unsigned}.${hmac(hashName, secret, unsigned, 'base64url')}`;
  const prefix = auth.prefix === undefined ? 'Bearer' : String(auth.prefix);
  headers.authorization = `${prefix ? `${prefix} ` : ''}${token}`;
  return url;
}

function parseDigestChallenge(header) {
  const source = String(header || '').replace(/^Digest\s+/i, '');
  const values = {};
  const pattern = /([a-z0-9_-]+)=(?:"((?:\\.|[^"])*)"|([^,\s]+))/gi;
  let match;
  while ((match = pattern.exec(source))) values[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(/\\"/g, '"');
  return values;
}

function digestResponse(challenge, method, url, username, password, body) {
  const qopChoices = String(challenge.qop || '').split(',').map(v => v.trim().toLowerCase());
  const qop = qopChoices.includes('auth') ? 'auth' : qopChoices.includes('auth-int') ? 'auth-int' : '';
  const algorithm = String(challenge.algorithm || 'MD5').toUpperCase();
  if (!['MD5', 'MD5-SESS'].includes(algorithm)) throw new Error(`Digest algorithm ${algorithm} is not supported by this build.`);
  const uri = `${url.pathname || '/'}${url.search}`;
  const cnonce = crypto.randomBytes(12).toString('hex');
  const nc = '00000001';
  let ha1 = md5(`${username}:${challenge.realm || ''}:${password}`);
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${challenge.nonce}:${cnonce}`);
  const entityHash = qop === 'auth-int' ? md5(body || '') : '';
  const ha2 = qop === 'auth-int' ? md5(`${method}:${uri}:${entityHash}`) : md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${challenge.nonce}:${ha2}`);
  const fields = [`username="${String(username).replace(/"/g, '\\"')}"`, `realm="${challenge.realm || ''}"`, `nonce="${challenge.nonce}"`, `uri="${uri}"`, `response="${response}"`];
  if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) fields.push(`algorithm=${challenge.algorithm}`);
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${fields.join(', ')}`;
}

function md4(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const bitLength = BigInt(input.length) * 8n;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const data = Buffer.alloc(paddedLength);
  input.copy(data);
  data[input.length] = 0x80;
  data.writeBigUInt64LE(bitLength, paddedLength - 8);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const rot = (x, n) => (x << n) | (x >>> (32 - n));
  const add = (...values) => values.reduce((sum, value) => (sum + value) >>> 0, 0);
  for (let offset = 0; offset < data.length; offset += 64) {
    const x = Array.from({ length: 16 }, (_, i) => data.readUInt32LE(offset + i * 4));
    let aa = a, bb = b, cc = c, dd = d;
    const f = (x, y, z) => (x & y) | (~x & z);
    const g = (x, y, z) => (x & y) | (x & z) | (y & z);
    const h = (x, y, z) => x ^ y ^ z;
    const r1 = [3, 7, 11, 19];
    const r2 = [3, 5, 9, 13];
    const r3 = [3, 9, 11, 15];
    const round = (fn, shifts, order, constant) => {
      for (let i = 0; i < 16; i++) {
        const mod = i % 4;
        let value;
        if (mod === 0) value = add(aa, fn(bb, cc, dd), x[order(i)], constant), aa = rot(value, shifts[mod]);
        else if (mod === 1) value = add(dd, fn(aa, bb, cc), x[order(i)], constant), dd = rot(value, shifts[mod]);
        else if (mod === 2) value = add(cc, fn(dd, aa, bb), x[order(i)], constant), cc = rot(value, shifts[mod]);
        else value = add(bb, fn(cc, dd, aa), x[order(i)], constant), bb = rot(value, shifts[mod]);
      }
    };
    round(f, r1, i => i, 0);
    round(g, r2, i => (i % 4) * 4 + Math.floor(i / 4), 0x5a827999);
    round(h, r3, i => [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15][i], 0x6ed9eba1);
    a = add(a, aa); b = add(b, bb); c = add(c, cc); d = add(d, dd);
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0); out.writeUInt32LE(b, 4); out.writeUInt32LE(c, 8); out.writeUInt32LE(d, 12);
  return out;
}

function securityBuffer(length, offset) {
  const result = Buffer.alloc(8);
  result.writeUInt16LE(length, 0); result.writeUInt16LE(length, 2); result.writeUInt32LE(offset, 4);
  return result;
}

function makeNtlmType1(domain = '', workstation = '') {
  const flags = (0x00000001 | 0x00000004 | 0x00000200 | 0x00008000 | 0x00080000 | 0x20000000 | 0x80000000) >>> 0;
  const domainBytes = Buffer.from(String(domain).toUpperCase(), 'ascii');
  const workstationBytes = Buffer.from(String(workstation).toUpperCase(), 'ascii');
  const header = Buffer.alloc(32);
  header.write('NTLMSSP\0', 0, 'ascii'); header.writeUInt32LE(1, 8); header.writeUInt32LE(flags, 12);
  securityBuffer(domainBytes.length, 32).copy(header, 16);
  securityBuffer(workstationBytes.length, 32 + domainBytes.length).copy(header, 24);
  return Buffer.concat([header, domainBytes, workstationBytes]).toString('base64');
}

function makeNtlmType3(type2Base64, username, password, domain = '', workstation = '') {
  const challenge = Buffer.from(type2Base64, 'base64');
  if (challenge.length < 32 || challenge.toString('ascii', 0, 8) !== 'NTLMSSP\0') throw new Error('The NTLM server returned an invalid challenge.');
  const flags2 = challenge.readUInt32LE(20);
  const serverChallenge = challenge.subarray(24, 32);
  let targetInfo = Buffer.alloc(0);
  if (challenge.length >= 48) {
    const targetLength = challenge.readUInt16LE(40);
    const targetOffset = challenge.readUInt32LE(44);
    if (targetLength && targetOffset + targetLength <= challenge.length) targetInfo = challenge.subarray(targetOffset, targetOffset + targetLength);
  }
  if (!targetInfo.length) targetInfo = Buffer.from([0, 0, 0, 0]);
  const user = String(username);
  const dom = String(domain || '');
  const work = String(workstation || '');
  const ntHash = md4(Buffer.from(String(password), 'utf16le'));
  const responseKey = hmac('md5', ntHash, Buffer.from(`${user.toUpperCase()}${dom}`, 'utf16le'));
  const clientNonce = crypto.randomBytes(8);
  const filetime = (BigInt(Date.now()) + 11644473600000n) * 10000n;
  const blob = Buffer.alloc(28 + targetInfo.length + 4);
  blob.writeUInt32LE(0x00000101, 0);
  blob.writeBigUInt64LE(filetime, 8);
  clientNonce.copy(blob, 16);
  targetInfo.copy(blob, 28);
  const proof = hmac('md5', responseKey, Buffer.concat([serverChallenge, blob]));
  const ntResponse = Buffer.concat([proof, blob]);
  const lmResponse = Buffer.concat([hmac('md5', responseKey, Buffer.concat([serverChallenge, clientNonce])), clientNonce]);
  const payloads = [lmResponse, ntResponse, Buffer.from(dom, 'utf16le'), Buffer.from(user, 'utf16le'), Buffer.from(work, 'utf16le'), Buffer.alloc(0)];
  const header = Buffer.alloc(64);
  header.write('NTLMSSP\0', 0, 'ascii'); header.writeUInt32LE(3, 8);
  let payloadOffset = 64;
  payloads.forEach((payload, i) => {
    securityBuffer(payload.length, payloadOffset).copy(header, 12 + i * 8);
    payloadOffset += payload.length;
  });
  const supported = (flags2 & (0x00000001 | 0x00000004 | 0x00000200 | 0x00008000 | 0x00080000 | 0x20000000 | 0x80000000)) >>> 0;
  header.writeUInt32LE(supported, 60);
  return Buffer.concat([header, ...payloads]).toString('base64');
}

async function requestWithNtlm(url, init, auth, signal) {
  const domain = auth.domain || '';
  const workstation = auth.workstation || '';
  const username = auth.username || '';
  const password = auth.password || '';
  if (!username || password === undefined) throw new Error('NTLM requires a username and password.');
  const headers = new Headers(init.headers);
  headers.set('authorization', `NTLM ${makeNtlmType1(domain, workstation)}`);
  let response = await fetch(url, { ...init, headers, signal });
  if (response.status !== 401) return response;
  const challenges = response.headers.get('www-authenticate') || '';
  const challenge = challenges.match(/NTLM\s+([A-Za-z0-9+/=]+)/i)?.[1];
  if (!challenge) return response;
  await response.arrayBuffer().catch(() => {});
  headers.set('authorization', `NTLM ${makeNtlmType3(challenge, username, password, domain, workstation)}`);
  return fetch(url, { ...init, headers, signal });
}

async function fetchOAuth2Token(auth, signal) {
  const tokenUrl = String(auth.tokenUrl || '').trim();
  if (!tokenUrl) throw new Error('OAuth 2.0 client credentials requires a token URL.');
  const parsed = new URL(tokenUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('OAuth token URLs must use HTTP or HTTPS.');
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (auth.scope) form.set('scope', String(auth.scope));
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const clientId = String(auth.clientId || '');
  const clientSecret = String(auth.clientSecret || '');
  if (!clientId || !clientSecret) throw new Error('OAuth 2.0 client credentials requires a client ID and secret.');
  if (auth.clientAuth === 'body') {
    form.set('client_id', clientId); form.set('client_secret', clientSecret);
  } else {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }
  const response = await fetch(parsed, { method: 'POST', headers, body: form.toString(), signal });
  const text = await response.text();
  let tokenData;
  try { tokenData = JSON.parse(text); } catch { throw new Error(`OAuth token endpoint returned non-JSON (${response.status}).`); }
  if (!response.ok || !tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || `OAuth token endpoint returned ${response.status}.`);
  return tokenData.access_token;
}

function normalizeHeaders(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    const name = String(key).trim();
    if (!name || /^(host|content-length|transfer-encoding|connection|upgrade)$/i.test(name)) continue;
    out[name] = String(value);
  }
  return out;
}

async function readResponse(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error('Response body exceeded the 12 MB local display limit.'), { statusCode: 502 });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

function performRawMethod(url, method, headers, body, timeout) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const options = { method, headers };
    if (method === 'CONNECT') options.path = `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
    const request = transport.request(url, options, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(Object.assign(new Error('Response body exceeded the 12 MB local display limit.'), { statusCode: 502 }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        statusText: response.statusMessage || '',
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        url: url.toString(), redirected: false
      }));
      response.on('error', reject);
    });
    request.on('connect', (response, socket, head) => {
      socket.destroy();
      resolve({ status: response.statusCode || 0, statusText: response.statusMessage || '', headers: response.headers, body: Buffer.from(head || '').toString('utf8'), url: url.toString(), redirected: false });
    });
    request.setTimeout(timeout, () => request.destroy(Object.assign(new Error('Request timed out.'), { name: 'TimeoutError' })));
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function responseHeaderObject(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (Array.isArray(value)) output[key] = value.join(', ');
    else if (value !== undefined) output[key] = String(value);
  }
  if (Array.isArray(headers?.['set-cookie'])) output['set-cookie'] = headers['set-cookie'].join('\n');
  return output;
}

async function performRequest(input) {
  const method = String(input.method || 'GET').toUpperCase();
  if (!/^[A-Z!#$%&'*+.^_`|~-]+$/.test(method)) throw Object.assign(new Error('Invalid HTTP method.'), { statusCode: 400 });
  const url = new URL(String(input.url || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Only HTTP and HTTPS request URLs are supported.'), { statusCode: 400 });
  const timeout = Math.min(120000, Math.max(1000, Number(input.timeout) || 30000));
  const signal = AbortSignal.timeout(timeout);
  const body = ['GET', 'HEAD'].includes(method) ? undefined : String(input.body ?? '');
  const headers = normalizeHeaders(input.headers);
  const auth = input.auth || { type: 'none' };
  const type = String(auth.type || 'none').toLowerCase().replace(/[ _-]/g, '');

  if (type === 'aws' || type === 'awsv4' || type === 'awssignature') applyAwsV4(url, method, headers, body || '', auth);
  if (type === 'oauth1' || type === 'oauth10') applyOAuth1(url, method, headers, body || '', auth);
  if (type === 'hawk' || type === 'hawkauthentication') applyHawk(url, method, headers, body || '', auth);
  if (type === 'edgegrid' || type === 'akamai') applyEdgeGrid(url, method, headers, body || '', auth);
  if (type === 'jwt' || type === 'jwtbearer') applyJwt(url, headers, auth);
  if (type === 'oauth2' && auth.grantType === 'client_credentials') {
    const accessToken = await fetchOAuth2Token(auth, signal);
    if (auth.tokenPlacement === 'query') url.searchParams.set(auth.tokenParam || 'access_token', accessToken);
    else headers.authorization = `${auth.tokenPrefix === undefined ? 'Bearer' : auth.tokenPrefix}${auth.tokenPrefix === '' ? '' : ' '}${accessToken}`;
  }

  if (method === 'TRACE' || method === 'CONNECT') {
    const rawResponse = await performRawMethod(url, method, headers, body, timeout);
    rawResponse.headers = responseHeaderObject(rawResponse.headers);
    return rawResponse;
  }

  const init = { method, headers, body, redirect: input.followRedirects === false ? 'manual' : 'follow', signal };
  let response;
  if (type === 'digest' || type === 'digestauth') {
    response = await fetch(url, init);
    if (response.status === 401) {
      const challengeHeader = response.headers.get('www-authenticate') || '';
      const match = challengeHeader.match(/Digest\s+.*?(?=,\s*(?:Basic|Bearer|NTLM)\s|$)/i) || challengeHeader.match(/Digest\s+[^,]+(?:,[^,]+)*/i);
      const digestChallenge = parseDigestChallenge(match?.[0] || challengeHeader);
      if (digestChallenge.nonce) {
        await response.arrayBuffer().catch(() => {});
        const digestHeaders = new Headers(headers);
        digestHeaders.set('authorization', digestResponse(digestChallenge, method, url, auth.username || '', auth.password || '', body || ''));
        response = await fetch(url, { ...init, headers: digestHeaders });
      }
    }
  } else if (type === 'ntlm' || type === 'ntlmv2') {
    response = await requestWithNtlm(url, init, auth, signal);
  } else {
    response = await fetch(url, init);
  }

  const responseBody = await readResponse(response);
  const responseHeaders = {};
  for (const [key, value] of response.headers.entries()) responseHeaders[key] = value;
  if (typeof response.headers.getSetCookie === 'function') {
    const cookies = response.headers.getSetCookie();
    if (cookies.length) responseHeaders['set-cookie'] = cookies.join('\n');
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: responseBody,
    url: response.url,
    redirected: response.redirected
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, name: 'API Manager', version: '1.0.0' });
  if (req.method !== 'POST' || pathname !== '/api/request') return json(res, 404, { error: 'Not found.' });
  try {
    const input = await readJson(req);
    const started = performance.now();
    const result = await performRequest(input);
    result.duration = Math.round(performance.now() - started);
    return json(res, 200, result);
  } catch (error) {
    const status = Number(error.statusCode) || (error.name === 'TimeoutError' || error.name === 'AbortError' ? 504 : 502);
    const message = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'Request timed out. Increase the timeout in request settings and try again.' : error.message || 'Request failed.';
    return json(res, status, { error: message, code: error.code || error.name || 'REQUEST_ERROR' });
  }
}

function serveStatic(req, res, pathname) {
  let requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const filePath = path.resolve(ROOT, `.${requested}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) && filePath !== ROOT) return json(res, 403, { error: 'Forbidden.' });
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) return json(res, 404, { error: 'File not found.' });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'content-length': stats.size,
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (requestUrl.pathname.startsWith('/api/')) return await handleApi(req, res, requestUrl.pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
    return serveStatic(req, res, requestUrl.pathname);
  } catch (error) {
    return json(res, 400, { error: error.message || 'Invalid request.' });
  }
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`API Manager is available on http://0.0.0.0:${PORT}`));
}

module.exports = { server, performRequest, parseDigestChallenge, digestResponse, md4, makeNtlmType1, makeNtlmType3, applyAwsV4, applyOAuth1, applyEdgeGrid };
