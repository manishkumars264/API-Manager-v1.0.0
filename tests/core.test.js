'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core');

const sampleCurl = `curl --request POST 'https://api.example.test/v1/widgets?limit=3&tag=local' \\\n  --header 'Content-Type: application/json' \\\n  --header 'X-Trace: hello world' \\\n  --data-raw '{"name":"widget"}'`;

test('imports common cURL options and preserves request components', () => {
  const request = Core.parseCurl(sampleCurl);
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://api.example.test/v1/widgets');
  assert.deepEqual(request.params.map(item => [item.key, item.value]), [['limit', '3'], ['tag', 'local']]);
  assert.equal(request.headers.find(item => item.key === 'X-Trace').value, 'hello world');
  assert.equal(request.body.raw, '{"name":"widget"}');
  assert.equal(request.body.mode, 'raw');
});

test('imports cURL basic auth, GET data, cookies and HEAD', () => {
  const basic = Core.parseCurl("curl -u 'alice:p@ss:word' https://api.example.test/private");
  assert.deepEqual(basic.auth, { type: 'basic', username: 'alice', password: 'p@ss:word' });
  const get = Core.parseCurl("curl -G https://api.example.test/search --data-urlencode 'q=two words'");
  assert.equal(get.method, 'GET');
  assert.equal(Core.formatUrl(get.url, get.params), 'https://api.example.test/search?q=two+words');
  const head = Core.parseCurl('curl -I https://api.example.test/health');
  assert.equal(head.method, 'HEAD');
  const cookie = Core.parseCurl("curl https://api.example.test/ -b 'session=abc'");
  assert.equal(cookie.headers.find(item => item.key === 'Cookie').value, 'session=abc');
  const form = Core.parseCurl("curl -F 'name=API Manager' https://api.example.test/upload");
  assert.equal(form.body.mode, 'formdata');
  assert.deepEqual(form.body.params.map(item => [item.key, item.value]), [['name', 'API Manager']]);
});

test('exports cURL with encoded query, headers, body, and authorization', () => {
  const request = {
    method: 'POST', url: 'https://api.example.test/items',
    params: [{ key: 'q', value: 'two words', enabled: true }],
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    auth: { type: 'bearer', token: 'secret-token' },
    body: { mode: 'raw', raw: '{"ok":true}' }
  };
  const curl = Core.toCurl(request);
  assert.match(curl, /^curl --request POST/);
  assert.match(curl, /q=two\+words/);
  assert.match(curl, /Authorization: Bearer secret-token/);
  assert.match(curl, /--data-raw/);
  const oauthCurl = Core.toCurl({ ...request, auth: { type: 'oauth2', accessToken: 'oauth-token', tokenPrefix: '' } });
  assert.match(oauthCurl, /Authorization: oauth-token/);
  assert.doesNotMatch(oauthCurl, /Authorization: Bearer oauth-token/);
});

test('Postman collection import/export preserves folders, scripts and request data', () => {
  const source = {
    info: { name: 'Example', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Users', item: [{ name: 'List users', request: { method: 'GET', url: { raw: 'https://api.example.test/users?active=true' }, header: [{ key: 'Accept', value: 'application/json' }] }, event: [{ listen: 'prerequest', script: { exec: ['pm.environment.set("ready", "yes");'] } }, { listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200));'] } }] }] }],
    variable: [{ key: 'baseUrl', value: 'https://api.example.test' }]
  };
  const imported = Core.fromPostmanCollection(source);
  assert.equal(imported.name, 'Example');
  assert.equal(imported.items[0].items[0].request.method, 'GET');
  assert.equal(imported.items[0].items[0].request.preScript, 'pm.environment.set("ready", "yes");');
  assert.equal(imported.items[0].items[0].request.postScript, 'pm.test("ok", () => pm.response.to.have.status(200));');
  const exported = Core.toPostmanCollection(imported);
  assert.equal(exported.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
  assert.equal(exported.item[0].item[0].request.url.raw, 'https://api.example.test/users?active=true');
  assert.equal(exported.item[0].item[0].event[0].listen, 'prerequest');
});

test('Postman environment import supports values and global scopes', () => {
  const environment = Core.fromPostmanEnvironment({ name: 'Local', values: [{ key: 'baseUrl', value: 'http://localhost', enabled: true }] });
  assert.equal(environment.name, 'Local');
  assert.deepEqual(environment.values.map(item => item.key), ['baseUrl']);
});

test('dynamic variables and environment/global precedence resolve locally', () => {
  const resolver = Core.createVariableResolver({ baseUrl: 'https://dev.example.test', shared: 'environment' }, { shared: 'global', owner: 'API Manager' });
  assert.equal(resolver('{{baseUrl}}/{{shared}}/{{owner}}'), 'https://dev.example.test/environment/API Manager');
  assert.match(resolver('{{$timestamp}}'), /^\d+$/);
  assert.match(resolver('{{$guid}}'), /^[0-9a-f-]{36}$/i);
  assert.equal(resolver('{{notDefined}}'), '{{notDefined}}');
});

test('Postman URL variables remain intact while query parameters are extracted', () => {
  const parsed = Core.parseQuery('{{baseUrl}}/v1/users?active=true&tag=one#ignored-fragment');
  assert.equal(parsed.base, '{{baseUrl}}/v1/users');
  assert.deepEqual(parsed.params.map(item => [item.key, item.value]), [['active', 'true'], ['tag', 'one']]);
});

test('query params are encoded without losing duplicate keys', () => {
  const request = Core.parseCurl("curl 'https://api.example.test/?x=1&x=2'");
  assert.equal(Core.formatUrl(request.url, request.params), 'https://api.example.test/?x=1&x=2');
});
