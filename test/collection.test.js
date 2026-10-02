'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../shared/collection.js');

const SAMPLE = {
  info: { name: 'Sample API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: 'ctok', type: 'string' }] },
  variable: [{ key: 'base', value: 'https://api.example.com', disabled: false }],
  item: [
    {
      id: 'f1',
      name: 'Users',
      item: [
        {
          id: 'r1',
          name: 'List users',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/users', href: 'https://api.example.com/users', query: [{ key: 'limit', value: '10' }] },
            header: [{ key: 'Accept', value: 'application/json' }],
            event: [
              { listen: 'prerequest', script: 'pm.environment.set("step", "1");' },
              { listen: 'test', script: 'pm.test("ok", () => pm.expect(pm.response.code).to.equal(200));' },
            ],
            variable: [{ key: 'local', value: 'v' }],
          },
        },
        {
          id: 'r2',
          name: 'Create user',
          request: {
            method: 'POST',
            url: 'https://api.example.com/users',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{"name":"Ada"}', options: { raw: { language: 'json' } } },
            auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Api-Key', type: 'string' }, { key: 'value', value: 'secret', type: 'string' }, { key: 'in', value: 'query', type: 'string' }] },
          },
        },
        {
          id: 'r3',
          name: 'Upload',
          request: {
            method: 'POST',
            url: 'https://api.example.com/upload',
            body: {
              mode: 'formdata',
              formdata: [
                { key: 'file', value: '/tmp/x.png', type: 'file' },
                { key: 'label', value: 'hi', type: 'text' },
              ],
            },
          },
        },
        {
          id: 'r4',
          name: 'Login',
          request: {
            method: 'POST',
            url: 'https://api.example.com/login',
            body: { mode: 'urlencoded', urlencoded: [{ key: 'u', value: 'a', disabled: false }, { key: 'p', value: 'b', disabled: true }] },
          },
        },
      ],
    },
    {
      id: 'r5',
      name: 'Health',
      request: { method: 'GET', url: 'https://api.example.com/health', body: { mode: 'graphql', graphql: { query: '{ me }', variables: '{ "x": 1 }' } } },
    },
  ],
};

test('normalizes a Postman v2.1 collection', () => {
  const col = C.normalizeCollection(SAMPLE);
  assert.strictEqual(col.name, 'Sample API');
  assert.strictEqual(col.auth.type, 'bearer');
  assert.strictEqual(col.auth.token, 'ctok');
  assert.strictEqual(col.variables.length, 1);
  assert.strictEqual(col.items.length, 2);
  const folder = col.items[0];
  assert.strictEqual(folder.type, 'folder');
  assert.strictEqual(folder.items.length, 4);
  const list = folder.items[0];
  assert.strictEqual(list.type, 'request');
  assert.strictEqual(list.request.method, 'GET');
  assert.strictEqual(list.request.url, 'https://api.example.com/users');
  assert.strictEqual(list.request.query.length, 1);
  assert.strictEqual(list.request.headers.length, 1);
  assert.ok(list.request.scripts.pre.includes('pm.environment.set'));
  assert.ok(list.request.scripts.test.includes('pm.test'));
  assert.strictEqual(list.request.variables.length, 1);
  const create = folder.items[1];
  assert.strictEqual(create.request.body.mode, 'raw');
  assert.strictEqual(create.request.body.rawLang, 'json');
  assert.strictEqual(create.request.body.raw, '{"name":"Ada"}');
  assert.strictEqual(create.auth.type, 'apikey');
  assert.strictEqual(create.auth.in, 'query');
  const upload = folder.items[2];
  assert.strictEqual(upload.request.body.mode, 'formdata');
  assert.strictEqual(upload.request.body.formdata[0].type, 'text'); // file → text (documented limitation)
  const login = folder.items[3];
  assert.strictEqual(login.request.body.mode, 'urlencoded');
  assert.strictEqual(login.request.body.urlencoded.length, 2);
  assert.strictEqual(login.request.body.urlencoded[1].enabled, false);
  const health = col.items[1];
  assert.strictEqual(health.request.body.mode, 'graphql');
  assert.strictEqual(health.request.body.graphql.query, '{ me }');
});

