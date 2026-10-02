'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../shared/curl.js');

test('tokenize handles quotes and line continuations', () => {
  const tokens = C.tokenize('curl \\\n  -X POST \\\n  "https://x.test/a b" \\\n  -d \'{"k":"v w"}\'');
  assert.deepStrictEqual(tokens, ['curl', '-X', 'POST', 'https://x.test/a b', '-d', '{"k":"v w"}']);
  const esc = C.tokenize('curl -d "a\\nb" -d "it\'s"');
  assert.deepStrictEqual(esc, ['curl', '-d', 'a\nb', '-d', "it's"]);
});

test('parses a basic POST with JSON body and headers', () => {
  const { request: r, warnings } = C.parseCurl(`curl -X POST 'https://api.example.com/users' -H 'Content-Type: application/json' -H 'X-Api-Key: k123' -d '{"name":"Ada"}'`);
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.url, 'https://api.example.com/users');
  assert.strictEqual(r.body.mode, 'raw');
  assert.strictEqual(r.body.raw, '{"name":"Ada"}');
  assert.strictEqual(r.body.rawLang, 'json');
  const h = Object.fromEntries(r.headers.map((x) => [x.key.toLowerCase(), x.value]));
  assert.strictEqual(h['x-api-key'], 'k123');
  assert.deepStrictEqual(warnings, []);
});

test('parses -d into urlencoded fields and implies POST', () => {
  const { request: r } = C.parseCurl("curl https://api.example.com/login -d 'u=alice' -d 'p=secret'");
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.body.mode, 'urlencoded');
  assert.deepStrictEqual(
    r.body.urlencoded.map((f) => [f.key, f.value]),
    [['u', 'alice'], ['p', 'secret']]
  );
});

test('parses basic auth, cookies, user agent, referer', () => {
  const { request: r } = C.parseCurl(`curl -u bob:pw -b 'sid=123; theme=dark' -A 'MyAgent/1.0' -e 'https://ref.test/' 'https://api.example.com/x'`);
  assert.strictEqual(r.auth.type, 'basic');
  assert.strictEqual(r.auth.username, 'bob');
  assert.strictEqual(r.auth.password, 'pw');
  const h = Object.fromEntries(r.headers.map((x) => [x.key.toLowerCase(), x.value]));
  assert.strictEqual(h.cookie, 'sid=123; theme=dark');
  assert.strictEqual(h['user-agent'], 'MyAgent/1.0');
  assert.strictEqual(h.referer, 'https://ref.test/');
});

test('parses -I as HEAD, -L, --max-time, -G', () => {
  const head = C.parseCurl('curl -I https://api.example.com/');
  assert.strictEqual(head.request.method, 'HEAD');
  const loc = C.parseCurl('curl -L https://api.example.com/');
  assert.strictEqual(loc.request.settings.redirect, 'follow');
  const t = C.parseCurl('curl --max-time 45 https://api.example.com/');
  assert.strictEqual(t.request.settings.timeoutMs, 45000);
  const g = C.parseCurl("curl -G https://api.example.com/search -d 'q=api' -d 'n=5'");
  assert.strictEqual(g.request.method, 'GET');
  assert.deepStrictEqual(
    g.request.query.map((q) => [q.key, q.value]),
    [['q', 'api'], ['n', '5']]
  );
});

test('parses -F text fields and warns on files', () => {
  const { request: r, warnings } = C.parseCurl(`curl -F 'name=Ada' -F 'file=@/tmp/x.png' https://api.example.com/upload`);
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.body.mode, 'formdata');
  assert.deepStrictEqual(r.body.formdata.map((f) => [f.key, f.value]), [['name', 'Ada']]);
  assert.ok(warnings.some((w) => w.includes('-F')));
});

test('parses URL with existing query string', () => {
  const { request: r } = C.parseCurl('curl "https://api.example.com/v1/items?limit=10&sort=asc"');
  assert.strictEqual(r.url, 'https://api.example.com/v1/items');
  assert.deepStrictEqual(
    r.query.map((q) => [q.key, q.value]),
    [['limit', '10'], ['sort', 'asc']]
  );
});

