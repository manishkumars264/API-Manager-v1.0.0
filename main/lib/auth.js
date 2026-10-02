'use strict';
/*
 * API Manager - authorization engine (main process only; uses Node crypto).
 *
 * Supported schemes:
 *   none, inherit (resolved before calling), apikey (header/query),
 *   bearer (configurable prefix), basic, digest (MD5 / SHA-256, challenge-response),
 *   oauth1 (HMAC-SHA1 / HMAC-SHA256 / PLAINTEXT), oauth2 (access token,
 *   client credentials), hawk, aws4, edgegrid, ntlmv2, jwt (HS256/384/512).
 *
 * Design: `computeAuthHeaders(auth, spec, env)` returns {headers, retryScheme}.
 * Challenge-response schemes (digest, ntlmv2) return a retryScheme; the proxy
 * performs the 401 challenge handshake and calls the corresponding
 * `*RetryHeaders` helper.
 *
 * `env` lets tests inject deterministic values:
 *   {now: Date, rand: () => number}
 */
const crypto = require('crypto');
const { md4, hmacMd4 } = require('./md4');

const DEFAULT_ENV = { now: () => new Date(), rand: () => Math.random() };

function envGet(env) {
  const e = env || DEFAULT_ENV;
  return {
    now: e.now || DEFAULT_ENV.now,
    rand: e.rand || DEFAULT_ENV.rand,
    nonce: typeof e.nonce === 'string' ? e.nonce : null,
  };
}

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}
function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hex(buf) {
  return Buffer.from(buf).toString('hex');
}
function hmacDigest(alg, key, data) {
  return crypto.createHmac(alg, key).update(data, 'utf8').digest();
}
function sha256hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}
function hashDigest(alg, data) {
  return crypto.createHash(alg).update(data, 'utf8').digest('hex');
}
function randString(n, chars, rand) {
  const r = typeof rand === 'function' ? rand : Math.random;
  const charsSet = chars || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < n; i++) out += charsSet[Math.floor(r() * charsSet.length)];
  return out;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
function awsEncode(str) {
  // RFC 3986 unreserved: A-Z a-z 0-9 - _ . ~
  return encodeURIComponent(String(str)).replace(/%2E/g, '.').replace(/%7E/g, '~').replace(/%2D/g, '-').replace(/%5F/g, '_');
}
function rfc3986(str) {
  return awsEncode(str);
}
function parseAuthUrl(url) {
  const u = new URL(url);
  return { u, host: u.host, path: u.pathname || '/', query: u.search ? u.search.replace(/^\?/, '') : '' };
}

// ---------------------------------------------------------------------------
// Schemes
// ---------------------------------------------------------------------------
function basicHeaders(a) {
  const token = Buffer.from((a.username || '') + ':' + (a.password || ''), 'utf8').toString('base64');
  return [['Authorization', 'Basic ' + token]];
}

function bearerHeaders(a) {
  const prefix = a.prefix === undefined || a.prefix === null ? 'Bearer' : a.prefix;
  return [['Authorization', (prefix ? prefix + ' ' : '') + (a.token || '')]];
}

function apiKeyHeaders(a, spec) {
  if (a.in === 'query') return [['@__query__', a.key || '', a.value || '']];
  return [[a.key || 'X-Api-Key', a.value || '']];
}

function jwtHeaders(a, env) {
  const alg = ['HS256', 'HS384', 'HS512'].includes(a.alg) ? a.alg : 'HS256';
  const e = envGet(env);
  const nowSec = Math.floor(e.now().getTime() / 1000);
  const ttl = Math.max(1, parseInt(a.expSeconds, 10) || 300);
  const header = { alg, typ: 'JWT' };
  const payload = { iat: nowSec, exp: nowSec + ttl };
  if (a.iss) payload.iss = a.iss;
  if (a.sub) payload.sub = a.sub;
  if (a.aud) payload.aud = a.aud;
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = b64url(hmacDigest(alg.toLowerCase() === 'hs256' ? 'sha256' : alg.toLowerCase() === 'hs384' ? 'sha384' : 'sha512', a.secret || '', signingInput));
  return [['Authorization', 'Bearer ' + signingInput + '.' + sig]];
}

