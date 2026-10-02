'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { performRequest } = require('../server');

test('NTLM proxy performs a challenge-response handshake', async () => {
  const challenge = Buffer.alloc(48);
  challenge.write('NTLMSSP\0', 0, 'ascii');
  challenge.writeUInt32LE(2, 8);
  challenge.writeUInt32LE(0x00088201, 20);
  Buffer.from('12345678').copy(challenge, 24);
  let attempts = 0;
  const fixture = http.createServer((req, res) => {
    attempts++;
    const header = req.headers.authorization || '';
    if (attempts === 1) {
      res.writeHead(401, { 'www-authenticate': `NTLM ${challenge.toString('base64')}` });
      res.end('challenge');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(header);
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  try {
    const response = await performRequest({ method: 'GET', url: `http://127.0.0.1:${fixture.address().port}/ntlm`, auth: { type: 'ntlm', username: 'user', password: 'password', domain: 'DOMAIN' } });
    assert.equal(attempts, 2);
    assert.equal(response.status, 200);
    assert.match(response.body, /^NTLM [A-Za-z0-9+/=]+$/);
  } finally { await new Promise(resolve => fixture.close(resolve)); }
});
