'use strict';
/*
 * API Manager - cURL import/export.
 * Pure JS (no Node dependencies) so it can run in the renderer, main, and tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.APIManager = root.APIManager || {};
  root.APIManager.curl = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  function tokenize(cmd) {
    cmd = String(cmd).replace(/\\\r?\n/g, ' ');
    const tokens = [];
    let cur = '';
    let quote = null;
    let esc = false;
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i];
      if (quote === "'") {
        if (c === "'") quote = null;
        else cur += c;
        continue;
      }
      if (quote === '"') {
        if (esc) {
          cur += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c;
          esc = false;
          continue;
        }
        if (c === '\\') {
          esc = true;
          continue;
        }
        if (c === '"') quote = null;
        else cur += c;
        continue;
      }
      if (c === "'") {
        quote = "'";
        continue;
      }
      if (c === '"') {
        quote = '"';
        continue;
      }
      if (c === '\\' && i + 1 < cmd.length) {
        cur += cmd[i + 1];
        i++;
        continue;
      }
      if (/\s/.test(c)) {
        if (cur) {
          tokens.push(cur);
          cur = '';
        }
        continue;
      }
      cur += c;
    }
    if (cur) tokens.push(cur);
    return tokens;
  }

  const IGNORED = new Set(['-s', '--silent', '-v', '--verbose', '-i', '--include', '-S', '--show-error', '--compressed', '-k', '--insecure', '--http1.1', '--http2', '--tlsv1.2', '--ssl', '-q']);

  function parseHeaderLine(value) {
    const idx = value.indexOf(':');
    if (idx === -1) return null;
    let key = value.slice(0, idx).trim();
    let val = value.slice(idx + 1).trim();
    // curl convention: "X-Forwarded-For:1.2.3.4" (no space) keeps first char in key
    return { key, value: val };
  }

  function looksLikeFormBody(body) {
    if (!body || /[\r\n]/.test(body)) return false;
    if (!body.includes('=')) return false;
    const parts = body.split('&');
    return parts.every((p) => {
      if (!p) return true;
      const eq = p.indexOf('=');
      return eq > 0 && /^[\w.\- ]+$/.test(decodeURIComponentSafe(p.slice(0, eq)));
    });
  }
  function decodeURIComponentSafe(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  /**
   * Parse a cURL command string into an API Manager request draft.
   * @returns {{request: object, warnings: string[]}}
   */
  function parseCurl(input) {
    const warnings = [];
    const tokens = tokenize(input);
    if (!tokens.length) throw new Error('Empty cURL command');
    let start = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (/(^|[/\\])curl$/.test(tokens[i]) && !tokens[i].includes('=')) {
        start = i + 1;
        break;
      }
    }
    const args = tokens.slice(start);

    const req = {
      name: 'Imported cURL',
      method: 'GET',
      url: '',
      query: [],
      headers: [],
      auth: null,
      body: { mode: 'none', raw: '', rawLang: 'text', urlencoded: [], formdata: [], graphql: { query: '', variables: '' }, soap: { version: '1.1', action: '', envelope: '' } },
      scripts: { pre: '', test: '' },
      variables: [],
      settings: { timeoutMs: 30000, redirect: 'follow' },
      description: 'Imported from cURL',
    };
    const headerList = [];
    const dataParts = [];
    let hasData = false;
    let method = null;
    let url = null;
    let gotFormdata = false;

    const getHeader = (k) => {
      for (let i = headerList.length - 1; i >= 0; i--) if (headerList[i].key.toLowerCase() === k) return headerList[i].value;
      return null;
    };

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const next = (v) => {
        const val = args[++i];
        if (val === undefined) throw new Error('Missing value for option ' + v);
        return val;
      };
      if (a === '-X' || a === '--request') {
        method = next(a).toUpperCase();
      } else if (a === '-H' || a === '--header') {
        const v = next(a).replace(/^HTTP\/\d\.\d[^\n]*\r?\n/, '');
        const parsed = parseHeaderLine(v);
        if (parsed) headerList.push(parsed);
        else warnings.push('Ignored malformed header: ' + v);
      } else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary' || a === '--data-urlencode') {
        if (a === '--data-urlencode') {
          const v = next(a);
          if (v.includes('=')) dataParts.push(v.split('=').slice(0, 1).join('=') + '=' + encodeURIComponent(v.split('=').slice(1).join('=')));
          else dataParts.push(encodeURIComponent(v));
        } else {
          dataParts.push(next(a));
        }
        hasData = true;
      } else if (a === '-F' || a === '--form') {
        const v = next(a);
        if (v.includes('=')) {
          const eq = v.indexOf('=');
          const val = v.slice(eq + 1);
          if (val.startsWith('@') || val.startsWith('<')) {
            // curl's file-upload syntax — this app's form-data is text-only
            warnings.push('Ignored -F file upload (text-only form data supported): ' + v);
          } else {
            req.body.formdata.push({ key: v.slice(0, eq), value: val, enabled: true, type: 'text' });
            gotFormdata = true;
          }
        } else {
          warnings.push('Ignored -F (file upload not supported by cURL import): ' + v);
        }
      } else if (a === '-u' || a === '--user') {
        const v = next(a);
        const idx = v.indexOf(':');
        req.auth = { type: 'basic', username: idx === -1 ? v : v.slice(0, idx), password: idx === -1 ? '' : v.slice(idx + 1) };
      } else if (a === '-b' || a === '--cookie') {
        headerList.push({ key: 'Cookie', value: next(a) });
      } else if (a === '-A' || a === '--user-agent') {
        headerList.push({ key: 'User-Agent', value: next(a) });
      } else if (a === '-e' || a === '--referer') {
        headerList.push({ key: 'Referer', value: next(a) });
      } else if (a === '--url') {
        url = next(a);
      } else if (a === '-G' || a === '--get') {
        req._useGetData = true;
      } else if (a === '-L' || a === '--location') {
        req.settings.redirect = 'follow';
      } else if (a === '--max-time' || a === '-m' || a === '--connect-timeout') {
        const n = parseFloat(next(a));
        if (Number.isFinite(n) && n > 0) req.settings.timeoutMs = Math.round(n * 1000);
      } else if (a === '-I' || a === '--head') {
        method = 'HEAD';
      } else if (a === '-x' || a === '--proxy' || a === '-E' || a === '--cert' || a === '--cacert' || a === '--capath' || a === '-U' || a === '--proxy-user') {
        next(a);
        warnings.push('Ignored option (not applicable in API Manager): ' + a);
      } else if (IGNORED.has(a)) {
        // no value
      } else if (a.startsWith('-')) {
        // option with attached value, e.g. --max-time=30
        const eq = a.indexOf('=');
        if (eq !== -1) {
          const opt = a.slice(0, eq);
          if (opt === '--max-time' || opt === '-m' || opt === '--connect-timeout') {
            const n = parseFloat(a.slice(eq + 1));
            if (Number.isFinite(n) && n > 0) req.settings.timeoutMs = Math.round(n * 1000);
          } else {
            warnings.push('Ignored option: ' + a);
          }
        } else {
          warnings.push('Ignored option: ' + a);
        }
      } else if (/^https?:\/\//i.test(a) && !url) {
        url = a;
      } else if (!url) {
        url = a;
      } else {
        warnings.push('Ignored positional argument: ' + a);
      }
    }

    if (!url) throw new Error('No URL found in cURL command');
    if (method) req.method = method;

    // Split URL into base + query
    const qIdx = url.indexOf('?');
    if (qIdx !== -1) {
      req.url = url.slice(0, qIdx);
      const qs = url.slice(qIdx + 1);
      for (const pair of qs.split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        req.query.push({ key: eq === -1 ? decodeURIComponentSafe(pair) : decodeURIComponentSafe(pair.slice(0, eq)), value: eq === -1 ? '' : decodeURIComponentSafe(pair.slice(eq + 1)), enabled: true });
      }
    } else {
      req.url = url;
    }

    // Body handling
    if (hasData || gotFormdata) {
      const body = dataParts.join('&');
      if (req._useGetData && req.method === 'GET' && hasData) {
        for (const pair of body.split('&')) {
          if (!pair) continue;
          const eq = pair.indexOf('=');
          req.query.push({ key: eq === -1 ? pair : pair.slice(0, eq), value: eq === -1 ? '' : pair.slice(eq + 1), enabled: true });
        }
      } else if (gotFormdata) {
        req.body.mode = 'formdata';
      } else if (hasData && looksLikeFormBody(body)) {
        req.body.mode = 'urlencoded';
        for (const pair of body.split('&')) {
          if (!pair) continue;
          const eq = pair.indexOf('=');
          req.body.urlencoded.push({ key: eq === -1 ? pair : decodeURIComponentSafe(pair.slice(0, eq)), value: eq === -1 ? '' : decodeURIComponentSafe(pair.slice(eq + 1)), enabled: true });
        }
      } else if (hasData) {
        const ct = getHeader('content-type') || '';
        req.body.mode = 'raw';
        req.body.raw = body;
        req.body.rawLang = ct.includes('json') ? 'json' : ct.includes('xml') ? 'xml' : ct.includes('javascript') ? 'js' : 'text';
      }
      // curl switches GET→POST when data is present unless -X or -G said otherwise
      if (method === null && !req._useGetData && (hasData || gotFormdata)) req.method = 'POST';
    }

    // Headers
    for (const h of headerList) {
      const lk = h.key.toLowerCase();
      if (lk === 'content-type' && hasData && req.body.mode === 'urlencoded') continue; // managed by body mode
      if (lk === 'content-type' && hasData && req.body.mode === 'raw' && !getHeader('content-type')) continue;
      req.headers.push({ key: h.key, value: h.value, enabled: true });
    }

    delete req._useGetData;
    if (hasData && req.method === 'POST' && req.body.mode === 'urlencoded' && !req.headers.some((h) => h.key.toLowerCase() === 'content-type')) {
      req.headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true });
    }
    return { request: req, warnings };
  }

  function shellQuote(s) {
    s = String(s);
    if (s === '') return "''";
    if (!/[\s'"\\$`\n\r\t&|;<>(){}[\]!*?~]/.test(s) && !s.startsWith('-') === false) {
      // simple: still quote to be safe
    }
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  function finalQuery(req) {
    return (req.query || []).filter((q) => q.enabled !== false && q.key !== '').map((q) => encodeURIComponent(q.key) + '=' + encodeURIComponent(q.value == null ? '' : q.value));
  }

  function urlWithQuery(req) {
    let u = req.url || '';
    const q = finalQuery(req);
    if (q.length) u += (u.includes('?') ? '&' : '?') + q.join('&');
    return u;
  }

  function bodyToString(req) {
    const b = req.body || { mode: 'none' };
    switch (b.mode) {
      case 'raw':
        return b.raw || '';
      case 'urlencoded':
        return (b.urlencoded || []).filter((f) => f.enabled !== false && f.key !== '').map((f) => encodeURIComponent(f.key) + '=' + encodeURIComponent(f.value == null ? '' : f.value)).join('&');
      case 'graphql': {
        const obj = { query: b.graphql ? b.graphql.query : '' };
        if (b.graphql && b.graphql.variables) {
          try {
            obj.variables = JSON.parse(b.graphql.variables);
          } catch (e) {
            obj.variables = b.graphql.variables;
          }
        }
        return JSON.stringify(obj);
      }
      case 'formdata':
        return (b.formdata || []).filter((f) => f.enabled !== false && f.key !== '').map((f) => '-F ' + shellQuote(f.key + '=' + (f.value == null ? '' : f.value))).join(' ');
      default:
        return '';
    }
  }

  function requestToCurl(req) {
    const parts = ['curl'];
    const method = (req.method || 'GET').toUpperCase();
    const b = req.body || { mode: 'none' };
    const hasBody = b.mode !== 'none' && b.mode !== undefined;

    // auth-derived query pairs (API key in query) and headers
    const extraQuery = [];
    const extraHeaders = [];
    if (req.auth) {
      if (req.auth.type === 'apikey') {
        if (req.auth.in === 'query' && req.auth.key) extraQuery.push([req.auth.key, req.auth.value || '']);
        else if (req.auth.key) extraHeaders.push({ key: req.auth.key, value: req.auth.value || '' });
      } else if (req.auth.type === 'bearer') {
        extraHeaders.push({ key: 'Authorization', value: (req.auth.prefix ? req.auth.prefix + ' ' : '') + (req.auth.token || '') });
      }
    }
    const url = req.url || '';
    const qParts = (req.query || []).filter((q) => q.enabled !== false && q.key !== '').map((q) => encodeURIComponent(q.key) + '=' + encodeURIComponent(q.value == null ? '' : q.value));
    for (const [k, v] of extraQuery) qParts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    const urlOut = qParts.length ? url + (url.includes('?') ? '&' : '?') + qParts.join('&') : url;

    if (method === 'HEAD') {
      parts.push('-I');
    } else if (method !== 'GET' || hasBody) {
      parts.push('-X', method);
    }
    parts.push(shellQuote(urlOut));

    if (req.settings && req.settings.redirect === 'follow') parts.push('-L');

    // Basic auth
    if (req.auth && req.auth.type === 'basic') parts.push('-u', shellQuote((req.auth.username || '') + ':' + (req.auth.password || '')));
    if (req.settings && req.settings.timeoutMs && req.settings.timeoutMs !== 30000) parts.push('--max-time', String(Math.max(1, Math.round(req.settings.timeoutMs / 1000))));

    // Headers (explicit user headers + auth-derived; skip Content-Type for modes that manage it)
    const allHeaders = (req.headers || []).filter((h) => h.enabled !== false && h.key !== '').concat(extraHeaders);
    for (const h of allHeaders) {
      const lk = h.key.toLowerCase();
      if (lk === 'content-type' && hasBody && ['urlencoded', 'graphql', 'formdata'].includes(b.mode)) continue;
      parts.push('-H', shellQuote(h.key + ': ' + (h.value == null ? '' : h.value)));
    }

    // Body
    if (hasBody) {
      if (b.mode === 'raw') {
        parts.push('--data', shellQuote(b.raw || ''));
      } else if (b.mode === 'urlencoded') {
        parts.push('--data', shellQuote(bodyToString(req)));
      } else if (b.mode === 'graphql') {
        if (!req.headers.some((h) => h.key.toLowerCase() === 'content-type')) parts.push('-H', shellQuote('Content-Type: application/json'));
        parts.push('--data', shellQuote(bodyToString(req)));
      } else if (b.mode === 'formdata') {
        parts.push(bodyToString(req));
      }
    }

    if (req.auth && !['basic', 'none', 'apikey', 'bearer'].includes(req.auth.type)) {
      parts.push('# Authorization: ' + req.auth.type + ' (computed by API Manager locally; not reproducible from this snippet)');
    }
    return parts.join(' ');
  }

  return { tokenize, parseCurl, requestToCurl, urlWithQuery, shellQuote };
});