/** OAuth 1.0a (RFC 5849) using HMAC-SHA1/HMAC-SHA256/PLAINTEXT. */
function oauth1Headers(a, spec, env) {
  const e = envGet(env);
  const method = (spec.method || 'GET').toUpperCase();
  const { u, path, query } = parseAuthUrl(spec.url);
  const ts = Math.floor(e.now().getTime() / 1000);
  const nonce = e.nonce || b64(crypto.randomBytes(16)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  const sigMethod = a.signatureMethod === 'HMAC-SHA256' ? 'HMAC-SHA256' : a.signatureMethod === 'PLAINTEXT' ? 'PLAINTEXT' : 'HMAC-SHA1';

  const params = [];
  if (query) {
    const sp = new URLSearchParams(query);
    for (const [k, v] of sp) params.push([k, v]);
  }
  const ct = (spec.headers || []).find((h) => h[0].toLowerCase() === 'content-type');
  const ctVal = ct ? String(ct[1]) : '';
  if (method === 'POST' && ctVal.includes('application/x-www-form-urlencoded') && spec.bodyString) {
    const sp = new URLSearchParams(spec.bodyString);
    for (const [k, v] of sp) params.push([k, v]);
  }
  params.push(['oauth_consumer_key', a.consumerKey || '']);
  params.push(['oauth_nonce', nonce]);
  params.push(['oauth_signature_method', sigMethod]);
  params.push(['oauth_timestamp', String(ts)]);
  if (a.token) params.push(['oauth_token', a.token]);
  params.push(['oauth_version', '1.0']);
  params.sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) : x[0] < y[0] ? -1 : 1));
  const paramStr = params.map(([k, v]) => rfc3986(k) + '=' + rfc3986(v)).join('&');
  const baseString = method + '&' + rfc3986(spec.url) + '&' + rfc3986(paramStr);

  let signature;
  if (sigMethod === 'PLAINTEXT') {
    signature = (a.consumerSecret || '') + '&' + (a.tokenSecret || '');
  } else {
    const key = (a.consumerSecret || '') + '&' + (a.tokenSecret || '');
    signature = b64(hmacDigest(sigMethod === 'HMAC-SHA256' ? 'sha256' : 'sha1', key, baseString));
  }
  params.push(['oauth_signature', signature]);
  const header = params.map(([k, v]) => rfc3986(k) + '="' + rfc3986(v) + '"').join(', ');
  return [['Authorization', 'OAuth ' + header]];
}

/** Hawk (header variant) per draft-pollihawk. */
function hawkHeaders(a, spec, env) {
  const e = envGet(env);
  const method = (spec.method || 'GET').toUpperCase();
  const { u } = parseAuthUrl(spec.url);
  const ts = Math.floor(e.now().getTime() / 1000);
  const nonce = e.nonce || randString(6, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', e.rand).slice(0, 6);
  const pathQuery = u.pathname + (u.search ? u.search : '');
  const canonical = ['hawk.1.header', String(ts), nonce, method, pathQuery, u.hostname, String(u.port || (u.protocol === 'https:' ? 443 : 80))].join('\n') + '\n';
  const mac = b64(hmacDigest('sha1', a.key || '', canonical));
  return [['Authorization', 'Hawk id="' + (a.id || '') + '", ts="' + ts + '", nonce="' + nonce + '", mac="' + mac + '"']];
}

/** AWS Signature Version 4. */
function aws4Headers(a, spec, env) {
  const e = envGet(env);
  const method = (spec.method || 'GET').toUpperCase();
  const { u, path, query } = parseAuthUrl(spec.url);
  const d = e.now();
  const amzDate = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = a.region || 'us-east-1';
  const service = a.service || 's3';

  const queryPairs = query ? Array.from(new URLSearchParams(query).entries()).map(([k, v]) => [awsEncode(k), awsEncode(v)]) : [];
  queryPairs.sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1));
  const canonicalQuery = queryPairs.map(([k, v]) => k + '=' + v).join('&');
  const canonicalPath = path || '/';

  const signedHeadersList = ['host', 'x-amz-date'];
  if (a.sessionToken) signedHeadersList.push('x-amz-security-token');
  const headerValues = {
    host: u.host,
    'x-amz-date': amzDate,
  };
  if (a.sessionToken) headerValues['x-amz-security-token'] = a.sessionToken;
  const canonicalHeaders = signedHeadersList.map((h) => h + ':' + headerValues[h] + '\n').join('');
  const signedHeaders = signedHeadersList.join(';');

  const payloadHash = 'UNSIGNED-PAYLOAD';
  const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = dateStamp + '/' + region + '/' + service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmacDigest('sha256', 'AWS4' + (a.secretAccessKey || ''), dateStamp);
  const kRegion = hmacDigest('sha256', kDate, region);
  const kService = hmacDigest('sha256', kRegion, service);
  const kSigning = hmacDigest('sha256', kService, 'aws4_request');
  const signature = hex(hmacDigest('sha256', kSigning, stringToSign));

  const headers = [
    ['x-amz-date', amzDate],
    ['Authorization', 'AWS4-HMAC-SHA256 Credential=' + (a.accessKeyId || '') + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature],
  ];
  if (a.sessionToken) headers.splice(1, 0, ['x-amz-security-token', a.sessionToken]);
  return headers;
}

