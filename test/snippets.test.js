'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../shared/snippets.js');

function baseReq(overrides) {
  return Object.assign(
    {
      name: 'Test request',
      method: 'GET',
      url: 'https://api.example.com/v1/items',
      query: [{ key: 'limit', value: '10', enabled: true }],
      headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
      auth: { type: 'none' },
      body: { mode: 'none', raw: '', rawLang: 'json', urlencoded: [], formdata: [], graphql: { query: '', variables: '' }, soap: { version: '1.1', action: '', envelope: '' } },
      settings: { timeoutMs: 30000, redirect: 'follow' },
    },
    overrides || {}
  );
}

test('generateAll returns all five languages', () => {
  const out = S.generateAll(baseReq());
  for (const lang of ['curl', 'python', 'fetch', 'java', 'postmanCli']) {
    assert.ok(typeof out[lang] === 'string' && out[lang].length > 10, lang + ' missing');
  }
});

test('cURL snippet', () => {
  const out = S.generateAll(baseReq({ method: 'POST', body: { mode: 'raw', raw: '{"a":1}', rawLang: 'json', urlencoded: [], formdata: [], graphql: { query: '', variables: '' }, soap: {} } })).curl;
  assert.ok(out.includes('-X POST'));
  assert.ok(out.includes('https://api.example.com/v1/items?limit=10'));
  assert.ok(out.includes('--data \'{"a":1}\''));
});

test('python snippet: json body, basic auth, params, timeout', () => {
  const py = S.genPython(
    baseReq({
      method: 'POST',
      body: { mode: 'raw', raw: '{"a":1}', rawLang: 'json', urlencoded: [], formdata: [], graphql: { query: '', variables: '' }, soap: {} },
      auth: { type: 'basic', username: 'u', password: 'p' },
      settings: { timeoutMs: 45000, redirect: 'follow' },
    })
  );
  assert.ok(py.includes('import requests'));
  assert.ok(py.includes('requests.request("POST"'));
  assert.ok(py.includes('json={"a":1}'));
  assert.ok(py.includes('auth=("u", "p")'));
  assert.ok(py.includes('params=params'));
  assert.ok(py.includes('timeout=45'));
});

test('python snippet: urlencoded body', () => {
  const py = S.genPython(
    baseReq({ method: 'POST', body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1', enabled: true }], raw: '', rawLang: 'text', formdata: [], graphql: { query: '', variables: '' }, soap: {} } })
  );
  assert.ok(py.includes('data='));
  assert.ok(py.includes('"a"'));
});

test('python snippet: advanced auth is labeled', () => {
  const py = S.genPython(baseReq({ auth: { type: 'aws4', accessKeyId: 'A', secretAccessKey: 'B', region: 'r', service: 's' } }));
  assert.ok(py.includes('# Authorization uses aws4'), py);
});

test('fetch snippet: bearer, body, abort signal', () => {
  const js = S.genFetch(
    baseReq({
      method: 'POST',
      body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1', enabled: true }], raw: '', rawLang: 'text', formdata: [], graphql: { query: '', variables: '' }, soap: {} },
      auth: { type: 'bearer', prefix: 'Bearer', token: 'tok' },
      settings: { timeoutMs: 15000, redirect: 'follow' },
    })
  );
  assert.ok(js.includes('await fetch('));
  assert.ok(js.includes('method: "POST"'));
  assert.ok(js.includes('Authorization'));
  assert.ok(js.includes('Bearer tok'));
  assert.ok(js.includes('AbortSignal.timeout(15000)'));
  assert.ok(js.includes('response.text()'));
});

test('fetch snippet: graphql body', () => {
  const js = S.genFetch(
    baseReq({ method: 'POST', body: { mode: 'graphql', query: '', rawLang: 'json', raw: '', urlencoded: [], formdata: [], graphql: { query: '{ me }', variables: '{ "id": "1" }' }, soap: {} } })
  );
  assert.ok(js.includes('JSON.stringify'));
  assert.ok(js.includes('application/json'));
});

test('java snippet: method, uri, headers, timeout', () => {
  const java = S.genJava(
    baseReq({
      method: 'POST',
      body: { mode: 'raw', raw: 'hello', rawLang: 'text', urlencoded: [], formdata: [], graphql: { query: '', variables: '' }, soap: {} },
      settings: { timeoutMs: 20000, redirect: 'follow' },
    })
  );
  assert.ok(java.includes('HttpClient.newHttpClient()'));
  assert.ok(java.includes('HttpRequest.newBuilder()'));
  assert.ok(java.includes('.method("POST"'));
  assert.ok(java.includes('URI.create("https://api.example.com/v1/items?limit=10")'));
  assert.ok(java.includes('BodyPublishers.ofString("hello")'));
  assert.ok(java.includes('Duration.ofMillis(20000)'));
  assert.ok(java.includes('BodyHandlers.ofString()'));
});

test('java snippet: bearer auth header', () => {
  const java = S.genJava(baseReq({ auth: { type: 'bearer', prefix: 'Bearer', token: 't' } }));
  assert.ok(java.includes('.header("Authorization", "Bearer t")'));
});

test('postman CLI snippet embeds a v2.1 collection', () => {
  const out = S.genPostmanCli(baseReq({ name: 'My Req' }));
  assert.ok(out.includes('postman collection run collection.json'));
  const jsonPart = out.slice(out.indexOf('{'));
  const col = JSON.parse(jsonPart.slice(0, jsonPart.lastIndexOf('}') + 1));
  assert.strictEqual(col.info.name, 'My Req');
  assert.ok(col.info.schema.includes('v2.1'));
  assert.strictEqual(col.item[0].request.method, 'GET');
});

test('snippet escaping in java strings', () => {
  const java = S.genJava(baseReq({ method: 'POST', body: { mode: 'raw', raw: 'a"b\\nc', rawLang: 'text', urlencoded: [], formdata: [], graphql: { query: '', variables: '' }, soap: {} } }));
  assert.ok(java.includes('a\\"b\\\\nc'));
});
