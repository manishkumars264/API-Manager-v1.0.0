'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Codegen = require('../codegen');

const request = {
  method: 'POST', url: 'https://api.example.test/v1/items',
  params: [{ key: 'tag', value: 'new item', enabled: true }],
  headers: [{ key: 'X-Client', value: 'API Manager', enabled: true }],
  auth: { type: 'bearer', token: 'local-token' },
  body: { mode: 'raw', language: 'json', raw: '{"created":true}' }
};

test('generates syntactically separated cURL, Python, JavaScript, Java and CLI snippets', () => {
  const curl = Codegen.generateCode(request, 'curl');
  assert.match(curl, /^curl --request POST/);
  assert.match(curl, /Authorization: Bearer local-token/);
  assert.match(curl, /Content-Type: application\/json/);
  assert.match(curl, /tag=new\+item/);
  for (const language of ['javascript', 'python', 'java', 'postman']) {
    const code = Codegen.generateCode(request, language, { collectionName: 'Example APIs', environmentName: 'Development' });
    assert.ok(code.includes('\n'), `${language} snippet should contain real line breaks`);
    assert.equal(code.includes('\\n'), false, `${language} snippet should not contain escaped line-break text`);
  }
  assert.match(Codegen.generateCode(request, 'python'), /requests\.request/);
  assert.match(Codegen.generateCode(request, 'javascript'), /fetch\(url, options\)/);
  assert.match(Codegen.generateCode(request, 'java'), /HttpClient\.newHttpClient/);
  assert.match(Codegen.generateCode(request, 'postman', { collectionName: 'Example APIs', environmentName: 'Development' }), /postman collection run "Example APIs" --environment "Development"/);
});

test('generated snippets carry multipart bodies with matching boundaries and CRLFs', () => {
  const form = {
    ...request, body: { mode: 'formdata', params: [{ key: 'name', value: 'API Manager', enabled: true }] },
    auth: { type: 'none' }, headers: []
  };
  const javascript = Codegen.generateCode(form, 'javascript');
  assert.match(javascript, /multipart\/form-data; boundary=----APIManagerCodegenBoundary/);
  const payload = Codegen.bodyData(form);
  const crlf = String.fromCharCode(13, 10);
  assert.ok(payload.includes(`${crlf}Content-Disposition: form-data; name="name"${crlf}${crlf}API Manager${crlf}`));
  assert.ok(javascript.includes(JSON.stringify(payload).slice(1, -1)));
});

test('generates a request using inherited collection authorization', () => {
  const inherited = { ...request, auth: { type: 'inherit' } };
  const code = Codegen.generateCode(inherited, 'curl', { collectionAuth: { type: 'bearer', token: 'collection-token' } });
  assert.match(code, /Authorization: Bearer collection-token/);
});
