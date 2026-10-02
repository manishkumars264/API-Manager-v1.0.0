'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('../shared/variables.js');

test('expands simple variables with resolver', () => {
  const resolve = (n) => ({ host: 'api.example.com', token: 'abc123' }[n] ?? null);
  assert.strictEqual(V.expandString('https://{{host}}/v1', resolve), 'https://api.example.com/v1');
  assert.strictEqual(V.expandString('Bearer {{token}}', resolve), 'Bearer abc123');
  assert.strictEqual(V.expandString('no vars here', resolve), 'no vars here');
  assert.strictEqual(V.expandString('', resolve), '');
  assert.strictEqual(V.expandString(123, resolve), 123);
});

test('unknown variables are left untouched', () => {
  const resolve = () => null;
  assert.strictEqual(V.expandString('value: {{missing}}', resolve), 'value: {{missing}}');
});

test('nested expansion resolves chained variables', () => {
  const resolve = (n) => ({ a: '{{b}}', b: 'final' }[n] ?? null);
  assert.strictEqual(V.expandString('{{a}}', resolve), 'final');
});

test('dynamic variables produce expected shapes', () => {
  const ts = V.DYNAMIC.timestamp();
  assert.match(ts, /^\d{13}$/);
  const iso = V.DYNAMIC.isoTimestamp();
  assert.ok(!Number.isNaN(Date.parse(iso)) && iso.includes('T') && iso.endsWith('Z'));
  const guid = V.DYNAMIC.guid();
  assert.match(guid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(V.DYNAMIC.uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (let i = 0; i < 50; i++) {
    const ri = parseInt(V.DYNAMIC.randomInt(5, 10), 10);
    assert.ok(ri >= 5 && ri <= 10, 'randomInt range: ' + ri);
  }
  for (let i = 0; i < 50; i++) {
    const rf = parseFloat(V.DYNAMIC.randomFloat(0, 1));
    assert.ok(rf >= 0 && rf <= 1, 'randomFloat range: ' + rf);
  }
  assert.ok(['true', 'false'].includes(V.DYNAMIC.randomBoolean()));
  assert.strictEqual(V.DYNAMIC.randomString(12).length, 12);
  assert.match(V.DYNAMIC.randomHex(16), /^[0-9a-f]{16}$/);
});

test('dynamic variables expand in strings with args', () => {
  const out = V.expandString('n={{$randomInt(1,3)}} b={{$randomBoolean()}} g={{$guid}}', () => null);
  assert.match(out, /^n=[123] b=(true|false) g=[0-9a-f-]{36}$/);
});

test('variable precedence: request > environment > globals', () => {
  const resolve = V.buildResolver({
    requestVariables: [{ key: 'a', value: 'req' }],
    environmentVariables: [{ key: 'a', value: 'env' }, { key: 'b', value: 'env' }],
    globalVariables: [{ key: 'a', value: 'glob' }, { key: 'b', value: 'glob' }, { key: 'c', value: 'glob' }],
  });
  assert.strictEqual(resolve('a'), 'req');
  assert.strictEqual(resolve('b'), 'env');
  assert.strictEqual(resolve('c'), 'glob');
  assert.strictEqual(resolve('d'), null);
});

test('disabled variables are skipped', () => {
  const resolve = V.buildResolver({
    requestVariables: [{ key: 'x', value: 'off', enabled: false }],
    environmentVariables: [{ key: 'x', value: 'on' }],
    globalVariables: [],
  });
  assert.strictEqual(resolve('x'), 'on');
});

test('listVariables reports winning sources', () => {
  const list = V.listVariables({
    requestVariables: [{ key: 'a', value: '1' }],
    environmentVariables: [{ key: 'a', value: '2' }, { key: 'b', value: '3' }],
    globalVariables: [{ key: 'a', value: '4' }, { key: 'c', value: '5' }],
  });
  const byKey = Object.fromEntries(list.map((v) => [v.key, v]));
  assert.strictEqual(byKey.a.source, 'request');
  assert.strictEqual(byKey.b.source, 'environment');
  assert.strictEqual(byKey.c.source, 'globals');
});

test('expansion guards against runaway recursion', () => {
  const resolve = (n) => ({ a: '{{a}}' }[n] ?? null);
  const out = V.expandString('{{a}}', resolve);
  assert.strictEqual(typeof out, 'string');
  assert.ok(out.length < 100000);
});