/** Akamai EdgeGrid. */
function edgegridHeaders(a, spec, env) {
  const e = envGet(env);
  const method = (spec.method || 'GET').toUpperCase();
  const { u, path, query } = parseAuthUrl(spec.url);
  const ts = e.now().toISOString();
  const nonce = e.nonce || randString(16, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', e.rand);

  const headersList = (spec.headers || [])
    .filter(([k]) => k.toLowerCase() !== 'authorization')
    .map(([k, v]) => [String(k).toLowerCase(), String(v)])
    .sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const headerStr = headersList.map(([k, v]) => k + ':' + v).join(';');

  const key = hmacDigest('sha256', a.clientSecretKey || '', ts);
  const key1 = hmacDigest('sha256', key, nonce);
  const key2 = hmacDigest('sha256', key1, path);
  const key3 = hmacDigest('sha256', key2, method + '\n' + u.host + '\n' + path + '\n' + query + '\n' + headerStr + '\n');
  const signature = hex(hmacDigest('sha256', key3, ''));

  return [['Authorization', 'EdgeGrid ts="' + ts + '", nonce="' + nonce + '", client_token="' + (a.clientToken || '') + '", signature="' + signature + '"']];
}

// ---------------------------------------------------------------------------
// Digest (RFC 2069/7616) challenge-response
// ---------------------------------------------------------------------------
function parseDigestChallenge(header) {
  const m = String(header || '').match(/Digest\s*(.*)$/i);
  if (!m) return null;
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) {
    out[mm[1].toLowerCase()] = mm[2] !== undefined ? mm[2] : mm[3];
  }
  return out;
}

function digestRetryHeaders(a, spec, challengeRaw, env) {
  const e = envGet(env);
  const c = parseDigestChallenge(challengeRaw);
  if (!c) throw new Error('Digest challenge could not be parsed');
  const algorithm = (c.algorithm || 'MD5').toUpperCase();
  const algo = algorithm.startsWith('SHA-256') ? 'sha256' : algorithm.startsWith('MD5') ? 'md5' : null;
  if (!algo) throw new Error('Unsupported digest algorithm: ' + algorithm);
  const sess = algorithm.includes('SESS') || algorithm.endsWith('SES');
  const H = (s) => hashDigest(algo, s);
  const user = a.username || '';
  const pass = a.password || '';
  const uri = new URL(spec.url).pathname + (new URL(spec.url).search || '');
  let ha1 = H(user + ':' + (c.realm || '') + ':' + pass);
  const cnonce = b64(crypto.randomBytes(8)).replace(/[^a-zA-Z0-9]/g, '');
  const nc = '00000001';
  const qop = c.qop || '';
  let response;
  if (qop) {
    const qopUse = qop.split(',').includes('auth') ? 'auth' : qop.split(',')[0];
    if (sess) ha1 = H(ha1 + ':' + c.nonce + ':' + cnonce);
    response = H(ha1 + ':' + c.nonce + ':' + nc + ':' + cnonce + ':' + qopUse + ':' + H((spec.method || 'GET').toUpperCase() + ':' + uri));
  } else {
    if (sess) ha1 = H(ha1 + ':' + c.nonce + ':' + cnonce);
    response = H(ha1 + ':' + c.nonce + ':' + H((spec.method || 'GET').toUpperCase() + ':' + uri));
  }
  const parts = ['username="' + user + '"', 'realm="' + (c.realm || '') + '"', 'nonce="' + c.nonce + '"', 'uri="' + uri + '"', 'algorithm=' + algorithm, 'qop=' + qopUseSafe(qop), 'nc=' + nc, 'cnonce="' + cnonce + '"', 'response="' + response + '"'];
  if (c.opaque) parts.push('opaque="' + c.opaque + '"');
  return [['Authorization', 'Digest ' + parts.join(', ')]];
}
function qopUseSafe(qop) {
  if (!qop) return '""';
  const q = qop.split(',').includes('auth') ? 'auth' : qop.split(',')[0];
  return '"' + q + '"';
}

