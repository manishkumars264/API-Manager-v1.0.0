'use strict';
/*
 * API Manager - history store helpers (pure, testable in Node).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.APIManager = root.APIManager || {};
  root.APIManager.history = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const MAX_HISTORY = 200;
  const MAX_STORED_BODY = 1024 * 1024; // 1 MB stored per entry

  function truncateBody(body, encoding) {
    if (typeof body !== 'string') return { body: '', encoding: encoding || 'utf8', truncated: false };
    if (encoding === 'base64') {
      const limit = Math.floor(MAX_STORED_BODY * 4 / 3) + 4;
      if (body.length > limit) {
        return { body: body.slice(0, limit).slice(0, Math.floor(limit / 4) * 4), encoding, truncated: true };
      }
      return { body, encoding, truncated: false };
    }
    if (body.length > MAX_STORED_BODY) {
      return { body: body.slice(0, MAX_STORED_BODY), encoding, truncated: true };
    }
    return { body, encoding, truncated: false };
  }

  /**
   * Build a history entry from a request spec and proxy response.
   */
  function makeEntry({ id, ts, name, method, url, request, response, tests }) {
    const stored = response && typeof response.body === 'string' ? truncateBody(response.body, response.bodyEncoding || 'utf8') : { body: '', encoding: 'utf8', truncated: false };
    return {
      id: id || String(Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
      ts: ts || Date.now(),
      name: name || 'Untitled request',
      method: method || 'GET',
      url: url || '',
      ok: !!(response && response.ok && response.status >= 200 && response.status < 400),
      status: response ? response.status : 0,
      statusText: response ? response.statusText || '' : '',
      durationMs: response ? response.durationMs : 0,
      sizeBytes: response ? response.sizeBytes || 0 : 0,
      truncated: !!stored.truncated,
      request: JSON.parse(JSON.stringify(request)),
      response: {
        ok: !!(response && response.ok),
        status: response ? response.status : 0,
        statusText: response ? response.statusText || '' : '',
        url: response && response.url ? response.url : '',
        headers: response && Array.isArray(response.headers) ? response.headers : [],
        cookies: response && Array.isArray(response.cookies) ? response.cookies : [],
        body: stored.body,
        bodyEncoding: stored.encoding,
        sizeBytes: response ? response.sizeBytes || 0 : 0,
      },
      tests: Array.isArray(tests) ? tests : [],
    };
  }

  /** Prepend an entry, keeping at most MAX_HISTORY entries. */
  function addEntry(list, entry) {
    const next = [entry].concat(list || []);
    return next.slice(0, MAX_HISTORY);
  }

  return { MAX_HISTORY, MAX_STORED_BODY, makeEntry, addEntry, truncateBody };
});
