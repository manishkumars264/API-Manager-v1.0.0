'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../shared/pmsubset.js');

function makeCtx(overrides) {
  const env = new Map([['base', 'https://api.example.com'], ['token', 't0']]);
  const glob = new Map([['org', 'acme']]);
  const req = new Map([['base', 'https://request.example.com']]);
  const changes = [];
  const ctx = {
    scopes: { env, glob, req, changes },
    resolve: (name) => {
      if (req.has(name)) return req.get(name);
      if (env.has(name)) return env.get(name);
      if (glob.has(name)) return glob.get(name);
      return null;
    },
    getVariable: (scope, name) => {
      const m = scope === 'environment' ? env : scope === 'globals' ? glob : req;
      return m.has(name) ? m.get(name) : undefined;
    },
    setVariable: (scope, name, value) => {
      const m = scope === 'environment' ? env : scope === 'globals' ? glob : req;
      m.set(name, value);
      changes.push({ scope, name, value });
    },
    unsetVariable: (scope, name) => {
      const m = scope === 'environment' ? env : scope === 'globals' ? glob : req;
      if (m.delete(name)) changes.push({ scope, name, value: null });
    },
    request: { method: 'GET', url: 'https://api.example.com/v1', headers: [['Content-Type', 'application/json'], ['X-Req', 'abc']], body: '{"a":1}' },
    response: {
      code: 200,
      reason: 'OK',
      headers: [['content-type', 'application/json'], ['x-id', '42']],
      text: JSON.stringify({ ok: true, items: [1, 2, 3] }),
      time: 55,
      sizeBytes: 34,
    },
    onLog: null,
    onTest: null,
  };
  return Object.assign(ctx, overrides || {});
}

test('pm.variables / pm.environment / pm.globals get+set+unset', () => {
  const ctx = makeCtx();
  const { pm } = P.createPm(ctx);
  assert.strictEqual(pm.variables.get('base'), 'https://request.example.com'); // request scope wins
  assert.strictEqual(pm.variables.get('token'), 't0');
  assert.strictEqual(pm.variables.get('org'), 'acme');
  assert.strictEqual(pm.variables.get('missing'), undefined);
  pm.environment.set('k1', 'v1');
  assert.strictEqual(ctx.scopes.env.get('k1'), 'v1');
  pm.globals.set('k2', 'v2');
  assert.strictEqual(ctx.scopes.glob.get('k2'), 'v2');
  pm.environment.unset('token');
  assert.strictEqual(ctx.scopes.env.has('token'), false);
  const changes = ctx.scopes.changes.map((c) => [c.scope, c.name, c.value]);
  const hasChange = (scope, name, value) => changes.some((c) => c[0] === scope && c[1] === name && c[2] === value);
  assert.ok(hasChange('environment', 'k1', 'v1'));
  assert.ok(hasChange('globals', 'k2', 'v2'));
  assert.ok(hasChange('environment', 'token', null));
  assert.throws(() => pm.environment.set('', 'x'), /name required/);
});

test('pm.request helpers', () => {
  const { pm } = P.createPm(makeCtx());
  assert.strictEqual(pm.request.method, 'GET');
  assert.strictEqual(pm.request.url, 'https://api.example.com/v1');
  assert.strictEqual(pm.request.header('content-type'), 'application/json');
  assert.strictEqual(pm.request.header('Content-Type'), 'application/json'); // case-insensitive
  assert.strictEqual(pm.request.header('X-REQ'), 'abc');
  assert.strictEqual(pm.request.header('nope'), undefined);
  assert.strictEqual(pm.request.body, '{"a":1}');
  assert.strictEqual(pm.request.headers[1].key, 'X-Req');
});

test('pm.response helpers', () => {
  const { pm } = P.createPm(makeCtx());
  assert.strictEqual(pm.response.code, 200);
  assert.strictEqual(pm.response.status, 200);
  assert.strictEqual(pm.response.reason, 'OK');
  assert.strictEqual(pm.response.time, 55);
  assert.strictEqual(pm.response.sizeBytes, 34);
  assert.strictEqual(pm.response.header('x-id'), '42');
  assert.strictEqual(pm.response.text(), '{"ok":true,"items":[1,2,3]}');
  const j = pm.response.json();
  assert.strictEqual(j.ok, true);
  assert.deepStrictEqual(j.items, [1, 2, 3]);
});

test('pm.response.json() throws on non-JSON', () => {
  const ctx = makeCtx();
  ctx.response.text = 'not json';
  const { pm } = P.createPm(ctx);
  assert.throws(() => pm.response.json(), /not valid JSON/);
});

test('pm.test collects pass and fail with error messages', () => {
  const results = [];
  const ctx = makeCtx({ onTest: (t) => results.push(t) });
  const { pm, tests } = P.createPm(ctx);
  pm.test('truthy fn', () => true);
  pm.test('truthy condition', true);
  pm.test('falsy condition', false);
  pm.test('throwing fn', () => {
    throw new Error('boom');
  });
  assert.strictEqual(tests.length, 4);
  assert.strictEqual(results.length, 4);
  assert.deepStrictEqual(tests.map((t) => [t.name, t.pass]), [
    ['truthy fn', true],
    ['truthy condition', true],
    ['falsy condition', false],
    ['throwing fn', false],
  ]);
  assert.strictEqual(tests[2].error, 'Condition was false');
  assert.match(tests[3].error, /boom/);
});