// ---------------------------------------------------------------------------
// NTLMv2
// ---------------------------------------------------------------------------
const NTLM_NEGOTIATE_UNICODE = 0x00000001;
const NTLM_NEGOTIATE_OEM = 0x00000002;
const NTLM_REQUEST_TARGET = 0x00000004;
const NTLM_NEGOTIATE_SIGN = 0x00000010;
const NTLM_NEGOTIATE_ALWAYS_SIGN = 0x00008000;
const NTLM_NEGOTIATE_NTLM = 0x00000200;
const NTLM_NEGOTIATE_ANONYMOUS = 0x00000800;

function utf16le(str) {
  const out = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return out;
}

function ntlmType1(env) {
  // MS-NLMP 2.2.2.3 NEGOTIATE (Type 1): signature(8) + type(4) at 8,
  // NegotiateFlags(4) at 12, DomainNameFields(8) at 16, WorkstationFields(8) at 24.
  const flags = NTLM_NEGOTIATE_UNICODE | NTLM_NEGOTIATE_OEM | NTLM_REQUEST_TARGET | NTLM_NEGOTIATE_SIGN | NTLM_NEGOTIATE_ALWAYS_SIGN | NTLM_NEGOTIATE_NTLM;
  const buf = Buffer.alloc(32);
  buf.write('NTLMSSP', 0, 'ascii');
  buf.writeUInt8(0, 7); // signature is 8 bytes
  buf.writeUInt32LE(1, 8); // type 1
  buf.writeUInt32LE(flags, 12);
  // domain name fields: zero-length
  buf.writeUInt16LE(0, 16);
  buf.writeUInt16LE(0, 18);
  buf.writeUInt32LE(32, 20);
  // workstation fields: zero-length
  buf.writeUInt16LE(0, 24);
  buf.writeUInt16LE(0, 26);
  buf.writeUInt32LE(32, 28);
  return b64(buf);
}

function parseNtlmType2(b64) {
  const buf = Buffer.from(b64, 'base64');
  // MS-NLMP 2.2.2.4 SERVERCHALLENGE (Type 2): signature(8) + type(4) at 8,
  // TargetNameFields(8) at 12, NegotiateFlags(4) at 20, ServerChallenge(8) at 24,
  // Reserved(4) at 32, TargetInfoFields(8) at 36, optional Version(8) at 44.
  if (buf.length < 44 || buf.toString('ascii', 0, 7) !== 'NTLMSSP' || buf[7] !== 0 || buf.readUInt32LE(8) !== 2) throw new Error('Invalid NTLM Type 2 message');
  const targetNameLen = buf.readUInt16LE(12);
  const targetNameMax = buf.readUInt16LE(14);
  const targetNameOffset = buf.readUInt32LE(16);
  const flags = buf.readUInt32LE(20);
  const serverChallenge = buf.slice(24, 32);
  const targetInfoLen = buf.readUInt16LE(36);
  const targetInfoOffset = buf.readUInt32LE(40);
  if (targetInfoOffset + targetInfoLen > buf.length) throw new Error('Truncated NTLM Type 2 message');
  const targetInfo = buf.slice(targetInfoOffset, targetInfoOffset + targetInfoLen);
  return { flags, serverChallenge, targetInfo, targetNameLen, targetNameMax };
}