test('collection export round-trips through v2.1', () => {
  const col = C.normalizeCollection(SAMPLE);
  const v21 = C.collectionToV21(col);
  assert.strictEqual(v21.info.name, 'Sample API');
  assert.strictEqual(v21.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
  assert.strictEqual(v21.auth.type, 'bearer');
  const re = C.normalizeCollection(v21);
  assert.strictEqual(re.name, col.name);
  assert.strictEqual(re.items.length, col.items.length);
  assert.strictEqual(re.items[0].items.length, col.items[0].items.length);
  for (let i = 0; i < col.items[0].items.length; i++) {
    const a = col.items[0].items[i].request;
    const b = re.items[0].items[i].request;
    assert.strictEqual(a.method, b.method, 'method ' + i);
    assert.strictEqual(a.url, b.url, 'url ' + i);
    assert.strictEqual(a.body.mode, b.body.mode, 'body mode ' + i);
  }
  // apikey survives
  assert.strictEqual(re.items[0].items[1].auth.type, 'apikey');
  assert.strictEqual(re.items[0].items[1].auth.key, 'X-Api-Key');
});

test('normalizes bare arrays and single requests', () => {
  const arr = C.normalizeCollection([
    { name: 'A', request: { method: 'POST', url: 'https://x.test/a' } },
    { name: 'B', request: { method: 'GET', url: 'https://x.test/b' } },
  ]);
  assert.strictEqual(arr.name, 'Imported Collection');
  assert.strictEqual(arr.items.length, 2);
  const single = C.normalizeCollection({ name: 'Solo', request: { method: 'GET', url: 'https://x.test/s' } });
  assert.strictEqual(single.items.length, 1);
  assert.strictEqual(single.items[0].request.method, 'GET');
});

test('auth normalization covers schemes', () => {
  assert.deepStrictEqual(C.normalizeAuth(null), null);
  assert.strictEqual(C.normalizeAuth({ type: 'noauth' }), null);
  assert.strictEqual(C.normalizeAuth({ type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] }).username, 'u');
  assert.strictEqual(C.normalizeAuth({ type: 'aws', aws: [{ key: 'accessKeyId', value: 'AK' }, { key: 'region', value: 'eu' }, { key: 'service', value: 's3' }] }).type, 'aws4');
  assert.strictEqual(C.normalizeAuth({ type: 'ntlm', ntlm: [{ key: 'username', value: 'dom\\u' }] }).type, 'ntlmv2');
  assert.strictEqual(C.normalizeAuth({ type: 'weird' }).type, 'none');
});

test('environment import/export', () => {
  const env = C.normalizeEnvironment({
    name: 'Prod',
    values: [
      { key: 'host', value: 'https://prod.test', enabled: true },
      { key: 'off', value: 'x', enabled: false },
    ],
    _postman_variable_scope: 'environment',
  });
  assert.strictEqual(env.name, 'Prod');
  assert.strictEqual(env.values[0].enabled, true);
  assert.strictEqual(env.values[1].enabled, false);
  const out = C.environmentToPostman(env);
  assert.strictEqual(out._postman_variable_scope, 'environment');
  assert.strictEqual(out.values.length, 2);
  const back = C.normalizeEnvironment(out);
  assert.deepStrictEqual(back.values.map((v) => [v.key, v.value]), [['host', 'https://prod.test'], ['off', 'x']]);
});

test('workspace backup round-trip and validation', () => {
  const col = C.normalizeCollection(SAMPLE);
  const env = { id: 'e1', name: 'Dev', values: [{ key: 'a', value: '1', enabled: true }] };
  const backup = C.createBackup({
    collections: [col],
    environments: [env],
    globals: { id: 'globals', name: 'Globals', values: [{ key: 'g', value: '2', enabled: true }] },
    history: [{ id: 'h1', ts: 1, name: 'x', method: 'GET', url: 'https://x', ok: true, status: 200, request: {}, response: {} }],
  });
  assert.strictEqual(backup.format, 'api-manager-workspace-backup');
  assert.strictEqual(backup.product, 'API Manager');
  const parsed = C.parseBackup(JSON.stringify(backup));
  assert.strictEqual(parsed.collections.length, 1);
  assert.strictEqual(parsed.collections[0].name, 'Sample API');
  assert.strictEqual(parsed.environments.length, 1);
  assert.strictEqual(parsed.globals.values.length, 1);
  assert.strictEqual(parsed.history.length, 1);
  assert.throws(() => C.parseBackup('{"format":"nope"}'), /Not an API Manager workspace backup/);
  assert.throws(() => C.parseBackup('not json'), /not valid JSON/);
  assert.throws(() => C.parseBackup(JSON.stringify({ format: C.BACKUP_FORMAT, version: 99 })), /Unsupported backup version/);
});
