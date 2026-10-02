(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.APIManagerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];

  function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function parseQuery(urlString) {
    const raw = String(urlString || '');
    const hashIndex = raw.indexOf('#');
    const withoutFragment = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    const queryIndex = withoutFragment.indexOf('?');
    const base = queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment;
    const query = queryIndex >= 0 ? withoutFragment.slice(queryIndex + 1) : '';
    const params = [...new URLSearchParams(query).entries()].map(([key, value]) => ({ key, value, enabled: true, description: '' }));
    return { base, params };
  }

  function formatUrl(base, params = []) {
    const filtered = (params || []).filter(param => param && param.enabled !== false && String(param.key || '').trim());
    if (!filtered.length) return base || '';
    const query = filtered.map(param => `${encodeURIComponent(String(param.key)).replace(/%20/g, '+')}=${encodeURIComponent(String(param.value ?? '')).replace(/%20/g, '+')}`).join('&');
    const separator = String(base || '').includes('?') ? (String(base).endsWith('?') || String(base).endsWith('&') ? '' : '&') : '?';
    return `${base || ''}${separator}${query}`;
  }

  function createVariableResolver(environment = {}, globals = {}) {
    const now = Date.now();
    const randomInt = Math.floor(Math.random() * 1000);
    const firstNames = ['Alex', 'Sam', 'Taylor', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Jamie'];
    const lastNames = ['Parker', 'Morgan', 'Reed', 'Patel', 'Kim', 'Singh', 'Lopez', 'Carter'];
    const pick = list => list[Math.floor(Math.random() * list.length)];
    const builtins = {
      '$timestamp': String(Math.floor(now / 1000)),
      '$isoTimestamp': new Date(now).toISOString(),
      '$guid': cryptoGuid(),
      '$randomUUID': cryptoGuid(),
      '$randomInt': String(randomInt),
      '$randomBoolean': String(Math.random() >= 0.5),
      '$randomEmail': `api.manager.${Math.random().toString(36).slice(2, 9)}@example.com`,
      '$randomFirstName': pick(firstNames),
      '$randomLastName': pick(lastNames),
      '$randomPassword': randomPassword(),
      '$randomPhoneNumber': `+1${Math.floor(2000000000 + Math.random() * 7900000000)}`,
      '$randomAlphaNumeric': Math.random().toString(36).slice(2, 12)
    };
    const resolve = key => {
      const name = String(key).trim();
      if (Object.prototype.hasOwnProperty.call(builtins, name)) return builtins[name];
      if (Object.prototype.hasOwnProperty.call(environment, name) && environment[name] !== undefined && environment[name] !== '') return String(environment[name]);
      if (Object.prototype.hasOwnProperty.call(globals, name)) return String(globals[name] ?? '');
      return `{{${name}}}`;
    };
    const apply = input => String(input ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => resolve(key));
    apply.get = resolve;
    apply.builtins = builtins;
    return apply;
  }

  function cryptoGuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function randomPassword() {
    const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';
    return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  function shellSplit(command) {
    const words = [];
    let word = '';
    let quote = '';
    let escaped = false;
    for (let i = 0; i < String(command).length; i++) {
      const ch = command[i];
      if (escaped) { word += ch; escaped = false; continue; }
      if (ch === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote) { if (ch === quote) quote = ''; else word += ch; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (/\s/.test(ch)) { if (word) { words.push(word); word = ''; } continue; }
      word += ch;
    }
    if (escaped) word += '\\';
    if (word) words.push(word);
    return words;
  }

  function parseCurl(command) {
    const tokens = shellSplit(String(command).trim().replace(/^\s*curl(?:\.exe)?\s*/i, ''));
    const request = {
      name: 'Imported cURL', method: 'GET', url: '', params: [],
      headers: [], auth: { type: 'none' },
      body: { mode: 'none', raw: '', language: 'json', soapAction: '', soapVersion: '1.1' },
      preScript: '', postScript: '', timeout: 30000
    };
    let explicitMethod = '';
    let sendAsGet = false;
    const headerMap = new Map();
    const pushData = value => {
      if (!request.body.raw) request.body.raw = value;
      else request.body.raw += `&${value}`;
      if (request.body.mode === 'none') request.body.mode = 'raw';
    };
    const readValue = (i, inline, option) => inline !== undefined ? [inline, i] : (i + 1 < tokens.length ? [tokens[i + 1], i + 1] : ['', i]);
    for (let i = 0; i < tokens.length; i++) {
      let token = tokens[i];
      if (token === '--url' || token === '-url') {
        const [value, next] = readValue(i); request.url = value; i = next; continue;
      }
      if (token === '-X' || token === '--request') {
        const [value, next] = readValue(i); explicitMethod = value.toUpperCase(); i = next; continue;
      }
      if (/^-X.+/.test(token) && token !== '-X') { explicitMethod = token.slice(2).toUpperCase(); continue; }
      if (token === '-H' || token === '--header') {
        const [value, next] = readValue(i); i = next;
        const colon = value.indexOf(':');
        if (colon > 0) {
          const key = value.slice(0, colon).trim(); const val = value.slice(colon + 1).trim();
          if (/^authorization$/i.test(key) && /^Bearer\s+/i.test(val)) request.auth = { type: 'bearer', token: val.replace(/^Bearer\s+/i, '') };
          else if (/^authorization$/i.test(key) && /^Basic\s+/i.test(val)) {
            try {
              const [username, ...password] = decodeURIComponent(escape(atobCompat(val.replace(/^Basic\s+/i, '')))).split(':');
              request.auth = { type: 'basic', username, password: password.join(':') };
            } catch { headerMap.set(key, val); }
          } else headerMap.set(key, val);
        }
        continue;
      }
      if (token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary' || token === '--data-ascii') {
        const [value, next] = readValue(i); pushData(value); i = next; continue;
      }
      if (token === '--data-urlencode') {
        const [value, next] = readValue(i); const separator = value.indexOf('=');
        const encoded = separator < 0 ? encodeURIComponent(value).replace(/%20/g, '+') : `${value.slice(0, separator)}=${encodeURIComponent(value.slice(separator + 1)).replace(/%20/g, '+')}`;
        pushData(encoded); i = next; continue;
      }
      if (token.startsWith('--data-urlencode=')) {
        const value = token.slice(17); const separator = value.indexOf('=');
        pushData(separator < 0 ? encodeURIComponent(value).replace(/%20/g, '+') : `${value.slice(0, separator)}=${encodeURIComponent(value.slice(separator + 1)).replace(/%20/g, '+')}`); continue;
      }
      if (token.startsWith('--data-raw=')) { pushData(token.slice(11)); continue; }
      if (token.startsWith('--data=')) { pushData(token.slice(7)); continue; }
      if (token === '-u' || token === '--user' || token === '--basic') {
        if (token === '--basic') { request.auth = { type: 'basic', username: '', password: '' }; continue; }
        const [value, next] = readValue(i); const colon = value.indexOf(':');
        request.auth = { type: 'basic', username: colon < 0 ? value : value.slice(0, colon), password: colon < 0 ? '' : value.slice(colon + 1) };
        i = next; continue;
      }
      if (token === '-G' || token === '--get') { sendAsGet = true; continue; }
      if (token === '-I' || token === '--head') { explicitMethod = 'HEAD'; continue; }
      if (token === '-F' || token === '--form') {
        const [value, next] = readValue(i); const separator = value.indexOf('=');
        request.body.mode = 'formdata'; request.body.params ||= [];
        request.body.params.push({ key: separator < 0 ? value : value.slice(0, separator), value: separator < 0 ? '' : value.slice(separator + 1), enabled: true, description: '' });
        i = next; continue;
      }
      if (token === '-b' || token === '--cookie') {
        const [value, next] = readValue(i); headerMap.set('Cookie', value); i = next; continue;
      }
      if (token === '-A' || token === '--user-agent') {
        const [value, next] = readValue(i); headerMap.set('User-Agent', value); i = next; continue;
      }
      if (token.startsWith('http://') || token.startsWith('https://')) request.url = token;
    }
    if (!request.url && tokens.length && /^https?:/i.test(tokens[tokens.length - 1])) request.url = tokens[tokens.length - 1];
    request.method = explicitMethod || (request.body.mode !== 'none' ? 'POST' : 'GET');
    if (sendAsGet && request.body.mode !== 'none') {
      try {
        const parsedUrl = new URL(request.url);
        if (request.body.mode === 'formdata') {
          for (const row of request.body.params || []) if (row.key) parsedUrl.searchParams.append(row.key, row.value || '');
        } else {
          for (const [key, value] of new URLSearchParams(request.body.raw || '')) parsedUrl.searchParams.append(key, value);
        }
        request.url = parsedUrl.toString();
      } catch {
        const sep = request.url.includes('?') ? '&' : '?'; request.url += `${sep}${encodeURIComponent(request.body.raw).replace(/%3D/g, '=').replace(/%26/g, '&')}`;
      }
      request.body = { ...request.body, mode: 'none', raw: '', params: [] }; request.method = 'GET';
    }
    if (request.body.mode === 'raw' && ![...headerMap.keys()].some(key => key.toLowerCase() === 'content-type')) headerMap.set('Content-Type', 'application/x-www-form-urlencoded');
    if (request.body.mode === 'raw') {
      const contentType = [...headerMap.entries()].find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
      request.body.language = /json/i.test(contentType) ? 'json' : /xml/i.test(contentType) ? 'xml' : 'text';
    }
    request.headers = [...headerMap.entries()].map(([key, value]) => ({ key, value, enabled: true, description: '' }));
    if (request.url) {
      const parsed = parseQuery(request.url);
      request.url = parsed.base;
      request.params = parsed.params;
    }
    return request;
  }

  function atobCompat(value) {
    if (typeof atob !== 'undefined') return atob(value);
    return Buffer.from(value, 'base64').toString('binary');
  }

  function quoteShell(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  function toCurl(request) {
    let url = formatUrl(request.url || '', request.params || []);
    const bits = ['curl', '--request', String(request.method || 'GET').toUpperCase()];
    const auth = request.auth || {};
    if (auth.type === 'apikey' && auth.key && auth.addTo === 'query') {
      try { const parsed = new URL(url); parsed.searchParams.append(auth.key, auth.value || ''); url = parsed.toString(); } catch {}
    }
    if (auth.type === 'oauth2' && auth.accessToken && auth.tokenPlacement === 'query') {
      try { const parsed = new URL(url); parsed.searchParams.append(auth.tokenParam || 'access_token', auth.accessToken); url = parsed.toString(); } catch {}
    }
    bits.push(quoteShell(url || 'https://example.com'));
    if (auth.type === 'basic' && auth.username) bits.push('--user', quoteShell(`${auth.username}:${auth.password || ''}`));
    const headers = (request.headers || []).filter(h => h && h.enabled !== false && h.key);
    if (auth.type === 'bearer' && auth.token) headers.unshift({ key: 'Authorization', value: `${auth.prefix === '' ? '' : `${auth.prefix || 'Bearer'} `}${auth.token}` });
    if (auth.type === 'oauth2' && auth.accessToken && auth.tokenPlacement !== 'query') headers.unshift({ key: 'Authorization', value: `${auth.tokenPrefix === '' ? '' : `${auth.tokenPrefix || 'Bearer'} `}${auth.accessToken}` });
    if (auth.type === 'apikey' && auth.addTo !== 'query' && auth.key) headers.unshift({ key: auth.key, value: auth.value || '' });
    const body = request.body || {};
    const hasContentType = headers.some(header => String(header.key).toLowerCase() === 'content-type');
    if (!hasContentType && body.mode === 'raw') headers.push({ key: 'Content-Type', value: body.language === 'json' ? 'application/json' : body.language === 'xml' ? (body.soapVersion === '1.2' ? 'application/soap+xml; charset=utf-8' : 'text/xml; charset=utf-8') : body.language === 'html' ? 'text/html; charset=utf-8' : body.language === 'javascript' ? 'application/javascript; charset=utf-8' : 'text/plain; charset=utf-8' });
    if (!hasContentType && body.mode === 'graphql') headers.push({ key: 'Content-Type', value: 'application/json' });
    headers.forEach(header => bits.push('--header', quoteShell(`${header.key}: ${header.value || ''}`)));
    if (body.mode === 'formdata') {
      (body.params || []).filter(item => item && item.key && item.enabled !== false).forEach(item => bits.push('--form', quoteShell(`${item.key}=${item.value || ''}`)));
    } else if (body.mode === 'urlencoded') {
      (body.params || []).filter(item => item && item.key && item.enabled !== false).forEach(item => bits.push('--data-urlencode', quoteShell(`${item.key}=${item.value || ''}`)));
    } else if (body.mode === 'graphql') {
      const graphql = JSON.stringify({ query: body.raw || '', variables: JSON.parse(body.variables || '{}') });
      bits.push('--data-raw', quoteShell(graphql));
    } else if (body.mode !== 'none' && body.raw) bits.push('--data-raw', quoteShell(body.raw));
    return bits.join(' ');
  }

  function postmanAuth(auth = {}) {
    const map = {
      none: 'noauth', bearer: 'bearer', basic: 'basic', apikey: 'apikey', oauth2: 'oauth2',
      digest: 'digest', oauth1: 'oauth1', hawk: 'hawk', aws: 'awsv4', edgegrid: 'edgegrid', ntlm: 'ntlm', jwt: 'jwt'
    };
    const type = map[auth.type] || auth.type;
    if (!type || type === 'noauth') return { type: 'noauth' };
    const fields = { ...auth }; delete fields.type;
    if (type === 'apikey' && fields.addTo) { fields.in = fields.addTo; delete fields.addTo; }
    if (type === 'oauth2') {
      if (fields.tokenPlacement) { fields.addTokenTo = fields.tokenPlacement === 'query' ? 'queryParams' : 'header'; delete fields.tokenPlacement; }
      if (fields.tokenPrefix) { fields.tokenType = fields.tokenPrefix; delete fields.tokenPrefix; }
    }
    const value = (key, val) => ({ key, value: val ?? '', type: 'string', disabled: false });
    return { type, [type]: Object.entries(fields).filter(([, val]) => typeof val !== 'object').map(([key, val]) => value(key, val)) };
  }

  function toPostmanRequest(request = {}) {
    const rawUrl = formatUrl(request.url || '', request.params || []);
    const headers = (request.headers || []).map(item => ({ key: item.key, value: item.value ?? '', description: item.description || '', disabled: item.enabled === false })).filter(item => item.key);
    const body = request.body || {};
    const result = {
      method: request.method || 'GET',
      header: headers,
      url: { raw: rawUrl, protocol: '', host: [], path: [], query: [] },
      description: request.description || ''
    };
    try {
      const parsed = new URL(rawUrl);
      result.url.protocol = parsed.protocol.replace(':', ''); result.url.host = parsed.hostname.split('.');
      result.url.path = parsed.pathname.split('/').filter(Boolean);
      result.url.query = [...parsed.searchParams.entries()].map(([key, value]) => ({ key, value, disabled: false }));
    } catch { result.url = { raw: rawUrl }; }
    if (body.mode === 'raw') result.body = { mode: 'raw', raw: body.raw || '', options: { raw: { language: body.language || 'json' } } };
    else if (body.mode === 'urlencoded') result.body = { mode: 'urlencoded', urlencoded: (body.params || []).map(item => ({ key: item.key, value: item.value, disabled: item.enabled === false })) };
    else if (body.mode === 'formdata') result.body = { mode: 'formdata', formdata: (body.params || []).map(item => ({ key: item.key, value: item.value, type: 'text', disabled: item.enabled === false })) };
    if (request.auth && request.auth.type && request.auth.type !== 'none') result.auth = postmanAuth(request.auth);
    return result;
  }

  function toPostmanCollection(collection) {
    const convertItem = item => {
      if (Array.isArray(item.items)) return { name: item.name || 'Folder', item: item.items.map(convertItem) };
      const request = item.request || item;
      const events = [];
      if (request.preScript) events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: String(request.preScript).split('\n') } });
      if (request.postScript) events.push({ listen: 'test', script: { type: 'text/javascript', exec: String(request.postScript).split('\n') } });
      return { name: item.name || request.name || 'Request', request: toPostmanRequest(request), response: [], ...(events.length ? { event: events } : {}) };
    };
    return {
      info: {
        _postman_id: collection.id || uid('collection'),
        name: collection.name || 'API Manager Collection',
        description: collection.description || '',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: (collection.items || []).map(convertItem),
      variable: (collection.variables || []).map(item => ({ key: item.key, value: item.value, type: 'string' })),
      ...(collection.auth ? { auth: postmanAuth(collection.auth) } : {})
    };
  }

  function fromPostmanUrl(input) {
    if (typeof input === 'string') {
      const parsed = parseQuery(input); return { url: parsed.base, params: parsed.params };
    }
    const raw = input?.raw || '';
    if (raw) return fromPostmanUrl(raw);
    const protocol = input?.protocol ? `${input.protocol}://` : '';
    const host = Array.isArray(input?.host) ? input.host.join('.') : (input?.host || '');
    const path = Array.isArray(input?.path) ? input.path.join('/') : (input?.path || '');
    const base = `${protocol}${host}${path ? `/${path}` : ''}`;
    const params = (input?.query || []).map(item => ({ key: item.key || '', value: item.value || '', enabled: !item.disabled, description: item.description || '' }));
    return { url: base, params };
  }

  function fromPostmanRequest(input = {}) {
    const parsedUrl = fromPostmanUrl(input.url);
    let auth = { type: 'none' };
    if (input.auth && input.auth.type) {
      const alias = { noauth: 'none', awsv4: 'aws', 'oauth2': 'oauth2', 'apikey': 'apikey', 'jwt': 'jwt', 'ntlm': 'ntlm', 'digest': 'digest', 'hawk': 'hawk', 'oauth1': 'oauth1', 'basic': 'basic', 'bearer': 'bearer' };
      const type = alias[input.auth.type] || input.auth.type;
      const rawFields = input.auth[type] || input.auth[input.auth.type] || [];
      auth = { type };
      for (const field of rawFields) if (field && field.key) auth[field.key] = field.value ?? '';
      if (type === 'apikey' && auth.in && !auth.addTo) auth.addTo = auth.in === 'query' || auth.in === 'queryParams' ? 'query' : 'header';
      if (type === 'oauth2') {
        if (auth.addTokenTo && !auth.tokenPlacement) auth.tokenPlacement = auth.addTokenTo === 'queryParams' ? 'query' : 'header';
        if (auth.tokenType && !auth.tokenPrefix) auth.tokenPrefix = auth.tokenType;
      }
    }
    const pmBody = input.body || {};
    const request = {
      name: input.name || 'Imported request', method: String(input.method || 'GET').toUpperCase(),
      url: parsedUrl.url, params: parsedUrl.params,
      headers: (input.header || []).map(item => ({ key: item.key || '', value: item.value || '', enabled: !item.disabled, description: item.description || '' })),
      auth,
      body: { mode: 'none', raw: '', language: 'json', soapAction: '', soapVersion: '1.1' },
      preScript: '', postScript: '', timeout: 30000,
      description: input.description || ''
    };
    if (pmBody.mode === 'raw') {
      request.body.mode = 'raw'; request.body.raw = pmBody.raw || '';
      request.body.language = pmBody.options?.raw?.language || 'json';
    } else if (pmBody.mode === 'urlencoded' || pmBody.mode === 'formdata') {
      request.body.mode = pmBody.mode;
      request.body.params = (pmBody[pmBody.mode] || []).map(item => ({ key: item.key || '', value: item.value || '', enabled: !item.disabled, description: item.description || '' }));
    }
    for (const event of input.event || []) {
      const script = event.script?.exec;
      if (Array.isArray(script)) {
        if (event.listen === 'prerequest') request.preScript = script.join('\n');
        if (event.listen === 'test') request.postScript = script.join('\n');
      }
    }
    return request;
  }

  function fromPostmanCollection(json) {
    const source = typeof json === 'string' ? JSON.parse(json) : json;
    const info = source.info || {};
    const convertItems = items => (items || []).map(item => {
      if (Array.isArray(item.item)) return { id: item.id || uid('folder'), name: item.name || 'Folder', items: convertItems(item.item) };
      const request = fromPostmanRequest({ ...(item.request || {}), name: item.name || item.request?.name });
      for (const event of item.event || []) {
        const script = event.script?.exec;
        if (!Array.isArray(script)) continue;
        if (event.listen === 'prerequest') request.preScript = script.join('\n');
        if (event.listen === 'test') request.postScript = script.join('\n');
      }
      return { id: item.id || uid('request'), name: item.name || request.name, request };
    });
    return {
      id: info._postman_id || uid('collection'), name: info.name || 'Imported collection',
      description: info.description || '', items: convertItems(source.item || []),
      variables: (source.variable || []).map(item => ({ key: item.key || '', value: item.value || '', enabled: !item.disabled })),
      auth: source.auth ? fromPostmanRequest({ auth: source.auth }).auth : { type: 'none' }
    };
  }

  function fromPostmanEnvironment(json) {
    const source = typeof json === 'string' ? JSON.parse(json) : json;
    const values = Array.isArray(source.values) ? source.values : Array.isArray(source.values?.values) ? source.values.values : Array.isArray(source.variable) ? source.variable : [];
    return {
      id: source.id || source._postman_variable_scope || uid('env'),
      name: source.name || 'Imported environment',
      values: values.map(item => ({ key: item.key || '', value: item.value ?? item.initialValue ?? '', enabled: !item.disabled, type: item.type || 'default' }))
    };
  }

  return {
    METHODS, uid, clone, parseQuery, formatUrl, createVariableResolver,
    shellSplit, parseCurl, toCurl, toPostmanRequest, toPostmanCollection,
    fromPostmanRequest, fromPostmanCollection, fromPostmanEnvironment
  };
});
