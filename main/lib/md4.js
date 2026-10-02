'use strict';
/*
 * Minimal MD4 implementation (RFC 1320) for NTLMv2 password hashing.
 * Node's crypto does not always expose MD4 (OpenSSL 3 legacy provider),
 * so we implement it in pure JS.
 */
function md4(input) {
  const msg = input instanceof Uint8Array ? input : new TextEncoder().encode(String(input));
  const len = msg.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  const bitLenLow = (len * 8) >>> 0;
  const bitLenHigh = Math.floor((len * 8) / 0x100000000);
  // Bit length in little-endian bit order: low 32 bits at offset 56, high at 60.
  dv.setUint32(total - 8, bitLenLow, true);
  dv.setUint32(total - 4, bitLenHigh, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & y) | (x & z) | (y & z);
  const H = (x, y, z) => x ^ y ^ z;
  const X = new Array(16);

  const r1 = [3, 7, 11, 19];
  const r2 = [3, 5, 9, 13];
  const r3 = [3, 9, 11, 15];
  const m1 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const m2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
  const m3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = dv.getUint32(off + i * 4, true);
    // r[0]=a, r[1]=b, r[2]=c, r[3]=d; after each step the register naming
    // rotates (a,b,c,d) -> (d,a,b,c), i.e. r = [r3, r0, r1, r2].
    const r = [a0, b0, c0, d0];
    const round = (fn, order, K, S) => {
      for (let i = 0; i < 16; i++) {
        r[0] = rotl((r[0] + fn(r[1], r[2], r[3]) + X[order[i]] + K) >>> 0, S[i % 4]);
        r.unshift(r.pop());
      }
    };
    round(F, m1, 0, r1);
    round(G, m2, 0x5a827999, r2);
    round(H, m3, 0x6ed9eba1, r3);

    a0 = (a0 + r[0]) >>> 0;
    b0 = (b0 + r[1]) >>> 0;
    c0 = (c0 + r[2]) >>> 0;
    d0 = (d0 + r[3]) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return out;
}

/** RFC 2104 HMAC using MD4. */
function hmacMd4(key, msg) {
  const k = key instanceof Uint8Array ? key : new TextEncoder().encode(String(key));
  const m = msg instanceof Uint8Array ? msg : new TextEncoder().encode(String(msg));
  const keyBuf = new Uint8Array(64);
  if (k.length > 64) keyBuf.set(md4(k));
  else keyBuf.set(k.subarray(0, Math.min(k.length, 64)));
  const ipad = new Uint8Array(64).fill(0x36);
  const opad = new Uint8Array(64).fill(0x5c);
  for (let i = 0; i < 64; i++) {
    ipad[i] ^= keyBuf[i];
    opad[i] ^= keyBuf[i];
  }
  const inner = new Uint8Array(64 + m.length);
  inner.set(ipad, 0);
  inner.set(m, 64);
  const innerHash = md4(inner);
  const outer = new Uint8Array(64 + 16);
  outer.set(opad, 0);
  outer.set(innerHash, 64);
  return md4(outer);
}

module.exports = { md4, hmacMd4 };