/**
 * Build NTLM Type 3 (v2) message.
 * opts: {clientChallenge?: Buffer(8), now?: Date} for deterministic tests.
 */
function ntlmType3(a, type2b64, env) {
  const e = envGet(env);
  const { serverChallenge, targetInfo } = parseNtlmType2(type2b64);
  const pass = a.password || '';
  const user = a.username || '';
  const domain = a.domain || '';

  const ntowf = md4(utf16le(pass));
  const clientChallenge = Buffer.alloc(8, 1);
  for (let i = 0; i < 8; i++) clientChallenge[i] = Math.floor(e.rand() * 256);

  // NTLMv2 (MS-NLMP 2.2.2.5.1): the challenge response is NTProof(16) ||
  // TimestampedBlob(>=56). The LMv2 response has the identical shape but is
  // HMAC-MD4 over ClientChallenge || ServerChallenge (swapped order).
  const ntProof = hmacMd4(ntowf, Buffer.concat([serverChallenge, clientChallenge]));
  const lmProof = hmacMd4(ntowf, Buffer.concat([clientChallenge, serverChallenge]));
  // blob = Resp(16) + 8*0 + 4*0 + clientChallenge(8) + 4*0 + timestamp(8) + 4*0 + targetInfo + 4*0
  const zero4 = Buffer.alloc(4, 0);
  const zero8 = Buffer.alloc(8, 0);
  // FILETIME = 100-ns intervals since 1601-01-01 (UTC), 64-bit little-endian.
  const ts = Buffer.alloc(8, 0);
  const filetime = (BigInt(e.now().getTime()) + 11644473600000n) * 10000n;
  ts.writeUInt32LE(Number(filetime & 0xFFFFFFFFn), 0);
  ts.writeUInt32LE(Number((filetime >> 32n) & 0xFFFFFFFFn), 4);
  const ntBlob = Buffer.concat([Buffer.from(ntProof), zero8, zero4, clientChallenge, zero4, ts, zero4, targetInfo, zero4]);
  const lmBlob = Buffer.concat([Buffer.from(lmProof), zero8, zero4, clientChallenge, zero4, ts, zero4, targetInfo, zero4]);
  const ntlmChallengeResponse = Buffer.concat([Buffer.from(ntProof), ntBlob]);
  const lmChallengeResponse = Buffer.concat([Buffer.from(lmProof), lmBlob]);

  // MS-NLMP 2.2.2.5 NTLMCHALLENGE_MESSAGE (Type 3):
  //   0: signature(8), 8: type(4), 12: LmChallengeResponseFields(8),
  //   20: NtChallengeResponseFields(8), 28: DomainNameFields(8),
  //   36: UserNameFields(8), 44: NegotiateFlags(4), 48: Reserved(8)
  const userU = utf16le(user);
  const domainU = utf16le(domain);
  const payloadOffset = 64;
  let off = payloadOffset;
  const offsets = {};
  for (const [name, data] of [['domain', domainU], ['user', userU], ['nt', Buffer.from(ntlmChallengeResponse)], ['lm', Buffer.from(lmChallengeResponse)]]) {
    offsets[name] = off;
    off += data.length;
  }
  const sessionKey = Buffer.alloc(8, 0);
  const reserved = Buffer.alloc(4, 0);
  const payload = Buffer.concat([domainU, userU, Buffer.from(ntlmChallengeResponse), Buffer.from(lmChallengeResponse), sessionKey, reserved]);
  const buf = Buffer.alloc(payloadOffset + payload.length);
  buf.write('NTLMSSP', 0, 'ascii');
  buf.writeUInt8(0, 7);
  buf.writeUInt32LE(3, 8);
  writeField(buf, 12, Buffer.from(lmChallengeResponse), offsets.lm);
  writeField(buf, 20, Buffer.from(ntlmChallengeResponse), offsets.nt);
  writeField(buf, 28, domainU, offsets.domain);
  writeField(buf, 36, userU, offsets.user);
  buf.writeUInt32LE(NTLM_NEGOTIATE_UNICODE | NTLM_NEGOTIATE_SIGN | NTLM_NEGOTIATE_NTLM, 44);
  // 48..55: reserved (zeros from alloc)
  payload.copy(buf, payloadOffset);
  return b64(buf);
}
function writeField(buf, off, data, offsetInBuffer) {
  buf.writeUInt16LE(data.length, off);
  buf.writeUInt16LE(data.length, off + 2);
  buf.writeUInt32LE(offsetInBuffer !== undefined ? offsetInBuffer : 0, off + 4);
}

