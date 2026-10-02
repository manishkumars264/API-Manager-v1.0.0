'use strict';
/*
 * API Manager - shared variable engine.
 * Works in Node (main process + tests) and in the browser renderer/worker.
 * UMD: exposes as module.exports in Node, as window.APIManager.variables in the browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.APIManager = root.APIManager || {};
  root.APIManager.variables = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  function uuidv4() {
    const c = typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : null;
    const b = c
      ? new Uint8Array(16)
      : new Uint8Array(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)));
    if (c) c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function parseNum(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  const DYNAMIC = {
    timestamp: () => String(Date.now()),
    isoTimestamp: () => new Date().toISOString(),
    guid: () => uuidv4(),
    uuid: () => uuidv4(),
    randomInt: (min, max) => {
      const a = parseNum(min, 0);
      const b = parseNum(max, 1000);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return String(Math.floor(lo + Math.random() * (hi - lo + 1)));
    },
    randomFloat: (min, max) => {
      const a = parseNum(min, 0);
      const b = parseNum(max, 1);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return String(lo + Math.random() * (hi - lo));
    },
    randomBoolean: () => (Math.random() < 0.5 ? 'true' : 'false'),
    randomString: (len) => {
      const n = Math.max(1, Math.min(128, Math.floor(parseNum(len, 16))));
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let out = '';
      for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
      return out;
    },
    randomHex: (len) => {
      const n = Math.max(1, Math.min(128, Math.floor(parseNum(len, 16))));
      let out = '';
      for (let i = 0; i < n; i++) out += '0123456789abcdef'[Math.floor(Math.random() * 16)];
      return out;
    },
  };

  const VAR_RE = /\{\{\s*([\w.$-]+)(?:\(([^)]*)\))?\s*\}\}/g;

  /**
   * Expand {{variable}} and {{$dynamic}} placeholders.
   * @param {string} input
   * @param {(name:string)=>(string|null|undefined)} resolve variable resolver
   * @returns {string}
   */
  function expandString(input, resolve) {
    if (typeof input !== 'string' || input.indexOf('{{') === -1) return input;
    let out = input;
    for (let pass = 0; pass < 3 && out.indexOf('{{') !== -1; pass++) {
      const next = out.replace(VAR_RE, (match, name, argsStr) => {
        if (name[0] === '$') {
          const fn = DYNAMIC[name.slice(1)];
          if (!fn) return match;
          const args = argsStr !== undefined && argsStr !== null ? argsStr.split(',').map((s) => s.trim()) : [];
          try {
            return String(fn.apply(null, args));
          } catch (e) {
            return match;
          }
        }
        const v = resolve ? resolve(name) : null;
        return v === null || v === undefined ? match : String(v);
      });
      if (next === out) break;
      out = next;
    }
    return out;
  }

  function toMap(values) {
    const m = new Map();
    for (const v of values || []) {
      if (!v || v.enabled === false) continue;
      if (v.key === '' || v.key === null || v.key === undefined) continue;
      m.set(String(v.key), v.value === null || v.value === undefined ? '' : String(v.value));
    }
    return m;
  }

  /**
   * Precedence (highest wins): request variables > environment variables > globals.
   */
  function buildResolver(sources) {
    const req = toMap(sources.requestVariables);
    const env = toMap(sources.environmentVariables);
    const glob = toMap(sources.globalVariables);
    return (name) => {
      if (req.has(name)) return req.get(name);
      if (env.has(name)) return env.get(name);
      if (glob.has(name)) return glob.get(name);
      return null;
    };
  }

  /** List all resolvable variables with their winning source. */
  function listVariables(sources) {
    const seen = new Map();
    const ordered = [
      ['request', sources.requestVariables],
      ['environment', sources.environmentVariables],
      ['globals', sources.globalVariables],
    ];
    const out = [];
    for (const [source, values] of ordered) {
      for (const v of values || []) {
        if (!v || v.key === '' || v.key === null || v.key === undefined) continue;
        const key = String(v.key);
        const enabled = v.enabled !== false;
        const existing = seen.get(key);
        if (!existing) {
          seen.set(key, { key, value: v.value === null || v.value === undefined ? '' : String(v.value), enabled, source });
        } else if (!existing.enabled && enabled) {
          // higher-priority entry was disabled → this source actually wins
          existing.enabled = true;
          existing.source = source;
          existing.value = v.value === null || v.value === undefined ? '' : String(v.value);
        }
      }
    }
    for (const item of seen.values()) out.push(item);
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  }

  /** Expand a full string field of a request (url, header values, body, ...). */
  function expandRequestField(field, resolve) {
    return typeof field === 'string' ? expandString(field, resolve) : field;
  }

  return { DYNAMIC, VAR_RE, expandString, expandRequestField, buildResolver, toMap, listVariables, uuidv4 };
});