test('pm.expect matchers', () => {
  const { pm } = P.createPm(makeCtx());
  const e = pm.expect;
  // equal / eql
  e(5).to.equal(5);
  e('x').to.be.equal('x');
  e({ a: [1, 2] }).to.eql({ a: [1, 2] });
  e([1, 2]).to.deep.eql([1, 2]);
  assert.throws(() => e(5).to.equal(6), AssertionErrorMsg);
  // numbers
  e(10).to.be.above(5);
  e(3).to.be.below(5);
  e(5).to.be.least(5).and.most(5);
  e(7).to.be.within(5, 10);
  // strings
  e('hello world').to.include('world');
  e('hello').to.have.lengthOf(5);
  e('abc').to.match(/^ab/);
  e('abc').to.startWith('ab').and.endWith('bc');
  e('abc').to.be.a('string');
  e('abc').to.be.a('string').that.include('b');
  // arrays / objects
  e([1, 2, 3]).to.include(2);
  e({ a: 1 }).to.have.keys('a');
  e({ a: 1, b: 2 }).to.have.keys(['a', 'b']);
  e({ a: 1 }).to.have.property('a', 1);
  e({ a: 1 }).to.be.an('object');
  e([]).to.be.empty();
  e('').to.be.empty();
  e({}).to.be.empty();
  // boolean / null
  e(true).to.be.true();
  e(false).to.be.false();
  e(null).to.be.null();
  e(undefined).to.be.undefined();
  e(1).to.be.ok();
  e(NaN).to.be.NaN();
  // negation
  e(5).to.not.equal(6);
  e('abc').to.not.include('z');
  e('abc').to.not.match(/z/);
  // oneOf, throw
  e('b').to.be.oneOf(['a', 'b', 'c']);
  e(() => {
    throw new TypeError('bad');
  }).to.throw(TypeError);
  e(() => {
    throw new Error('specific message');
  }).to.throw('specific');
  e(() => {}).to.not.throw();
  function AssertionErrorMsg(err) {
    assert.ok(err instanceof P.AssertionError || /expected/.test(err.message), err.message);
    return true;
  }
});

test('pm.expect chain order (chai-like): to.be.a', () => {
  const { pm } = P.createPm(makeCtx());
  pm.expect(42).to.be.a('number').and.be.above(0);
  pm.expect({ x: 1 }).to.be.an('object').with.property('x', 1);
  assert.throws(() => pm.expect(42).to.be.a('string'));
});

test('console output is captured with levels', () => {
  const logs = [];
  const ctx = makeCtx({ onLog: (args, level) => logs.push({ level: level || 'log', message: args.join(' ') }) });
  const { pm, console: con } = P.createPm(ctx);
  con.log('plain');
  con.info('info', { a: 1 });
  con.warn('careful');
  con.error('broken', new Error('x'));
  assert.strictEqual(logs.length, 4);
  assert.strictEqual(logs[0].message, 'plain');
  assert.strictEqual(logs[1].message, 'info {"a":1}');
  assert.strictEqual(logs[2].level, 'warn');
  assert.strictEqual(logs[3].level, 'error');
  assert.strictEqual(logs[3].message, 'broken x');
  void pm;
});

test('runScript executes a realistic test suite', async () => {
  const ctx = makeCtx();
  const script = [
    'pm.test("status 200", () => pm.expect(pm.response.code).to.equal(200));',
    'pm.test("has items", () => {',
    '  const data = pm.response.json();',
    '  pm.expect(data.items).to.have.lengthOf(3);',
    '});',
    'pm.test("bad assertion", () => pm.expect(pm.response.code).to.equal(404));',
    'pm.environment.set("seen", "true");',
    'pm.globals.set("hits", "1");',
    'console.log("done", pm.variables.get("base"));',
  ].join('\n');
  const res = await P.runScript(script, ctx, 5000);
  assert.strictEqual(res.error, null);
  assert.strictEqual(res.tests.length, 3);
  assert.strictEqual(res.tests[0].pass, true);
  assert.strictEqual(res.tests[1].pass, true);
  assert.strictEqual(res.tests[2].pass, false);
  assert.match(res.tests[2].error, /expected 200 to equal 404/);
  assert.strictEqual(ctx.scopes.env.get('seen'), 'true');
  assert.strictEqual(ctx.scopes.glob.get('hits'), '1');
  assert.ok(res.logs.some((l) => l.message.includes('done https://request.example.com')));
});

test('runScript reports script errors', async () => {
  const res = await P.runScript('pm.test("x", () => { throw new Error("kaboom"); })', makeCtx(), 5000);
  assert.strictEqual(res.error, null); // errors inside pm.test are captured, not fatal
  assert.strictEqual(res.tests[0].pass, false);
  const fatal = await P.runScript('undefinedFn();', makeCtx(), 5000);
  assert.match(fatal.error, /undefinedFn is not defined/);
});

test('runScript enforces the time limit', async () => {
  const t0 = Date.now();
  const res = await P.runScript('while (true) {}', makeCtx(), 150);
  assert.ok(res.timedOut, 'expected timeout, got: ' + res.error);
  assert.ok(Date.now() - t0 < 5000);
});

test('pm available for pre-request stage without response', async () => {
  const ctx = makeCtx();
  ctx.response = null;
  const res = await P.runScript('pm.environment.set("pre", "1"); pm.test("req url", () => pm.expect(pm.request.url).to.include("/v1"));', ctx, 5000);
  assert.strictEqual(res.error, null);
  assert.strictEqual(ctx.scopes.env.get('pre'), '1');
  assert.strictEqual(res.tests[0].pass, true);
});
