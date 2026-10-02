'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('../shared/history.js');
const SOAP = require('../shared/soap.js');

test('history keeps at most 200 entries, newest first', () => {
  let list = [];
  for (let i = 0; i < 250; i++) {
    list = H.addEntry(list, { id: 'e' + i, ts: i });
  }
  assert.strictEqual(list.length, 200);
  assert.strictEqual(list[0].id, 'e249');
  assert.strictEqual(list[199].id, 'e50');
  assert.ok(list.every((e) => e.id !== 'e49'));
});

test('makeEntry builds a full snapshot and ok flag', () => {
  const entry = H.makeEntry({
    name: 'My req',
    method: 'POST',
    url: 'https://x.test/a',
    request: { method: 'POST', url: 'https://x.test/a', headers: [] },
    response: { ok: true, status: 200, statusText: 'OK', headers: [['a', 'b']], cookies: [{ name: 's', value: 'v' }], body: 'hello', bodyEncoding: 'utf8', sizeBytes: 5, durationMs: 12 },
    tests: [{ name: 't', pass: true, error: null }],
  });
  assert.strictEqual(entry.ok, true);
  assert.strictEqual(entry.status, 200);
  assert.strictEqual(entry.request.method, 'POST');
  assert.strictEqual(entry.response.body, 'hello');
  assert.strictEqual(entry.tests.length, 1);
  const failed = H.makeEntry({
    name: 'f',
    method: 'GET',
    url: 'https://x',
    request: {},
    response: { ok: true, status: 500, body: '', bodyEncoding: 'utf8', sizeBytes: 0, durationMs: 1 },
  });
  assert.strictEqual(failed.ok, false);
});

test('makeEntry truncates oversized stored bodies', () => {
  const big = 'x'.repeat(H.MAX_STORED_BODY + 5000);
  const entry = H.makeEntry({
    name: 'big',
    method: 'GET',
    url: 'https://x',
    request: {},
    response: { ok: true, status: 200, body: big, bodyEncoding: 'utf8', sizeBytes: big.length, durationMs: 1 },
  });
  assert.strictEqual(entry.truncated, true);
  assert.strictEqual(entry.response.body.length, H.MAX_STORED_BODY);
  assert.strictEqual(entry.response.sizeBytes, big.length); // original size preserved
});

test('truncation keeps base64 aligned to 4 chars', () => {
  const b64 = Buffer.from('y'.repeat(H.MAX_STORED_BODY + 1000)).toString('base64');
  const r = H.truncateBody(b64, 'base64');
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.body.length % 4, 0);
});

test('SOAP templates and headers', () => {
  const t11 = SOAP.template('1.1');
  assert.ok(t11.includes('http://schemas.xmlsoap.org/soap/envelope/'));
  assert.ok(t11.includes('soapenv:Body'));
  const t12 = SOAP.template('1.2');
  assert.ok(t12.includes('http://www.w3.org/2003/05/soap-envelope'));
  const h11 = SOAP.soapHeaders('1.1', 'urn:GetUser');
  assert.strictEqual(h11['Content-Type'], 'text/xml; charset=utf-8');
  assert.strictEqual(h11.SOAPAction, '"urn:GetUser"');
  const h11e = SOAP.soapHeaders('1.1', '');
  assert.strictEqual(h11e.SOAPAction, '""');
  const h12 = SOAP.soapHeaders('1.2', 'urn:GetUser');
  assert.strictEqual(h12['Content-Type'], 'application/soap+xml; charset=utf-8; action="urn:GetUser"');
  const h12e = SOAP.soapHeaders('1.2', '');
  assert.strictEqual(h12e['Content-Type'], 'application/soap+xml; charset=utf-8');
  assert.strictEqual(h12.SOAPAction, undefined);
});
