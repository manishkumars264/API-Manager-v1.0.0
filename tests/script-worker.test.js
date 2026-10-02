'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function workerSource() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const match = source.match(/function workerScriptSource\(\)\s*\{\s*return `([\s\S]*?)`;\s*\}/);
  assert.ok(match, 'worker source template should exist');
  return Function(`return \`${match[1]}\``)();
}

function executeScript(code, context) {
  return new Promise((resolve, reject) => {
    const workerScope = { postMessage: resolve };
    try {
      new Function('self', workerSource())(workerScope);
      workerScope.onmessage({ data: { code, context } });
    } catch (error) { reject(error); }
  });
}

test('Postman-style worker exposes local variables, request helpers, response and tests', async () => {
  const result = await executeScript(`
    pm.environment.set('token', 'abc123');
    pm.request.headers.upsert({ key: 'X-Added', value: 'pre-request' });
    console.log('request prepared');
    pm.test('response status', () => pm.response.to.have.status(201));
    pm.test('response JSON', () => pm.expect(pm.response.json()).to.have.property('id'));
  `, {
    environment: { baseUrl: 'https://api.example.test' }, globals: {}, collectionVariables: {},
    request: { method: 'GET', url: 'https://api.example.test', headers: [] },
    response: { status: 201, statusText: 'Created', duration: 5, body: '{"id":42}', headers: { 'content-type': 'application/json' } }
  });
  assert.equal(result.error, '');
  assert.equal(result.environment.token, 'abc123');
  assert.equal(result.request.headers[0].key, 'X-Added');
  assert.deepEqual(result.tests.map(item => item.passed), [true, true]);
  assert.match(result.logs[0].message, /request prepared/);
});

test('Postman-style worker reports failing assertions without failing the worker', async () => {
  const result = await executeScript(`pm.test('expected status', () => pm.response.to.have.status(200));`, {
    response: { status: 404, body: 'not found' }
  });
  assert.equal(result.error, '');
  assert.equal(result.tests.length, 1);
  assert.equal(result.tests[0].passed, false);
  assert.match(result.tests[0].error, /Expected HTTP status 200, received 404/);
});
