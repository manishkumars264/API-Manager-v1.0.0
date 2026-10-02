'use strict';
/*
 * API Manager - collections, environments, import/export normalization.
 * Supports Postman Collection v2.1 and Postman Environment formats plus the
 * native API Manager workspace backup format.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.APIManager = root.APIManager || {};
  root.APIManager.collection = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  function genId(prefix) {
    prefix = prefix || 'id';
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  const RAW_LANG_MAP = {
    json: 'json',
    xml: 'xml',
    html: 'html',
    javascript: 'js',
    js: 'js',
    text: 'text',
    default: 'text',
  };
  const RAW_LANG_REVERSE = { json: 'json', xml: 'xml', html: 'html', js: 'javascript', text: 'text' };

  function normalizeUrl(u) {
    if (u === null || u === undefined) return '';
    if (typeof u === 'string') return u;
    if (typeof u === 'object') {
      let base = '';
      if (u.raw && typeof u.raw === 'string') {
        base = u.raw;
      } else {
        const proto = (u.protocol || 'https') + '://';
        const host = Array.isArray(u.host) ? u.host.join('.') : u.host || '';
        const path = Array.isArray(u.path) ? '/' + u.path.join('/') : (u.path || '');
        base = proto + host + path;
        if (Array.isArray(u.query) && u.query.length) {
          const q = u.query.filter((x) => x && x.key !== '' && x.disabled !== true).map((x) => encodeURIComponent(x.key) + '=' + encodeURIComponent(x.value || ''));
          if (q.length) base += '?' + q.join('&');
        }
      }
      return base;
    }
    return String(u);
  }

  function normalizeHeaderList(list) {
    const out = [];
    for (const h of list || []) {
      if (!h) continue;
      out.push({
        id: genId('h'),
        key: h.key === null || h.key === undefined ? '' : String(h.key),
        value: h.value === null || h.value === undefined ? '' : String(h.value),
        enabled: h.disabled !== true && h.enabled !== false,
      });
    }
    return out;
  }

  function normalizeBody(body) {
    const base = {
      mode: 'none',
      raw: '',
      rawLang: 'json',
      urlencoded: [],
      formdata: [],
      graphql: { query: '', variables: '' },
      soap: { version: '1.1', action: '', envelope: '' },
    };
    if (!body || !body.mode || body.mode === 'none') return base;
    switch (body.mode) {
      case 'raw':
        return { ...base, mode: 'raw', raw: typeof body.raw === 'string' ? body.raw : (body.raw && body.raw.raw) || '', rawLang: RAW_LANG_MAP[(body.raw && body.raw.lang) || 'json'] || 'text' };
      case 'urlencoded':
        return { ...base, mode: 'urlencoded', urlencoded: (body.urlencoded || []).map((f) => ({ id: genId('kv'), key: String(f.key ?? ''), value: String(f.value ?? ''), enabled: f.disabled !== true, type: 'text' })) };
      case 'formdata':
        return {
          ...base,
          mode: 'formdata',
          formdata: (body.formdata || []).map((f) => ({ id: genId('kv'), key: String(f.key ?? ''), value: String(f.value ?? ''), enabled: f.disabled !== true, type: f.type === 'file' ? 'text' : 'text' })),
        };
      case 'graphql': {
        let q = '';
        let vars = '';
        if (typeof body.graphql === 'string') {
          q = body.graphql;
        } else if (body.graphql) {
          q = body.graphql.query || '';
          const v = body.graphql.variables;
          vars = typeof v === 'string' ? v : JSON.stringify(v || '', null, 2);
        }
        return { ...base, mode: 'graphql', graphql: { query: q, variables: vars } };
      }
      default:
        return base;
    }
  }

  function authField(auth, arrayKey, fieldKey) {
    const arr = auth && Array.isArray(auth[arrayKey]) ? auth[arrayKey] : [];
    for (const f of arr) if (f && f.key === fieldKey) return f.value === null || f.value === undefined ? '' : String(f.value);
    return '';
  }

  function normalizeAuth(auth) {
    if (!auth || typeof auth !== 'object') return null;
    if (auth.type === 'noauth') return null;
    switch (auth.type) {
      case 'apikey':
        return { type: 'apikey', key: authField(auth, 'apikey', 'key'), value: authField(auth, 'apikey', 'value'), in: authField(auth, 'apikey', 'in') === 'query' ? 'query' : 'header' };
      case 'bearer':
        return { type: 'bearer', prefix: 'Bearer', token: authField(auth, 'bearer', 'token') };
      case 'basic':
        return { type: 'basic', username: authField(auth, 'basic', 'username'), password: authField(auth, 'basic', 'password') };
      case 'digest':
        return { type: 'digest', username: authField(auth, 'digest', 'username'), password: authField(auth, 'digest', 'password'), algorithm: 'MD5' };
      case 'oauth1':
        return {
          type: 'oauth1',
          authUrl: authField(auth, 'oauth1', 'authUrl'),
          accessTokenUrl: authField(auth, 'oauth1', 'accessTokenUrl'),
          consumerKey: authField(auth, 'oauth1', 'consumerKey'),
          consumerSecret: authField(auth, 'oauth1', 'consumerSecret'),
          token: authField(auth, 'oauth1', 'token'),
          tokenSecret: authField(auth, 'oauth1', 'tokenSecret'),
          signatureMethod: 'HMAC-SHA1',
        };
      case 'oauth2': {
        const flow = authField(auth, 'oauth2', 'flow');
        return {
          type: 'oauth2',
          flow: flow === 'client_credentials' ? 'client_credentials' : 'access_token',
          accessToken: authField(auth, 'oauth2', 'accessToken'),
          tokenUrl: authField(auth, 'oauth2', 'tokenUrl'),
          clientId: authField(auth, 'oauth2', 'clientId'),
          clientSecret: authField(auth, 'oauth2', 'clientSecret'),
          scope: authField(auth, 'oauth2', 'scope'),
        };
      }
      case 'hawk':
        return { type: 'hawk', id: authField(auth, 'hawk', 'id'), key: authField(auth, 'hawk', 'key') };
      case 'aws':
        return { type: 'aws4', accessKeyId: authField(auth, 'aws', 'accessKeyId'), secretAccessKey: authField(auth, 'aws', 'secretAccessKey'), sessionToken: authField(auth, 'aws', 'sessionToken'), region: authField(auth, 'aws', 'region'), service: authField(auth, 'aws', 'service') };
      case 'ntlm':
        return { type: 'ntlmv2', username: authField(auth, 'ntlm', 'username'), password: authField(auth, 'ntlm', 'password'), domain: authField(auth, 'ntlm', 'domain') };
      case 'jwt':
        return {
          type: 'jwt',
          alg: authField(auth, 'jwt', 'alg') || 'HS256',
          iss: authField(auth, 'jwt', 'iss'),
          sub: authField(auth, 'jwt', 'sub'),
          aud: authField(auth, 'jwt', 'aud'),
          expSeconds: authField(auth, 'jwt', 'expSeconds') || '300',
          secret: authField(auth, 'jwt', 'secret'),
        };
      case 'none':
        return { type: 'none' };
      default:
        return { type: 'none' };
    }
  }

  function bodyToSpec(body) {
    return normalizeBody(body);
  }

  function normalizeRequest(input) {
    const req = input && input.request ? input.request : input || {};
    const method = String(req.method || 'GET').toUpperCase();
    return {
      id: req.id || genId('req'),
      name: (input && input.name) || req.name || 'Untitled request',
      method,
      url: normalizeUrl(req.url),
      query: normalizeHeaderList(req.url && typeof req.url === 'object' ? req.url.query : undefined).filter((q) => q.key !== ''),
      headers: normalizeHeaderList(req.header),
      auth: normalizeAuth(req.auth),
      body: normalizeBody(req.body),
      scripts: {
        pre: (req.event || []).find((e) => e && e.listen === 'prerequest') ? String(req.event.find((e) => e && e.listen === 'prerequest').script || '') : '',
        test: (req.event || []).find((e) => e && e.listen === 'test') ? String(req.event.find((e) => e && e.listen === 'test').script || '') : '',
      },
      variables: (req.variable || (input && input.variable) || []).map((v) => ({ key: String(v.key ?? ''), value: String(v.value ?? ''), enabled: v.disabled !== true })),
      settings: { timeoutMs: 30000, redirect: 'follow' },
      description: req.description ? (typeof req.description === 'string' ? req.description : req.description.content || '') : '',
    };
  }

  function normalizeItem(item, depth) {
    depth = depth || 0;
    if (!item) return null;
    if (item.request || (item.method !== undefined || item.url !== undefined)) {
      const req = normalizeRequest(item);
      if (depth === 0 && item.name) req.name = item.name;
      return { id: item.id || genId('it'), name: req.name, type: 'request', request: req, auth: normalizeAuth(item.auth || (item.request && item.request.auth)), description: item.description || '' };
    }
    const children = (item.item || []).map((c) => normalizeItem(c, depth + 1)).filter(Boolean);
    return { id: item.id || genId('dir'), name: item.name || 'Folder', type: 'folder', items: children, auth: normalizeAuth(item.auth), description: item.description || '' };
  }

  /**
   * Accept: Postman Collection v2.1 object, an array of items/requests,
   * or a single request. Returns a normalized API Manager collection.
   */
  function normalizeCollection(input) {
    if (!input) throw new Error('Empty collection input');
    if (Array.isArray(input)) {
      return {
        id: genId('col'),
        name: 'Imported Collection',
        description: '',
        auth: null,
        variables: [],
        items: input.map((i) => normalizeItem(i, 1)).filter(Boolean),
      };
    }
    // A bare request (or array of requests) becomes a one-item collection.
    if (input.request || (input.method !== undefined && input.url !== undefined)) {
      return {
        id: genId('col'),
        name: 'Imported Collection',
        description: '',
        auth: null,
        variables: [],
        items: [normalizeItem(input, 1)].filter(Boolean),
      };
    }
    const info = input.info || {};
    return {
      id: input.id || genId('col'),
      name: info.name || input.name || 'Imported Collection',
      description: info.description ? (typeof info.description === 'string' ? info.description : info.description.content || '') : '',
      auth: normalizeAuth(input.auth),
      variables: (input.variable || []).map((v) => ({ key: String(v.key ?? ''), value: String(v.value ?? ''), enabled: v.disabled !== true })),
      items: (input.item || []).map((i) => normalizeItem(i, 1)).filter(Boolean),
    };
  }

  function authToPostman(auth) {
    if (!auth || auth.type === 'none' || auth.type === 'inherit') return { type: 'noauth' };
    const str = (key, value) => ({ key, value: String(value ?? ''), type: 'string' });
    switch (auth.type) {
      case 'apikey':
        return { type: 'apikey', apikey: [str('key', auth.key), str('value', auth.value), str('in', auth.in)] };
      case 'bearer':
        return { type: 'bearer', bearer: [str('token', auth.token)] };
      case 'basic':
        return { type: 'basic', basic: [str('username', auth.username), str('password', auth.password)] };
      case 'digest':
        return { type: 'digest', digest: [str('username', auth.username), str('password', auth.password)] };
      case 'oauth1':
        return {
          type: 'oauth1',
          oauth1: [str('authUrl', auth.authUrl), str('accessTokenUrl', auth.accessTokenUrl), str('consumerKey', auth.consumerKey), str('consumerSecret', auth.consumerSecret), str('token', auth.token), str('tokenSecret', auth.tokenSecret)],
        };
      case 'oauth2':
        return {
          type: 'oauth2',
          oauth2: [str('flow', auth.flow), str('accessToken', auth.accessToken), str('tokenUrl', auth.tokenUrl), str('clientId', auth.clientId), str('clientSecret', auth.clientSecret), str('scope', auth.scope)],
        };
      case 'hawk':
        return { type: 'hawk', hawk: [str('id', auth.id), str('key', auth.key)] };
      case 'aws4':
        return { type: 'aws', aws: [str('accessKeyId', auth.accessKeyId), str('secretAccessKey', auth.secretAccessKey), str('sessionToken', auth.sessionToken), str('region', auth.region), str('service', auth.service)] };
      case 'ntlmv2':
        return { type: 'ntlm', ntlm: [str('username', auth.username), str('password', auth.password), str('domain', auth.domain)] };
      case 'jwt':
        return { type: 'jwt', jwt: [str('alg', auth.alg), str('iss', auth.iss), str('sub', auth.sub), str('aud', auth.aud), str('expSeconds', auth.expSeconds), str('secret', auth.secret)] };
      default:
        return { type: 'noauth' };
    }
  }

  function bodyToPostman(body) {
    if (!body || !body.mode || body.mode === 'none') return { mode: 'none' };
    switch (body.mode) {
      case 'raw':
        return { mode: 'raw', raw: body.raw || '', options: { raw: { language: RAW_LANG_REVERSE[body.rawLang] || 'text' } } };
      case 'urlencoded':
        return { mode: 'urlencoded', urlencoded: (body.urlencoded || []).map((f) => ({ key: f.key, value: f.value, disabled: !f.enabled, type: 'text' })) };
      case 'formdata':
        return { mode: 'formdata', formdata: (body.formdata || []).map((f) => ({ key: f.key, value: f.value, disabled: !f.enabled, type: 'text' })) };
      case 'graphql':
        return { mode: 'graphql', graphql: { query: body.graphql ? body.graphql.query : '', variables: body.graphql && body.graphql.variables ? body.graphql.variables : '' } };
      default:
        return { mode: 'none' };
    }
  }

  function requestToItem(node) {
    const req = node.request;
    return {
      id: node.id,
      name: node.name,
      description: node.description || undefined,
      request: {
        method: req.method,
        header: (req.headers || []).map((h) => ({ key: h.key, value: h.value, disabled: !h.enabled })),
        body: bodyToPostman(req.body),
        url: { raw: req.url, href: req.url },
        auth: authToPostman(req.auth),
        ...(req.scripts && (req.scripts.pre || req.scripts.test)
          ? {
              event: [
                ...(req.scripts.pre ? [{ listen: 'prerequest', script: req.scripts.pre }] : []),
                ...(req.scripts.test ? [{ listen: 'test', script: req.scripts.test }] : []),
              ],
            }
          : {}),
        ...(req.variables && req.variables.length ? { variable: req.variables.map((v) => ({ key: v.key, value: v.value, disabled: !v.enabled })) } : {}),
      },
    };
  }

  function collectionToV21(col) {
    const items = (col.items || []).map((item) => {
      if (item.type === 'folder') {
        return {
          id: item.id,
          name: item.name,
          description: item.description || undefined,
          ...(item.auth ? { auth: authToPostman(item.auth) } : {}),
          item: (item.items || []).map(collectionToV21Item),
        };
      }
      return collectionToV21Item(item);
    });
    function collectionToV21Item(it) {
      if (it.type === 'folder') {
        return {
          id: it.id,
          name: it.name,
          description: it.description || undefined,
          ...(it.auth ? { auth: authToPostman(it.auth) } : {}),
          item: (it.items || []).map(collectionToV21Item),
        };
      }
      return requestToItem(it);
    }
    return {
      info: {
        _postman_id: col.id,
        name: col.name,
        description: col.description || '',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        ...(col.auth ? {} : {}),
      },
      item: items,
      ...(col.auth ? { auth: authToPostman(col.auth) } : {}),
      ...(col.variables && col.variables.length ? { variable: col.variables.map((v) => ({ key: v.key, value: v.value, disabled: !v.enabled })) } : {}),
    };
  }

  function normalizeEnvironment(input) {
    if (!input) throw new Error('Empty environment input');
    const env = Array.isArray(input) ? input[0] || {} : input;
    const values = (env.values || []).map((v) => ({
      key: String(v.key ?? ''),
      value: v.value === null || v.value === undefined ? '' : String(v.value),
      enabled: v.enabled !== false && v.disabled !== true,
      type: 'default',
    }));
    return {
      id: env.id || genId('env'),
      name: env.name || 'Imported environment',
      values,
    };
  }

  function environmentToPostman(env) {
    return {
      id: env.id,
      name: env.name,
      values: (env.values || []).map((v) => ({ key: v.key, value: v.value, enabled: v.enabled !== false, type: 'default' })),
      _postman_variable_scope: 'environment',
      _postman_exported_at: new Date().toISOString(),
    };
  }

  const BACKUP_FORMAT = 'api-manager-workspace-backup';
  const BACKUP_VERSION = 1;

  function createBackup(parts) {
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      product: 'API Manager',
      exportedAt: new Date().toISOString(),
      collections: parts.collections || [],
      environments: parts.environments || [],
      globals: parts.globals || null,
      history: parts.history || [],
    };
  }

  function parseBackup(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new Error('Backup is not valid JSON: ' + e.message);
    }
    if (!obj || obj.format !== BACKUP_FORMAT) throw new Error('Not an API Manager workspace backup');
    if (!Number.isInteger(obj.version) || obj.version > BACKUP_VERSION) throw new Error('Unsupported backup version: ' + obj.version);
    return {
      collections: (obj.collections || []).map(normalizeCollection),
      environments: (obj.environments || []).map(normalizeEnvironment),
      globals: obj.globals || null,
      history: Array.isArray(obj.history) ? obj.history : [],
    };
  }

  return {
    genId,
    normalizeUrl,
    normalizeHeaderList,
    normalizeBody,
    normalizeAuth,
    normalizeRequest,
    normalizeItem,
    normalizeCollection,
    collectionToV21,
    normalizeEnvironment,
    environmentToPostman,
    createBackup,
    parseBackup,
    BACKUP_FORMAT,
    BACKUP_VERSION,
  };
});