test('ignores proxy/verbose flags with warnings', () => {
  const { warnings } = C.parseCurl('curl -v --compressed -k --proxy http://127.0.0.1:9 -x http://127.0.0.1:9 https://x.test/');
  assert.ok(warnings.length >= 1);
});

test('requestToCurl round-trips a JSON POST', () => {
  const req = {
    name: 'Create',
    method: 'POST',
    url: 'https://api.example.com/users',
    query: [{ key: 'v', value: '2', enabled: true }],
    headers: [
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Custom', value: 'a b', enabled: true },
      { key: 'Disabled', value: 'x', enabled: false },
    ],
    auth: { type: 'none' },
    body: { mode: 'raw', raw: '{"a":1}', rawLang: 'json', urlencoded: [], formdata: [], graphql: {}, soap: {} },
    settings: { timeoutMs: 30000, redirect: 'follow' },
  };
  const cmd = C.requestToCurl(req);
  assert.ok(cmd.startsWith('curl'), cmd);
  assert.ok(cmd.includes('-X POST'), cmd);
  assert.ok(cmd.includes('https://api.example.com/users?v=2'), cmd);
  assert.ok(cmd.includes('-L'), cmd);
  assert.ok(cmd.includes('-H \'X-Custom: a b\''), cmd);
  assert.ok(cmd.includes('--data \'{"a":1}\''), cmd);
  assert.ok(!cmd.includes('Disabled'), cmd);
  const parsed = C.parseCurl(cmd);
  assert.strictEqual(parsed.request.method, 'POST');
  assert.strictEqual(parsed.request.url, 'https://api.example.com/users');
  const pq = Object.fromEntries(parsed.request.query.map((q) => [q.key, q.value]));
  assert.strictEqual(pq.v, '2');
});

test('requestToCurl exports HEAD, basic auth, timeout, urlencoded, apikey note', () => {
  const head = C.requestToCurl({ method: 'HEAD', url: 'https://x.test/', headers: [], body: { mode: 'none' }, auth: null, query: [], settings: {} });
  assert.ok(head.includes('-I'), head);
  const basic = C.requestToCurl({ method: 'GET', url: 'https://x.test/', headers: [], body: { mode: 'none' }, auth: { type: 'basic', username: 'u', password: 'p' }, query: [], settings: { timeoutMs: 45000, redirect: 'none' } });
  assert.ok(basic.includes("-u 'u:p'"), basic);
  assert.ok(basic.includes('--max-time 45'), basic);
  assert.ok(!basic.includes('-L'), basic);
  const ue = C.requestToCurl({
    method: 'POST',
    url: 'https://x.test/a',
    headers: [],
    body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1', enabled: true }, { key: 'b', value: 'x y', enabled: true }], raw: '', rawLang: 'text', formdata: [], graphql: {}, soap: {} },
    auth: { type: 'apikey', key: 'X-K', value: 'v', in: 'header' },
    query: [],
    settings: {},
  });
  assert.ok(ue.includes('--data \'a=1&b=x%20y\''), ue);
  assert.ok(ue.includes("-H 'X-K: v'"), ue);
  const adv = C.requestToCurl({ method: 'GET', url: 'https://x.test/', headers: [], body: { mode: 'none' }, auth: { type: 'aws4' }, query: [], settings: {} });
  assert.ok(adv.includes('# Authorization: aws4'), adv);
});

test('urlWithQuery joins query params', () => {
  assert.strictEqual(C.urlWithQuery({ url: 'https://x.test/a', query: [{ key: 'b', value: 'c d', enabled: true }, { key: 'off', value: '1', enabled: false }] }), 'https://x.test/a?b=c%20d');
  assert.strictEqual(C.urlWithQuery({ url: 'https://x.test/a', query: [] }), 'https://x.test/a');
});
