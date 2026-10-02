'use strict';
/*
 * API Manager - documented subset of the Postman `pm` API.
 *
 * Runs inside a time-limited Web Worker in the desktop app (isolated from the UI)
 * and inside a Node `vm` sandbox in tests. Pure JS - no Node APIs, no DOM.
 *
 * Supported:
 *   pm.variables.get / set / unset      (set/unset write to the active environment)
 *   pm.environment.get / set / unset
 *   pm.globals.get / set / unset
 *   pm.request.{method,url,header,headers,body}
 *   pm.response.{code,status,reason,headers,header,text(),json(),time,sizeBytes,body}
 *   pm.test(name, fnOrCondition)
 *   pm.expect(...) with a chai-like matcher subset (see below)
 *   console.log/info/warn/error
 *
 * NOT supported: pm.sendRequest, pm.cookie, pm.collection*, pm.history, pm.iteration*,
 * require(), fetch/XHR, Node globals. Variable changes are persisted by the host
 * (request scope is read-only; environment and globals changes are saved).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.APIManager = root.APIManager || {};
  root.APIManager.pmSubset = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  class AssertionError extends Error {
    constructor(message) {
      super(message);
      this.name = 'AssertionError';
    }
  }

  function isObject(v) {
    return v !== null && typeof v === 'object';
  }
  function deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (!isObject(a) || !isObject(b)) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  function includesString(haystack, needle) {
    return typeof haystack === 'string' && typeof needle === 'string' && haystack.includes(needle);
  }
  function includesArray(arr, el) {
    return Array.isArray(arr) && arr.includes(el);
  }
  function includesObject(obj, key) {
    return isObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
  }
  function stringIncludes(haystack, needle) {
    return typeof haystack === 'string' && typeof needle === 'string' && haystack.includes(needle);
  }
  function stringMatches(haystack, needle) {
    if (typeof haystack !== 'string') return false;
    if (typeof needle === 'string') return haystack.includes(needle);
    if (needle instanceof RegExp) return needle.test(haystack);
    return false;
  }
  function stringStartsWith(str, prefix) {
    return typeof str === 'string' && str.startsWith(prefix);
  }
  function stringEndsWith(str, suffix) {
    return typeof str === 'string' && str.endsWith(suffix);
  }
  function keysOf(obj) {
    return isObject(obj) ? Object.keys(obj) : [];
  }

  /**
   * Build the pm API object.
   * ctx = {
   *   resolve(name): string|null,          // variable lookup (request > env > globals)
   *   getVariable(scope, name): string|undefined,
   *   setVariable(scope, name, value),     // host applies + records
   *   unsetVariable(scope, name),
   *   request: {method, url, headers:[[k,v]], body},
   *   response: {code, reason, headers:[[k,v]], text, time, sizeBytes} | null,
   *   onLog(args: string[]),
   *   onTest(test),                        // collects pm.test results
   * }
   */
  function createPm(ctx) {
    const req = ctx.request || { method: 'GET', url: '', headers: [], body: '' };
    const res = ctx.response || null;

    function findHeader(list, name) {
      for (const h of list || []) {
        const k = Array.isArray(h) ? h[0] : h.key;
        if (String(k).toLowerCase() === String(name).toLowerCase()) return Array.isArray(h) ? h[1] : h.value;
      }
      return undefined;
    }

    const pm = {};

    // --- variables ---
    pm.variables = {
      get: (name) => {
        const v = ctx.resolve ? ctx.resolve(name) : undefined;
        return v === null ? undefined : v;
      },
      set: (name, value) => {
        if (typeof name !== 'string' || !name) throw new Error('pm.variables.set: name required');
        ctx.setVariable('environment', name, value === null || value === undefined ? '' : String(value));
      },
      unset: (name) => ctx.unsetVariable('environment', name),
    };
    const requireName = (fn, name) => {
      if (typeof name !== 'string' || !name) throw new Error(fn + ': name required');
    };
    pm.environment = {
      get: (name) => (ctx.getVariable ? ctx.getVariable('environment', name) : undefined),
      set: (name, value) => {
        requireName('pm.environment.set', name);
        ctx.setVariable('environment', name, value === null || value === undefined ? '' : String(value));
      },
      unset: (name) => ctx.unsetVariable('environment', name),
    };
    pm.globals = {
      get: (name) => (ctx.getVariable ? ctx.getVariable('globals', name) : undefined),
      set: (name, value) => {
        requireName('pm.globals.set', name);
        ctx.setVariable('globals', name, value === null || value === undefined ? '' : String(value));
      },
      unset: (name) => ctx.unsetVariable('globals', name),
    };

    // --- request ---
    const headersArr = (req.headers || []).map((h) => (Array.isArray(h) ? { key: h[0], value: h[1] } : { key: h.key, value: h.value }));
    pm.request = {
      method: req.method || 'GET',
      url: req.url || '',
      body: req.body || '',
      headers: headersArr,
      header: (name) => findHeader(req.headers, name),
      get: (o) => {
        o = o || {};
        return {
          method: o.method || pm.request.method,
          url: o.url || pm.request.url,
          body: o.body !== undefined ? o.body : pm.request.body,
          header: (name) => findHeader(o.headers || req.headers, name),
        };
      },
    };

    // --- response ---
    const response = {
      code: res ? res.code : undefined,
      status: res ? res.code : undefined,
      reason: res ? res.reason : undefined,
      time: res ? res.time : undefined,
      sizeBytes: res ? res.sizeBytes : undefined,
      body: res ? res.text : '',
      headers: (res ? res.headers : []).map((h) => (Array.isArray(h) ? { key: h[0], value: h[1] } : { key: h.key, value: h.value })),
      header: (name) => findHeader(res ? res.headers : [], name),
      text: () => (res ? res.text : ''),
      json: () => {
        if (!res) throw new Error('No response available');
        try {
          return JSON.parse(res.text);
        } catch (e) {
          throw new Error('pm.response.json(): response body is not valid JSON');
        }
      },
    };
    pm.response = response;

    // --- tests ---
    const tests = [];
    pm.test = (name, fn) => {
      const result = { name: String(name), pass: false, error: null };
      try {
        if (typeof fn === 'function') {
          fn();
          result.pass = true;
        } else {
          result.pass = !!fn;
          if (!result.pass) result.error = 'Condition was false';
        }
      } catch (e) {
        result.pass = false;
        result.error = (e && e.message) || String(e);
      }
      tests.push(result);
      if (ctx.onTest) ctx.onTest(result);
    };
    pm.tests = tests;

    // --- expect (chai-like subset) ---
    pm.expect = function expect(actual) {
      const state = {
        actual,
        negated: false,
        deep: false,
        message: '',
        chain: function (next) {
          return next || state;
        },
      };

      function check(pass, label) {
        const ok = state.negated ? !pass : pass;
        if (!ok) {
          const msg = state.negated ? 'expected ' + show(actual) + ' NOT ' + label : 'expected ' + show(actual) + ' ' + label;
          throw new AssertionError(msg);
        }
        return state;
      }

      function show(v) {
        try {
          if (typeof v === 'string') return JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v);
          if (typeof v === 'function') return 'Function';
          return String(v);
        } catch (e) {
          return String(v);
        }
      }

      const chainers = ['to', 'be', 'been', 'is', 'and', 'has', 'have', 'that', 'which', 'was', 'were', 'will', 'should', 'does', 'still', 'same'];
      const matchers = {
        equal: (e) => check(deepEqual(state.actual, e) || state.actual === e, 'to equal ' + show(e)),
        eql: (e) => check(deepEqual(state.actual, e), 'to deeply equal ' + show(e)),
        equals: (e) => check(state.actual === e || deepEqual(state.actual, e), 'to equal ' + show(e)),
        above: (e) => check(typeof state.actual === 'number' && state.actual > e, 'to be above ' + e),
        below: (e) => check(typeof state.actual === 'number' && state.actual < e, 'to be below ' + e),
        least: (e) => check(typeof state.actual === 'number' && state.actual >= e, 'to be at least ' + e),
        most: (e) => check(typeof state.actual === 'number' && state.actual <= e, 'to be at most ' + e),
        within: (a, b) => check(typeof state.actual === 'number' && state.actual >= Math.min(a, b) && state.actual <= Math.max(a, b), 'to be within ' + a + '..' + b),
        length: (e) => check(state.actual != null && state.actual.length === e, 'to have length ' + e),
        lengthOf: (e) => check(state.actual != null && state.actual.length === e, 'to have length ' + e),
        include: (e) => check(stringIncludes(state.actual, e) || includesArray(state.actual, e) || includesObject(state.actual, e), 'to include ' + show(e)),
        includes: (e) => check(stringIncludes(state.actual, e) || includesArray(state.actual, e) || includesObject(state.actual, e), 'to include ' + show(e)),
        contain: (e) => check(stringIncludes(state.actual, e) || includesArray(state.actual, e) || includesObject(state.actual, e), 'to contain ' + show(e)),
        oneOf: (list) => check(Array.isArray(list) && list.includes(state.actual), 'to be one of ' + JSON.stringify(list)),
        string: (s) => check(typeof state.actual === 'string' && (s === undefined || stringIncludes(state.actual, s)), s === undefined ? 'to be a string' : 'to be a string including ' + show(s)),
        keys: (k) => {
          const ks = keysOf(state.actual);
          if (Array.isArray(k)) return check(ks.length === k.length && k.every((x) => ks.includes(x)), 'to have keys ' + JSON.stringify(k));
          return check(ks.includes(k), 'to have key ' + show(k));
        },
        property: (k, v) => {
          if (!isObject(state.actual)) return check(false, 'to have property ' + show(k));
          const has = Object.prototype.hasOwnProperty.call(state.actual, k);
          if (v === undefined) return check(has, 'to have property ' + show(k));
          return check(has && deepEqual(state.actual[k], v), 'to have property ' + show(k) + ' equal to ' + show(v));
        },
        a: (t) => check(typeCheck(state.actual, t), 'to be a ' + t),
        an: (t) => check(typeCheck(state.actual, t), 'to be an ' + t),
        instanceof: (C) => check(state.actual instanceof C, 'to be an instance of ' + (C && C.name)),
        ok: () => check(!!state.actual, 'to be truthy'),
        true: () => check(state.actual === true, 'to be true'),
        false: () => check(state.actual === false, 'to be false'),
        null: () => check(state.actual === null, 'to be null'),
        undefined: () => check(state.actual === undefined, 'to be undefined'),
        NaN: () => check(Number.isNaN(state.actual), 'to be NaN'),
        empty: () => check((typeof state.actual === 'string' || Array.isArray(state.actual)) ? state.actual.length === 0 : isObject(state.actual) ? Object.keys(state.actual).length === 0 : !!state.actual, 'to be empty'),
        match: (re) => check(stringMatches(state.actual, re), 'to match ' + (re instanceof RegExp ? re : show(re))),
        matches: (re) => check(stringMatches(state.actual, re), 'to match ' + (re instanceof RegExp ? re : show(re))),
        startsWith: (s) => check(stringStartsWith(state.actual, s), 'to start with ' + show(s)),
        startWith: (s) => check(stringStartsWith(state.actual, s), 'to start with ' + show(s)),
        endsWith: (s) => check(stringEndsWith(state.actual, s), 'to end with ' + show(s)),
        endWith: (s) => check(stringEndsWith(state.actual, s), 'to end with ' + show(s)),
        throw: function (expected) {
          const fn = state.actual;
          expected = expected === undefined ? undefined : expected;
          if (typeof fn !== 'function') return check(false, 'to be a function that throws');
          let threw = null;
          try {
            fn();
          } catch (e) {
            threw = e;
          }
          if (expected === undefined) return check(!!threw, 'to throw an error');
          if (threw === null) return check(false, 'to throw an error');
          const msg = threw && threw.message ? threw.message : String(threw);
          if (typeof expected === 'string') return check(msg.includes(expected), 'to throw an error including ' + show(expected));
          return check(threw instanceof expected, 'to throw an instance of ' + (expected.name || 'constructor'));
        },
        throwError: null,
      };

      function typeCheck(v, t) {
        switch (t) {
          case 'string':
            return typeof v === 'string';
          case 'number':
            return typeof v === 'number';
          case 'boolean':
            return typeof v === 'boolean';
          case 'function':
            return typeof v === 'function';
          case 'object':
            return isObject(v) || typeof v === 'function';
          case 'array':
            return Array.isArray(v);
          case 'null':
            return v === null;
          case 'undefined':
            return v === undefined;
          case 'error':
            return v instanceof Error;
          case 'instanceof':
            return v !== null && typeof v === 'object';
          default:
            return true;
        }
      }

      function makeChain() {
        const obj = {};
        // Chai-style chainers are property accesses (expect(x).to.equal(y) and
        // expect(x).to.be.equal(y) both work), so they self-reference.
        for (const c of chainers) obj[c] = obj;
        Object.defineProperty(obj, 'not', { enumerable: false, configurable: true, get: () => { state.negated = true; return obj; } });
        Object.defineProperty(obj, 'no', { enumerable: false, configurable: true, get: () => { state.negated = true; return obj; } });
        Object.defineProperty(obj, 'deep', { enumerable: false, configurable: true, get: () => { state.deep = true; return obj; } });
        Object.defineProperty(obj, 'own', { enumerable: false, configurable: true, get: () => obj });
        for (const [name, fn] of Object.entries(matchers)) {
          if (!fn) continue;
          obj[name] = function (...args) {
            fn.apply(null, args);
            return obj;
          };
        }
        obj.throwError = obj.throw;
        return obj;
      }
      const finalObj = makeChain();
      const have = makeChain();
      finalObj.have = have;
      finalObj.with = have;
      return finalObj;
    };

    // --- console ---
    const consoleShim = {
      log: (...args) => ctx.onLog && ctx.onLog(args.map(stringifyArg)),
      info: (...args) => ctx.onLog && ctx.onLog(args.map(stringifyArg)),
      warn: (...args) => ctx.onLog && ctx.onLog(args.map(stringifyArg), 'warn'),
      error: (...args) => ctx.onLog && ctx.onLog(args.map(stringifyArg), 'error'),
    };

    function stringifyArg(a) {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch (e) {
        return String(a);
      }
    }

    pm.console = consoleShim;
    return { pm, console: consoleShim, tests };
  }

  /**
   * Run a script string with a timeout.
   * ctxShape: same ctx as createPm (optionally with {scopes: {env, glob, req}}
   * so variable changes can be synced back).
   * Returns {tests, logs, error, timedOut}.
   *
   * In Node the script runs in an isolated worker thread that the host
   * terminates after `timeoutMs` — the same isolation the desktop app gets
   * from its Web Worker (a synchronous `vm` timeout cannot interrupt a
   * tight infinite loop on the main thread). This path is async (Promise);
   * in the browser it runs synchronously in the current worker context,
   * where the host terminates the whole worker on its time budget.
   */
  function runScript(script, ctx, timeoutMs) {
    timeoutMs = timeoutMs || 5000;
    const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
    if (isNode) return runScriptIsolated(script, ctx, timeoutMs);
    const { pm, console: con, tests } = createPm(ctx);
    const logs = [];
    ctx.onLog = (args, level) => logs.push({ level: level || 'log', message: args.join(' ') });
    try {
      const fn = new Function('pm', 'console', 'tests', script || '');
      fn(pm, con, tests);
      return { tests: tests.slice(), logs, error: null, timedOut: false };
    } catch (e) {
      return { tests: tests.slice(), logs, error: (e && e.message) || String(e), timedOut: /timeout/i.test(String(e && e.message)) };
    }
  }

  const WORKER_HARNESS = [
    "const { parentPort, workerData } = require('worker_threads');",
    "const P = require(workerData.modulePath);",
    "const d = workerData;",
    "const maps = {",
    "  request: new Map(d.variables.request || []),",
    "  environment: new Map(d.variables.environment || []),",
    "  globals: new Map(d.variables.globals || []),",
    "};",
    "const logs = [];",
    "const changes = [];",
    "const ctx = {",
    "  resolve: (n) => maps.request.has(n) ? maps.request.get(n) : maps.environment.has(n) ? maps.environment.get(n) : maps.globals.has(n) ? maps.globals.get(n) : null,",
    "  getVariable: (scope, name) => (maps[scope === 'data' ? 'request' : scope] || {}).has ? maps[scope === 'data' ? 'request' : scope].get(name) : undefined,",
    "  setVariable: (scope, name, value) => { const m = maps[scope === 'data' ? 'request' : scope]; if (m) { m.set(name, value); changes.push({ scope, name, value }); } },",
    "  unsetVariable: (scope, name) => { const m = maps[scope === 'data' ? 'request' : scope]; if (m && m.delete(name)) changes.push({ scope, name, value: null }); },",
    "  request: d.request || null,",
    "  response: d.response || null,",
    "  onLog: (args, level) => logs.push({ level: level || 'log', message: args.join(' ') }),",
    "};",
    "let result;",
    "try {",
    "  const built = P.createPm(ctx);",
    "  const fn = new Function('pm', 'console', 'tests', '\"use strict\";\\n' + (d.script || ''));",
    "  fn(built.pm, built.console, built.tests);",
    "  result = { ok: true, tests: built.tests, logs, changes };",
    "} catch (e) {",
    "  result = { ok: false, error: (e && e.message) || String(e) };",
    "}",
    "parentPort.postMessage(result);",
  ].join('\n');

  function runScriptIsolated(script, ctx, timeoutMs) {
    const mapEntries = (m) => (m instanceof Map ? [...m.entries()] : []);
    const sc = (ctx && ctx.scopes) || {};
    const arrEntries = (vals) => (Array.isArray(vals) ? vals.filter((v) => v && v.key != null && v.key !== '' && v.enabled !== false).map((v) => [String(v.key), v.value == null ? '' : String(v.value)]) : []);
    const variables = {
      request: sc.req instanceof Map ? mapEntries(sc.req) : arrEntries(ctx && ctx.requestVariables),
      environment: sc.env instanceof Map ? mapEntries(sc.env) : arrEntries(ctx && ctx.environmentVariables),
      globals: sc.glob instanceof Map ? mapEntries(sc.glob) : arrEntries(ctx && ctx.globalVariables),
    };
    return new Promise((resolve) => {
      let worker;
      try {
        // eslint-disable-next-line global-require
        const { Worker } = require('worker_threads');
        worker = new Worker(WORKER_HARNESS, {
          eval: true,
          workerData: { modulePath: __filename, script: script || '', variables, request: ctx.request || null, response: ctx.response || null },
        });
      } catch (e) {
        resolve({ tests: [], logs: [], error: 'Could not start script worker: ' + e.message, timedOut: false });
        return;
      }
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { worker.terminate(); } catch (e) { /* already dead */ }
        resolve(r);
      };
      const timer = setTimeout(() => {
        finish({ tests: [], logs: [], error: 'Script timed out after ' + timeoutMs + ' ms', timedOut: true });
      }, timeoutMs);
      worker.on('message', (msg) => {
        if (msg && msg.ok) {
          // sync variable changes back into the caller's context
          const target = (scope) => {
            if (!sc) return null;
            if (scope === 'environment') return sc.env;
            if (scope === 'globals') return sc.glob;
            return sc.req;
          };
          for (const ch of msg.changes || []) {
            const m = target(ch.scope);
            if (m instanceof Map) {
              if (ch.value === null) m.delete(ch.name);
              else m.set(ch.name, ch.value);
              if (Array.isArray(sc.changes)) sc.changes.push(ch);
            }
          }
          finish({ tests: msg.tests || [], logs: msg.logs || [], error: null, timedOut: false });
        } else {
          finish({ tests: (msg && msg.tests) || [], logs: (msg && msg.logs) || [], error: (msg && msg.error) || 'Script failed', timedOut: false });
        }
      });
      worker.on('error', (e) => finish({ tests: [], logs: [], error: e.message, timedOut: false }));
    });
  }

  return { createPm, runScript, AssertionError, deepEqual };
});