// ---------------------------------------------------------------------------
// Top-level entry
// ---------------------------------------------------------------------------
/**
 * @param {object} a auth config {type, ...}
 * @param {object} spec {method, url (final, incl. query), headers [[k,v]], bodyString?, bodyBuffer?}
 * @returns {{headers: Array<[string,string]>, extraQuery: Array<[string,string]>, retryScheme: 'digest'|'ntlm'|null, error?: string}}
 */
function computeAuthHeaders(a, spec, env) {
  if (!a || a.type === 'none' || a.type === 'inherit') {
    return { headers: [], extraQuery: [], retryScheme: null };
  }
  try {
    switch (a.type) {
      case 'apikey': {
        if (a.in === 'query') return { headers: [], extraQuery: [[a.key || 'apikey', a.value || '']], retryScheme: null };
        return { headers: [[a.key || 'X-Api-Key', a.value || '']], extraQuery: [], retryScheme: null };
      }
      case 'bearer':
        return { headers: bearerHeaders(a), extraQuery: [], retryScheme: null };
      case 'basic':
        return { headers: basicHeaders(a), extraQuery: [], retryScheme: null };
      case 'digest':
        return { headers: [], extraQuery: [], retryScheme: 'digest' };
      case 'oauth1':
        return { headers: oauth1Headers(a, spec, env), extraQuery: [], retryScheme: null };
      case 'oauth2': {
        if (a.flow === 'client_credentials') {
          // token is resolved by the proxy (token exchange) before computeAuthHeaders;
          // if a token is already present, use it.
          if (a.accessToken) return { headers: bearerHeaders({ prefix: 'Bearer', token: a.accessToken }), extraQuery: [], retryScheme: null };
          return { headers: [], extraQuery: [], retryScheme: null, error: 'OAuth2 client credentials: no access token available (token exchange failed)' };
        }
        return { headers: bearerHeaders({ prefix: 'Bearer', token: a.accessToken }), extraQuery: [], retryScheme: null };
      }
      case 'hawk':
        return { headers: hawkHeaders(a, spec, env), extraQuery: [], retryScheme: null };
      case 'aws4':
        return { headers: aws4Headers(a, spec, env), extraQuery: [], retryScheme: null };
      case 'edgegrid':
        return { headers: edgegridHeaders(a, spec, env), extraQuery: [], retryScheme: null };
      case 'ntlmv2':
        return { headers: [['Authorization', 'NTLM ' + ntlmType1(env)]], extraQuery: [], retryScheme: 'ntlm' };
      case 'jwt':
        return { headers: jwtHeaders(a, env), extraQuery: [], retryScheme: null };
      default:
        return { headers: [], extraQuery: [], retryScheme: null, error: 'Unknown auth type: ' + a.type };
    }
  } catch (err) {
    return { headers: [], extraQuery: [], retryScheme: null, error: 'Auth error (' + a.type + '): ' + err.message };
  }
}

module.exports = {
  computeAuthHeaders,
  parseDigestChallenge,
  digestRetryHeaders,
  ntlmType1,
  parseNtlmType2,
  ntlmType3,
  jwtHeaders,
  basicHeaders,
  bearerHeaders,
  oauth1Headers,
  hawkHeaders,
  aws4Headers,
  edgegridHeaders,
  awsEncode,
  b64,
  b64url,
  hex,
  hmacDigest,
  sha256hex,
};
