'use strict';
/*
 * API Manager - code generation: cURL, Python Requests, JavaScript Fetch,
 * Java HttpClient, and Postman CLI.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.APIManager = root.APIManager || {};
  root.APIManager.snippets = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const { requestToCurl, urlWithQuery } = requireCurl();
  function requireCurl() {
    if (typeof module === 'object' && typeof require === 'function') {
      try {
        return require('./curl.js');
      } catch (e) {
        /* fall through to global */
      }
    }
    return (typeof self !== 'undefined' ? self.APIManager : globalThis.APIManager).curl;
  }

  function jsString(s) {
    return JSON.stringify(String(s == null ? '' : s));
  }

  function pythonString(s) {
    return JSON.stringify(String(s == null ? '' : s));
  }

  function enabledHeaders(req) {
    return (req.headers || []).filter((h) => h.enabled !== false && h.key !== '');
  }
  function enabledQuery(req) {
    return (req.query || []).filter((q) => q.enabled !== false && q.key !== '');
  }

  function authNote(auth) {
    if (!auth || auth.type === 'none' || auth.type === 'inherit') return null;
    switch (auth.type) {
      case 'basic':
        return null; // inlined as basic auth
      case 'bearer':
        return null; // inlined as Authorization header
      case 'apikey':
        return null; // inlined
      default:
        return 'Authorization uses ' + auth.type + '; the signature is computed by API Manager locally and is not included in this snippet. See README "Authentication" for details.';
    }
  }

  function basicAuthHeader(auth) {
    const { createHash } = typeof crypto !== 'undefined' && crypto.webcrypto ? {} : {};
    // base64 without node deps
    const s = (auth.username || '') + ':' + (auth.password || '');
    let b64;
    if (typeof btoa === 'function') b64 = btoa(s);
    else if (typeof Buffer !== 'undefined') b64 = Buffer.from(s, 'utf8').toString('base64');
    else b64 = s;
    return ['Basic', b64];
  }

  function effectiveAuth(req) {
    return req.auth || { type: 'none' };
  }

  function genCurl(req) {
    return requestToCurl(req);
  }

  function genPython(req) {
    const method = (req.method || 'GET').toUpperCase();
    const url = req.url || '';
    const lines = [];
    lines.push('import requests');
    lines.push('');
    lines.push('url = ' + pythonString(url));
    const query = enabledQuery(req);
    if (query.length) {
      lines.push('params = {');
      for (const q of query) lines.push('    ' + pythonString(q.key) + ': ' + pythonString(q.value) + ',');
      lines.push('}');
    }
    const headers = {};
    const b = req.body || { mode: 'none' };
    const hasBody = b.mode && b.mode !== 'none';
    for (const h of enabledHeaders(req)) {
      const lk = h.key.toLowerCase();
      if (hasBody && ['urlencoded', 'graphql', 'formdata'].includes(b.mode) && lk === 'content-type') continue;
      if (hasBody && b.mode === 'raw' && lk === 'content-type' && !h.value) continue;
      headers[h.key] = h.value == null ? '' : h.value;
    }
    const auth = effectiveAuth(req);
    if (auth.type === 'bearer') {
      headers['Authorization'] = (auth.prefix ? auth.prefix + ' ' : '') + (auth.token || '');
    } else if (auth.type === 'basic') {
      headers['Authorization'] = basicAuthHeader(auth).join(' ');
    } else if (auth.type === 'apikey' && auth.in === 'header' && auth.key) {
      headers[auth.key] = auth.value || '';
    } else if (auth.type === 'apikey' && auth.in === 'query' && auth.key) {
      if (!lines.some((l) => l.startsWith('params'))) lines.splice(1, 0, '');
    }
    if (Object.keys(headers).length) {
      lines.push('headers = {');
      for (const [k, v] of Object.entries(headers)) lines.push('    ' + pythonString(k) + ': ' + pythonString(v) + ',');
      lines.push('}');
    }
    let dataLine = '';
    let jsonLine = '';
    if (hasBody) {
      if (b.mode === 'raw' && (b.rawLang === 'json' || b.rawLang === 'text' || b.rawLang === 'js' || b.rawLang === 'html' || b.rawLang === 'xml')) {
        if (b.rawLang === 'json') {
          jsonLine = 'json=' + (b.raw || 'null');
        } else {
          dataLine = 'data=' + pythonString(b.raw);
        }
      } else if (b.mode === 'raw') {
        dataLine = 'data=' + pythonString(b.raw);
      } else if (b.mode === 'urlencoded') {
        const d = {};
        for (const f of b.urlencoded || []) if (f.enabled !== false) d[f.key] = f.value || '';
        dataLine = 'data=' + JSON.stringify(d);
      } else if (b.mode === 'graphql') {
        let obj = { query: b.graphql ? b.graphql.query : '' };
        if (b.graphql && b.graphql.variables) {
          try {
            obj.variables = JSON.parse(b.graphql.variables);
          } catch (e) {
            obj.variables = b.graphql.variables;
          }
        }
        jsonLine = 'json=' + JSON.stringify(obj);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      } else if (b.mode === 'formdata') {
        const d = {};
        for (const f of b.formdata || []) if (f.enabled !== false) d[f.key] = f.value || '';
        dataLine = 'data=' + JSON.stringify(d);
      }
    }
    if (b.mode === 'formdata') lines.push("# Note: multipart form-data is sent as urlencoded here; use files={} for real multipart payloads.");
    const kwargs = [];
    if (query.length) kwargs.push('params=params');
    if (Object.keys(headers).length) kwargs.push('headers=headers');
    if (jsonLine) kwargs.push(jsonLine);
    else if (dataLine) kwargs.push(dataLine);
    if (auth.type === 'basic') kwargs.push('auth=(' + pythonString(auth.username || '') + ', ' + pythonString(auth.password || '') + ')');
    if (auth.type === 'apikey' && auth.in === 'query' && auth.key) {
      if (!query.length) lines.push('params = {');
      if (!lines.some((l) => l === 'params = {')) {
        lines.push('params = {');
        lines.push('    ' + pythonString(auth.key) + ': ' + pythonString(auth.value || '') + ',');
        lines.push('}');
      }
      if (!kwargs.includes('params=params')) kwargs.push('params=params');
    }
    if (req.settings && req.settings.timeoutMs && req.settings.timeoutMs !== 30000) {
      kwargs.push('timeout=' + Math.round(req.settings.timeoutMs / 1000));
    }
    const note = authNote(auth);
    if (note) lines.push('# ' + note);
    lines.push('');
    const kwargsStr = kwargs.length ? ',\n    ' + kwargs.join(',\n    ') : '';
    lines.push('response = requests.request(' + pythonString(method) + ', url' + (kwargsStr ? ',' + kwargsStr : '') + ')');
    lines.push('print(response.status_code)');
    lines.push('print(response.text)');
    return lines.join('\n');
  }

  function genFetch(req) {
    const method = (req.method || 'GET').toUpperCase();
    const lines = [];
    const b = req.body || { mode: 'none' };
    const hasBody = b.mode && b.mode !== 'none';
    const headers = {};
    for (const h of enabledHeaders(req)) {
      const lk = h.key.toLowerCase();
      if (hasBody && ['urlencoded', 'graphql', 'formdata'].includes(b.mode) && lk === 'content-type') continue;
      headers[h.key] = h.value == null ? '' : h.value;
    }
    const auth = effectiveAuth(req);
    if (auth.type === 'bearer') headers['Authorization'] = (auth.prefix ? auth.prefix + ' ' : '') + (auth.token || '');
    else if (auth.type === 'basic') headers['Authorization'] = basicAuthHeader(auth).join(' ');
    else if (auth.type === 'apikey' && auth.in === 'header' && auth.key) headers[auth.key] = auth.value || '';
    let bodyExpr = '';
    if (hasBody) {
      if (b.mode === 'raw') {
        bodyExpr = jsString(b.raw || '');
      } else if (b.mode === 'urlencoded') {
        const s = (b.urlencoded || [])
          .filter((f) => f.enabled !== false)
          .map((f) => encodeURIComponent(f.key) + '=' + encodeURIComponent(f.value || ''))
          .join('&');
        bodyExpr = jsString(s);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else if (b.mode === 'graphql') {
        let obj = { query: b.graphql ? b.graphql.query : '' };
        if (b.graphql && b.graphql.variables) {
          try {
            obj.variables = JSON.parse(b.graphql.variables);
          } catch (e) {
            obj.variables = b.graphql.variables;
          }
        }
        bodyExpr = 'JSON.stringify(' + JSON.stringify(obj) + ')';
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      } else if (b.mode === 'formdata') {
        bodyExpr = 'JSON.stringify(' + JSON.stringify(Object.fromEntries((b.formdata || []).filter((f) => f.enabled !== false).map((f) => [f.key, f.value || '']))) + ')';
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        lines.push('// Note: multipart form-data is sent urlencoded here; build a FormData for real multipart payloads.');
      }
    }
    const note = authNote(auth);
    if (note) lines.push('// ' + note);
    lines.push('const response = await fetch(' + jsString(req.url || '') + (enabledQuery(req).length ? ' + "' + '?' + enabledQuery(req).map((q) => encodeURIComponent(q.key) + '=' + encodeURIComponent(q.value || '')).join('&') + '"' : '') + ', {');
    lines.push('  method: ' + jsString(method) + ',');
    if (Object.keys(headers).length) {
      lines.push('  headers: ' + JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ') + ',');
    }
    if (bodyExpr) lines.push('  body: ' + bodyExpr + ',');
    if (req.settings && req.settings.timeoutMs && req.settings.timeoutMs !== 30000) {
      lines.push('  signal: AbortSignal.timeout(' + req.settings.timeoutMs + '),');
    }
    lines.push('});');
    lines.push('');
    lines.push('console.log(response.status);');
    lines.push('const text = await response.text();');
    lines.push('console.log(text);');
    return lines.join('\n');
  }

  function javaString(s) {
    return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }

  function genJava(req) {
    const method = (req.method || 'GET').toUpperCase();
    const url = urlWithQuery(req);
    const b = req.body || { mode: 'none' };
    const hasBody = b.mode && b.mode !== 'none';
    const headers = enabledHeaders(req).filter((h) => {
      const lk = h.key.toLowerCase();
      if (hasBody && ['urlencoded', 'graphql', 'formdata'].includes(b.mode) && lk === 'content-type') return false;
      return true;
    });
    const auth = effectiveAuth(req);
    let authLine = null;
    if (auth.type === 'bearer') authLine = '.header("Authorization", ' + javaString((auth.prefix ? auth.prefix + ' ' : '') + (auth.token || '')) + ')';
    else if (auth.type === 'basic') authLine = '.header("Authorization", ' + javaString(basicAuthHeader(auth).join(' ')) + ')';
    else if (auth.type === 'apikey' && auth.in === 'header' && auth.key) authLine = '.header(' + javaString(auth.key) + ', ' + javaString(auth.value || '') + ')';
    const note = authNote(auth);

    let bodyExpr = 'HttpRequest.BodyPublishers.noBody()';
    if (hasBody) {
      let s = '';
      if (b.mode === 'raw') s = b.raw || '';
      else if (b.mode === 'urlencoded')
        s = (b.urlencoded || [])
          .filter((f) => f.enabled !== false)
          .map((f) => encodeURIComponent(f.key) + '=' + encodeURIComponent(f.value || ''))
          .join('&');
      else if (b.mode === 'graphql') {
        let obj = { query: b.graphql ? b.graphql.query : '' };
        if (b.graphql && b.graphql.variables) {
          try {
            obj.variables = JSON.parse(b.graphql.variables);
          } catch (e) {
            obj.variables = b.graphql.variables;
          }
        }
        s = JSON.stringify(obj);
      } else if (b.mode === 'formdata')
        s = (b.formdata || [])
          .filter((f) => f.enabled !== false)
          .map((f) => encodeURIComponent(f.key) + '=' + encodeURIComponent(f.value || ''))
          .join('&');
      bodyExpr = 'HttpRequest.BodyPublishers.ofString(' + javaString(s) + ')';
      if (b.mode === 'urlencoded' && !headers.some((h) => h.key.toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true });
      if (['graphql', 'formdata'].includes(b.mode) && !headers.some((h) => h.key.toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
    }

    const lines = [];
    if (note) lines.push('// ' + note);
    lines.push('var client = java.net.http.HttpClient.newHttpClient();');
    lines.push('var request = java.net.http.HttpRequest.newBuilder()');
    lines.push('    .uri(java.net.URI.create(' + javaString(url) + '))');
    lines.push('    .method(' + javaString(method) + ', ' + bodyExpr + ')');
    for (const h of headers) lines.push('    .header(' + javaString(h.key) + ', ' + javaString(h.value == null ? '' : h.value) + ')');
    if (authLine) lines.push(authLine);
    if (req.settings && req.settings.timeoutMs && req.settings.timeoutMs !== 30000) lines.push('    .timeout(java.time.Duration.ofMillis(' + req.settings.timeoutMs + '))');
    lines.push('    .build();');
    lines.push('');
    lines.push('var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());');
    lines.push('System.out.println(response.statusCode());');
    lines.push('System.out.println(response.body());');
    return lines.join('\n');
  }

  function genPostmanCli(req, collectionName) {
    const { collectionToV21 } = typeof module === 'object' && typeof require === 'function' ? require('./collection.js') : (typeof self !== 'undefined' ? self.APIManager : globalThis.APIManager).collection;
    const col = collectionToV21({ id: 'req-' + Date.now().toString(36), name: collectionName || req.name || 'Request', items: [{ id: req.id || 'it-1', name: req.name || 'Request', type: 'request', request: req }] });
    const lines = [];
    lines.push('// 1) Save the collection below as collection.json');
    lines.push('// 2) Run: postman collection run collection.json --header "Accept: application/json"');
    lines.push('//    (Postman CLI: https://github.com/postmanlabs/postman-cli)');
    lines.push(JSON.stringify(col, null, 2));
    return lines.join('\n');
  }

  function generateAll(req) {
    return {
      curl: genCurl(req),
      python: genPython(req),
      fetch: genFetch(req),
      java: genJava(req),
      postmanCli: genPostmanCli(req),
    };
  }

  return { genCurl, genPython, genFetch, genJava, genPostmanCli, generateAll };
});
