(function (root, factory) {
  const core = root?.APIManagerCore || (typeof module !== 'undefined' && module.exports ? require('./core') : null);
  const api = factory(core);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.APIManagerCodegen = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  function setHeader(headers, key, value) {
    for (const existing of Object.keys(headers)) if (existing.toLowerCase() === String(key).toLowerCase()) delete headers[existing];
    headers[key] = String(value ?? '');
  }
  function utf8Base64(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function bodyData(request) {
    const body = request.body || {};
    if (body.mode === 'raw') return body.raw || '';
    if (body.mode === 'urlencoded') return new URLSearchParams((body.params || []).filter(item => item.key && item.enabled !== false).map(item => [item.key, item.value || ''])).toString();
    if (body.mode === 'graphql') {
      let variables = {};
      try { variables = JSON.parse(body.variables || '{}'); } catch { variables = {}; }
      return JSON.stringify({ query: body.raw || '', variables });
    }
    if (body.mode === 'formdata') {
      const boundary = '----APIManagerCodegenBoundary';
      const parts = (body.params || []).filter(item => item.key && item.enabled !== false).map(item => `--${boundary}\r\nContent-Disposition: form-data; name="${String(item.key).replace(/["\r\n]/g, '')}"\r\n\r\n${item.value || ''}\r\n`);
      return `${parts.join('')}--${boundary}--\r\n`;
    }
    return '';
  }
  function makeHeaders(request) {
    const headers = {};
    (request.headers || []).filter(item => item.key && item.enabled !== false).forEach(item => setHeader(headers, item.key, item.value || ''));
    const auth = request.auth || {};
    if (auth.type === 'bearer' && auth.token) setHeader(headers, 'Authorization', `${auth.prefix === '' ? '' : `${auth.prefix || 'Bearer'} `}${auth.token}`);
    if (auth.type === 'basic' && auth.username) setHeader(headers, 'Authorization', `Basic ${utf8Base64(`${auth.username}:${auth.password || ''}`)}`);
    if (auth.type === 'oauth2' && auth.accessToken && auth.tokenPlacement !== 'query') setHeader(headers, 'Authorization', `${auth.tokenPrefix === '' ? '' : `${auth.tokenPrefix || 'Bearer'} `}${auth.accessToken}`);
    if (auth.type === 'apikey' && auth.addTo !== 'query' && auth.key) setHeader(headers, auth.key, auth.value || '');
    const hasType = Object.keys(headers).some(key => key.toLowerCase() === 'content-type');
    const body = request.body || {};
    if (!hasType && body.mode === 'raw') {
      const contentType = body.language === 'json' ? 'application/json' : body.language === 'xml' ? (body.soapVersion === '1.2' ? 'application/soap+xml; charset=utf-8' : 'text/xml; charset=utf-8') : body.language === 'html' ? 'text/html; charset=utf-8' : body.language === 'javascript' ? 'application/javascript; charset=utf-8' : 'text/plain; charset=utf-8';
      headers['Content-Type'] = contentType;
    }
    if (!hasType && body.mode === 'urlencoded') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (!hasType && body.mode === 'graphql') headers['Content-Type'] = 'application/json';
    if (!hasType && body.mode === 'formdata') headers['Content-Type'] = 'multipart/form-data; boundary=----APIManagerCodegenBoundary';
    return headers;
  }
  function quoteCli(text) { return `"${String(text).replace(/"/g, '\\"')}"`; }
  function generateCode(request, language, options = {}) {
    if (!Core) throw new Error('Request conversion helpers are unavailable.');
    const method = String(request.method || 'GET').toUpperCase();
    let url = Core.formatUrl(request.url || '', request.params || []);
    const auth = request.auth || {};
    if (auth.type === 'inherit' && options.collectionAuth) request = { ...request, auth: options.collectionAuth };
    const effectiveAuth = request.auth || {};
    if (effectiveAuth.type === 'apikey' && effectiveAuth.addTo === 'query' && effectiveAuth.key) { const parsed = new URL(url); parsed.searchParams.append(effectiveAuth.key, effectiveAuth.value || ''); url = parsed.toString(); }
    if (effectiveAuth.type === 'oauth2' && effectiveAuth.accessToken && effectiveAuth.tokenPlacement === 'query') { const parsed = new URL(url); parsed.searchParams.append(effectiveAuth.tokenParam || 'access_token', effectiveAuth.accessToken); url = parsed.toString(); }
    const headers = makeHeaders(request);
    const body = bodyData(request);
    if (language === 'curl') return Core.toCurl({ ...request, url, params: [], headers: Object.entries(headers).map(([key, value]) => ({ key, value, enabled: true })), auth: { type: 'none' } });
    if (language === 'javascript') {
      const headerText = JSON.stringify(headers, null, 2);
      const bodyLine = ['GET', 'HEAD'].includes(method) || request.body?.mode === 'none' ? '' : `,\n  body: ${JSON.stringify(body)}`;
      return `const url = ${JSON.stringify(url)};\n\nconst options = {\n  method: ${JSON.stringify(method)},\n  headers: ${headerText}${bodyLine}\n};\n\nconst response = await fetch(url, options);\nconst responseBody = await response.text();\nconsole.log(response.status, responseBody);`;
    }
    if (language === 'python') {
      const headerText = JSON.stringify(headers, null, 4);
      const bodyArg = ['GET', 'HEAD'].includes(method) || request.body?.mode === 'none' ? '' : `,\n    data=${JSON.stringify(body)}`;
      return `import requests\n\nurl = ${JSON.stringify(url)}\nheaders = ${headerText}\nresponse = requests.request(\n    ${JSON.stringify(method)}, url, headers=headers${bodyArg}\n)\nprint(response.status_code)\nprint(response.text)`;
    }
    if (language === 'java') {
      const headersText = Object.entries(headers).map(([key, value]) => `        .header(${JSON.stringify(key)}, ${JSON.stringify(value)})`).join('\n');
      const publisher = ['GET', 'HEAD'].includes(method) || request.body?.mode === 'none' ? 'HttpRequest.BodyPublishers.noBody()' : `HttpRequest.BodyPublishers.ofString(${JSON.stringify(body)})`;
      const methodCall = method === 'GET' && publisher.includes('noBody') ? '.GET()' : `.method(${JSON.stringify(method)}, ${publisher})`;
      return `import java.net.URI;\nimport java.net.http.HttpClient;\nimport java.net.http.HttpRequest;\nimport java.net.http.HttpResponse;\n\nHttpClient client = HttpClient.newHttpClient();\nHttpRequest request = HttpRequest.newBuilder()\n        .uri(URI.create(${JSON.stringify(url)}))${headersText ? `\n${headersText}` : ''}\n        ${methodCall}\n        .build();\nHttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());\nSystem.out.println(response.statusCode());\nSystem.out.println(response.body());`;
    }
    if (language === 'postman') return `# Export this request to a Postman Collection first, then run it with the Postman CLI.\npostman collection run ${quoteCli(options.collectionName || 'My Collection')}${options.environmentName ? ` --environment ${quoteCli(options.environmentName)}` : ''}`;
    return Core.toCurl(request);
  }

  return { generateCode, bodyData, makeHeaders };
});
