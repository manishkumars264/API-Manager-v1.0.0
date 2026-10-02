(() => {
  'use strict';

  const Core = window.APIManagerCore;
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const STORAGE_KEY = 'api-manager-workspace-v1';
  const DB_NAME = 'api-manager-local-data';
  const DB_VERSION = 1;
  const HISTORY_LIMIT = 200;
  const NO_RESPONSE = '<div class="response-empty"><div class="response-empty-icon"><svg class="icon"><use href="#i-send"/></svg></div><strong>Ready when you are</strong><p>Configure your request, then press <kbd>⌘ Enter</kbd> or select <b>Send</b>.</p></div>';
  const modalRoot = $('#modal-root');
  const toastRegion = $('#toast-region');
  const importInput = $('#import-file-input');
  let saveTimer = null;
  let db = null;
  let sending = false;
  let closeMenuHandler = null;
  let toastTimerIds = [];

  function emptyRow() { return { key: '', value: '', enabled: true, description: '' }; }
  function newRequest() {
    return {
      name: 'Untitled Request', method: 'GET', url: '', params: [],
      headers: [], auth: { type: 'none' },
      body: { mode: 'none', raw: '', language: 'json', params: [], variables: '{}' },
      preScript: '', postScript: '', timeout: 30000, followRedirects: true, description: ''
    };
  }
  function newTab(request = newRequest(), extras = {}) {
    return {
      id: Core.uid('tab'), request: normalizeRequest(request), saved: false,
      collectionId: null, itemId: null, dirty: false, response: null,
      responseTab: 'body', responseView: 'pretty', wrapLines: false, zoom: 11,
      testResults: [], error: '', ...extras
    };
  }
  function initialState() {
    const tab = newTab();
    return {
      version: 1, tabs: [tab], selectedTabId: tab.id, collections: [], environments: [],
      globals: [], history: [], activeEnvironmentId: '', sidebarView: 'collections',
      activeSection: 'params', expandedCollections: [], expandedFolders: [],
      sidebarCollapsed: false, consoleOpen: false, consoleLog: [], globalSearch: ''
    };
  }
  let state = initialState();

  function normalizeRequest(input = {}) {
    const base = newRequest();
    const request = { ...base, ...Core.clone(input) };
    request.method = String(request.method || 'GET').toUpperCase();
    request.params = Array.isArray(request.params) ? request.params.map(item => ({ ...emptyRow(), ...item })) : [];
    request.headers = Array.isArray(request.headers) ? request.headers.map(item => ({ ...emptyRow(), ...item })) : [];
    request.auth = request.auth && typeof request.auth === 'object' ? { type: 'none', ...request.auth } : { type: 'none' };
    request.body = { ...base.body, ...(request.body || {}) };
    request.body.params = Array.isArray(request.body.params) ? request.body.params.map(item => ({ ...emptyRow(), ...item })) : [];
    request.timeout = Number(request.timeout) || 30000;
    return request;
  }
  function normalizeState(source) {
    const fallback = initialState();
    if (!source || typeof source !== 'object') return fallback;
    const next = { ...fallback, ...source };
    next.tabs = Array.isArray(source.tabs) ? source.tabs.map(tab => newTab(tab.request || newRequest(), {
      ...tab, id: tab.id || Core.uid('tab'), request: normalizeRequest(tab.request || {}),
      response: tab.response || null, testResults: Array.isArray(tab.testResults) ? tab.testResults : []
    })) : fallback.tabs;
    if (!next.tabs.length) next.tabs = fallback.tabs;
    if (!next.tabs.some(tab => tab.id === next.selectedTabId)) next.selectedTabId = next.tabs[0].id;
    next.collections = Array.isArray(source.collections) ? source.collections : [];
    next.environments = Array.isArray(source.environments) ? source.environments : [];
    next.globals = Array.isArray(source.globals) ? source.globals : [];
    next.history = Array.isArray(source.history) ? source.history.slice(0, HISTORY_LIMIT) : [];
    next.consoleLog = Array.isArray(source.consoleLog) ? source.consoleLog.slice(-300) : [];
    next.expandedCollections = Array.isArray(source.expandedCollections) ? source.expandedCollections : [];
    next.expandedFolders = Array.isArray(source.expandedFolders) ? source.expandedFolders : [];
    next.sidebarView = ['collections', 'history', 'environments'].includes(next.sidebarView) ? next.sidebarView : 'collections';
    next.activeSection = ['params', 'authorization', 'headers', 'body', 'pre', 'post', 'settings'].includes(next.activeSection) ? next.activeSection : 'params';
    return next;
  }

  function openDatabase() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    return new Promise(resolve => {
      let request;
      try { request = indexedDB.open(DB_NAME, DB_VERSION); }
      catch { resolve(null); return; }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('workspace')) database.createObjectStore('workspace', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
  function dbGet(database) {
    return new Promise(resolve => {
      if (!database) return resolve(null);
      try {
        const tx = database.transaction('workspace', 'readonly');
        const request = tx.objectStore('workspace').get('session');
        request.onsuccess = () => resolve(request.result?.data || null);
        request.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  async function loadWorkspace() {
    db = await openDatabase();
    const indexed = await dbGet(db);
    if (indexed) return normalizeState(indexed);
    try {
      const text = localStorage.getItem(STORAGE_KEY);
      if (text) return normalizeState(JSON.parse(text));
    } catch (error) { console.warn('Local fallback could not be read:', error); }
    return initialState();
  }
  function persistSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 220);
    const label = $('#save-status');
    if (label) label.textContent = 'Saving…';
  }
  function persistNow() {
    clearTimeout(saveTimer);
    const snapshot = Core.clone(state);
    const fallback = () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); }
      catch (error) {
        const trimmed = Core.clone(snapshot);
        trimmed.history = (trimmed.history || []).map(entry => ({ ...entry, response: entry.response ? { ...entry.response, body: String(entry.response.body || '').slice(0, 40000) } : null }));
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed)); }
        catch { $('#save-status').textContent = 'Storage is full'; return; }
      }
      $('#save-status').textContent = 'Saved locally';
    };
    if (!db) { fallback(); return; }
    try {
      const tx = db.transaction('workspace', 'readwrite');
      tx.objectStore('workspace').put({ key: 'session', data: snapshot });
      tx.oncomplete = () => { const label = $('#save-status'); if (label) label.textContent = 'Saved locally'; };
      tx.onerror = () => { fallback(); };
      tx.onabort = () => { fallback(); };
    } catch { fallback(); }
  }

  const currentTab = () => state.tabs.find(tab => tab.id === state.selectedTabId) || state.tabs[0];
  const activeRequest = () => currentTab().request;
  const getIcon = (name, extra = '') => `<svg class="icon ${extra}"><use href="#i-${name}"/></svg>`;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const attr = value => escapeHtml(value).replace(/\n/g, '&#10;');
  function statusMethodClass(method) { return `method-${String(method || 'get').toLowerCase()}`; }
  function textForMethod(method) { return String(method || 'GET').toUpperCase(); }
  function prettyBytes(size) {
    const bytes = Number(size) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  function activeEnvironment() { return state.environments.find(env => env.id === state.activeEnvironmentId) || null; }
  function listToObject(rows = []) {
    const output = {};
    for (const item of rows) if (item && item.key && item.enabled !== false) output[item.key] = String(item.value ?? '');
    return output;
  }
  function currentVariableResolver() {
    return Core.createVariableResolver(listToObject(activeEnvironment()?.values || []), listToObject(state.globals));
  }
  function markDirty() {
    const tab = currentTab();
    if (!tab) return;
    tab.dirty = true;
    updateRequestTabStrip();
    updateBreadcrumb();
    persistSoon();
  }
  function updateBreadcrumb() {
    const tab = currentTab();
    if (!tab) return;
    const collection = state.collections.find(item => item.id === tab.collectionId);
    $('#breadcrumb-collection').textContent = collection ? collection.name : (tab.saved ? 'My Workspace' : 'New Request');
    $('#breadcrumb-name').textContent = tab.request.name || 'Untitled Request';
    $('#unsaved-indicator').classList.toggle('visible', !!tab.dirty);
  }
  function updateRequestTabStrip() {
    const element = $('#request-tabs');
    const tabs = state.tabs.map(tab => `<div class="request-tab ${tab.id === state.selectedTabId ? 'active' : ''} ${tab.dirty ? 'is-dirty' : ''}" role="tab" aria-selected="${tab.id === state.selectedTabId}" data-tab-id="${attr(tab.id)}" title="${attr(tab.request.name || tab.request.url || 'Untitled Request')}">
      <span class="method-chip ${statusMethodClass(tab.request.method)}">${escapeHtml(tab.request.method)}</span><span class="request-tab-title">${escapeHtml(tab.request.name || 'Untitled Request')}</span><span class="dirty-dot"></span><button type="button" class="request-tab-close" data-close-tab="${attr(tab.id)}" aria-label="Close tab">${getIcon('x')}</button>
    </div>`).join('');
    element.innerHTML = `${tabs}<button type="button" class="request-tab-add" id="request-tab-add" title="New request">${getIcon('plus')}</button>`;
  }
  function updateToolbar() {
    const tab = currentTab();
    if (!tab) return;
    $('#method-select').value = tab.request.method || 'GET';
    $('#method-select').className = `method-select ${statusMethodClass(tab.request.method)}`;
    $('#url-input').value = fullRequestUrl(tab.request);
    $('#url-clear').style.display = tab.request.url ? 'grid' : 'none';
    $('#send-label').textContent = sending ? 'Sending…' : 'Send';
    $('#send-button').disabled = sending;
    $('#headers-count').textContent = (tab.request.headers || []).filter(item => item.key && item.enabled !== false).length || '';
    updateBreadcrumb();
  }
  function fullRequestUrl(request) {
    return Core.formatUrl(request.url || '', request.params || []);
  }
  function updateEnvSelect() {
    const select = $('#environment-select');
    const selected = state.activeEnvironmentId || '';
    select.innerHTML = `<option value="">No environment</option>${state.environments.map(env => `<option value="${attr(env.id)}">${escapeHtml(env.name || 'Environment')}</option>`).join('')}`;
    select.value = state.environments.some(env => env.id === selected) ? selected : '';
    const count = state.history.length;
    $('#history-count').textContent = count ? String(count) : '0';
    $('#collection-count').textContent = String(state.collections.length);
  }
  function renderAll() {
    updateRequestTabStrip();
    updateToolbar();
    updateEnvSelect();
    renderRequestEditor();
    renderResponse();
    renderSidebar();
    renderConsole();
    $('#sidebar').classList.toggle('collapsed', !!state.sidebarCollapsed);
    $('#console-drawer').hidden = !state.consoleOpen;
  }

  function htmlRowsTable(kind, rows, options = {}) {
    const visible = rows.length ? rows : [emptyRow()];
    const desc = !!options.description;
    const rowHtml = visible.map((row, index) => `<tr class="${row.enabled === false ? 'disabled-row' : ''}" data-row-index="${index}">
      <td><input type="checkbox" class="row-check" data-row-enabled="${kind}" data-index="${index}" ${row.enabled === false ? '' : 'checked'} aria-label="Enable row"></td>
      <td><input type="text" data-row-field="key" data-row-kind="${kind}" data-index="${index}" value="${attr(row.key)}" placeholder="Key"></td>
      <td><input type="text" data-row-field="value" data-row-kind="${kind}" data-index="${index}" value="${attr(row.value)}" placeholder="Value"></td>
      ${desc ? `<td><input type="text" data-row-field="description" data-row-kind="${kind}" data-index="${index}" value="${attr(row.description)}" placeholder="Description"></td>` : ''}
      <td><button class="row-delete" type="button" data-delete-row="${kind}" data-index="${index}" title="Remove row">${getIcon('trash')}</button></td>
    </tr>`).join('');
    return `<table class="kv-table"><thead><tr><th><input class="row-check" type="checkbox" disabled aria-label="Enable all"></th><th>Key</th><th>Value</th>${desc ? '<th>Description</th>' : ''}<th></th></tr></thead><tbody>${rowHtml}</tbody></table><div class="table-add-row" role="button" tabindex="0" data-add-row="${kind}">+ Add ${kind === 'params' ? 'parameter' : kind === 'headers' ? 'header' : 'field'}</div>`;
  }

  const AUTH_LABELS = {
    none: 'No Auth', inherit: 'Inherit auth from parent', apikey: 'API Key', bearer: 'Bearer Token', basic: 'Basic Auth',
    digest: 'Digest Auth', oauth2: 'OAuth 2.0', oauth1: 'OAuth 1.0', hawk: 'Hawk Authentication',
    aws: 'AWS Signature', edgegrid: 'Akamai EdgeGrid', ntlm: 'NTLM Authentication', jwt: 'JWT Bearer'
  };
  function authFieldHtml(field, auth) {
    const value = auth[field.key] ?? field.default ?? '';
    const full = field.full ? ' full' : '';
    const help = field.help ? `<span class="field-note">${escapeHtml(field.help)}</span>` : '';
    let control = '';
    if (field.type === 'select') {
      control = `<select data-auth-field="${attr(field.key)}">${field.options.map(item => `<option value="${attr(item.value)}" ${String(value) === String(item.value) ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select>`;
    } else if (field.type === 'checkbox') {
      control = `<label class="radio-pill"><input type="checkbox" data-auth-checkbox="${attr(field.key)}" ${value ? 'checked' : ''}> ${escapeHtml(field.checkboxLabel || field.label)}</label>`;
    } else if (field.type === 'textarea') {
      control = `<textarea data-auth-field="${attr(field.key)}" spellcheck="false" placeholder="${attr(field.placeholder || '')}">${escapeHtml(value)}</textarea>`;
    } else if (field.secret) {
      control = `<div class="password-wrap"><input type="password" data-auth-field="${attr(field.key)}" value="${attr(value)}" placeholder="${attr(field.placeholder || '')}" autocomplete="off"><button type="button" class="reveal-secret" title="Show value">◉</button></div>`;
    } else {
      control = `<input type="${field.type === 'number' ? 'number' : 'text'}" data-auth-field="${attr(field.key)}" value="${attr(value)}" placeholder="${attr(field.placeholder || '')}" ${field.type === 'number' ? 'min="1"' : ''} autocomplete="off">`;
    }
    return `<div class="auth-field${full}"><label>${escapeHtml(field.label)}</label>${control}${help}</div>`;
  }
  function authFields(auth) {
    const type = auth.type || 'none';
    const text = (key, label, opts = {}) => ({ key, label, ...opts });
    const select = (key, label, options, opts = {}) => ({ key, label, type: 'select', options, ...opts });
    if (type === 'apikey') return [text('key', 'Key name', { placeholder: 'x-api-key' }), text('value', 'Value', { secret: true }), select('addTo', 'Add to', [{ value: 'header', label: 'Header' }, { value: 'query', label: 'Query parameters' }], { default: 'header' })];
    if (type === 'bearer') return [text('token', 'Token', { secret: true, full: true }), text('prefix', 'Token prefix', { default: 'Bearer', help: 'Use an empty prefix for a raw token.' })];
    if (type === 'basic') return [text('username', 'Username'), text('password', 'Password', { secret: true })];
    if (type === 'digest') return [text('username', 'Username'), text('password', 'Password', { secret: true }), { key: '_digest-note', label: 'Digest challenge-response is negotiated locally by the request proxy.', type: 'note', full: true }];
    if (type === 'oauth2') return [
      select('grantType', 'Grant type', [{ value: 'token', label: 'Access token' }, { value: 'client_credentials', label: 'Client Credentials' }], { default: 'token' }),
      select('tokenPlacement', 'Add token to', [{ value: 'header', label: 'Request Headers' }, { value: 'query', label: 'Query Params' }], { default: 'header' }),
      text('accessToken', 'Access token', { secret: true, full: true }),
      text('tokenPrefix', 'Token prefix', { default: 'Bearer', help: 'Used when the token is added to a request header.' }),
      text('tokenParam', 'Query parameter name', { default: 'access_token' }),
      text('tokenUrl', 'Access token URL', { full: true }),
      text('clientId', 'Client ID'), text('clientSecret', 'Client secret', { secret: true }),
      text('scope', 'Scope'), select('clientAuth', 'Client authentication', [{ value: 'header', label: 'Send as Basic auth header' }, { value: 'body', label: 'Send client credentials in body' }], { default: 'header' }),
      { key: '_oauth-note', label: 'The Client Credentials flow requests a token at send time. Other OAuth flows can use a token pasted into Access token.', type: 'note', full: true }
    ];
    if (type === 'oauth1') return [text('consumerKey', 'Consumer key'), text('consumerSecret', 'Consumer secret', { secret: true }), text('token', 'Access token'), text('tokenSecret', 'Token secret', { secret: true }), select('signatureMethod', 'Signature method', [{ value: 'HMAC-SHA1', label: 'HMAC-SHA1' }, { value: 'HMAC-SHA256', label: 'HMAC-SHA256' }, { value: 'PLAINTEXT', label: 'PLAINTEXT' }, { value: 'RSA-SHA1', label: 'RSA-SHA1' }], { default: 'HMAC-SHA1' }), text('realm', 'Realm'), text('callback', 'Callback URL'), text('verifier', 'Verifier'), { key: 'privateKey', label: 'RSA private key (PEM)', type: 'textarea', full: true }, { key: '_oauth1-note', label: 'OAuth 1.0 signatures are generated locally using HMAC-SHA1, HMAC-SHA256, PLAINTEXT, or RSA-SHA1.', type: 'note', full: true }];
    if (type === 'hawk') return [text('id', 'ID'), text('key', 'Key', { secret: true }), select('algorithm', 'Algorithm', [{ value: 'sha256', label: 'SHA-256' }, { value: 'sha1', label: 'SHA-1' }], { default: 'sha256' }), text('ext', 'Extra data'), { key: 'hashPayload', label: 'Hash request payload', type: 'checkbox', default: false }, { key: '_hawk-note', label: 'Hawk request MACs are calculated locally. Payload hashing is optional and most often used for non-empty request bodies.', type: 'note', full: true }];
    if (type === 'aws') return [text('accessKey', 'Access key ID'), text('secretKey', 'Secret access key', { secret: true }), text('region', 'AWS region', { default: 'us-east-1' }), text('service', 'Service name', { default: 'execute-api' }), text('sessionToken', 'Session token (optional)', { secret: true, full: true }), { key: '_aws-note', label: 'AWS Signature Version 4 is signed locally. Keep credentials private; they are sent only to your request destination.', type: 'note', full: true }];
    if (type === 'edgegrid') return [text('clientToken', 'Client token'), text('accessToken', 'Access token'), text('clientSecret', 'Client secret', { secret: true, full: true }), { key: '_edgegrid-note', label: 'Akamai EdgeGrid EG1-HMAC-SHA256 signatures are generated locally for each request.', type: 'note', full: true }];
    if (type === 'ntlm') return [text('username', 'Username'), text('password', 'Password', { secret: true }), text('domain', 'Domain'), text('workstation', 'Workstation'), { key: '_ntlm-note', label: 'NTLMv2 challenge-response negotiation runs in the local request proxy.', type: 'note', full: true }];
    if (type === 'jwt') return [select('algorithm', 'Signing algorithm', [{ value: 'HS256', label: 'HS256' }, { value: 'HS384', label: 'HS384' }, { value: 'HS512', label: 'HS512' }], { default: 'HS256' }), text('secret', 'Secret', { secret: true }), text('prefix', 'Token prefix', { default: 'Bearer' }), text('payload', 'JWT payload claims (JSON)', { type: 'textarea', full: true, default: '{}' }), text('header', 'JWT header overrides (JSON)', { type: 'textarea', full: true, default: '{}' }), { key: 'addIat', label: 'Add issued-at (iat) claim', type: 'checkbox', default: true }, { key: '_jwt-note', label: 'API Manager signs HMAC JWTs locally using HS256, HS384, or HS512.', type: 'note', full: true }];
    return [];
  }
  function renderAuthEditor(tab) {
    const auth = tab.request.auth || { type: 'none' };
    const fieldHtml = authFields(auth).map(field => field.type === 'note' ? `<div class="auth-notice">${escapeHtml(field.label)}</div>` : authFieldHtml(field, auth)).join('');
    const notice = auth.type === 'none' ? 'This request does not use an authorization helper. Any Authorization header you add manually is sent as entered.' : auth.type === 'inherit' ? 'Authorization inheritance is shown for Postman collection compatibility. This standalone request has no parent request to inherit from.' : '';
    return `<div class="editor-section"><div class="editor-section-title"><strong>Authorization</strong><span>Credentials are saved only in this browser.</span></div><div class="auth-layout"><div><label class="modal-label" for="auth-type-select">Auth Type</label><select class="auth-type-select" id="auth-type-select">${Object.entries(AUTH_LABELS).map(([key, label]) => `<option value="${key}" ${key === auth.type ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>${auth.type === 'inherit' ? '<div class="auth-inherit">Parent authentication is not available in a standalone request.</div>' : ''}</div><div class="auth-fields">${notice ? `<div class="auth-notice">${escapeHtml(notice)}</div>` : fieldHtml}</div></div></div>`;
  }
  function renderBodyEditor(tab) {
    const body = tab.request.body;
    const modes = [['none', 'none'], ['raw', 'raw'], ['urlencoded', 'x-www-form-urlencoded'], ['formdata', 'form-data'], ['graphql', 'GraphQL']];
    const radioHtml = modes.map(([key, label]) => `<label class="radio-pill"><input type="radio" name="body-mode" data-body-mode="${key}" ${body.mode === key ? 'checked' : ''}> ${label}</label>`).join('');
    let content = '';
    if (body.mode === 'raw') {
      const language = body.language || 'json';
      content = `<div class="body-toolbar"><div class="editor-help">Choose a raw body type. SOAP requests use a raw XML envelope with the SOAP-specific controls below.</div><select class="body-language" data-body-language aria-label="Body language">${[['json','JSON'],['xml','XML'],['text','Text'],['javascript','JavaScript'],['html','HTML']].map(([key,label]) => `<option value="${key}" ${language === key ? 'selected' : ''}>${label}</option>`).join('')}</select><button class="secondary-button" type="button" id="beautify-request-body">${getIcon('code')} Beautify</button></div>${language === 'xml' ? `<div class="soap-fields"><select data-soap-version><option value="1.1" ${body.soapVersion !== '1.2' ? 'selected' : ''}>SOAP 1.1</option><option value="1.2" ${body.soapVersion === '1.2' ? 'selected' : ''}>SOAP 1.2</option></select><input type="text" data-soap-action value="${attr(body.soapAction || '')}" placeholder="SOAPAction (optional)"><button type="button" class="secondary-button" id="soap-template-button">Insert SOAP envelope</button></div>` : ''}<div class="body-editor-wrap"><div class="line-numbers" id="request-line-numbers">1</div><textarea class="body-editor" data-body-raw spellcheck="false" placeholder="Enter request body…">${escapeHtml(body.raw || '')}</textarea></div>`;
    } else if (body.mode === 'urlencoded' || body.mode === 'formdata') {
      content = `<p class="editor-help">${body.mode === 'formdata' ? 'Text multipart fields are supported. File attachments are not included in this local-first initial release.' : 'Fields are sent as application/x-www-form-urlencoded.'}</p>${htmlRowsTable('bodyparams', body.params || [])}`;
    } else if (body.mode === 'graphql') {
      content = `<p class="editor-help">GraphQL requests are sent as JSON with query and variables.</p><div class="body-editor-wrap"><div class="line-numbers">1</div><textarea class="body-editor" data-body-raw spellcheck="false" placeholder="query { hello }">${escapeHtml(body.raw || '')}</textarea></div><div class="form-row" style="margin-top:10px"><label class="modal-label">Variables (JSON)</label><textarea class="modal-textarea" data-body-variables spellcheck="false" placeholder="{}">${escapeHtml(body.variables || '{}')}</textarea></div>`;
    } else {
      content = `<div class="empty-list" style="text-align:left;padding:20px 4px"><strong>No request body</strong><span>Select raw, form-data, or x-www-form-urlencoded to add a body.</span></div>`;
    }
    return `<div class="editor-section"><div class="editor-section-title"><strong>Request Body</strong><span>Body type</span></div><div class="body-toolbar"><div class="body-mode-group">${radioHtml}</div></div>${content}</div>`;
  }
  function renderRequestEditor() {
    const tab = currentTab();
    const section = state.activeSection;
    $$('.section-tab').forEach(button => button.classList.toggle('active', button.dataset.section === section));
    let html = '';
    if (section === 'params') {
      const rows = tab.request.params || [];
      html = `<div class="editor-section"><div class="editor-section-title"><strong>Query Params</strong><span>Parameters are appended to the request URL.</span></div>${htmlRowsTable('params', rows, { description: true })}</div>`;
    } else if (section === 'authorization') html = renderAuthEditor(tab);
    else if (section === 'headers') {
      html = `<div class="editor-section"><div class="editor-section-title"><strong>Request Headers</strong><span>Headers set by an authorization helper may not appear here.</span></div>${htmlRowsTable('headers', tab.request.headers || [], { description: true })}</div>`;
    } else if (section === 'body') html = renderBodyEditor(tab);
    else if (section === 'pre') {
      html = `<div class="editor-section"><div class="script-head"><div><strong style="font-size:11px">Pre-request Script</strong><p class="editor-help">Runs locally immediately before the request. Set environment/global variables with <code>pm.environment.set()</code>.</p></div><button class="secondary-button" type="button" data-script-example="pre">Insert example</button></div><textarea class="script-editor" data-script="pre" spellcheck="false" placeholder="// Example: pm.environment.set('startedAt', new Date().toISOString());">${escapeHtml(tab.request.preScript || '')}</textarea><div class="script-reference">Available: <code>pm.environment</code>, <code>pm.globals</code>, <code>pm.variables</code>, <code>pm.request</code>, <code>console</code>.</div></div>`;
    } else if (section === 'post') {
      html = `<div class="editor-section"><div class="script-head"><div><strong style="font-size:11px">Post-response Script</strong><p class="editor-help">Runs locally after a response. Add assertions with <code>pm.test()</code> and inspect data with <code>pm.response.json()</code>.</p></div><button class="secondary-button" type="button" data-script-example="post">Insert example</button></div><textarea class="script-editor" data-script="post" spellcheck="false" placeholder="pm.test('Status is successful', () => pm.response.to.have.status(200));">${escapeHtml(tab.request.postScript || '')}</textarea><div class="script-reference">This initial sandbox exposes Postman-style environment, variable, request and response helpers; script execution is isolated in a worker.</div></div>`;
    } else if (section === 'settings') {
      html = `<div class="editor-section"><div class="editor-section-title"><strong>Request Settings</strong><span>Settings apply to this request only.</span></div><div class="settings-grid"><div class="setting-row"><div class="setting-info"><strong>Request timeout</strong><span>Stop waiting after this many milliseconds (1–120,000).</span></div><input type="number" min="1000" max="120000" step="1000" data-request-setting="timeout" value="${attr(tab.request.timeout || 30000)}"></div><div class="setting-row"><div class="setting-info"><strong>Automatically follow redirects</strong><span>Follow HTTP 3xx responses to their destination.</span></div><input type="checkbox" data-request-setting="followRedirects" ${tab.request.followRedirects === false ? '' : 'checked'}></div></div><div class="variable-reference"><b>Dynamic variables</b><br>Use <code>{{$timestamp}}</code>, <code>{{$isoTimestamp}}</code>, <code>{{$guid}}</code>, <code>{{$randomInt}}</code>, <code>{{$randomUUID}}</code>, <code>{{$randomEmail}}</code>, <code>{{$randomFirstName}}</code>, <code>{{$randomLastName}}</code>, <code>{{$randomPassword}}</code>, <code>{{$randomPhoneNumber}}</code>, or define your own environment and global variables using <code>{{name}}</code>.</div></div>`;
    }
    $('#request-editor').innerHTML = html;
    updateLineNumbers();
  }

  function highlightJson(text) {
    const escaped = escapeHtml(text);
    return escaped.replace(/("(?:\\.|[^"\\])*")\s*:/g, '<span class="json-key">$1</span>:')
      .replace(/(:\s*)("(?:\\.|[^"\\])*"|\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/g, (match, prefix, value) => {
        const klass = value[0] === '"' ? 'json-string' : value === 'true' || value === 'false' ? 'json-bool' : value === 'null' ? 'json-null' : 'json-number';
        return `${prefix}<span class="${klass}">${value}</span>`;
      });
  }
  function prettifyJson(text) {
    try { return JSON.stringify(JSON.parse(String(text)), null, 2); }
    catch { return null; }
  }
  function beautifyXml(source) {
    try {
      const input = String(source).replace(/>\s*</g, '><').trim();
      if (!input.startsWith('<')) return null;
      let depth = 0;
      return input.replace(/(<[^>]+>)/g, token => {
        if (/^<\//.test(token)) depth = Math.max(0, depth - 1);
        const line = `${'  '.repeat(depth)}${token}`;
        if (/^<[^!?/][^>]*[^/]?>$/.test(token) && !/<\/?[^>]+>.*<\/?[^>]+>/.test(token)) depth++;
        return line;
      }).replace(/\n{2,}/g, '\n');
    } catch { return null; }
  }
  function responseBody(tab) {
    const body = String(tab.response?.body ?? '');
    if (tab.responseView === 'raw') return body;
    if (tab.responseFormatted) return tab.responseFormatted;
    const json = prettifyJson(body);
    if (json !== null) return json;
    const contentType = String(tab.response?.headers?.['content-type'] || '').toLowerCase();
    if (contentType.includes('xml') && tab.responseView === 'pretty') return beautifyXml(body) || body;
    return body;
  }
  function responseLanguage(tab) {
    const contentType = String(tab.response?.headers?.['content-type'] || '').toLowerCase();
    if (contentType.includes('json') || prettifyJson(tab.response?.body || '') !== null) return 'JSON';
    if (contentType.includes('xml')) return 'XML';
    if (contentType.includes('html')) return 'HTML';
    if (contentType.includes('javascript')) return 'JavaScript';
    return 'TEXT';
  }
  function responseCookies(tab) {
    const raw = tab.response?.headers?.['set-cookie'] || '';
    return raw.split(/\n|,(?=[^;,]+=)/).filter(Boolean).map(item => {
      const [pair, ...rest] = item.split(';');
      const index = pair.indexOf('=');
      return { name: index >= 0 ? pair.slice(0, index).trim() : pair.trim(), value: index >= 0 ? pair.slice(index + 1).trim() : '', attributes: rest.join(';').trim() };
    });
  }
  function renderResponse() {
    const tab = currentTab();
    const response = tab.response;
    const content = $('#response-content');
    const actions = $$('.response-tool');
    const hasResponse = !!response;
    actions.forEach(button => { button.disabled = !hasResponse; });
    $('#response-view-mode').disabled = !hasResponse;
    $('#response-language').textContent = response ? responseLanguage(tab) : '—';
    $('#response-view-mode').value = tab.responseView || 'pretty';
    $('#wrap-button').classList.toggle('active', !!tab.wrapLines);
    $('#zoom-in-button').disabled = !hasResponse || (tab.zoom || 11) >= 22;
    $('#zoom-out-button').disabled = !hasResponse || (tab.zoom || 11) <= 8;
    $$('#response-tabs button').forEach(button => button.classList.toggle('active', button.dataset.responseTab === (tab.responseTab || 'body')));
    $('#cookie-count').textContent = response ? String(responseCookies(tab).length || '') : '';
    $('#response-header-count').textContent = response ? String(Object.keys(response.headers || {}).length || '') : '';
    $('#response-meta').innerHTML = response ? `<span class="response-status ${response.status >= 200 && response.status < 300 ? 'ok' : response.status >= 400 ? 'bad' : 'warn'}">${escapeHtml(response.status)} ${escapeHtml(response.statusText || '')}</span><span class="response-duration">${escapeHtml(response.duration ?? 0)} ms</span><span class="response-size">${prettyBytes(new TextEncoder().encode(String(response.body || '')).length)}</span>` : '';
    $('#response-summary').textContent = tab.error ? 'Request failed' : response ? `Response from ${response.url || tab.lastResolvedUrl || 'request'}` : 'Send a request to see the response';
    if (tab.error) {
      content.innerHTML = `<div class="response-error"><strong>Request error</strong><br>${escapeHtml(tab.error)}</div>`;
      return;
    }
    if (!response) { content.innerHTML = NO_RESPONSE; return; }
    const active = tab.responseTab || 'body';
    if (active === 'headers') {
      const rows = Object.entries(response.headers || {}).map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join('');
      content.innerHTML = `<table class="response-table"><tbody>${rows || '<tr><td colspan="2">No response headers.</td></tr>'}</tbody></table>`;
      return;
    }
    if (active === 'cookies') {
      const cookies = responseCookies(tab);
      content.innerHTML = cookies.length ? `<table class="response-table"><tbody>${cookies.map(cookie => `<tr><th>${escapeHtml(cookie.name)}</th><td>${escapeHtml(cookie.value)}${cookie.attributes ? `<br><small>${escapeHtml(cookie.attributes)}</small>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-list">No cookies in this response.</div>';
      return;
    }
    if (active === 'tests') {
      content.innerHTML = `<div class="test-results"><h4>Test Results <span class="section-count">${tab.testResults.length}</span></h4>${tab.testResults.length ? tab.testResults.map(test => `<div class="test-result ${test.passed ? '' : 'fail'}">${getIcon(test.passed ? 'check' : 'x')}<strong>${escapeHtml(test.name)}</strong>${test.error ? ` — ${escapeHtml(test.error)}` : ''}</div>`).join('') : '<div class="empty-list" style="padding:12px">No post-response tests were run for this request.</div>'}</div>`;
      return;
    }
    if (tab.responseView === 'preview' && /html/i.test(response.headers?.['content-type'] || '')) {
      content.innerHTML = `<iframe class="preview-frame" sandbox="" title="Response preview"></iframe>`;
      $('.preview-frame', content).srcdoc = response.body || '';
      return;
    }
    const output = responseBody(tab);
    const code = responseLanguage(tab) === 'JSON' ? highlightJson(output) : escapeHtml(output);
    content.innerHTML = `<div class="response-body-wrap"><pre class="response-code ${tab.wrapLines ? 'wrap-lines' : ''}" style="font-size:${Number(tab.zoom) || 11}px"><code>${code}</code></pre></div>`;
  }

  function renderCollectionTree(items, collectionId, depth = 0) {
    return (items || []).map(item => {
      const isFolder = Array.isArray(item.items);
      const expanded = state.expandedFolders.includes(item.id);
      const indent = depth ? `<span class="tree-indent" style="margin-left:${Math.min(depth, 6) * 13}px"></span>` : '';
      if (isFolder) return `<div class="tree-row folder-tree-row" data-folder-row="${attr(item.id)}" data-collection-id="${attr(collectionId)}">${indent}<button class="tree-toggle" type="button" data-toggle-folder="${attr(item.id)}">${getIcon(expanded ? 'chevron-down' : 'chevron')}</button>${getIcon('folder')}<span class="tree-name">${escapeHtml(item.name || 'Folder')}</span><span class="tree-actions"><button type="button" title="Folder options" data-tree-action="folder-menu" data-id="${attr(item.id)}" data-collection-id="${attr(collectionId)}">${getIcon('more')}</button></span></div>${expanded ? renderCollectionTree(item.items, collectionId, depth + 1) : ''}`;
      const req = item.request || {};
      return `<div class="tree-row request-tree-row" data-open-item="${attr(item.id)}" data-collection-id="${attr(collectionId)}" title="${attr(req.url || item.name)}">${indent}<span class="tree-toggle"></span><span class="tree-method ${statusMethodClass(req.method)}">${escapeHtml(req.method || 'GET')}</span><span class="tree-name">${escapeHtml(item.name || 'Request')}</span><span class="tree-actions"><button type="button" title="Request options" data-tree-action="request-menu" data-id="${attr(item.id)}" data-collection-id="${attr(collectionId)}">${getIcon('more')}</button></span></div>`;
    }).join('');
  }
  function collectionHasSearch(collection, term) {
    if (!term) return true;
    const contains = items => (items || []).some(item => String(item.name || '').toLowerCase().includes(term) || (item.request && `${item.request.method} ${item.request.url}`.toLowerCase().includes(term)) || contains(item.items));
    return String(collection.name || '').toLowerCase().includes(term) || contains(collection.items);
  }
  function renderSidebar() {
    const activeView = state.sidebarView;
    $$('.sidebar-nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === activeView));
    const title = { collections: 'COLLECTIONS', history: 'HISTORY', environments: 'ENVIRONMENTS' }[activeView];
    $('#sidebar-content-title').textContent = title;
    $('#sidebar-add-button').title = activeView === 'collections' ? 'Create collection' : activeView === 'environments' ? 'Create environment' : 'Refresh history';
    const root = $('#sidebar-content');
    const term = String(state.globalSearch || '').trim().toLowerCase();
    if (activeView === 'collections') {
      const list = state.collections.filter(collection => collectionHasSearch(collection, term));
      root.innerHTML = list.length ? `<div class="collection-tree">${list.map(collection => {
        const expanded = state.expandedCollections.includes(collection.id) || !!term;
        return `<div class="tree-row collection-tree-row" data-collection-row="${attr(collection.id)}"><button class="tree-toggle" type="button" data-toggle-collection="${attr(collection.id)}">${getIcon(expanded ? 'chevron-down' : 'chevron')}</button>${getIcon('folder')}<span class="tree-name">${escapeHtml(collection.name || 'Collection')}</span><span class="tree-actions"><button type="button" title="Collection options" data-tree-action="collection-menu" data-id="${attr(collection.id)}">${getIcon('more')}</button></span></div>${expanded ? renderCollectionTree(collection.items, collection.id) : ''}`;
      }).join('')}</div>` : `<div class="empty-list"><div class="empty-icon">${getIcon('folder')}</div><strong>${term ? 'No matches' : 'No collections yet'}</strong>${term ? 'Try a different search.' : 'Create a collection or import a Postman collection to get started.'}</div>`;
    } else if (activeView === 'history') {
      const rows = state.history.filter(entry => !term || `${entry.request?.method} ${entry.request?.url} ${entry.resolvedUrl}`.toLowerCase().includes(term));
      root.innerHTML = rows.length ? rows.map(entry => {
        const response = entry.response || {};
        const status = response.status || (entry.error ? 'ERR' : '—');
        return `<div class="history-card" data-history-card="${attr(entry.id)}"><div class="history-card-top"><span class="history-method ${statusMethodClass(entry.request?.method)}">${escapeHtml(entry.request?.method || 'GET')}</span><span class="history-url" title="${attr(entry.resolvedUrl || entry.request?.url)}">${escapeHtml(entry.resolvedUrl || entry.request?.url || '(no URL)')}</span><span class="history-card-time">${escapeHtml(formatRelativeDate(entry.createdAt))}</span></div><div class="history-card-bottom"><span class="history-status ${Number(status) >= 400 || status === 'ERR' ? 'bad' : 'ok'}">${escapeHtml(status)}${response.duration != null ? ` · ${escapeHtml(response.duration)} ms` : ''}</span><div class="history-actions"><button type="button" data-history-action="open" data-id="${attr(entry.id)}">Open</button><button type="button" data-history-action="run" data-id="${attr(entry.id)}">Run again</button></div></div></div>`;
      }).join('') : `<div class="empty-list"><div class="empty-icon">${getIcon('clock')}</div><strong>${term ? 'No history matches' : 'No requests in history'}</strong>${term ? 'Try a different search.' : 'Every API run is saved here on this device (up to 200).'}<br><br>${state.history.length ? '<button class="text-button" type="button" data-clear-history>Clear history</button>' : ''}</div>`;
    } else {
      root.innerHTML = `<div class="sidebar-env-tools"><button class="secondary-button" type="button" data-manage-globals>${getIcon('settings')} Manage globals</button><button class="secondary-button" type="button" data-import-env>Import</button></div>${state.environments.length ? state.environments.filter(env => !term || String(env.name).toLowerCase().includes(term)).map(env => `<div class="env-card ${state.activeEnvironmentId === env.id ? 'active' : ''}" data-env-card="${attr(env.id)}"><div class="env-card-top"><div class="env-card-name">${escapeHtml(env.name || 'Environment')}</div><div class="env-card-actions"><button type="button" data-env-action="export" data-id="${attr(env.id)}" title="Export">${getIcon('download')}</button><button type="button" data-env-action="edit" data-id="${attr(env.id)}" title="Edit">${getIcon('settings')}</button><button type="button" data-env-action="delete" data-id="${attr(env.id)}" title="Delete">${getIcon('trash')}</button></div></div><div class="env-card-meta">${(env.values || []).filter(item => item.key).length} variable${(env.values || []).filter(item => item.key).length === 1 ? '' : 's'}${state.activeEnvironmentId === env.id ? ' · Active' : ''}</div></div>`).join('') : '<div class="empty-list"><div class="empty-icon">' + getIcon('globe') + '</div><strong>No environments yet</strong>Create an environment to keep base URLs, tokens and other values organized locally.</div>'}<div class="sidebar-env-create"><button class="secondary-button" type="button" data-create-env>${getIcon('plus')} New environment</button></div>`;
    }
    $('#sidebar').classList.toggle('collapsed', !!state.sidebarCollapsed);
  }
  function formatRelativeDate(value) {
    const date = new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return 'now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return date.toLocaleDateString();
  }

  function renderConsole() {
    const root = $('#console-log-list');
    $('#console-drawer').hidden = !state.consoleOpen;
    $('#console-log-count').textContent = String(state.consoleLog.length);
    root.innerHTML = state.consoleLog.slice(-200).map(log => `<div class="console-log-row"><span class="console-log-time">${escapeHtml(new Date(log.time).toLocaleTimeString())}</span><span class="console-log-level ${log.level === 'error' ? 'error' : ''}">${escapeHtml(log.level || 'info').toUpperCase()}</span><span class="console-log-message">${escapeHtml(log.message)}</span></div>`).join('') || '<div class="empty-list">Console output appears here when you send requests or run scripts.</div>';
    root.scrollTop = root.scrollHeight;
  }
  function addLog(level, message) {
    state.consoleLog.push({ time: Date.now(), level, message: String(message) });
    state.consoleLog = state.consoleLog.slice(-300);
    if (state.consoleOpen) renderConsole();
    persistSoon();
  }

  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'error' : ''}`;
    toast.innerHTML = `<span class="toast-mark">${type === 'error' ? getIcon('x') : '✓'}</span><span>${escapeHtml(message)}</span>`;
    toastRegion.appendChild(toast);
    const timer = setTimeout(() => { toast.remove(); }, 3000);
    toastTimerIds.push(timer);
  }
  async function copyText(text, label = 'Copied to clipboard') {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(String(text));
      else throw new Error('Clipboard API unavailable');
      showToast(label);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = String(text); textarea.style.position = 'fixed'; textarea.style.opacity = '0';
      document.body.appendChild(textarea); textarea.select();
      const ok = document.execCommand('copy'); textarea.remove();
      showToast(ok ? label : 'Unable to copy. Select and copy the text manually.', ok ? 'success' : 'error');
    }
  }
  function downloadText(filename, text, mime = 'application/json') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }
  function safeFilename(name) { return String(name || 'api-manager').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'api-manager'; }

  function openModal(config) {
    const { title, subtitle = '', body = '', footer = '', size = 'normal', close = true } = config;
    modalRoot.innerHTML = `<div class="modal-backdrop" data-backdrop><div class="modal ${size === 'wide' ? 'wide' : size === 'narrow' ? 'narrow' : ''}" role="dialog" aria-modal="true" aria-label="${attr(title)}"><div class="modal-header"><div class="modal-heading-copy"><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>${close ? `<button class="modal-close" type="button" data-modal-close aria-label="Close">${getIcon('x')}</button>` : ''}</div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}</div></div>`;
    const backdrop = $('[data-backdrop]', modalRoot);
    backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) closeModal(); });
    const focusable = $('input:not([type=hidden]),textarea,select,button', modalRoot);
    setTimeout(() => focusable?.focus(), 20);
  }
  function closeModal() { modalRoot.innerHTML = ''; }
  function modalInput(name, label, value = '', placeholder = '') {
    return `<div class="form-row"><label class="modal-label" for="${attr(name)}">${escapeHtml(label)}</label><input class="modal-input" id="${attr(name)}" value="${attr(value)}" placeholder="${attr(placeholder)}"></div>`;
  }
  function askConfirm(title, text, confirmLabel = 'Delete', danger = true) {
    return new Promise(resolve => {
      openModal({ title, size: 'narrow', body: `<p style="font-size:11px;line-height:1.6;color:#666;margin:0">${escapeHtml(text)}</p>`, footer: `<button type="button" class="plain-button" data-confirm-cancel>Cancel</button><button type="button" class="${danger ? 'danger-button' : 'primary-button'}" data-confirm-yes>${escapeHtml(confirmLabel)}</button>` });
      $('[data-confirm-cancel]', modalRoot).onclick = () => { closeModal(); resolve(false); };
      $('[data-confirm-yes]', modalRoot).onclick = () => { closeModal(); resolve(true); };
    });
  }

  function createCollectionModal(initialName = '') {
    openModal({ title: 'Create collection', subtitle: 'Organize requests in a local collection.', size: 'narrow', body: `${modalInput('collection-name', 'Collection name', initialName, 'e.g. Customer API')}<div class="form-row"><label class="modal-label" for="collection-description">Description <span style="font-weight:400;color:#999">(optional)</span></label><textarea class="modal-textarea" id="collection-description" placeholder="What does this collection contain?"></textarea></div>`, footer: '<button type="button" class="plain-button" data-modal-close>Cancel</button><button type="button" class="primary-button" id="create-collection-confirm">Create collection</button>' });
    $('#create-collection-confirm', modalRoot).onclick = () => {
      const name = $('#collection-name', modalRoot).value.trim();
      if (!name) { showToast('Give the collection a name.', 'error'); return; }
      const collection = { id: Core.uid('collection'), name, description: $('#collection-description', modalRoot).value.trim(), items: [], variables: [], auth: { type: 'none' } };
      state.collections.push(collection); state.expandedCollections.push(collection.id); closeModal(); persistSoon(); renderAll(); showToast(`Created “${name}”`);
    };
  }
  function openSaveRequestModal() {
    const tab = currentTab();
    const collections = state.collections;
    const selectedCollection = tab.collectionId && collections.some(item => item.id === tab.collectionId) ? tab.collectionId : collections[0]?.id || '';
    const body = `<div class="form-row"><label class="modal-label" for="save-request-name">Request name</label><input class="modal-input" id="save-request-name" value="${attr(tab.request.name || 'Untitled Request')}" placeholder="Request name"></div><div class="form-row"><label class="modal-label" for="save-request-collection">Save to collection</label><select class="modal-select" id="save-request-collection">${collections.map(collection => `<option value="${attr(collection.id)}" ${collection.id === selectedCollection ? 'selected' : ''}>${escapeHtml(collection.name)}</option>`).join('')}<option value="__new">+ Create new collection…</option></select>${collections.length ? '' : '<p class="modal-help">Create a collection first, or use the new collection option.</p>'}</div>`;
    openModal({ title: tab.saved ? 'Save request changes' : 'Save request', subtitle: 'This request and its settings remain on this device.', size: 'narrow', body, footer: '<button type="button" class="plain-button" data-modal-close>Cancel</button><button type="button" class="primary-button" id="save-request-confirm">Save</button>' });
    $('#save-request-collection', modalRoot).addEventListener('change', event => {
      if (event.target.value === '__new') { closeModal(); createCollectionModal(); }
    });
    $('#save-request-confirm', modalRoot).onclick = () => {
      const name = $('#save-request-name', modalRoot).value.trim() || 'Untitled Request';
      const collectionId = $('#save-request-collection', modalRoot).value;
      if (!collectionId || collectionId === '__new') { showToast('Choose a collection.', 'error'); return; }
      const collection = state.collections.find(item => item.id === collectionId);
      if (!collection) { showToast('That collection no longer exists.', 'error'); return; }
      tab.request.name = name;
      tab.collectionId = collectionId;
      let item = findCollectionItem(collection, tab.itemId);
      if (!item) {
        item = { id: Core.uid('request'), name, request: Core.clone(tab.request) };
        collection.items.push(item); tab.itemId = item.id;
      } else { item.name = name; item.request = Core.clone(tab.request); }
      tab.saved = true; tab.dirty = false;
      if (!state.expandedCollections.includes(collectionId)) state.expandedCollections.push(collectionId);
      closeModal(); persistSoon(); renderAll(); showToast('Request saved locally');
    };
  }
  function findCollectionItem(collection, id, items = collection?.items || []) {
    if (!id) return null;
    for (const item of items) {
      if (item.id === id) return item;
      if (Array.isArray(item.items)) { const nested = findCollectionItem(collection, id, item.items); if (nested) return nested; }
    }
    return null;
  }
  function findItemLocation(itemId) {
    for (const collection of state.collections) {
      const item = findCollectionItem(collection, itemId);
      if (item) return { collection, item };
    }
    return null;
  }
  function findTabForItem(itemId) { return state.tabs.find(tab => tab.itemId === itemId) || null; }

  function openVariableEditor({ id = null, globals = false, isNew = false } = {}) {
    const target = globals ? { id: 'globals', name: 'Global variables', values: state.globals } : state.environments.find(env => env.id === id);
    const title = globals ? 'Manage global variables' : (isNew ? 'Create environment' : 'Edit environment');
    const values = target?.values || [];
    const rows = values.length ? values : [emptyRow()];
    const variableRows = rows.map((row, index) => `<tr class="variable-editor-row" data-index="${index}"><td><input class="row-check" type="checkbox" data-variable-enabled ${row.enabled === false ? '' : 'checked'} aria-label="Enable variable"></td><td><input data-variable-key value="${attr(row.key)}" placeholder="Variable name"></td><td><input data-variable-value value="${attr(row.value)}" placeholder="Value"></td><td><button type="button" class="row-delete" data-variable-delete title="Remove variable">${getIcon('trash')}</button></td></tr>`).join('');
    const nameField = globals ? '' : `<div class="form-row"><label class="modal-label" for="environment-name">Environment name</label><input class="modal-input" id="environment-name" value="${attr(target?.name || '')}" placeholder="e.g. Development"></div>`;
    openModal({ title, subtitle: globals ? 'Globals are used when an active environment does not define the same variable.' : 'Environment variables and values are stored only in this browser.', size: 'normal', body: `${nameField}<div class="form-row"><table class="variable-table"><thead><tr><th></th><th>Variable</th><th>Initial value</th><th></th></tr></thead><tbody id="variable-editor-rows">${variableRows}</tbody></table><div class="variable-add" id="add-variable-row">+ Add variable</div></div><p class="modal-help">Use variables in requests as <code>{{variableName}}</code>. Checking a row makes it available during substitution.</p>`, footer: `${globals ? '<span class="footer-left">Global variables</span><button type="button" class="plain-button" id="export-globals">Export</button>' : ''}<button type="button" class="plain-button" data-modal-close>Cancel</button><button type="button" class="primary-button" id="save-environment">${globals ? 'Save globals' : 'Save environment'}</button>` });
    const tbody = $('#variable-editor-rows', modalRoot);
    const addRow = () => {
      const index = $$('.variable-editor-row', tbody).length;
      tbody.insertAdjacentHTML('beforeend', `<tr class="variable-editor-row" data-index="${index}"><td><input class="row-check" type="checkbox" data-variable-enabled checked aria-label="Enable variable"></td><td><input data-variable-key placeholder="Variable name"></td><td><input data-variable-value placeholder="Value"></td><td><button type="button" class="row-delete" data-variable-delete title="Remove variable">${getIcon('trash')}</button></td></tr>`);
      $('[data-variable-key]', tbody.lastElementChild).focus();
    };
    $('#add-variable-row', modalRoot).onclick = addRow;
    tbody.addEventListener('click', event => {
      if (event.target.closest('[data-variable-delete]')) { event.target.closest('tr').remove(); }
    });
    $('#save-environment', modalRoot).onclick = () => {
      const nextValues = $$('.variable-editor-row', tbody).map(row => ({
        key: $('[data-variable-key]', row).value.trim(), value: $('[data-variable-value]', row).value,
        enabled: $('[data-variable-enabled]', row).checked, type: 'default'
      })).filter(item => item.key);
      if (globals) state.globals = nextValues;
      else {
        const name = $('#environment-name', modalRoot).value.trim() || 'Environment';
        if (isNew) {
          const env = { id: Core.uid('environment'), name, values: nextValues };
          state.environments.push(env); state.activeEnvironmentId = env.id;
        } else if (target) { target.name = name; target.values = nextValues; }
      }
      closeModal(); persistSoon(); renderAll(); showToast(globals ? 'Global variables saved' : 'Environment saved');
    };
    if (globals) $('#export-globals', modalRoot).onclick = () => exportEnvironment(null, true);
  }
  function exportEnvironment(environment, globals = false) {
    const name = globals ? 'Globals' : environment.name || 'Environment';
    const source = globals ? state.globals : environment.values || [];
    const json = {
      id: globals ? Core.uid('globals') : environment.id,
      name, values: source.map(item => ({ key: item.key, value: item.value ?? '', type: item.type || 'default', enabled: item.enabled !== false })),
      _postman_variable_scope: globals ? 'globals' : 'environment',
      _postman_exported_at: new Date().toISOString(), _postman_exported_using: 'API Manager 1.0.0'
    };
    downloadText(`${safeFilename(name)}.postman_environment.json`, JSON.stringify(json, null, 2));
  }
  function exportCollection(collection) {
    const exported = Core.toPostmanCollection(collection);
    downloadText(`${safeFilename(collection.name)}.postman_collection.json`, JSON.stringify(exported, null, 2));
  }

  function openImportModal() {
    openModal({ title: 'Import', subtitle: 'Import a cURL command, Postman collection, or Postman environment into this local workspace.', size: 'normal', body: `<div class="import-drop" id="import-drop"><strong>Choose a file or drop it here</strong><p>Postman Collection v2.1, environment JSON, cURL text</p><div class="import-buttons"><button type="button" class="primary-button" id="choose-import-file">Choose file</button><button type="button" class="plain-button" id="paste-curl-quick">Paste cURL</button></div></div><div class="form-row" style="margin-top:14px"><label class="import-paste-label" for="import-type"><span>Import as</span><select class="modal-select" id="import-type" style="height:27px;width:190px"><option value="auto">Detect automatically</option><option value="curl">cURL request</option><option value="collection">Postman collection</option><option value="environment">Postman environment</option></select></label><textarea class="modal-textarea" id="import-text" style="height:170px" placeholder="Paste a cURL command or JSON export here…"></textarea><p class="import-hint">All imported content is kept in your browser. Imported scripts are stored as text and run only if you execute the request.</p></div>`, footer: '<button type="button" class="plain-button" data-modal-close>Cancel</button><button type="button" class="primary-button" id="import-text-confirm">Import</button>' });
    $('#choose-import-file', modalRoot).onclick = () => importInput.click();
    $('#paste-curl-quick', modalRoot).onclick = async () => {
      try { const text = await navigator.clipboard.readText(); $('#import-text', modalRoot).value = text; $('#import-type', modalRoot).value = 'curl'; }
      catch { $('#import-text', modalRoot).focus(); showToast('Paste the cURL text into the box.', 'error'); }
    };
    const drop = $('#import-drop', modalRoot);
    drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('dragover'); const file = event.dataTransfer.files[0]; if (file) readImportFile(file); });
    $('#import-text-confirm', modalRoot).onclick = () => {
      const text = $('#import-text', modalRoot).value.trim();
      if (!text) { importInput.click(); return; }
      try { importText(text, $('#import-type', modalRoot).value); closeModal(); }
      catch (error) { showToast(error.message || 'Could not import this file.', 'error'); }
    };
  }
  async function readImportFile(file) {
    try {
      const text = await file.text();
      if (modalRoot.innerHTML) {
        const input = $('#import-text', modalRoot); if (input) input.value = text;
        const select = $('#import-type', modalRoot);
        if (select && file.name.toLowerCase().includes('environment')) select.value = 'environment';
        else if (select && file.name.toLowerCase().includes('collection')) select.value = 'collection';
        if ($('#import-text-confirm', modalRoot)) { $('#import-text-confirm', modalRoot).focus(); showToast(`Loaded ${file.name}. Select Import to continue.`); return; }
      }
      importText(text, file.name.toLowerCase().includes('environment') ? 'environment' : file.name.toLowerCase().includes('collection') ? 'collection' : 'auto');
    } catch (error) { showToast(`Could not read file: ${error.message}`, 'error'); }
  }
  function importText(text, forcedType = 'auto') {
    const input = String(text || '').trim();
    if (!input) throw new Error('Paste cURL text or choose a JSON file to import.');
    if (forcedType === 'curl' || (forcedType === 'auto' && /^curl(?:\.exe)?\s/i.test(input))) {
      const request = Core.parseCurl(input);
      if (!request.url) throw new Error('No URL was found in this cURL command.');
      request.name = request.url.split('/').filter(Boolean).pop() || 'Imported cURL';
      openRequestTab(request); state.sidebarView = 'collections'; persistSoon(); renderAll(); showToast('cURL imported as a request'); return;
    }
    let parsed;
    try { parsed = JSON.parse(input); }
    catch (error) {
      if (forcedType === 'auto' && /^https?:\/\//i.test(input)) {
        const request = Core.parseCurl(`curl ${JSON.stringify(input)}`);
        request.name = 'Imported URL'; openRequestTab(request); renderAll(); showToast('URL imported as a request'); return;
      }
      throw new Error(`Invalid JSON: ${error.message}`);
    }
    const isCollection = forcedType === 'collection' || (forcedType === 'auto' && (parsed.info?.schema?.includes('collection') || (parsed.info?.name && Array.isArray(parsed.item))));
    const isEnvironment = forcedType === 'environment' || (forcedType === 'auto' && (Array.isArray(parsed.values) || parsed._postman_variable_scope === 'environment'));
    if (isCollection) {
      const collection = Core.fromPostmanCollection(parsed);
      collection.id = Core.uid('collection');
      state.collections.push(collection); state.expandedCollections.push(collection.id); state.sidebarView = 'collections';
      persistSoon(); renderAll(); showToast(`Imported collection “${collection.name}”`); return;
    }
    if (isEnvironment) {
      const environment = Core.fromPostmanEnvironment(parsed);
      environment.id = Core.uid('environment');
      state.environments.push(environment); state.activeEnvironmentId = environment.id; state.sidebarView = 'environments';
      persistSoon(); renderAll(); showToast(`Imported environment “${environment.name}”`); return;
    }
    if (parsed.request || parsed.method || parsed.url) {
      const request = Core.fromPostmanRequest(parsed.request || parsed);
      request.name = parsed.name || request.name || 'Imported request';
      openRequestTab(request); renderAll(); showToast('Request imported'); return;
    }
    throw new Error('Unrecognized file. Import a Postman Collection v2.1, Postman environment, or cURL command.');
  }

  function openRequestTab(request, extras = {}) {
    const tab = newTab(request, extras);
    state.tabs.push(tab); state.selectedTabId = tab.id; state.activeSection = 'params';
    persistSoon(); renderAll();
    setTimeout(() => { const node = $(`[data-tab-id="${CSS.escape(tab.id)}"]`); node?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, 0);
    return tab;
  }
  function openSavedRequest(collectionId, itemId) {
    const collection = state.collections.find(item => item.id === collectionId);
    const item = findCollectionItem(collection, itemId);
    if (!item) return;
    const existing = findTabForItem(itemId);
    if (existing) { state.selectedTabId = existing.id; renderAll(); return; }
    const tab = newTab(item.request, { saved: true, collectionId, itemId, dirty: false });
    state.tabs.push(tab); state.selectedTabId = tab.id; state.activeSection = 'params';
    persistSoon(); renderAll();
  }
  async function selectTab(id) {
    state.selectedTabId = id;
    renderAll();
    persistSoon();
    const node = $(`[data-tab-id="${CSS.escape(id)}"]`);
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  async function closeTab(id) {
    const tab = state.tabs.find(item => item.id === id);
    if (!tab) return;
    if (tab.dirty) {
      const accepted = await askConfirm('Discard unsaved changes?', `“${tab.request.name || 'Untitled Request'}” has unsaved changes. Close it and discard them?`, 'Discard', true);
      if (!accepted) return;
    }
    state.tabs = state.tabs.filter(item => item.id !== id);
    if (!state.tabs.length) state.tabs.push(newTab());
    if (state.selectedTabId === id) state.selectedTabId = state.tabs[Math.max(0, state.tabs.findIndex(item => item.id === id) - 1)]?.id || state.tabs[0].id;
    renderAll(); persistSoon();
  }

  function setHeader(headers, key, value) {
    for (const existing of Object.keys(headers)) if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
    headers[key] = value;
  }
  function utf8Base64(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function resolveObject(value, resolve) {
    if (typeof value === 'string') return resolve(value);
    if (Array.isArray(value)) return value.map(item => resolveObject(item, resolve));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveObject(item, resolve)]));
    return value;
  }
  function buildBody(request, resolve, headerMap) {
    const body = request.body || { mode: 'none' };
    if (body.mode === 'none') return undefined;
    if (body.mode === 'raw') {
      const raw = resolve(body.raw || '');
      if (!Object.keys(headerMap).some(key => key.toLowerCase() === 'content-type')) {
        const contentType = body.language === 'json' ? 'application/json' : body.language === 'xml' ? (body.soapVersion === '1.2' ? 'application/soap+xml; charset=utf-8' : 'text/xml; charset=utf-8') : body.language === 'html' ? 'text/html; charset=utf-8' : body.language === 'javascript' ? 'application/javascript; charset=utf-8' : 'text/plain; charset=utf-8';
        headerMap['content-type'] = contentType;
      }
      if (body.language === 'xml' && body.soapAction) {
        if (body.soapVersion === '1.1') headerMap.soapaction = resolve(body.soapAction);
        else if (!/action=/i.test(headerMap['content-type'])) headerMap['content-type'] += `; action="${resolve(body.soapAction)}"`;
      }
      return raw;
    }
    if (body.mode === 'urlencoded') {
      const data = new URLSearchParams();
      for (const row of body.params || []) if (row.enabled !== false && row.key) data.append(resolve(row.key), resolve(row.value || ''));
      if (!Object.keys(headerMap).some(key => key.toLowerCase() === 'content-type')) headerMap['content-type'] = 'application/x-www-form-urlencoded';
      return data.toString();
    }
    if (body.mode === 'formdata') {
      const boundary = `----APIManager${cryptoRandomString(18)}`;
      const parts = [];
      for (const row of body.params || []) if (row.enabled !== false && row.key) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${resolve(row.key).replace(/["\r\n]/g, '')}"\r\n\r\n${resolve(row.value || '')}\r\n`);
      }
      parts.push(`--${boundary}--\r\n`);
      if (!Object.keys(headerMap).some(key => key.toLowerCase() === 'content-type')) headerMap['content-type'] = `multipart/form-data; boundary=${boundary}`;
      return parts.join('');
    }
    if (body.mode === 'graphql') {
      let variables = {};
      try { variables = JSON.parse(resolve(body.variables || '{}')); } catch { throw new Error('GraphQL variables must be valid JSON.'); }
      if (!Object.keys(headerMap).some(key => key.toLowerCase() === 'content-type')) headerMap['content-type'] = 'application/json';
      return JSON.stringify({ query: resolve(body.raw || ''), variables });
    }
    return body.raw || '';
  }
  function cryptoRandomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = new Uint8Array(length); crypto.getRandomValues(bytes);
    return [...bytes].map(byte => chars[byte % chars.length]).join('');
  }
  function prepareAuth(auth, urlText, headers, resolve) {
    const config = resolveObject(auth || { type: 'none' }, resolve);
    const type = String(config.type || 'none').toLowerCase();
    let url = urlText;
    if (type === 'bearer') {
      if (config.token) setHeader(headers, 'Authorization', `${config.prefix === '' ? '' : `${config.prefix || 'Bearer'} `}${config.token}`);
    } else if (type === 'basic') {
      setHeader(headers, 'Authorization', `Basic ${utf8Base64(`${config.username || ''}:${config.password || ''}`)}`);
    } else if (type === 'apikey') {
      if (config.key) {
        if (config.addTo === 'query') { const parsed = new URL(url); parsed.searchParams.append(config.key, config.value || ''); url = parsed.toString(); }
        else setHeader(headers, config.key, config.value || '');
      }
    } else if (type === 'oauth2' && config.grantType !== 'client_credentials' && config.accessToken) {
      if (config.tokenPlacement === 'query') { const parsed = new URL(url); parsed.searchParams.append(config.tokenParam || 'access_token', config.accessToken); url = parsed.toString(); }
      else setHeader(headers, 'Authorization', `${config.tokenPrefix === '' ? '' : `${config.tokenPrefix || 'Bearer'} `}${config.accessToken}`);
    }
    if (type === 'inherit') config.type = 'none';
    return { url, auth: config };
  }

  function workerScriptSource() {
    return `
      'use strict';
      self.onmessage = async function (event) {
        const input = event.data || {};
        const context = input.context || {};
        const environment = { ...(context.environment || {}) };
        const globals = { ...(context.globals || {}) };
        const collectionVariables = { ...(context.collectionVariables || {}) };
        const localVariables = { ...(context.variables || {}) };
        const tests = [];
        const pendingTests = [];
        const logs = [];
        const asText = value => typeof value === 'string' ? value : JSON.stringify(value);
        const consoleApi = {
          log: (...args) => logs.push({ level: 'info', message: args.map(asText).join(' ') }),
          info: (...args) => logs.push({ level: 'info', message: args.map(asText).join(' ') }),
          warn: (...args) => logs.push({ level: 'warn', message: args.map(asText).join(' ') }),
          error: (...args) => logs.push({ level: 'error', message: args.map(asText).join(' ') })
        };
        const check = (condition, message) => { if (!condition) throw new Error(message || 'Assertion failed'); };
        const expect = actual => {
          const chain = {
            to: null, be: null, have: null, deep: null,
            equal: expected => check(actual === expected, 'Expected ' + asText(actual) + ' to equal ' + asText(expected)),
            eql: expected => check(JSON.stringify(actual) === JSON.stringify(expected), 'Expected values to deeply equal'),
            include: expected => check((typeof actual === 'string' || Array.isArray(actual) ? actual.includes(expected) : actual && Object.prototype.hasOwnProperty.call(actual, expected)), 'Expected value to include ' + asText(expected)),
            property: key => check(actual != null && Object.prototype.hasOwnProperty.call(actual, key), 'Expected property ' + key + ' to exist'),
            a: type => check(typeof actual === type || (type === 'array' && Array.isArray(actual)), 'Expected value to be a ' + type),
            ok: () => check(Boolean(actual), 'Expected value to be truthy')
          };
          chain.to = chain.be = chain.have = chain.deep = chain;
          return chain;
        };
        const variables = {
          get: name => localVariables[name] ?? environment[name] ?? collectionVariables[name] ?? globals[name],
          set: (name, value) => { localVariables[name] = value; },
          replaceIn: text => String(text).replace(/\\{\\{\\s*([^{}]+?)\\s*\\}\\}/g, (all, name) => String(localVariables[name] ?? environment[name] ?? collectionVariables[name] ?? globals[name] ?? all))
        };
        const makeVars = values => ({
          get: name => values[name], has: name => Object.prototype.hasOwnProperty.call(values, name),
          set: (name, value) => { values[name] = value; }, unset: name => { delete values[name]; },
          clear: () => { for (const key of Object.keys(values)) delete values[key]; }, toObject: () => ({ ...values })
        });
        const request = { ...(context.request || {}) };
        const requestHeaders = Array.isArray(request.headers) ? request.headers.map(item => ({ ...item })) : [];
        const headerApi = {
          add: item => requestHeaders.push({ key: item.key, value: item.value, disabled: false }),
          upsert: item => { const index = requestHeaders.findIndex(header => String(header.key).toLowerCase() === String(item.key).toLowerCase()); if (index < 0) requestHeaders.push({ key: item.key, value: item.value, disabled: false }); else requestHeaders[index] = { ...requestHeaders[index], ...item }; },
          remove: name => { const index = requestHeaders.findIndex(header => String(header.key).toLowerCase() === String(name).toLowerCase()); if (index >= 0) requestHeaders.splice(index, 1); },
          has: name => requestHeaders.some(header => String(header.key).toLowerCase() === String(name).toLowerCase()),
          get: name => requestHeaders.find(header => String(header.key).toLowerCase() === String(name).toLowerCase())?.value,
          all: () => requestHeaders
        };
        request.headers = headerApi;
        const response = context.response || {};
        const responseBody = String(response.body || '');
        let parsedBody;
        let parsedBodyReady = false;
        let parseBodyError = false;
        const parseBody = () => { if (!parsedBodyReady) { parsedBodyReady = true; try { parsedBody = JSON.parse(responseBody); } catch { parseBodyError = true; } } return parsedBody; };
        const statusAssertion = expected => check(Number(response.status) === Number(expected), 'Expected HTTP status ' + expected + ', received ' + response.status);
        const pm = {
          environment: makeVars(environment), globals: makeVars(globals), collectionVariables: makeVars(collectionVariables), variables,
          request,
          response: {
            code: response.status, status: response.statusText || '', responseTime: response.duration || 0,
            responseSize: responseBody.length, text: () => responseBody,
            json: () => { const body = parseBody(); if (parseBodyError) throw new Error('Response body is not valid JSON'); return body; },
            headers: response.headers || {},
            to: { have: { status: statusAssertion }, be: { accepted: () => statusAssertion(202), ok: () => check(Number(response.status) >= 200 && Number(response.status) < 300, 'Expected a successful response') } }
          },
          test: (name, callback) => {
            const task = (async () => { try { await callback(); tests.push({ name: String(name), passed: true }); } catch (error) { tests.push({ name: String(name), passed: false, error: error.message || String(error) }); } })();
            pendingTests.push(task); return task;
          },
          expect
        };
        let error = '';
        try {
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const fn = new AsyncFunction('pm', 'console', 'expect', '"use strict";\\n' + String(input.code || ''));
          await fn(pm, consoleApi, expect);
          await Promise.all(pendingTests);
        } catch (exception) { error = exception && exception.message ? exception.message : String(exception); }
        self.postMessage({ error, environment, globals, collectionVariables, variables: localVariables, request: { ...request, headers: requestHeaders }, tests, logs });
      };
    `;
  }
  function runScript(code, context = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!String(code || '').trim()) return resolve({ environment: context.environment || {}, globals: context.globals || {}, variables: context.variables || {}, request: context.request, tests: [], logs: [], error: '' });
      let worker;
      let url;
      const timeout = setTimeout(() => { worker?.terminate(); if (url) URL.revokeObjectURL(url); reject(new Error('Script timed out after 5 seconds.')); }, timeoutMs);
      try {
        const blob = new Blob([workerScriptSource()], { type: 'text/javascript' });
        url = URL.createObjectURL(blob); worker = new Worker(url);
        worker.onmessage = event => { clearTimeout(timeout); worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
        worker.onerror = event => { clearTimeout(timeout); worker.terminate(); URL.revokeObjectURL(url); reject(new Error(event.message || 'Script worker failed.')); };
        worker.postMessage({ code: String(code), context });
      } catch (error) { clearTimeout(timeout); if (url) URL.revokeObjectURL(url); reject(new Error(`Unable to start script worker: ${error.message}`)); }
    });
  }
  function updateScriptVariableRows(rows, nextValues, originalValues) {
    let result = [...(rows || [])];
    for (const key of Object.keys(originalValues || {})) {
      if (!Object.prototype.hasOwnProperty.call(nextValues || {}, key)) result = result.filter(row => row.key !== key || row.enabled === false);
    }
    for (const [key, value] of Object.entries(nextValues || {})) {
      const changed = !Object.prototype.hasOwnProperty.call(originalValues || {}, key) || String(originalValues[key]) !== String(value ?? '');
      if (!changed) continue;
      const existing = result.find(row => row.key === key);
      if (existing) { existing.value = String(value ?? ''); existing.enabled = true; }
      else result.push({ key, value: String(value ?? ''), enabled: true, type: 'default' });
    }
    return result;
  }
  function applyScriptScope(result, context) {
    const env = activeEnvironment();
    const original = context.original || {};
    if (env) env.values = updateScriptVariableRows(env.values, result.environment || {}, original.environment || {});
    else state.globals = updateScriptVariableRows(state.globals, result.environment || {}, original.environment || {});
    state.globals = updateScriptVariableRows(state.globals, result.globals || {}, original.globals || {});
    if (context.collection) context.collection.variables = updateScriptVariableRows(context.collection.variables, result.collectionVariables || {}, original.collectionVariables || {});
    persistSoon();
  }
  function scriptRequestShape(request) {
    return {
      method: request.method, url: fullRequestUrl(request),
      headers: (request.headers || []).map(item => ({ key: item.key, value: item.value, disabled: item.enabled === false })),
      body: request.body?.raw || ''
    };
  }
  function applyScriptRequest(request, result) {
    const scriptReq = result.request;
    if (!scriptReq) return;
    if (scriptReq.method) request.method = String(scriptReq.method).toUpperCase();
    if (scriptReq.url && scriptReq.url !== fullRequestUrl(request)) {
      const parsed = Core.parseQuery(String(scriptReq.url)); request.url = parsed.base; request.params = parsed.params;
    }
    if (Array.isArray(scriptReq.headers)) request.headers = scriptReq.headers.map(item => ({ ...emptyRow(), key: item.key || '', value: item.value || '', enabled: item.disabled !== true }));
    if (typeof scriptReq.body === 'string' && request.body?.mode === 'raw') request.body.raw = scriptReq.body;
  }
  function resolveVariablesAfterScripts(result) {
    const envMap = listToObject(activeEnvironment()?.values || []);
    const globals = listToObject(state.globals);
    return Core.createVariableResolver({ ...envMap, ...(result?.variables || {}) }, globals);
  }
  async function sendRequest() {
    if (sending) return;
    const tab = currentTab();
    if (!tab) return;
    const requestSnapshot = Core.clone(tab.request);
    const collection = state.collections.find(item => item.id === tab.collectionId) || null;
    tab.error = ''; tab.testResults = []; tab.lastResolvedUrl = '';
    sending = true; updateToolbar();
    addLog('info', `→ ${requestSnapshot.method} ${fullRequestUrl(requestSnapshot) || '(no URL)'}`);
    $('#response-content').innerHTML = '<div class="response-empty"><div class="response-empty-icon"><span class="spinner"></span></div><strong>Sending request…</strong><p>Waiting for the local request proxy.</p></div>';
    try {
      let preResult = { environment: listToObject(activeEnvironment()?.values || []), globals: listToObject(state.globals), variables: {}, request: scriptRequestShape(tab.request), tests: [], logs: [] };
      if (tab.request.preScript) {
        addLog('info', 'Running pre-request script in a local worker.');
        const preContext = {
          environment: preResult.environment, globals: preResult.globals,
          collectionVariables: listToObject(collection?.variables || []), variables: {}, request: scriptRequestShape(tab.request)
        };
        preResult = await runScript(tab.request.preScript, preContext);
        if (preResult.error) throw new Error(`Pre-request script failed: ${preResult.error}`);
        applyScriptScope(preResult, { collection, original: preContext }); applyScriptRequest(tab.request, preResult);
        for (const log of preResult.logs || []) addLog(log.level, `[pre-request] ${log.message}`);
      }
      const resolve = resolveVariablesAfterScripts(preResult);
      const resolvedMethod = resolve(tab.request.method || 'GET').toUpperCase();
      const resolvedBase = resolve(tab.request.url || '');
      const resolvedParams = (tab.request.params || []).map(item => ({ ...item, key: resolve(item.key), value: resolve(item.value || '') }));
      let url = Core.formatUrl(resolvedBase, resolvedParams);
      if (!/^https?:\/\//i.test(url)) throw new Error('Enter a complete HTTP or HTTPS request URL.');
      const headers = {};
      for (const item of tab.request.headers || []) if (item.enabled !== false && item.key) setHeader(headers, resolve(item.key), resolve(item.value || ''));
      let body = buildBody(tab.request, resolve, headers);
      const configuredAuth = tab.request.auth?.type === 'inherit' ? (collection?.auth || { type: 'none' }) : tab.request.auth;
      const prepared = prepareAuth(configuredAuth, url, headers, resolve);
      url = prepared.url;
      const payload = {
        method: resolvedMethod, url, headers, body,
        auth: prepared.auth, timeout: tab.request.timeout || 30000,
        followRedirects: tab.request.followRedirects !== false
      };
      tab.lastResolvedUrl = url;
      addLog('info', `Sending ${resolvedMethod} ${url}`);
      const response = await fetch('/api/request', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || `Local request proxy returned ${response.status}.`);
      tab.response = data; tab.error = ''; tab.responseFormatted = '';
      if (tab.request.postScript) {
        addLog('info', 'Running post-response script in a local worker.');
        const postContext = {
          environment: listToObject(activeEnvironment()?.values || []), globals: listToObject(state.globals),
          collectionVariables: listToObject(collection?.variables || []), variables: preResult.variables || {},
          request: scriptRequestShape(tab.request), response: data
        };
        const postResult = await runScript(tab.request.postScript, postContext);
        if (postResult.error) addLog('error', `[post-response] ${postResult.error}`);
        else {
          applyScriptScope(postResult, { collection, original: postContext });
          tab.testResults = postResult.tests || [];
          for (const log of postResult.logs || []) addLog(log.level, `[post-response] ${log.message}`);
          const passed = tab.testResults.filter(test => test.passed).length;
          const failed = tab.testResults.length - passed;
          if (tab.testResults.length) addLog(failed ? 'error' : 'info', `Tests: ${passed} passed${failed ? `, ${failed} failed` : ''}.`);
        }
      }
      const history = {
        id: Core.uid('history'), createdAt: Date.now(), request: requestSnapshot,
        resolvedUrl: url, response: Core.clone(data)
      };
      state.history.unshift(history); state.history = state.history.slice(0, HISTORY_LIMIT);
      addLog(data.status >= 400 ? 'warn' : 'info', `← ${data.status} ${data.statusText || ''} (${data.duration} ms, ${prettyBytes(new TextEncoder().encode(data.body || '').length)})`);
      persistSoon();
    } catch (error) {
      tab.error = error.message || String(error);
      addLog('error', tab.error);
      showToast(tab.error.slice(0, 120), 'error');
      state.history.unshift({
        id: Core.uid('history'), createdAt: Date.now(), request: requestSnapshot,
        resolvedUrl: tab.lastResolvedUrl || fullRequestUrl(requestSnapshot), response: null, error: tab.error
      });
      state.history = state.history.slice(0, HISTORY_LIMIT);
      persistSoon();
    } finally {
      sending = false; renderAll();
    }
  }

  function bodyWithHeaders(tab) {
    const response = tab.response;
    const headerLines = Object.entries(response?.headers || {}).map(([key, value]) => `${key}: ${value}`).join('\r\n');
    return `HTTP/1.1 ${response?.status || ''} ${response?.statusText || ''}\r\n${headerLines}\r\n\r\n${response?.body || ''}`;
  }
  function copyResponse(withHeaders = false) {
    const tab = currentTab(); if (!tab.response) return;
    copyText(withHeaders ? bodyWithHeaders(tab) : String(tab.response.body ?? ''), withHeaders ? 'Response and headers copied' : 'Response body copied');
  }
  function downloadResponse() {
    const tab = currentTab(); if (!tab.response) return;
    const body = String(tab.response.body ?? '');
    const pretty = prettifyJson(body);
    const json = pretty ?? JSON.stringify(body, null, 2);
    downloadText(`api-response-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, json);
    showToast('Response downloaded as JSON');
  }
  function beautifyResponse() {
    const tab = currentTab(); if (!tab.response) return;
    const language = responseLanguage(tab);
    const pretty = language === 'JSON' ? prettifyJson(tab.response.body) : language === 'XML' ? beautifyXml(tab.response.body) : null;
    if (!pretty) { showToast(`Response is not valid ${language === 'JSON' ? 'JSON' : 'XML'}.`, 'error'); return; }
    tab.responseView = 'pretty'; tab.responseFormatted = pretty;
    renderResponse(); showToast(`${language} response beautified`);
  }
  function beautifyRequestBody() {
    const body = activeRequest().body;
    if (body.language === 'json') {
      const pretty = prettifyJson(body.raw || '');
      if (pretty === null) { showToast('Request body is not valid JSON.', 'error'); return; }
      body.raw = pretty;
    } else if (body.language === 'xml') {
      const pretty = beautifyXml(body.raw || '');
      if (pretty === null) { showToast('Request body is not valid XML.', 'error'); return; }
      body.raw = pretty;
    } else { showToast('Beautify is available for JSON and XML bodies.', 'error'); return; }
    markDirty(); renderRequestEditor(); showToast('Request body beautified');
  }

  function requestForCode(tab) {
    const request = Core.clone(tab.request);
    const resolver = currentVariableResolver();
    request.url = resolver(request.url);
    request.params = (request.params || []).map(item => ({ ...item, key: resolver(item.key), value: resolver(item.value) }));
    request.headers = (request.headers || []).map(item => ({ ...item, key: resolver(item.key), value: resolver(item.value) }));
    request.auth = resolveObject(request.auth || {}, resolver);
    if (request.body?.mode === 'raw') request.body.raw = resolver(request.body.raw || '');
    if (request.body?.mode === 'graphql') { request.body.raw = resolver(request.body.raw || ''); request.body.variables = resolver(request.body.variables || '{}'); }
    if (request.body?.soapAction) request.body.soapAction = resolver(request.body.soapAction);
    return request;
  }
  function generateCode(request, language) {
    const tab = currentTab();
    const collection = state.collections.find(item => item.id === tab.collectionId);
    const environment = activeEnvironment();
    return window.APIManagerCodegen.generateCode(request, language, {
      collectionName: collection?.name || 'My Collection',
      environmentName: environment?.name || '',
      collectionAuth: collection?.auth ? resolveObject(collection.auth, currentVariableResolver()) : null
    });
  }
  const CODE_LANGUAGES = [
    { id: 'curl', label: 'cURL' }, { id: 'python', label: 'Python · Requests' },
    { id: 'javascript', label: 'JavaScript · Fetch' }, { id: 'java', label: 'Java · HttpClient' },
    { id: 'postman', label: 'Postman CLI' }
  ];
  function openCodeGenerator() {
    const tab = currentTab();
    const request = requestForCode(tab);
    const selected = 'curl';
    const code = generateCode(request, selected);
    openModal({ title: 'Generate code', subtitle: 'Generate a ready-to-adapt request snippet for the current API request.', size: 'wide', body: `<div class="code-toolbar"><select id="code-language">${CODE_LANGUAGES.map(language => `<option value="${language.id}" ${language.id === selected ? 'selected' : ''}>${escapeHtml(language.label)}</option>`).join('')}</select><div class="code-actions"><button type="button" class="plain-button" id="copy-generated-code">${getIcon('copy')} Copy code</button><button type="button" class="plain-button" id="download-generated-code">${getIcon('download')} Download</button></div></div><textarea class="code-output" id="generated-code" spellcheck="false" readonly>${escapeHtml(code)}</textarea><p class="modal-help">Generated code is a starting point; review secrets and request options before sharing it. SOAP body contents and common authorization fields are included.</p>`, footer: '<span class="footer-left">Code generation runs locally.</span><button type="button" class="plain-button" data-modal-close>Close</button>' });
    const update = () => { const language = $('#code-language', modalRoot).value; $('#generated-code', modalRoot).value = generateCode(request, language); };
    $('#code-language', modalRoot).onchange = update;
    $('#copy-generated-code', modalRoot).onclick = () => copyText($('#generated-code', modalRoot).value, 'Code copied');
    $('#download-generated-code', modalRoot).onclick = () => downloadText(`api-manager-${$('#code-language', modalRoot).value}.txt`, $('#generated-code', modalRoot).value, 'text/plain');
  }

  function openHistoryEntry(id, run = false) {
    const entry = state.history.find(item => item.id === id);
    if (!entry) return;
    const tab = openRequestTab(entry.request, { response: Core.clone(entry.response), lastResolvedUrl: entry.resolvedUrl, dirty: false, error: entry.error || '' });
    tab.request.name = entry.request.name || 'History request';
    if (run) { tab.response = null; sendRequest(); }
    else showToast('History response opened');
  }
  function duplicateRequest(collectionId, itemId) {
    const location = findItemLocation(itemId);
    if (!location) return;
    const request = Core.clone(location.item.request);
    request.name = `${location.item.name || 'Request'} copy`;
    openRequestTab(request);
  }
  function removeCollectionItem(collectionId, itemId) {
    const collection = state.collections.find(item => item.id === collectionId);
    if (!collection) return;
    const removeFrom = items => {
      const index = items.findIndex(item => item.id === itemId);
      if (index >= 0) { items.splice(index, 1); return true; }
      for (const item of items) if (Array.isArray(item.items) && removeFrom(item.items)) return true;
      return false;
    };
    removeFrom(collection.items);
    state.tabs.forEach(tab => { if (tab.itemId === itemId) { tab.saved = false; tab.itemId = null; tab.collectionId = null; tab.dirty = true; } });
    persistSoon(); renderAll();
  }
  function cloneCollection(collection) {
    const copy = Core.clone(collection); copy.id = Core.uid('collection'); copy.name = `${collection.name} copy`;
    const cloneItems = items => (items || []).map(item => ({ ...item, id: Core.uid(Array.isArray(item.items) ? 'folder' : 'request'), items: Array.isArray(item.items) ? cloneItems(item.items) : undefined }));
    copy.items = cloneItems(copy.items); return copy;
  }
  function showMenu(items, x, y) {
    $('.dropdown-menu')?.remove();
    const menu = document.createElement('div'); menu.className = 'dropdown-menu'; menu.innerHTML = items.map(item => item.separator ? '<div class="dropdown-separator"></div>' : `<button type="button" class="dropdown-item ${item.danger ? 'danger' : ''}" data-menu-action="${attr(item.id)}">${item.icon ? getIcon(item.icon) : ''}<span>${escapeHtml(item.label)}</span></button>`).join('');
    document.body.appendChild(menu);
    menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 10)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 10)}px`;
    const close = event => { if (!menu.contains(event.target)) { menu.remove(); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', keyClose); } };
    const keyClose = event => { if (event.key === 'Escape') { menu.remove(); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', keyClose); } };
    setTimeout(() => { document.addEventListener('mousedown', close); document.addEventListener('keydown', keyClose); }, 0);
    menu.addEventListener('click', event => {
      const button = event.target.closest('[data-menu-action]'); if (!button) return;
      const action = button.dataset.menuAction; menu.remove(); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', keyClose);
      items.find(item => item.id === action)?.run();
    });
  }
  function openCollectionAuthEditor(collection) {
    let auth = Core.clone(collection.auth || { type: 'none' });
    openModal({ title: 'Collection authorization', subtitle: `Default authorization for requests in “${collection.name}”.`, size: 'normal', body: '', footer: '<button type="button" class="plain-button" data-modal-close>Cancel</button><button type="button" class="primary-button" id="save-collection-auth">Save authorization</button>' });
    const body = $('.modal-body', modalRoot);
    const renderFields = () => {
      body.innerHTML = renderAuthEditor({ request: { auth } });
      $('#auth-type-select', body).onchange = event => { auth = { ...auth, type: event.target.value }; renderFields(); };
    };
    body.addEventListener('input', event => { if (event.target.dataset.authField) auth[event.target.dataset.authField] = event.target.value; });
    body.addEventListener('change', event => {
      if (event.target.dataset.authField) auth[event.target.dataset.authField] = event.target.value;
      if (event.target.dataset.authCheckbox) auth[event.target.dataset.authCheckbox] = event.target.checked;
    });
    body.addEventListener('click', event => {
      const reveal = event.target.closest('.reveal-secret');
      if (reveal) { const input = reveal.parentElement.querySelector('input'); input.type = input.type === 'password' ? 'text' : 'password'; }
    });
    renderFields();
    $('#save-collection-auth', modalRoot).onclick = () => { collection.auth = auth; closeModal(); persistSoon(); renderAll(); showToast('Collection authorization saved'); };
  }

  function openCollectionMenu(collectionId, event) {
    const collection = state.collections.find(item => item.id === collectionId); if (!collection) return;
    showMenu([
      { id: 'new', label: 'New request', icon: 'plus', run: () => { const tab = newTab(newRequest(), { collectionId, saved: false }); tab.request.name = 'Untitled Request'; state.tabs.push(tab); state.selectedTabId = tab.id; if (!state.expandedCollections.includes(collectionId)) state.expandedCollections.push(collectionId); renderAll(); } },
      { id: 'export', label: 'Export collection', icon: 'download', run: () => exportCollection(collection) },
      { id: 'auth', label: 'Edit collection authorization', icon: 'settings', run: () => openCollectionAuthEditor(collection) },
      { id: 'duplicate', label: 'Duplicate collection', icon: 'copy', run: () => { const copy = cloneCollection(collection); state.collections.push(copy); state.expandedCollections.push(copy.id); renderAll(); persistSoon(); showToast('Collection duplicated'); } },
      { id: 'rename', label: 'Rename', icon: 'settings', run: () => renameCollection(collection) },
      { separator: true },
      { id: 'delete', label: 'Delete collection', icon: 'trash', danger: true, run: async () => { if (await askConfirm('Delete collection?', `“${collection.name}” and its saved requests will be removed from this device.`, 'Delete collection')) { state.collections = state.collections.filter(item => item.id !== collectionId); state.tabs.forEach(tab => { if (tab.collectionId === collectionId) { tab.saved = false; tab.collectionId = null; tab.itemId = null; tab.dirty = true; } }); renderAll(); persistSoon(); } } }
    ], event.clientX, event.clientY);
  }
  function renameCollection(collection) {
    openModal({ title: 'Rename collection', size: 'narrow', body: modalInput('rename-collection', 'Collection name', collection.name), footer: '<button type="button" class="plain-button" data-modal-close>Cancel</button><button type="button" class="primary-button" id="rename-collection-save">Save</button>' });
    $('#rename-collection-save', modalRoot).onclick = () => { const value = $('#rename-collection', modalRoot).value.trim(); if (!value) return; collection.name = value; closeModal(); renderAll(); persistSoon(); };
  }
  function openRequestMenu(collectionId, itemId, event) {
    const location = findItemLocation(itemId); if (!location) return;
    const request = location.item.request;
    showMenu([
      { id: 'open', label: 'Open request', icon: 'folder', run: () => openSavedRequest(collectionId, itemId) },
      { id: 'run', label: 'Run request', icon: 'send', run: () => { openSavedRequest(collectionId, itemId); sendRequest(); } },
      { id: 'copycurl', label: 'Copy as cURL', icon: 'copy', run: () => copyText(Core.toCurl(request), 'cURL copied') },
      { id: 'code', label: 'Generate code', icon: 'code', run: () => { openSavedRequest(collectionId, itemId); openCodeGenerator(); } },
      { id: 'rename', label: 'Rename', icon: 'settings', run: () => renameCollectionRequest(location) },
      { separator: true },
      { id: 'delete', label: 'Delete request', icon: 'trash', danger: true, run: async () => { if (await askConfirm('Delete request?', `“${location.item.name}” will be removed from “${location.collection.name}”.`, 'Delete request')) removeCollectionItem(collectionId, itemId); } }
    ], event.clientX, event.clientY);
  }
  function renameCollectionRequest(location) {
    openModal({ title: 'Rename request', size: 'narrow', body: modalInput('rename-request', 'Request name', location.item.name), footer: '<button type="button" class="plain-button" data-modal-close>Cancel</button><button type="button" class="primary-button" id="rename-request-save">Save</button>' });
    $('#rename-request-save', modalRoot).onclick = () => {
      const name = $('#rename-request', modalRoot).value.trim(); if (!name) return;
      location.item.name = name; location.item.request.name = name;
      state.tabs.forEach(tab => { if (tab.itemId === location.item.id) tab.request.name = name; });
      closeModal(); renderAll(); persistSoon();
    };
  }

  function importEnvironmentFromSidebar() { state.sidebarView = 'environments'; renderAll(); openImportModal(); }
  function mailtoReport() {
    const subject = encodeURIComponent('API Manager bug report');
    const body = encodeURIComponent('Summary:\n[Briefly describe the issue]\n\nDescription:\n[What happened? What did you expect to happen?]\n\nSteps to reproduce:\n1. [First step]\n2. [Second step]\n3. [Expected/actual result]\n\nAPI Manager version: 1.0.0');
    window.location.href = `mailto:manishkumars264@gmail.com?to=manishkumars264%40gmail.com&subject=${subject}&body=${body}`;
  }
  function openAbout() {
    openModal({ title: 'About API Manager', subtitle: 'A local-first API workspace. No account, sync service, or cloud storage required.', size: 'normal', body: `<div class="about-card"><div class="about-avatar">M</div><div><strong>Developed by Manish Kumar Singh</strong><span>API Manager · Version 1.0.0</span><a href="mailto:manishkumars264@gmail.com">manishkumars264@gmail.com</a></div></div><div class="release-block"><div class="release-version"><strong>Version 1.0.0</strong><span>Initial release · October 2026</span></div><ul class="release-list"><li>Local-first API request workspace with multi-request tabs and session restoration.</li><li>HTTP methods, query parameters, headers, raw JSON/text/XML, URL-encoded and multipart text bodies, and SOAP 1.1/1.2 controls.</li><li>Authorization helpers: No Auth, API Key, Bearer, Basic, Digest, OAuth 1.0, OAuth 2.0 token/client credentials, Hawk, AWS Signature v4, Akamai EdgeGrid, NTLMv2, and HMAC JWT.</li><li>Pre-request and post-response scripts with a worker-isolated Postman-style pm API and test assertions.</li><li>Collections, Postman Collection v2.1 and environment import/export, cURL import/export, and local global/environment variables with dynamic variables.</li><li>Response status, timing, headers, cookies, test results, JSON/XML beautify, wrapping, zoom, copy body/headers and .json download.</li><li>History of the latest 200 runs with saved responses and a run-again action; API console; cURL, Python, JavaScript, Java and Postman CLI snippets.</li><li>Bug report email template addressed to the developer.</li></ul></div><div class="report-note"><b>Found a bug?</b> Send a pre-filled report with summary, description and reproduction steps to <a href="mailto:manishkumars264@gmail.com?subject=API%20Manager%20bug%20report&body=Summary%3A%0A%5BBriefly%20describe%20the%20issue%5D%0A%0ADescription%3A%0A%5BWhat%20happened%3F%20What%20did%20you%20expect%3F%5D%0A%0ASteps%20to%20reproduce%3A%0A1.%20%5BFirst%20step%5D%0A2.%20%5BSecond%20step%5D%0A3.%20%5BExpected%2Factor%5D">manishkumars264@gmail.com</a>.</div>`, footer: '<button type="button" class="plain-button" id="report-bug-button">Report a bug</button><button type="button" class="primary-button" data-modal-close>Done</button>' });
    $('#report-bug-button', modalRoot).onclick = mailtoReport;
  }

  function openSettings() {
    openModal({ title: 'Settings', subtitle: 'Manage local data and inspect how this workspace stores information.', size: 'narrow', body: `<div class="variable-reference" style="margin-top:0"><b>Local storage</b><br>Requests, credentials, collections, environments, scripts, responses and the selected session are saved in this browser using IndexedDB (with localStorage fallback). Nothing is synced to an API Manager account.</div><div class="form-row" style="margin-top:16px"><button class="plain-button" id="export-workspace-button" type="button">Export workspace backup</button><p class="modal-help">Creates a JSON backup file containing collections, environments, globals, tabs, history and saved responses.</p></div><div class="form-row"><button class="plain-button" id="clear-history-settings" type="button">Clear request history</button></div><div class="form-row"><button class="danger-button" id="clear-workspace-button" type="button">Clear all local data</button><p class="modal-help">This removes all API Manager information stored in this browser. This cannot be undone.</p></div>`, footer: '<button type="button" class="plain-button" data-modal-close>Close</button>' });
    $('#export-workspace-button', modalRoot).onclick = () => downloadText('api-manager-workspace-backup.json', JSON.stringify(state, null, 2));
    $('#clear-history-settings', modalRoot).onclick = async () => {
      if (await askConfirm('Clear request history?', 'All 200-run history entries and response snapshots will be removed.', 'Clear history')) { state.history = []; persistSoon(); renderAll(); closeModal(); showToast('History cleared'); }
    };
    $('#clear-workspace-button', modalRoot).onclick = async () => {
      if (await askConfirm('Clear all local data?', 'Collections, environments, globals, history and open tabs will be removed from this browser.', 'Clear everything')) {
        const newState = initialState(); state = newState;
        try { indexedDB.deleteDatabase(DB_NAME); localStorage.removeItem(STORAGE_KEY); } catch {}
        db = await openDatabase(); renderAll(); persistSoon(); closeModal(); showToast('Local workspace cleared');
      }
    };
  }

  function changeUrlFromInput(value) {
    const tab = currentTab();
    const text = String(value || '');
    if (!text) { tab.request.url = ''; tab.request.params = []; }
    else {
      const parsed = Core.parseQuery(text);
      tab.request.url = parsed.base;
      tab.request.params = parsed.params;
    }
    markDirty();
  }
  function updateRow(kind, index, field, value) {
    const request = activeRequest();
    let rows;
    if (kind === 'params') rows = request.params;
    else if (kind === 'headers') rows = request.headers;
    else rows = request.body.params;
    while (rows.length <= index) rows.push(emptyRow());
    rows[index][field] = value;
    if (kind === 'params') $('#url-input').value = fullRequestUrl(request);
    markDirty();
  }
  function deleteRow(kind, index) {
    const request = activeRequest();
    const rows = kind === 'params' ? request.params : kind === 'headers' ? request.headers : request.body.params;
    rows.splice(index, 1); markDirty(); renderRequestEditor(); updateToolbar();
  }
  function addRow(kind) {
    const request = activeRequest();
    if (kind === 'params') request.params.push(emptyRow());
    else if (kind === 'headers') request.headers.push(emptyRow());
    else request.body.params.push(emptyRow());
    markDirty(); renderRequestEditor();
    const input = $(`[data-row-field="key"][data-row-kind="${kind}"][data-index="${(kind === 'params' ? request.params : kind === 'headers' ? request.headers : request.body.params).length - 1}"]`);
    input?.focus();
  }
  function updateLineNumbers() {
    const textarea = $('[data-body-raw]', $('#request-editor'));
    const lines = $('#request-line-numbers');
    if (!textarea || !lines) return;
    const count = Math.max(1, textarea.value.split('\n').length);
    lines.textContent = Array.from({ length: count }, (_, index) => index + 1).join('\n');
  }
  function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    textarea.setRangeText(text, start, end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function bindEvents() {
    $('#new-request-button').addEventListener('click', () => openRequestTab(newRequest()));
    $('#import-button').addEventListener('click', openImportModal);
    $('#help-button').addEventListener('click', openAbout);
    $('#about-button').addEventListener('click', openAbout);
    $('#settings-button').addEventListener('click', openSettings);
    $('#method-select').addEventListener('change', event => { activeRequest().method = event.target.value; markDirty(); updateToolbar(); updateRequestTabStrip(); });
    $('#url-input').addEventListener('input', event => changeUrlFromInput(event.target.value));
    $('#url-input').addEventListener('paste', event => {
      const text = event.clipboardData?.getData('text') || '';
      if (/^\s*curl(?:\.exe)?\s/i.test(text)) {
        event.preventDefault();
        try { const request = Core.parseCurl(text); if (!request.url) throw new Error('No URL found.'); currentTab().request = normalizeRequest(request); currentTab().dirty = true; renderAll(); showToast('cURL pasted into request'); }
        catch (error) { showToast(error.message, 'error'); }
      }
    });
    $('#url-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); sendRequest(); } });
    $('#url-clear').addEventListener('click', () => { $('#url-input').value = ''; changeUrlFromInput(''); $('#url-input').focus(); });
    $('#send-button').addEventListener('click', sendRequest);
    $('#save-request-button').addEventListener('click', openSaveRequestModal);
    $('#request-more-button').addEventListener('click', event => {
      const tab = currentTab();
      showMenu([
        { id: 'copycurl', label: 'Copy request as cURL', icon: 'copy', run: () => copyText(Core.toCurl(tab.request), 'cURL copied') },
        { id: 'code', label: 'Generate code', icon: 'code', run: openCodeGenerator },
        { id: 'duplicate', label: 'Duplicate in new tab', icon: 'plus', run: () => openRequestTab(tab.request) },
        { id: 'clear-response', label: 'Clear response', icon: 'trash', run: () => { tab.response = null; tab.error = ''; tab.testResults = []; renderResponse(); persistSoon(); } }
      ], event.clientX, event.clientY);
    });
    $('#request-section-tabs').addEventListener('click', event => {
      const button = event.target.closest('[data-section]');
      if (!button) return;
      state.activeSection = button.dataset.section; renderRequestEditor(); persistSoon();
    });
    $('#request-tabs').addEventListener('click', event => {
      const close = event.target.closest('[data-close-tab]');
      if (close) { event.stopPropagation(); closeTab(close.dataset.closeTab); return; }
      const tab = event.target.closest('[data-tab-id]'); if (tab) selectTab(tab.dataset.tabId);
      if (event.target.closest('#request-tab-add')) openRequestTab(newRequest());
    });
    $('#request-tabs').addEventListener('wheel', event => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) { $('#request-tabs').scrollLeft += event.deltaY; event.preventDefault(); } }, { passive: false });
    $('#environment-select').addEventListener('change', event => { state.activeEnvironmentId = event.target.value; persistSoon(); renderAll(); showToast(state.activeEnvironmentId ? `Active environment: ${activeEnvironment()?.name}` : 'No environment selected'); });
    $('#global-search').addEventListener('input', event => { state.globalSearch = event.target.value; renderSidebar(); });
    $('#global-search').addEventListener('keydown', event => { if (event.key === 'Escape') { event.target.value = ''; state.globalSearch = ''; renderSidebar(); event.target.blur(); } });
    $('#sidebar-collapse').addEventListener('click', () => { state.sidebarCollapsed = !state.sidebarCollapsed; renderAll(); persistSoon(); });
    $('#sidebar-add-button').addEventListener('click', () => {
      if (state.sidebarView === 'collections') createCollectionModal();
      else if (state.sidebarView === 'environments') openVariableEditor({ globals: false, isNew: true });
      else { state.history = []; renderAll(); persistSoon(); }
    });
    $$('.sidebar-nav-item').forEach(button => button.addEventListener('click', () => { state.sidebarView = button.dataset.view; state.globalSearch = ''; $('#global-search').value = ''; renderSidebar(); persistSoon(); }));
    $('#sidebar-content').addEventListener('click', async event => {
      const action = event.target.closest('[data-tree-action]');
      if (action) {
        event.stopPropagation();
        const type = action.dataset.treeAction;
        if (type === 'collection-menu') openCollectionMenu(action.dataset.id, event);
        else if (type === 'request-menu') openRequestMenu(action.dataset.collectionId, action.dataset.id, event);
        else if (type === 'folder-menu') showMenu([{ id: 'toggle', label: 'Expand/collapse folder', icon: 'folder', run: () => { const id = action.dataset.id; state.expandedFolders = state.expandedFolders.includes(id) ? state.expandedFolders.filter(item => item !== id) : [...state.expandedFolders, id]; renderSidebar(); } }], event.clientX, event.clientY);
        return;
      }
      const toggleCollection = event.target.closest('[data-toggle-collection]');
      if (toggleCollection) { const id = toggleCollection.dataset.toggleCollection; state.expandedCollections = state.expandedCollections.includes(id) ? state.expandedCollections.filter(item => item !== id) : [...state.expandedCollections, id]; renderSidebar(); persistSoon(); return; }
      const toggleFolder = event.target.closest('[data-toggle-folder]');
      if (toggleFolder) { const id = toggleFolder.dataset.toggleFolder; state.expandedFolders = state.expandedFolders.includes(id) ? state.expandedFolders.filter(item => item !== id) : [...state.expandedFolders, id]; renderSidebar(); persistSoon(); return; }
      const collectionRow = event.target.closest('[data-collection-row]');
      if (collectionRow) { const id = collectionRow.dataset.collectionRow; state.expandedCollections = state.expandedCollections.includes(id) ? state.expandedCollections.filter(item => item !== id) : [...state.expandedCollections, id]; renderSidebar(); persistSoon(); return; }
      const requestRow = event.target.closest('[data-open-item]');
      if (requestRow) { openSavedRequest(requestRow.dataset.collectionId, requestRow.dataset.openItem); return; }
      const historyAction = event.target.closest('[data-history-action]');
      if (historyAction) { openHistoryEntry(historyAction.dataset.id, historyAction.dataset.historyAction === 'run'); return; }
      const clearHistory = event.target.closest('[data-clear-history]');
      if (clearHistory) { state.history = []; renderAll(); persistSoon(); return; }
      const createEnv = event.target.closest('[data-create-env]'); if (createEnv) { openVariableEditor({ isNew: true }); return; }
      const importEnv = event.target.closest('[data-import-env]'); if (importEnv) { importEnvironmentFromSidebar(); return; }
      const globals = event.target.closest('[data-manage-globals]'); if (globals) { openVariableEditor({ globals: true }); return; }
      const envAction = event.target.closest('[data-env-action]');
      if (envAction) {
        const env = state.environments.find(item => item.id === envAction.dataset.id); if (!env) return;
        if (envAction.dataset.envAction === 'edit') openVariableEditor({ id: env.id });
        else if (envAction.dataset.envAction === 'export') exportEnvironment(env);
        else if (envAction.dataset.envAction === 'delete' && await askConfirm('Delete environment?', `“${env.name}” and its variables will be removed.`, 'Delete environment')) { state.environments = state.environments.filter(item => item.id !== env.id); if (state.activeEnvironmentId === env.id) state.activeEnvironmentId = ''; renderAll(); persistSoon(); }
        return;
      }
      const envCard = event.target.closest('[data-env-card]'); if (envCard) { state.activeEnvironmentId = envCard.dataset.envCard; renderAll(); persistSoon(); }
    });
    $('#request-editor').addEventListener('input', event => {
      const target = event.target;
      if (target.dataset.rowField) { updateRow(target.dataset.rowKind, Number(target.dataset.index), target.dataset.rowField, target.value); return; }
      if (target.dataset.authField) { activeRequest().auth[target.dataset.authField] = target.value; markDirty(); return; }
      if (target.dataset.bodyRaw !== undefined) { activeRequest().body.raw = target.value; markDirty(); updateLineNumbers(); return; }
      if (target.dataset.bodyVariables !== undefined) { activeRequest().body.variables = target.value; markDirty(); return; }
      if (target.dataset.soapAction !== undefined) { activeRequest().body.soapAction = target.value; markDirty(); return; }
      if (target.dataset.script) { activeRequest()[target.dataset.script === 'pre' ? 'preScript' : 'postScript'] = target.value; markDirty(); return; }
      if (target.dataset.requestSetting === 'timeout') { activeRequest().timeout = Math.min(120000, Math.max(1000, Number(target.value) || 30000)); markDirty(); return; }
    });
    $('#request-editor').addEventListener('change', event => {
      const target = event.target;
      if (target.dataset.rowEnabled) { const rows = target.dataset.rowEnabled === 'params' ? activeRequest().params : target.dataset.rowEnabled === 'headers' ? activeRequest().headers : activeRequest().body.params; if (rows[Number(target.dataset.index)]) rows[Number(target.dataset.index)].enabled = target.checked; target.closest('tr')?.classList.toggle('disabled-row', !target.checked); markDirty(); return; }
      if (target.dataset.authCheckbox) { activeRequest().auth[target.dataset.authCheckbox] = target.checked; markDirty(); return; }
      if (target.id === 'auth-type-select') { const prior = activeRequest().auth; activeRequest().auth = { ...prior, type: target.value }; markDirty(); renderRequestEditor(); return; }
      if (target.dataset.authField) { activeRequest().auth[target.dataset.authField] = target.value; markDirty(); return; }
      if (target.dataset.bodyMode) { activeRequest().body.mode = target.dataset.bodyMode; markDirty(); renderRequestEditor(); return; }
      if (target.dataset.bodyLanguage) { activeRequest().body.language = target.value; markDirty(); renderRequestEditor(); return; }
      if (target.dataset.soapVersion) { activeRequest().body.soapVersion = target.value; markDirty(); return; }
      if (target.dataset.requestSetting === 'followRedirects') { activeRequest().followRedirects = target.checked; markDirty(); return; }
      if (target.dataset.requestSetting === 'timeout') { activeRequest().timeout = Math.min(120000, Math.max(1000, Number(target.value) || 30000)); markDirty(); return; }
    });
    $('#request-editor').addEventListener('click', event => {
      const deleteButton = event.target.closest('[data-delete-row]'); if (deleteButton) { deleteRow(deleteButton.dataset.deleteRow, Number(deleteButton.dataset.index)); return; }
      const add = event.target.closest('[data-add-row]'); if (add) { addRow(add.dataset.addRow); return; }
      const reveal = event.target.closest('.reveal-secret'); if (reveal) { const input = reveal.parentElement.querySelector('input'); input.type = input.type === 'password' ? 'text' : 'password'; reveal.textContent = input.type === 'password' ? '◉' : '○'; return; }
      if (event.target.closest('#beautify-request-body')) { beautifyRequestBody(); return; }
      if (event.target.closest('#soap-template-button')) {
        const body = activeRequest().body; body.mode = 'raw'; body.language = 'xml';
        body.raw = body.soapVersion === '1.2' ? `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">\n  <soap12:Header/>\n  <soap12:Body>\n    <!-- Add your SOAP operation here -->\n  </soap12:Body>\n</soap12:Envelope>` : `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n  <soap:Header/>\n  <soap:Body>\n    <!-- Add your SOAP operation here -->\n  </soap:Body>\n</soap:Envelope>`;
        if (!activeRequest().method || activeRequest().method === 'GET') activeRequest().method = 'POST';
        markDirty(); updateToolbar(); renderRequestEditor(); return;
      }
      const example = event.target.closest('[data-script-example]'); if (example) {
        if (example.dataset.scriptExample === 'pre') activeRequest().preScript = `pm.environment.set('requestStartedAt', new Date().toISOString());\nconsole.log('Preparing request at', pm.environment.get('requestStartedAt'));`;
        else activeRequest().postScript = `pm.test('Status is successful', () => pm.response.to.have.status(200));\nconst data = pm.response.json();\nconsole.log('Response keys:', Object.keys(data));`;
        markDirty(); renderRequestEditor(); return;
      }
    });
    $('#request-editor').addEventListener('keydown', event => {
      if (event.key === 'Tab' && (event.target.matches('textarea') || event.target.matches('input[data-row-field]'))) {
        event.preventDefault(); insertAtCursor(event.target, '  ');
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); sendRequest(); }
      if (event.target.matches('[data-add-row]') && (event.key === 'Enter' || event.key === ' ')) addRow(event.target.dataset.addRow);
    });
    $('#response-tabs').addEventListener('click', event => {
      const button = event.target.closest('[data-response-tab]'); if (!button) return;
      currentTab().responseTab = button.dataset.responseTab; renderResponse(); persistSoon();
    });
    $('#response-view-mode').addEventListener('change', event => { currentTab().responseView = event.target.value; currentTab().responseFormatted = ''; renderResponse(); persistSoon(); });
    $('#copy-response-button').addEventListener('click', () => copyResponse(false));
    $('#copy-all-button').addEventListener('click', () => copyResponse(true));
    $('#download-response-button').addEventListener('click', downloadResponse);
    $('#beautify-button').addEventListener('click', beautifyResponse);
    $('#wrap-button').addEventListener('click', () => { currentTab().wrapLines = !currentTab().wrapLines; renderResponse(); persistSoon(); });
    $('#zoom-in-button').addEventListener('click', () => { currentTab().zoom = Math.min(22, (currentTab().zoom || 11) + 1); renderResponse(); persistSoon(); });
    $('#zoom-out-button').addEventListener('click', () => { currentTab().zoom = Math.max(8, (currentTab().zoom || 11) - 1); renderResponse(); persistSoon(); });
    $('#codegen-button').addEventListener('click', openCodeGenerator);
    $('#console-toggle-side').addEventListener('click', toggleConsole);
    $('#status-console-button').addEventListener('click', toggleConsole);
    $('#close-console-button').addEventListener('click', () => { state.consoleOpen = false; renderConsole(); persistSoon(); });
    $('#clear-console-button').addEventListener('click', () => { state.consoleLog = []; renderConsole(); persistSoon(); });
    $('#workspace-button').addEventListener('click', () => showToast('This workspace is stored locally on this device.'));
    $('#sidebar-more').addEventListener('click', event => showMenu([
      { id: 'export', label: 'Export workspace backup', icon: 'download', run: () => downloadText('api-manager-workspace-backup.json', JSON.stringify(state, null, 2)) },
      { id: 'globals', label: 'Manage global variables', icon: 'settings', run: () => openVariableEditor({ globals: true }) },
      { id: 'about', label: 'About API Manager', icon: 'help', run: openAbout }
    ], event.clientX, event.clientY));
    importInput.addEventListener('change', async () => { const file = importInput.files?.[0]; importInput.value = ''; if (file) await readImportFile(file); });
    modalRoot.addEventListener('click', event => {
      if (event.target.closest('[data-modal-close]')) closeModal();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && modalRoot.innerHTML) closeModal();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'enter') { event.preventDefault(); sendRequest(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#global-search').focus(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); openRequestTab(newRequest()); }
      if ((event.metaKey || event.ctrlKey) && event.altKey && event.key.toLowerCase() === 'c') { event.preventDefault(); toggleConsole(); }
      if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); cycleTab(1); }
      if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); cycleTab(-1); }
    });
    window.addEventListener('beforeunload', () => { if (saveTimer) persistNow(); });
  }
  function toggleConsole() { state.consoleOpen = !state.consoleOpen; renderConsole(); persistSoon(); }
  function cycleTab(direction) {
    const currentIndex = state.tabs.findIndex(tab => tab.id === state.selectedTabId);
    const index = (currentIndex + direction + state.tabs.length) % state.tabs.length;
    selectTab(state.tabs[index].id);
  }

  async function boot() {
    bindEvents();
    $('#request-editor').innerHTML = '<div class="empty-list">Restoring your local workspace…</div>';
    try { state = await loadWorkspace(); } catch { state = initialState(); }
    renderAll();
    $('#save-status').textContent = 'Ready';
    if (!state.collections.length && !state.history.length) addLog('info', 'Welcome to API Manager. Your collections, requests and environments stay in this browser.');
  }
  boot();
})();
