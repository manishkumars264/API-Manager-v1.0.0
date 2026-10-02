'use strict';
/*
 * API Manager - renderer application logic.
 * UI state, collections/environments/history management, request sending
 * (via the same-origin loopback proxy), scripting (time-limited worker),
 * import/export, code generation, console, menus and shortcuts.
 */
(function () {
  const C = window.Core;
  const V = C.V;
  const SH = window.APIManager; // {variables, collection, curl, soap, history, pmSubset, snippets}
  const $ = (id) => document.getElementById(id);

  // ==================================================================
  // Init
  // ==================================================================
  async function init() {
    bindStaticEvents();
    const [tabs, cols, envs, history, logs, kvs] = await Promise.all([
      C.dbAll('tabs'),
      C.dbAll('collections'),
      C.dbAll('environments'),
      C.dbAll('history'),
      C.dbAll('console'),
      C.dbAll('kv'),
    ]);
    const kvMap = {};
    for (const kv of kvs) kvMap[kv.key] = kv.value;
    S0.settings = Object.assign(S0.settings, kvMap.settings || {});
    S0.globals = kvMap.globals || S0.globals;
    S0.collections = cols;
    S0.environments = envs;
    S0.history = history;
    S0.consoleLog = logs;
    if (!S0.settings.selectedCollectionId && cols.length) S0.settings.selectedCollectionId = cols[0].id;
    if (tabs && tabs.length) {
      S0.tabs = tabs.sort((a, b) => (a.id < b.id ? -1 : 1));
      S0.activeTabId = S0.tabs[S0.tabs.length - 1].id;
    } else {
      newRequestTab();
    }
    applyTheme();
    renderAll();
    C.addConsole('info', 'system', 'API Manager ready. All data is stored locally on this device.');
    S0.loaded = true;
  }
  const S0 = C.S;

  function renderAll() {
    renderTabs();
    renderCollections();
    renderEnvs();
    renderGlobals();
    renderHistory();
    renderConsole();
    renderEditor();
    updateEmptyState();
  }

  function updateEmptyState() {
    $('empty-state').classList.toggle('hidden', S0.tabs.length > 0);
    $('editor').classList.toggle('hidden', S0.tabs.length === 0);
  }

  // ==================================================================
  // Tabs
  // ==================================================================
  function renderTabs() {
    const list = $('tab-list');
    list.innerHTML = '';
    for (const t of S0.tabs) {
      const m = (t.request.method || 'GET').slice(0, 3);
      const tab = C.el('div', {
        class: 'tab' + (t.id === S0.activeTabId ? ' active' : ''),
        role: 'tab',
        'aria-selected': t.id === S0.activeTabId ? 'true' : 'false',
        title: t.name + ' — ' + t.request.url,
        onclick: () => selectTab(t.id),
        onauxclick: (e) => { if (e.button === 1) closeTab(t.id); },
      }, [
        C.el('span', { class: 'tab-method', style: `color:var(--method-${(t.request.method || 'get').toLowerCase()})` }, m),
        C.el('span', { class: 'tab-name' }, t.name),
        t.dirty ? C.el('span', { class: 'tab-dot', title: 'Unsaved changes' }) : null,
        C.el('button', {
          class: 'tab-close',
          'aria-label': 'Close tab',
          onclick: (e) => { e.stopPropagation(); closeTab(t.id); },
        }, '✕'),
      ]);
      list.append(tab);
    }
  }

  function selectTab(id) {
    if (S0.activeTabId === id) return;
    S0.activeTabId = id;
    C.schedulePersist();
    renderTabs();
    renderEditor();
  }

  function newRequestTab(request, provenance) {
    const t = C.newTab(request || C.newRequest(), provenance || null);
    renderTabs();
    renderEditor();
    updateEmptyState();
    return t;
  }

  function closeTab(id) {
    const idx = S0.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    S0.tabs.splice(idx, 1);
    C.dbDelete('tabs', id).catch(() => {});
    if (S0.activeTabId === id) {
      S0.activeTabId = S0.tabs.length ? S0.tabs[Math.max(0, idx - 1)].id : null;
    }
    if (!S0.tabs.length) newRequestTab();
    renderTabs();
    renderEditor();
    updateEmptyState();
    C.schedulePersist();
  }

  function duplicateActiveTab() {
    const t = C.activeTab();
    if (!t) return;
    const clone = JSON.parse(JSON.stringify(t.request));
    const req = C.newRequest(clone);
    req.name = t.name + ' copy';
    const nt = newRequestTab(req, t.provenance ? null : null);
    nt.dirty = true;
    C.toast('Tab duplicated');
  }

  function cycleTab(dir) {
    if (!S0.tabs.length) return;
    const idx = S0.tabs.findIndex((t) => t.id === S0.activeTabId);
    const next = (idx + dir + S0.tabs.length) % S0.tabs.length;
    selectTab(S0.tabs[next].id);
  }

  function selectTabByIndex(n) {
    if (S0.tabs[n - 1]) selectTab(S0.tabs[n - 1].id);
  }

  // ==================================================================
  // Collections
  // ==================================================================
  function findItem(col, itemId) {
    let found = null;
    (function walk(items, parents) {
      for (const it of items || []) {
        if (it.id === itemId) { found = { item: it, col, parents }; return; }
        if (it.type === 'folder') walk(it.items, parents.concat(it));
      }
    })(col.items, []);
    return found;
  }

  function findItemPath(col, itemId) {
    let found = null;
    (function walk(items, parents) {
      for (const it of items || []) {
        if (it.id === itemId) { found = { item: it, parents }; return; }
        if (it.type === 'folder') walk(it.items, parents.concat(it));
      }
    })(col.items, []);
    return found;
  }

  function renderCollections() {
    const tree = $('col-tree');
    tree.innerHTML = '';
    const q = ($('side-search').value || '').trim().toLowerCase();
    if (!S0.collections.length) {
      tree.append(C.el('div', { class: 'side-empty' }, 'No collections yet. Use + to create one, or import a Postman collection.'));
      return;
    }
    for (const col of S0.collections) {
      const selected = S0.settings.selectedCollectionId === col.id;
      const row = C.el('div', {
        class: 'tree-row' + (selected ? ' selected' : ''),
        style: 'font-weight:600',
        onclick: (e) => { S0.settings.selectedCollectionId = col.id; C.schedulePersist(); renderCollections(); },
        oncontextmenu: (e) => collectionMenu(e, col),
      }, [
        C.el('span', { class: 'tw' }, '▾'),
        C.el('span', { class: 'icon' }, '📂'),
        C.el('span', { class: 'name' }, col.name),
      ]);
      tree.append(row);
      if (q) {
        const matches = [];
        (function walk(items, parents) {
          for (const it of items || []) {
            if (it.type === 'request' && (it.name.toLowerCase().includes(q) || (it.request && it.request.url && it.request.url.toLowerCase().includes(q)))) {
              matches.push({ item: it, parents, col });
            } else if (it.type === 'folder') walk(it.items, parents.concat(it));
          }
        })(col.items, []);
        for (const m of matches) {
          tree.append(requestRow(m.item, col, 1, m.parents));
        }
      } else {
        renderTreeChildren(tree, col.items, col, 1);
      }
    }
  }

  function isExpanded(id) {
    return (S0.settings.expanded || []).includes(id);
  }

  function renderTreeChildren(container, items, col, depth) {
    for (const item of items || []) {
      if (item.type === 'folder') {
        const open = isExpanded(item.id);
        const row = C.el('div', {
          class: 'tree-row',
          style: `padding-left:${10 + depth * 14}px`,
          onclick: () => {
            const arr = S0.settings.expanded || (S0.settings.expanded = []);
            const i = arr.indexOf(item.id);
            if (i === -1) arr.push(item.id);
            else arr.splice(i, 1);
            C.schedulePersist();
            renderCollections();
          },
          oncontextmenu: (e) => folderMenu(e, col, item),
        }, [
          C.el('span', { class: 'tw' }, open ? '▾' : '▸'),
          C.el('span', { class: 'icon' }, open ? '📂' : '📁'),
          C.el('span', { class: 'name' }, item.name),
        ]);
        container.append(row);
        if (open) renderTreeChildren(container, item.items, col, depth + 1);
      } else {
        container.append(requestRow(item, col, depth));
      }
    }
  }

  function requestRow(item, col, depth, parents) {
    const m = (item.request && item.request.method) || 'GET';
    return C.el('div', {
      class: 'tree-row',
      style: `padding-left:${10 + depth * 14}px`,
      title: item.request && item.request.url,
      onclick: () => openRequestFromCollection(col, item),
      oncontextmenu: (e) => requestMenu(e, col, item),
    }, [
      C.el('span', { class: 'tw' }, ''),
      C.el('span', { class: 'm', style: `color:var(--method-${m.toLowerCase()})` }, m.slice(0, 3)),
      C.el('span', { class: 'name' }, item.name),
    ]);
  }

  function openRequestFromCollection(col, item) {
    const req = C.newRequest(JSON.parse(JSON.stringify(item.request || {})));
    if (item.auth && item.auth.type && item.auth.type !== 'none') {
      req.auth = JSON.parse(JSON.stringify(item.auth));
    } else {
      req.auth = { type: 'inherit' };
    }
    req.name = item.name;
    const t = newRequestTab(req, { collectionId: col.id, itemId: item.id });
    t.provenance = { collectionId: col.id, itemId: item.id };
    C.schedulePersist();
    C.addConsole('info', 'system', `Opened "${item.name}" from ${col.name}`);
    return t;
  }

  async function newCollection() {
    const name = await C.promptDialog('New collection', 'Collection name', 'My Collection');
    if (!name) return;
    const col = { id: C.uid('col'), name, description: '', auth: null, variables: [], items: [] };
    S0.collections.push(col);
    S0.settings.selectedCollectionId = col.id;
    C.schedulePersist();
    renderCollections();
  }

  async function addRequestTo(parent) {
    const col = parent.col;
    const items = parent.type === 'collection' ? col.items : parent.item.items;
    const item = { id: C.uid('it'), name: 'Untitled request', type: 'request', request: C.newRequest({ name: 'Untitled request' }), auth: null, description: '' };
    items.push(item);
    C.schedulePersist();
    renderCollections();
    openRequestFromCollection(col, item);
  }

  async function addFolderTo(parent) {
    const col = parent.col;
    const items = parent.type === 'collection' ? col.items : parent.item.items;
    const name = await C.promptDialog('New folder', 'Folder name', 'New Folder');
    if (!name) return;
    items.push({ id: C.uid('dir'), name, type: 'folder', items: [], auth: null, description: '' });
    C.schedulePersist();
    renderCollections();
  }

  async function renameItem(col, item) {
    const name = await C.promptDialog('Rename', 'Name', item.name);
    if (!name) return;
    item.name = name;
    if (item.type === 'request') item.request.name = name;
    // also update open tabs with this provenance
    for (const t of S0.tabs) {
      if (t.provenance && t.provenance.itemId === item.id) {
        t.name = name;
        t.request.name = name;
      }
    }
    C.schedulePersist();
    renderCollections();
    renderTabs();
  }

  async function deleteItem(col, item) {
    const ok = await C.confirmDialog(`Delete "${item.name}"? This cannot be undone.`, { title: 'Delete', danger: true, okLabel: 'Delete' });
    if (!ok) return;
    removeItemRecursive(col.items, item.id);
    for (let i = S0.tabs.length - 1; i >= 0; i--) {
      const t = S0.tabs[i];
      if (t.provenance && t.provenance.itemId === item.id) closeTab(t.id);
    }
    C.schedulePersist();
    renderCollections();
  }

  function removeItemRecursive(items, id) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === id) {
        items.splice(i, 1);
        return true;
      }
      if (items[i].type === 'folder' && removeItemRecursive(items[i].items, id)) return true;
    }
    return false;
  }

  function cloneItem(item) {
    const c = JSON.parse(JSON.stringify(item));
    (function reid(it) {
      it.id = C.uid(it.type === 'folder' ? 'dir' : 'it');
      if (it.type === 'request') it.request.id = C.uid('req');
      for (const ch of it.items || []) reid(ch);
    })(c);
    return c;
  }

  function duplicateItem(col, item) {
    const src = findItemPath(col, item.id);
    if (!src) return;
    src.parents.length ? src.parents[src.parents.length - 1].items.push(cloneItem(item)) : col.items.push(cloneItem(item));
    C.schedulePersist();
    renderCollections();
  }

  function collectionMenu(e, col) {
    e.preventDefault();
    C.showContextMenu(e.clientX, e.clientY, [
      { label: 'Add request', action: () => addRequestTo({ type: 'collection', col }) },
      { label: 'Add folder', action: () => addFolderTo({ type: 'collection', col }) },
      { label: 'Rename collection…', action: async () => { const n = await C.promptDialog('Rename collection', 'Name', col.name); if (n) { col.name = n; C.schedulePersist(); renderCollections(); } } },
      { label: 'Export collection…', action: () => exportCollection(col) },
      '-',
      { label: 'Delete collection', danger: true, action: async () => {
        const ok = await C.confirmDialog(`Delete collection "${col.name}" and all its requests?`, { title: 'Delete collection', danger: true, okLabel: 'Delete' });
        if (!ok) return;
        S0.collections = S0.collections.filter((c) => c.id !== col.id);
        if (S0.settings.selectedCollectionId === col.id) S0.settings.selectedCollectionId = S0.collections[0] ? S0.collections[0].id : null;
        C.schedulePersist();
        renderCollections();
      } },
    ]);
  }

  function folderMenu(e, col, folder) {
    e.preventDefault();
    C.showContextMenu(e.clientX, e.clientY, [
      { label: 'Add request', action: () => addRequestTo({ type: 'folder', col, item: folder }) },
      { label: 'Add subfolder', action: () => addFolderTo({ type: 'folder', col, item: folder }) },
      { label: 'Rename folder…', action: () => renameItem(col, folder) },
      { label: 'Duplicate', action: () => duplicateItem(col, folder) },
      '-',
      { label: 'Delete folder', danger: true, action: () => deleteItem(col, folder) },
    ]);
  }

  function requestMenu(e, col, item) {
    e.preventDefault();
    C.showContextMenu(e.clientX, e.clientY, [
      { label: 'Open in new tab', action: () => openRequestFromCollection(col, item) },
      { label: 'Rename request…', action: () => renameItem(col, item) },
      { label: 'Duplicate', action: () => duplicateItem(col, item) },
      '-',
      { label: 'Delete request', danger: true, action: () => deleteItem(col, item) },
    ]);
  }

  function exportCollection(col) {
    const v21 = SH.collection.collectionToV21(col);
    C.download(slug(col.name) + '.postman_collection.json', JSON.stringify(v21, null, 2));
    C.toast('Collection exported (Postman v2.1)', 'ok');
  }

  function exportSelectedCollection() {
    const col = S0.collections.find((c) => c.id === S0.settings.selectedCollectionId) || S0.collections[0];
    if (!col) {
      C.toast('No collection to export', 'warn');
      return;
    }
    exportCollection(col);
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'api-manager';
  }

  // ==================================================================
  // Environments
  // ==================================================================
  function renderEnvs() {
    const list = $('env-list');
    list.innerHTML = '';
    if (!S0.environments.length) {
      list.append(C.el('div', { class: 'side-empty' }, 'No environments. Use + to create one.'));
    }
    for (const env of S0.environments) {
      const active = S0.settings.activeEnvId === env.id;
      const row = C.el('div', {
        class: 'env-row' + (active ? ' active' : ''),
        onclick: () => setActiveEnv(env.id),
        oncontextmenu: (e) => envMenu(e, env),
      }, [
        C.el('input', { type: 'radio', 'aria-label': 'Use environment ' + env.name, onclick: (e) => e.stopPropagation(), checked: active ? true : null }),
        C.el('span', { class: 'name' }, env.name),
        C.el('span', { class: 'acts' }, [
          C.el('button', { class: 'icon-btn', title: 'Rename environment', onclick: async (e) => { e.stopPropagation(); const n = await C.promptDialog('Rename environment', 'Name', env.name); if (n) { env.name = n; C.schedulePersist(); renderEnvs(); } } }, '✎'),
          C.el('button', { class: 'icon-btn', title: 'Delete environment', onclick: async (e) => { e.stopPropagation(); const ok = await C.confirmDialog(`Delete environment "${env.name}"?`, { title: 'Delete environment', danger: true, okLabel: 'Delete' }); if (ok) { S0.environments = S0.environments.filter((x) => x.id !== env.id); if (S0.settings.activeEnvId === env.id) S0.settings.activeEnvId = null; C.schedulePersist(); renderEnvs(); } } }, '✕'),
        ]),
      ]);
      list.append(row);
    }
    // active env select in footer
    const sel = $('active-env-select');
    sel.innerHTML = '<option value="">No environment</option>';
    for (const env of S0.environments) {
      sel.append(C.el('option', { value: env.id }, env.name));
    }
    sel.value = S0.settings.activeEnvId || '';
  }

  function setActiveEnv(id) {
    S0.settings.activeEnvId = id || null;
    C.schedulePersist();
    renderEnvs();
    renderEditor();
    const env = C.activeEnv();
    C.addConsole('info', 'system', env ? 'Active environment: ' + env.name : 'Environment disabled');
  }

  async function newEnvironment() {
    const name = await C.promptDialog('New environment', 'Environment name', 'Development');
    if (!name) return;
    const env = { id: C.uid('env'), name, values: [] };
    S0.environments.push(env);
    S0.settings.activeEnvId = env.id;
    C.schedulePersist();
    renderEnvs();
  }

  function envMenu(e, env) {
    e.preventDefault();
    C.showContextMenu(e.clientX, e.clientY, [
      { label: 'Use this environment', action: () => setActiveEnv(env.id) },
      { label: 'Rename…', action: async () => { const n = await C.promptDialog('Rename environment', 'Name', env.name); if (n) { env.name = n; C.schedulePersist(); renderEnvs(); } } },
      { label: 'Export…', action: () => { C.download(slug(env.name) + '.postman_environment.json', JSON.stringify(SH.collection.environmentToPostman(env), null, 2)); C.toast('Environment exported', 'ok'); } },
      '-',
      { label: 'Delete', danger: true, action: async () => { const ok = await C.confirmDialog(`Delete environment "${env.name}"?`, { title: 'Delete environment', danger: true, okLabel: 'Delete' }); if (ok) { S0.environments = S0.environments.filter((x) => x.id !== env.id); if (S0.settings.activeEnvId === env.id) S0.settings.activeEnvId = null; C.schedulePersist(); renderEnvs(); } } },
    ]);
  }

  function exportActiveEnv() {
    const env = C.activeEnv();
    if (!env) {
      C.toast('No active environment to export', 'warn');
      return;
    }
    C.download(slug(env.name) + '.postman_environment.json', JSON.stringify(SH.collection.environmentToPostman(env), null, 2));
    C.toast('Environment exported', 'ok');
  }

  // ==================================================================
  // Globals
  // ==================================================================
  function renderGlobals() {
    const box = $('globals-editor');
    box.innerHTML = '';
    const wrap = C.el('div', { class: 'kv-editor' });
    for (const v of S0.globals.values || []) {
      wrap.append(globalRow(v));
    }
    if (!S0.globals.values.length) {
      wrap.append(C.el('div', { class: 'side-empty' }, 'No global variables.'));
    }
    box.append(wrap);
  }

  function globalRow(v) {
    const row = C.el('div', { class: 'kv-row' }, [
      C.el('input', { class: 'k', value: v.key, 'aria-label': 'Variable name', spellcheck: 'false' }),
      C.el('input', { class: 'v', value: v.value, 'aria-label': 'Variable value', spellcheck: 'false' }),
      C.el('button', { class: 'icon-btn', title: 'Remove', 'aria-label': 'Remove variable', onclick: () => { S0.globals.values = S0.globals.values.filter((x) => x !== v); C.schedulePersist(); renderGlobals(); } }, '✕'),
    ]);
    const [k, val] = row.querySelectorAll('input');
    k.addEventListener('input', () => { v.key = k.value; C.schedulePersist(); });
    val.addEventListener('input', () => { v.value = val.value; C.schedulePersist(); });
    return row;
  }

  function addGlobalVar() {
    S0.globals.values.push({ key: '', value: '', enabled: true });
    C.schedulePersist();
    renderGlobals();
  }

  // ==================================================================
  // History
  // ==================================================================
  function renderHistory() {
    const list = $('history-list');
    list.innerHTML = '';
    if (!S0.history.length) {
      list.append(C.el('div', { class: 'side-empty' }, 'No requests sent yet.'));
      return;
    }
    for (const h of S0.history.slice(0, 50)) {
      const row = C.el('div', {
        class: 'hist-row',
        title: new Date(h.ts).toLocaleString() + ' — ' + h.url,
        onclick: () => openHistoryEntry(h),
      }, [
        C.el('span', { class: 'dot', style: `background:${h.ok ? 'var(--green)' : 'var(--red)'}` }),
        C.el('span', { class: 'm', style: `color:var(--method-${(h.method || 'get').toLowerCase()}); font-size:9.5px; font-weight:700` }, (h.method || 'GET').slice(0, 3)),
        C.el('span', { class: 'u' }, h.url),
        C.el('span', { class: 'st' }, String(h.status)),
      ]);
      list.append(row);
    }
  }

  function openHistoryEntry(h) {
    const req = C.newRequest(JSON.parse(JSON.stringify(h.request || {})));
    const t = newRequestTab(req, null);
    t.name = h.name;
    t.fromHistory = true;
    t.response = h.response || null;
    t.tests = h.tests || [];
    C.schedulePersist();
    renderEditor();
    C.addConsole('info', 'request', `Restored from history: ${h.method} ${h.url} → ${h.status}`);
  }

  async function clearHistory() {
    const ok = await C.confirmDialog('Clear all request history?', { title: 'Clear history', danger: true, okLabel: 'Clear' });
    if (!ok) return;
    S0.history = [];
    await C.dbClear('history');
    renderHistory();
    C.addConsole('info', 'system', 'History cleared');
  }

  // ==================================================================
  // Editor (request)
  // ==================================================================
  const PANELS = ['params', 'auth', 'headers', 'body', 'scripts', 'settings', 'vars'];

  function renderEditor() {
    const t = C.activeTab();
    updateEmptyState();
    if (!t) return;
    const r = t.request;
    // method select
    const ms = $('req-method');
    if (ms.options.length === 0) {
      for (const m of C.METHODS) {
        const o = C.el('option', { value: m }, m);
        ms.append(o);
      }
    }
    ms.value = r.method;
    ms.style.color = `var(--method-${r.method.toLowerCase()})`;
    const urlInput = $('req-url');
    if (document.activeElement !== urlInput) urlInput.value = r.url;
    $('btn-run-again').classList.toggle('hidden', !(t.response || t.fromHistory));
    // panels
    for (const p of PANELS) {
      const btn = document.querySelector(`.panel-tabs [data-panel="${p}"]`);
      if (btn) btn.classList.toggle('active', S0.settings.activePanel === p);
    }
    for (const page of document.querySelectorAll('.panel-page')) {
      page.classList.toggle('active', page.dataset.panelbody === S0.settings.activePanel);
    }
    renderPanel(S0.settings.activePanel, t);
    renderResponse(t);
  }

  function renderPanel(name, t) {
    const page = document.querySelector(`.panel-page[data-panelbody="${name}"]`);
    if (!page) return;
    page.innerHTML = '';
    if (name === 'params') renderKVPanel(page, t.request.query, { keyPh: 'parameter', valuePh: 'value', addLabel: 'Add query parameter', hint: 'Query parameters are appended to the URL. Disabled rows are ignored.', onEdit: syncUrlFromParams });
    else if (name === 'headers') renderKVPanel(page, t.request.headers, { keyPh: 'header name', valuePh: 'value', addLabel: 'Add header', hint: 'Headers are expanded for variables before each request.' });
    else if (name === 'vars') renderKVPanel(page, t.request.variables, { keyPh: 'variable', valuePh: 'value', addLabel: 'Add request variable', hint: 'Request variables override the active environment and globals. Reference them as {{name}}.' });
    else if (name === 'auth') renderAuthPanel(page, t);
    else if (name === 'body') renderBodyPanel(page, t);
    else if (name === 'scripts') renderScriptsPanel(page, t);
    else if (name === 'settings') renderSettingsPanel(page, t);
  }

  function renderKVPanel(page, rows, opts) {
    const table = C.el('table', { class: 'kv-table' }, [
      C.el('thead', null, C.el('tr', null, [C.el('th', null, ''), C.el('th', null, 'Key'), C.el('th', null, 'Value'), C.el('th', null, 'Del')])),
    ]);
    const tb = C.el('tbody');
    for (const row of rows) {
      const tr = C.el('tr', { class: row.enabled === false ? 'disabled' : '' });
      const cb = C.el('input', { type: 'checkbox', checked: row.enabled !== false ? true : null, 'aria-label': 'Enable ' + (row.key || 'row') });
      const kIn = C.el('input', { value: row.key, placeholder: opts.keyPh, spellcheck: 'false', 'aria-label': 'Key' });
      const vIn = C.el('input', { value: row.value, placeholder: opts.valuePh, spellcheck: 'false', 'aria-label': 'Value' });
      const del = C.el('button', { class: 'del-btn icon-btn', title: 'Remove row', 'aria-label': 'Remove row', onclick: () => { rows.splice(rows.indexOf(row), 1); markDirtyTab(); renderPanelCurrent(); } }, '✕');
      cb.addEventListener('change', () => { row.enabled = cb.checked; tr.classList.toggle('disabled', !row.enabled); markDirtyTab(); });
      kIn.addEventListener('input', () => { row.key = kIn.value; markDirtyTab(); if (opts.onEdit) opts.onEdit(); });
      vIn.addEventListener('input', () => { row.value = vIn.value; markDirtyTab(); if (opts.onEdit) opts.onEdit(); });
      tr.append(C.el('td', { class: 'enabled' }, cb), C.el('td', null, kIn), C.el('td', null, vIn), C.el('td', { class: 'del' }, del));
      tb.append(tr);
    }
    table.append(tb);
    page.append(table);
    page.append(
      C.el('div', { class: 'kv-foot' }, [
        C.el('button', { class: 'btn small', onclick: () => { rows.push({ key: '', value: '', enabled: true }); markDirtyTab(); renderPanelCurrent(); } }, '+ ' + opts.addLabel),
        C.el('span', { class: 'hint' }, opts.hint),
      ])
    );
  }

  function renderPanelCurrent() {
    const t = C.activeTab();
    renderPanel(S0.settings.activePanel, t);
  }

  function markDirtyTab() {
    C.markDirty(C.activeTab());
  }

  function syncUrlFromParams() {
    const t = C.activeTab();
    if (!t) return;
    const r = t.request;
    let url = r.url;
    const qIdx = url.indexOf('?');
    const base = qIdx === -1 ? url : url.slice(0, qIdx);
    const q = r.query.filter((x) => x.enabled !== false && x.key !== '');
    const qs = q.map((x) => encodeURIComponent(x.key) + '=' + encodeURIComponent(x.value || '')).join('&');
    r.url = base + (qs ? '?' + qs : '');
    const urlInput = $('req-url');
    if (document.activeElement !== urlInput) urlInput.value = r.url;
  }

  function parseUrlIntoParams(t) {
    const r = t.request;
    const qIdx = r.url.indexOf('?');
    if (qIdx === -1) {
      r.query = [];
      return;
    }
    const base = r.url.slice(0, qIdx);
    const qs = r.url.slice(qIdx + 1);
    const rows = [];
    for (const pair of qs.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      let k, v;
      try {
        k = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
        v = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
      } catch (e) {
        k = eq === -1 ? pair : pair.slice(0, eq);
        v = eq === -1 ? '' : pair.slice(eq + 1);
      }
      rows.push({ key: k, value: v, enabled: true });
    }
    r.query = rows;
    r.url = base + (rows.length ? '?' + rows.map((x) => encodeURIComponent(x.key) + '=' + encodeURIComponent(x.value || '')).join('&') : '');
  }

  // ----- Auth panel -----
  const AUTH_TYPES = [
    ['inherit', 'Inherit from collection'],
    ['none', 'No Auth'],
    ['apikey', 'API Key'],
    ['bearer', 'Bearer Token'],
    ['basic', 'Basic Auth'],
    ['digest', 'Digest Auth'],
    ['oauth1', 'OAuth 1.0a'],
    ['oauth2', 'OAuth 2.0'],
    ['hawk', 'Hawk'],
    ['aws4', 'AWS Signature v4'],
    ['edgegrid', 'Akamai EdgeGrid'],
    ['ntlmv2', 'NTLMv2'],
    ['jwt', 'HMAC JWT (HS256/384/512)'],
  ];

  function renderAuthPanel(page, t) {
    const r = t.request;
    if (!r.auth || !r.auth.type) r.auth = { type: 'inherit' };
    const sel = C.el('select', { 'aria-label': 'Auth type' });
    for (const [v, label] of AUTH_TYPES) sel.append(C.el('option', { value: v }, label));
    sel.value = r.auth.type;
    sel.addEventListener('change', () => {
      r.auth = defaultAuth(sel.value);
      markDirtyTab();
      renderPanelCurrent();
    });
    page.append(C.el('div', { class: 'auth-type-row' }, [C.el('span', { class: 'hint' }, 'Type'), sel]));
    const body = C.el('div');
    page.append(body);
    renderAuthFields(body, r.auth, t);
  }

  function defaultAuth(type) {
    switch (type) {
      case 'inherit': return { type: 'inherit' };
      case 'none': return { type: 'none' };
      case 'apikey': return { type: 'apikey', key: '', value: '', in: 'header' };
      case 'bearer': return { type: 'bearer', prefix: 'Bearer', token: '' };
      case 'basic': return { type: 'basic', username: '', password: '' };
      case 'digest': return { type: 'digest', username: '', password: '', algorithm: 'MD5' };
      case 'oauth1': return { type: 'oauth1', consumerKey: '', consumerSecret: '', token: '', tokenSecret: '', signatureMethod: 'HMAC-SHA1' };
      case 'oauth2': return { type: 'oauth2', flow: 'access_token', accessToken: '', tokenUrl: '', clientId: '', clientSecret: '', scope: '' };
      case 'hawk': return { type: 'hawk', id: '', key: '' };
      case 'aws4': return { type: 'aws4', accessKeyId: '', secretAccessKey: '', sessionToken: '', region: 'us-east-1', service: '' };
      case 'edgegrid': return { type: 'edgegrid', clientToken: '', clientSecretKey: '' };
      case 'ntlmv2': return { type: 'ntlmv2', username: '', password: '', domain: '' };
      case 'jwt': return { type: 'jwt', alg: 'HS256', iss: '', sub: '', aud: '', expSeconds: '300', secret: '' };
      default: return { type: 'none' };
    }
  }

  function field(label, input, sub) {
    return C.el('div', { class: 'field' }, [C.el('label', null, label), input, sub ? C.el('span', { class: 'sub' }, sub) : null]);
  }

  function textInput(initial, onChange, opts) {
    const i = C.el('input', Object.assign({ type: 'text', value: initial || '', spellcheck: 'false' }, opts || {}));
    i.addEventListener('input', () => onChange(i.value));
    return i;
  }
  function selectInput(initial, options, onChange) {
    const s = C.el('select');
    for (const [v, label] of options) s.append(C.el('option', { value: v }, label));
    s.value = initial;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function passwordInput(initial, onChange) {
    const i = C.el('input', { type: 'password', value: initial || '', spellcheck: 'false' });
    i.addEventListener('input', () => onChange(i.value));
    return i;
  }

  function renderAuthFields(body, a, t) {
    body.innerHTML = '';
    const set = (fn) => (v) => { fn(v); markDirtyTab(); };
    switch (a.type) {
      case 'inherit': {
        const resolved = C.resolveInheritedAuth(a);
        body.append(
          C.el('div', { class: 'inherit-note' }, [
            'This request inherits authorization from its collection (or the nearest folder). ',
            C.el('b', null, resolved.type === 'none' ? 'No auth is currently configured above this request.' : 'Currently resolving to: ' + resolved.type.toUpperCase()),
          ])
        );
        break;
      }
      case 'none':
        body.append(C.el('div', { class: 'inherit-note' }, 'No authorization will be sent with this request.'));
        break;
      case 'apikey':
        body.append(
          field('Key', textInput(a.key, set((v) => (a.key = v)), { placeholder: 'X-Api-Key' })),
          field('Value', textInput(a.value, set((v) => (a.value = v)))),
          field('Add to', selectInput(a.in, [['header', 'Header'], ['query', 'Query string']], set((v) => (a.in = v))))
        );
        break;
      case 'bearer':
        body.append(
          field('Token', textInput(a.token, set((v) => (a.token = v)), { placeholder: 'your-token' })),
          field('Prefix', textInput(a.prefix, set((v) => (a.prefix = v)), { placeholder: 'Bearer' }), 'Leave empty for a raw token.')
        );
        break;
      case 'basic':
        body.append(
          field('Username', textInput(a.username, set((v) => (a.username = v)))),
          field('Password', passwordInput(a.password, (v) => { a.password = v; markDirtyTab(); }))
        );
        break;
      case 'digest':
        body.append(
          field('Username', textInput(a.username, set((v) => (a.username = v)))),
          field('Password', (function () { const i = C.el('input', { type: 'password', value: a.password, spellcheck: 'false' }); i.addEventListener('input', () => { a.password = i.value; markDirtyTab(); }); return i; })()),
          field('Algorithm', selectInput(a.algorithm || 'MD5', [['MD5', 'MD5'], ['SHA-256', 'SHA-256']], set((v) => (a.algorithm = v))), 'The proxy performs the 401 challenge–response handshake automatically (qop=auth).')
        );
        break;
      case 'oauth1':
        body.append(
          field('Consumer Key', textInput(a.consumerKey, set((v) => (a.consumerKey = v)))),
          field('Consumer Secret', textInput(a.consumerSecret, set((v) => (a.consumerSecret = v)))),
          field('Token', textInput(a.token, set((v) => (a.token = v)), { placeholder: 'optional' })),
          field('Token Secret', textInput(a.tokenSecret, set((v) => (a.tokenSecret = v)), { placeholder: 'optional' })),
          field('Signature Method', selectInput(a.signatureMethod, [['HMAC-SHA1', 'HMAC-SHA1'], ['HMAC-SHA256', 'HMAC-SHA256'], ['PLAINTEXT', 'PLAINTEXT (unsafe)']], set((v) => (a.signatureMethod = v))))
        );
        break;
      case 'oauth2':
        body.append(
          field('Flow', selectInput(a.flow, [['access_token', 'Access Token (manual)'], ['client_credentials', 'Client Credentials (auto token exchange)']], set((v) => { a.flow = v; markDirtyTab(); renderPanelCurrent(); }))),
          a.flow === 'client_credentials'
            ? [
                field('Token URL', textInput(a.tokenUrl, set((v) => (a.tokenUrl = v)), { placeholder: 'https://auth.example.com/oauth/token' })),
                field('Client ID', textInput(a.clientId, set((v) => (a.clientId = v)))),
                field('Client Secret', (function () { const i = C.el('input', { type: 'password', value: a.clientSecret, spellcheck: 'false' }); i.addEventListener('input', () => { a.clientSecret = i.value; markDirtyTab(); }); return i; })()),
                field('Scope', textInput(a.scope, set((v) => (a.scope = v)), { placeholder: 'optional' })),
              ]
            : [
                field('Access Token', textInput(a.accessToken, set((v) => (a.accessToken = v)), { placeholder: 'paste token' })),
                C.el('div', { class: 'inherit-note' }, 'The token is sent as an Authorization: Bearer header.'),
              ]
        );
        break;
      case 'hawk':
        body.append(
          field('ID', textInput(a.id, set((v) => (a.id = v)))),
          field('Key', textInput(a.key, set((v) => (a.key = v)))),
          C.el('div', { class: 'inherit-note' }, 'Hawk header MAC (SHA-1) is computed locally using the current timestamp and a random nonce.')
        );
        break;
      case 'aws4':
        body.append(
          field('Access Key ID', textInput(a.accessKeyId, set((v) => (a.accessKeyId = v)))),
          field('Secret Access Key', textInput(a.secretAccessKey, set((v) => (a.secretAccessKey = v)))),
          field('Session Token', textInput(a.sessionToken, set((v) => (a.sessionToken = v)), { placeholder: 'optional (STS)' })),
          C.el('div', { class: 'field-row' }, [
            field('Region', textInput(a.region, set((v) => (a.region = v))), { placeholder: 'us-east-1' }),
            field('Service', textInput(a.service, set((v) => (a.service = v))), { placeholder: 's3' }),
          ]),
          C.el('div', { class: 'inherit-note' }, 'SigV4 uses UNSIGNED-PAYLOAD (the request body is not hashed into the signature).')
        );
        break;
      case 'edgegrid':
        body.append(
          field('Client Token', textInput(a.clientToken, set((v) => (a.clientToken = v)))),
          field('Client Secret Key', (function () { const i = C.el('input', { type: 'password', value: a.clientSecretKey, spellcheck: 'false' }); i.addEventListener('input', () => { a.clientSecretKey = i.value; markDirtyTab(); }); return i; })())
        );
        break;
      case 'ntlmv2':
        body.append(
          field('Username', textInput(a.username, set((v) => (a.username = v)))),
          field('Password', (function () { const i = C.el('input', { type: 'password', value: a.password, spellcheck: 'false' }); i.addEventListener('input', () => { a.password = i.value; markDirtyTab(); }); return i; })()),
          field('Domain', textInput(a.domain, set((v) => (a.domain = v)), { placeholder: 'optional (WORKGROUP)' }))
        );
        break;
      case 'jwt':
        body.append(
          field('Algorithm', selectInput(a.alg, [['HS256', 'HS256'], ['HS384', 'HS384'], ['HS512', 'HS512']], set((v) => (a.alg = v)))),
          field('Secret', (function () { const i = C.el('input', { type: 'password', value: a.secret, spellcheck: 'false' }); i.addEventListener('input', () => { a.secret = i.value; markDirtyTab(); }); return i; })()),
          C.el('div', { class: 'field-row' }, [
            field('iss (issuer)', textInput(a.iss, set((v) => (a.iss = v)))),
            field('sub (subject)', textInput(a.sub, set((v) => (a.sub = v)))),
          ]),
          C.el('div', { class: 'field-row' }, [
            field('aud (audience)', textInput(a.aud, set((v) => (a.aud = v)))),
            field('Lifetime (seconds)', textInput(a.expSeconds, set((v) => (a.expSeconds = v)), { placeholder: '300' })),
          ])
        );
        break;
    }
  }

  // ----- Body panel -----
  const BODY_MODES = [
    ['none', 'none'],
    ['raw', 'raw (JSON / XML / text / JS / HTML)'],
    ['urlencoded', 'urlencoded'],
    ['formdata', 'form-data (text fields)'],
    ['graphql', 'GraphQL'],
    ['soap11', 'SOAP 1.1'],
    ['soap12', 'SOAP 1.2'],
  ];

  function renderBodyPanel(page, t) {
    const r = t.request;
    const b = r.body;
    if (!b.graphql) b.graphql = { query: '', variables: '' };
    if (!b.soap) b.soap = { version: '1.1', action: '', envelope: '' };
    if (b.mode === 'soap12') b.soap.version = '1.2';
    if (b.mode === 'soap11') b.soap.version = '1.1';
    const sel = C.el('select', { 'aria-label': 'Body mode' });
    for (const [v, label] of BODY_MODES) sel.append(C.el('option', { value: v }, label));
    sel.value = b.mode;
    sel.addEventListener('change', () => {
      b.mode = sel.value;
      markDirtyTab();
      renderPanelCurrent();
    });
    page.append(C.el('div', { class: 'body-mode-row' }, sel));
    const box = C.el('div');
    page.append(box);
    const set = (fn) => (v) => { fn(v); markDirtyTab(); };

    if (b.mode === 'raw') {
      const langSel = C.el('select', { 'aria-label': 'Raw language' });
      for (const [v, label] of [['json', 'JSON'], ['xml', 'XML'], ['text', 'Text'], ['js', 'JavaScript'], ['html', 'HTML']]) langSel.append(C.el('option', { value: v }, label));
      langSel.value = b.rawLang || 'json';
      langSel.addEventListener('change', () => { b.rawLang = langSel.value; markDirtyTab(); });
      box.append(C.el('div', { class: 'raw-lang-row' }, langSel));
      const ta = C.el('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'Raw body' });
      ta.value = b.raw || '';
      ta.addEventListener('input', () => { b.raw = ta.value; markDirtyTab(); });
      box.append(ta);
    } else if (b.mode === 'urlencoded') {
      renderKVInto(box, b.urlencoded, { keyPh: 'field', valuePh: 'value', addLabel: 'Add field' });
    } else if (b.mode === 'formdata') {
      renderKVInto(box, b.formdata, { keyPh: 'field', valuePh: 'value', addLabel: 'Add text field' });
      box.append(C.el('div', { class: 'script-note' }, 'Multipart form-data with text fields only — file upload is not supported in v1.0.0.'));
    } else if (b.mode === 'graphql') {
      const q = C.el('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'GraphQL query', placeholder: 'query { me { name } }' });
      q.value = b.graphql.query || '';
      q.addEventListener('input', () => { b.graphql.query = q.value; markDirtyTab(); });
      const v = C.el('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'GraphQL variables (JSON)', placeholder: '{ "id": "1" }' });
      v.value = b.graphql.variables || '';
      v.addEventListener('input', () => { b.graphql.variables = v.value; markDirtyTab(); });
      box.append(
        C.el('div', { class: 'field' }, [C.el('label', null, 'Query'), q]),
        C.el('div', { class: 'field' }, [
          C.el('label', null, 'Variables (JSON)'),
          C.el('div', { class: 'field-row' }, [v, C.el('button', { class: 'btn small', onclick: () => { try { b.graphql.variables = JSON.stringify(JSON.parse(b.graphql.variables || '{}'), null, 2); v.value = b.graphql.variables; markDirtyTab(); C.toast('Variables formatted', 'ok'); } catch (e) { C.toast('Variables are not valid JSON: ' + e.message, 'err'); } } }, 'Format')]),
        ])
      );
    } else if (b.mode === 'soap11' || b.mode === 'soap12') {
      const ver = b.mode === 'soap12' ? '1.2' : '1.1';
      const action = C.el('input', { type: 'text', value: b.soap.action || '', placeholder: 'e.g. "urn:GetUser" (optional)', spellcheck: 'false' });
      action.addEventListener('input', () => { b.soap.action = action.value; markDirtyTab(); });
      const env = C.el('textarea', { class: 'code tall', spellcheck: 'false', 'aria-label': 'SOAP envelope' });
      env.value = b.soap.envelope || '';
      env.addEventListener('input', () => { b.soap.envelope = env.value; markDirtyTab(); });
      box.append(
        C.el('div', { class: 'field' }, [C.el('label', null, 'SOAPAction'), action]),
        C.el('div', { class: 'soap-actions' }, [
          C.el('button', { class: 'btn small', onclick: () => { b.soap.envelope = SH.soap.template(ver); env.value = b.soap.envelope; markDirtyTab(); } }, 'Load SOAP ' + ver + ' envelope template'),
          C.el('span', { class: 'hint' }, ver === '1.2' ? 'Content-Type: application/soap+xml — action is carried in Content-Type.' : 'Content-Type: text/xml — SOAPAction is sent as a header (empty action = "").'),
        ]),
        env
      );
    } else if (b.mode === 'none') {
      box.append(C.el('div', { class: 'inherit-note' }, 'No request body will be sent.'));
    }
  }

  function renderKVInto(container, rows, opts) {
    const wrap = C.el('div');
    renderKVPanelLike(wrap, rows, opts);
    container.append(wrap);
  }
  function renderKVPanelLike(page, rows, opts) {
    const table = C.el('table', { class: 'kv-table' }, [
      C.el('thead', null, C.el('tr', null, [C.el('th', null, ''), C.el('th', null, 'Key'), C.el('th', null, 'Value'), C.el('th', null, 'Del')])),
    ]);
    const tb = C.el('tbody');
    for (const row of rows) {
      const tr = C.el('tr', { class: row.enabled === false ? 'disabled' : '' });
      const cb = C.el('input', { type: 'checkbox', checked: row.enabled !== false ? true : null, 'aria-label': 'Enable ' + (row.key || 'field') });
      const kIn = C.el('input', { value: row.key, placeholder: opts.keyPh, spellcheck: 'false', 'aria-label': 'Key' });
      const vIn = C.el('input', { value: row.value, placeholder: opts.valuePh, spellcheck: 'false', 'aria-label': 'Value' });
      const del = C.el('button', { class: 'del-btn icon-btn', title: 'Remove', onclick: () => { rows.splice(rows.indexOf(row), 1); markDirtyTab(); renderPanelCurrent(); } }, '✕');
      cb.addEventListener('change', () => { row.enabled = cb.checked; tr.classList.toggle('disabled', !row.enabled); markDirtyTab(); });
      kIn.addEventListener('input', () => { row.key = kIn.value; markDirtyTab(); });
      vIn.addEventListener('input', () => { row.value = vIn.value; markDirtyTab(); });
      tr.append(C.el('td', { class: 'enabled' }, cb), C.el('td', null, kIn), C.el('td', null, vIn), C.el('td', { class: 'del' }, del));
      tb.append(tr);
    }
    table.append(tb);
    page.append(table);
    page.append(C.el('div', { class: 'kv-foot' }, C.el('button', { class: 'btn small', onclick: () => { rows.push({ key: '', value: '', enabled: true }); markDirtyTab(); renderPanelCurrent(); } }, '+ ' + opts.addLabel)));
  }

  // ----- Scripts panel -----
  function renderScriptsPanel(page, t) {
    const s = t.request.scripts;
    const pre = C.el('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'Pre-request script', placeholder: '// Runs before the request. Example:\n// pm.environment.set("csrf", "abc");' });
    pre.value = s.pre || '';
    pre.addEventListener('input', () => { s.pre = pre.value; markDirtyTab(); });
    const test = C.el('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'Tests script', placeholder: '// Runs after the response. Example:\n// pm.test("status is 200", () => pm.expect(pm.response.code).to.equal(200));' });
    test.value = s.test || '';
    test.addEventListener('input', () => { s.test = test.value; markDirtyTab(); });
    page.append(
      C.el('div', { class: 'script-block' }, [
        C.el('h4', null, 'Pre-request script'),
        pre,
        C.el('div', { class: 'script-note' }, 'Runs in an isolated, time-limited worker (5 s). Supported: pm.variables / pm.environment / pm.globals (get/set/unset), pm.request, console. Variable changes are persisted; a failing pre-request aborts the send.'),
      ]),
      C.el('div', { class: 'script-block' }, [
        C.el('h4', null, 'Tests (post-response)'),
        test,
        C.el('div', { class: 'script-note' }, 'Supported: pm.response (code, headers, header, text, json, time, sizeBytes), pm.test, pm.expect (chai-like subset: equal, deep eql, above, below, within, include, keys, property, a/an, ok/true/false/null/empty, match, throw, oneOf, lengthOf, string, startsWith, endsWith, not, deep), console.'),
      ])
    );
  }

  // ----- Settings panel -----
  function renderSettingsPanel(page, t) {
    const st = t.request.settings;
    if (!st) st.timeoutMs = 30000, (t.request.settings = st), (st.redirect = 'follow');
    const timeout = C.el('input', { type: 'number', min: '0', step: '1000', value: String(st.timeoutMs) });
    timeout.addEventListener('change', () => { st.timeoutMs = Math.max(0, parseInt(timeout.value, 10) || 0); markDirtyTab(); });
    const redirect = selectInput(st.redirect, [['follow', 'Follow redirects (max 5)'], ['limit', 'Follow 1 redirect'], ['none', 'Do not follow redirects']], (v) => { st.redirect = v; markDirtyTab(); });
    page.append(
      C.el('div', { class: 'settings-row' }, [C.el('label', null, 'Timeout (ms)'), timeout, C.el('span', { class: 'hint' }, '0 = no timeout')]),
      C.el('div', { class: 'settings-row' }, [C.el('label', null, 'Redirect behavior'), redirect]),
      C.el('div', { class: 'inherit-note' }, 'Redirects: 303 and 301/302/307/308 are followed with browser semantics (POST→GET on 301/302/303). Request bodies and URL-dependent auth (OAuth1, AWS v4, Hawk, EdgeGrid) are recomputed after each hop.')
    );
  }

  // ==================================================================
  // Response
  // ==================================================================
  function renderResponse(t) {
    const resp = t.response;
    const statusChip = $('resp-status');
    const dur = $('resp-duration');
    const size = $('resp-size');
    const content = $('resp-content');
    // view switch buttons
    for (const b of document.querySelectorAll('#resp-view-switch [data-view]')) {
      b.classList.toggle('active', b.dataset.view === S0.settings.view);
    }
    if (!resp) {
      statusChip.textContent = 'No response yet';
      statusChip.className = 'chip none';
      dur.textContent = '';
      size.textContent = '';
      content.innerHTML = '';
      content.append(
        C.el('div', { class: 'resp-empty' }, [
          C.el('div', { class: 'big' }, '⇄'),
          C.el('div', null, 'Send a request to see the response here.'),
          C.el('div', { class: 'hint' }, 'Ctrl+Enter to send · responses are cached locally for this tab'),
        ])
      );
      return;
    }
    if (!resp.ok && resp.error) {
      statusChip.textContent = 'Error';
      statusChip.className = 'chip err';
      dur.textContent = '';
      size.textContent = '';
      content.innerHTML = '';
      content.append(C.el('div', { class: 'resp-error' }, [
        C.el('div', { style: 'font-weight:700; margin-bottom:6px' }, 'Request failed'),
        C.el('div', null, resp.error),
      ]));
      return;
    }
    const cls = resp.status < 400 ? (resp.status < 300 ? 'ok' : 'warn') : 'err';
    statusChip.textContent = resp.status + ' ' + (resp.statusText || '');
    statusChip.className = 'chip ' + cls;
    dur.textContent = C.fmtDuration(resp.durationMs);
    size.textContent = C.fmtSize(resp.sizeBytes) + (resp.truncated ? ' (truncated at 20 MB)' : '');
    renderResponseTab(t, resp);
  }

  function responseBodyText(resp) {
    if (resp.bodyEncoding === 'base64') return null;
    return resp.body;
  }

  function detectKind(resp) {
    const ct = headerValue(resp.headers, 'content-type') || '';
    if (ct.includes('application/json') || ct.includes('+json')) return 'json';
    if (ct.includes('xml')) return 'xml';
    if (ct.includes('text/html')) return 'html';
    const text = typeof resp.body === 'string' && resp.bodyEncoding !== 'base64' ? resp.body : '';
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { JSON.parse(trimmed); return 'json'; } catch (e) { /* not json */ }
    }
    if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) return trimmed.startsWith('<!DOCTYPE html') || trimmed.startsWith('<html') ? 'html' : 'xml';
    return 'text';
  }

  function headerValue(headers, name) {
    for (const h of headers || []) if (String(h[0]).toLowerCase() === name) return h[1];
    return null;
  }

  function prettyJson(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {
      return null;
    }
  }

  function prettyXml(text) {
    try {
      let s = text.replace(/>\s+</g, '><').replace(/</g, '\n<').replace(/\n\s*\n/g, '\n');
      let pad = 0;
      const out = s
        .split('\n')
        .map((line) => {
          const t = line.trim();
          if (!t) return '';
          const closesFirst = /^<\//.test(t);
          if (closesFirst) pad = Math.max(0, pad - 1);
          const res = '  '.repeat(pad) + t;
          if (/^<[^!?][^>]*[^/]>$/.test(t) && !/^<[/?]/.test(t) && !t.includes('</')) pad++;
          return res;
        })
        .join('\n');
      return out;
    } catch (e) {
      return null;
    }
  }

  function renderResponseTab(t, resp) {
    const content = $('resp-content');
    content.innerHTML = '';
    for (const b of document.querySelectorAll('.resp-tabs [data-rtab]')) {
      b.classList.toggle('active', b.dataset.rtab === S0.settings.activeRTab);
    }
    const tab = S0.settings.activeRTab;
    const zoomPx = Math.round(12 * (S0.settings.zoom / 100));
    const wrap = S0.settings.wrap ? ' wrap' : '';
    const text = responseBodyText(resp);

    if (tab === 'body') {
      const kind = detectKind(resp);
      const view = S0.settings.view;
      const htmlBtn = document.querySelector('#resp-view-switch [data-view="html"]');
      if (htmlBtn) htmlBtn.classList.toggle('hidden', kind !== 'html');

      if (text === null) {
        content.append(
          C.el('div', { class: 'resp-empty' }, [
            C.el('div', { class: 'big' }, '▦'),
            C.el('div', null, 'Binary response (' + C.fmtSize(resp.sizeBytes) + ').'),
            C.el('div', { class: 'hint' }, 'Switch to Raw to view the base64 representation.'),
          ])
        );
        return;
      }
      if (view === 'html' && kind === 'html') {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', '');
        frame.setAttribute('aria-label', 'HTML preview');
        frame.srcdoc = resp.body;
        content.append(frame);
      } else if (view === 'pretty') {
        let out = text;
        if (kind === 'json') {
          out = prettyJson(text);
          if (out === null) {
            content.append(C.el('pre', { class: wrap, style: 'font-size:' + zoomPx + 'px' }, text));
            content.append(C.el('div', { class: 'hint', style: 'padding:8px 14px' }, 'Body claims JSON but does not parse — showing raw.'));
            return;
          }
        } else if (kind === 'xml') {
          out = prettyXml(text) || text;
        }
        content.append(C.el('pre', { class: wrap, style: 'font-size:' + zoomPx + 'px' }, out));
        if (kind === 'json') {
          const rawBtn = document.querySelector('#resp-view-switch [data-view="raw"]');
          if (rawBtn) rawBtn.title = 'Raw view (unparsed)';
        }
      } else {
        content.append(C.el('pre', { class: wrap, style: 'font-size:' + zoomPx + 'px' }, text));
      }
    } else if (tab === 'headers') {
      const table = C.el('table', { class: 'resp-table' }, [
        C.el('thead', null, C.el('tr', null, [C.el('th', null, 'Header'), C.el('th', null, 'Value'), C.el('th', null, '')])),
      ]);
      const tb = C.el('tbody');
      for (const [k, v] of resp.headers || []) {
        tb.append(C.el('tr', null, [
          C.el('td', { class: 'k' }, k),
          C.el('td', null, v),
          C.el('td', null, C.el('button', { class: 'icon-btn', title: 'Copy value', onclick: () => { C.copyToClipboard(v); C.toast('Copied', 'ok'); } }, '⧉')),
        ]));
      }
      table.append(tb);
      content.append(table);
    } else if (tab === 'cookies') {
      if (!(resp.cookies || []).length) {
        content.append(C.el('div', { class: 'resp-empty' }, [C.el('div', { class: 'big' }, '🍪'), C.el('div', null, 'No cookies set by this response.')]));
        return;
      }
      const table = C.el('table', { class: 'resp-table' }, [
        C.el('thead', null, C.el('tr', null, [C.el('th', null, 'Name'), C.el('th', null, 'Value'), C.el('th', null, 'Path'), C.el('th', null, 'Domain'), C.el('th', null, 'Expires'), C.el('th', null, 'Flags')])),
      ]);
      const tb = C.el('tbody');
      for (const c of resp.cookies) {
        const flags = [c.secure ? 'Secure' : '', c.httpOnly ? 'HttpOnly' : '', c.sameSite || ''].filter(Boolean).join(' ');
        tb.append(C.el('tr', null, [
          C.el('td', { class: 'k' }, c.name),
          C.el('td', null, c.value),
          C.el('td', null, c.path || ''),
          C.el('td', null, c.domain || ''),
          C.el('td', null, c.expires || (c.maxAge ? 'max-age=' + c.maxAge : 'session')),
          C.el('td', null, flags),
        ]));
      }
      table.append(tb);
      content.append(
        table,
        C.el('div', { style: 'padding:10px' }, C.el('button', { class: 'btn small', onclick: () => { C.copyToClipboard(resp.cookies.map((c) => c.name + '=' + c.value).join('; ')); C.toast('Copied Cookie header', 'ok'); } }, 'Copy as Cookie header'))
      );
    } else if (tab === 'tests') {
      const tests = t.tests || [];
      if (!tests.length) {
        content.append(C.el('div', { class: 'resp-empty' }, [C.el('div', { class: 'big' }, '✓'), C.el('div', null, 'No test results.'), C.el('div', { class: 'hint' }, 'Add a tests script (Scripts panel) to see results here.')]));
        return;
      }
      const pass = tests.filter((x) => x.pass).length;
      const box = C.el('div');
      box.append(C.el('div', { class: 'test-summary' }, pass + ' passing, ' + (tests.length - pass) + ' failing of ' + tests.length));
      for (const test of tests) {
        box.append(
          C.el('div', { class: 'test-item ' + (test.pass ? 'pass' : 'fail') }, [
            C.el('span', { class: 'mark' }, test.pass ? '✓' : '✕'),
            C.el('div', null, [test.name, test.error ? C.el('div', { class: 'err' }, test.error) : null]),
          ])
        );
      }
      content.append(box);
    }
  }

  function copyFullResponse(resp) {
    const lines = ['HTTP/1.1 ' + resp.status + ' ' + (resp.statusText || '')];
    for (const [k, v] of resp.headers || []) lines.push(k + ': ' + v);
    lines.push('');
    lines.push(resp.bodyEncoding === 'base64' ? '[binary body, base64]\n' + resp.body : resp.body || '');
    C.copyToClipboard(lines.join('\n')).then(() => C.toast('Copied response with headers', 'ok'));
  }

  function downloadBody(resp) {
    const text = responseBodyText(resp);
    const jsonText = text != null ? prettyJson(text) : null;
    let out, name;
    if (jsonText !== null) {
      out = jsonText;
      name = 'response.json';
    } else {
      // Non-JSON bodies are wrapped in a valid JSON document.
      out = JSON.stringify(
        {
          url: resp.url,
          status: resp.status,
          statusText: resp.statusText,
          headers: resp.headers,
          cookies: resp.cookies,
          sizeBytes: resp.sizeBytes,
          bodyEncoding: resp.bodyEncoding,
          body: resp.body,
          downloadedAt: new Date().toISOString(),
        },
        null,
        2
      );
      name = 'response.json';
    }
    C.download(name, out, 'application/json');
    C.toast('Downloaded ' + name, 'ok');
  }

  // ==================================================================
  // Sending
  // ==================================================================
  let workerSeq = 0;
  function runScriptStage(stage, script, context) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { worker.terminate(); } catch (e) { /* ignore */ }
        resolve(r);
      };
      let worker;
      try {
        worker = new Worker('worker.js');
      } catch (e) {
        return finish({ id: ++workerSeq, ok: false, stage, error: 'Could not start script worker: ' + e.message, tests: [], logs: [], changes: [] });
      }
      const id = ++workerSeq;
      const timer = setTimeout(() => finish({ id, ok: false, stage, error: 'Script timed out after 5 seconds and was terminated.', tests: [], logs: [], changes: [] }), 5000);
      worker.onmessage = (e) => {
        if (e.data && e.data.id === id) finish(e.data);
      };
      worker.onerror = (e) => finish({ id, ok: false, stage, error: e.message || 'Script worker error', tests: [], logs: [], changes: [] });
      worker.postMessage({ id, stage, script, context });
    });
  }

  function expandRequest(t) {
    const r = t.request;
    const resolve = C.buildResolver(t);
    const ex = (s) => (typeof s === 'string' ? V.expandString(s, resolve) : s);
    const out = JSON.parse(JSON.stringify(r));
    out.url = ex(out.url);
    out.query = out.query.map((q) => ({ ...q, key: ex(q.key), value: ex(q.value) }));
    out.headers = out.headers.map((h) => ({ ...h, key: ex(h.key), value: ex(h.value) }));
    out.variables = out.variables.map((v) => ({ ...v, key: ex(v.key), value: ex(v.value) }));
    out.body = {
      ...out.body,
      raw: ex(out.body.raw || ''),
      urlencoded: (out.body.urlencoded || []).map((f) => ({ ...f, key: ex(f.key), value: ex(f.value) })),
      formdata: (out.body.formdata || []).map((f) => ({ ...f, key: ex(f.key), value: ex(f.value) })),
      graphql: { query: ex(out.body.graphql ? out.body.graphql.query : ''), variables: ex(out.body.graphql ? out.body.graphql.variables : '') },
      soap: { ...out.body.soap, action: ex(out.body.soap ? out.body.soap.action : ''), envelope: ex(out.body.soap ? out.body.soap.envelope : '') },
    };
    if (out.auth) out.auth = { ...out.auth };
    return out;
  }

  function buildRequestBody(er) {
    const b = er.body || { mode: 'none' };
    const headers = [];
    switch (b.mode) {
      case 'raw': {
        const ct = { json: 'application/json', xml: 'application/xml', html: 'text/html', js: 'application/javascript', text: 'text/plain' }[b.rawLang] || 'text/plain';
        return { data: b.raw || '', headers: [['Content-Type', ct]] };
      }
      case 'urlencoded': {
        const data = (b.urlencoded || [])
          .filter((f) => f.enabled !== false && f.key !== '')
          .map((f) => encodeURIComponent(f.key) + '=' + encodeURIComponent(f.value || ''))
          .join('&');
        return { data, headers: [['Content-Type', 'application/x-www-form-urlencoded']] };
      }
      case 'formdata': {
        const boundary = '----apimanager-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        let data = '';
        for (const f of b.formdata || []) {
          if (f.enabled === false || f.key === '') continue;
          data += `--${boundary}\r\nContent-Disposition: form-data; name="${f.key.replace(/"/g, '\\"')}"\r\n\r\n${f.value || ''}\r\n`;
        }
        data += `--${boundary}--\r\n`;
        return { data, headers: [['Content-Type', 'multipart/form-data; boundary=' + boundary]] };
      }
      case 'graphql': {
        let obj = { query: b.graphql ? b.graphql.query : '' };
        if (b.graphql && b.graphql.variables) {
          try {
            obj.variables = JSON.parse(b.graphql.variables);
          } catch (e) {
            obj.variables = b.graphql.variables;
          }
        }
        return { data: JSON.stringify(obj), headers: [['Content-Type', 'application/json']] };
      }
      case 'soap11':
      case 'soap12': {
        const ver = b.mode === 'soap12' ? '1.2' : '1.1';
        const envelope = b.soap && b.soap.envelope ? b.soap.envelope : SH.soap.template(ver);
        return { data: envelope, headers: Object.entries(SH.soap.soapHeaders(ver, b.soap ? b.soap.action : '')) };
      }
      default:
        return { data: null, headers: [] };
    }
  }

  function finalUrlOf(er) {
    let url = er.url || '';
    const pairs = (er.query || []).filter((q) => q.enabled !== false && q.key !== '');
    if (pairs.length) {
      const usp = new URLSearchParams();
      for (const q of pairs) usp.append(q.key, q.value == null ? '' : q.value);
      url += (url.includes('?') ? '&' : '?') + usp.toString();
    }
    return url;
  }

  async function sendTab(tabId) {
    const t = C.S.tabs.find((x) => x.id === tabId);
    if (!t || t.sending) return;
    t.sending = true;
    const btn = $('btn-send');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    C.addConsole('info', 'request', `→ ${t.request.method} ${t.request.url}`);
    try {
      parseUrlIntoParams(t); // keep the query table in sync with the typed URL
      const er = expandRequest(t);
      const built = buildRequestBody(er);
      const finalUrl = finalUrlOf(er);
      const userHeaders = (er.headers || []).filter((h) => h.enabled !== false && h.key !== '').map((h) => [h.key, h.value]);
      const headers = userHeaders.slice();
      for (const [k, v] of built.headers) {
        if (!headers.some(([hk]) => hk.toLowerCase() === k.toLowerCase())) headers.push([k, v]);
      }
      if (!headers.some(([hk]) => hk.toLowerCase() === 'user-agent')) headers.push(['User-Agent', 'API Manager/1.0.0 (+local desktop client)']);

      // pre-request script
      let preChanges = [];
      if (er.scripts && er.scripts.pre) {
        C.addConsole('info', 'script', 'Running pre-request script…');
        const res = await runScriptStage('prerequest', er.scripts.pre, {
          request: { method: er.method, url: finalUrl, headers, body: built.data || '' },
          requestVariables: er.variables,
          environmentVariables: C.activeEnv() ? C.activeEnv().values : [],
          globalVariables: C.S.globals.values,
        });
        for (const log of res.logs || []) C.addConsole(log.level === 'error' ? 'error' : log.level === 'warn' ? 'warn' : 'info', 'script', log.message);
        if (!res.ok) {
          t.response = { ok: false, error: 'Pre-request script failed: ' + res.error };
          t.tests = [];
          recordHistory(t, null);
          renderResponse(t);
          renderTabs();
          return;
        }
        preChanges = res.changes || [];
        applyVariableChanges(t, preChanges);
      }

      const auth = C.resolveInheritedAuth(er.auth);
      const spec = {
        method: er.method,
        // base URL only; the proxy appends the (expanded) query table, so
        // signatures always cover exactly the URL that is sent
        url: (er.url || '').split('?')[0],
        query: er.query,
        headers,
        body: built.data != null ? { encoding: 'utf8', data: built.data } : null,
        timeoutMs: er.settings && er.settings.timeoutMs,
        redirect: er.settings && er.settings.redirect ? er.settings.redirect : 'follow',
        auth: auth && auth.type !== 'none' ? auth : null,
      };

      const res = await fetch('/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
      });
      const data = await res.json();
      if (data.ok) {
        C.addConsole('info', 'request', `${er.method} ${finalUrl} → ${data.status} ${data.statusText || ''} (${C.fmtDuration(data.durationMs)}, ${C.fmtSize(data.sizeBytes)})`);
        if (data.truncated) C.addConsole('warn', 'request', 'Response body truncated at 20 MB');
      } else {
        C.addConsole('error', 'request', `${er.method} ${finalUrl} failed: ${data.error}`);
      }

      // post-response tests
      let tests = [];
      if (data.ok && er.scripts && er.scripts.test) {
        C.addConsole('info', 'script', 'Running tests…');
        const res2 = await runScriptStage('test', er.scripts.test, {
          request: { method: er.method, url: finalUrl, headers, body: built.data || '' },
          response: {
            code: data.status,
            reason: data.statusText || '',
            headers: data.headers || [],
            text: data.bodyEncoding === 'base64' ? '' : data.body,
            time: data.durationMs,
            sizeBytes: data.sizeBytes,
          },
          requestVariables: er.variables,
          environmentVariables: C.activeEnv() ? C.activeEnv().values : [],
          globalVariables: C.S.globals.values,
        });
        for (const log of res2.logs || []) C.addConsole(log.level === 'error' ? 'error' : log.level === 'warn' ? 'warn' : 'info', 'script', log.message);
        if (!res2.ok) {
          tests = [{ name: 'Tests script', pass: false, error: res2.error }];
          C.addConsole('error', 'script', 'Tests script failed: ' + res2.error);
        } else {
          tests = res2.tests || [];
          applyVariableChanges(t, res2.changes || []);
          const pass = tests.filter((x) => x.pass).length;
          C.addConsole(tests.length && pass === tests.length ? 'info' : 'warn', 'script', `Tests: ${pass}/${tests.length} passed`);
        }
      }

      t.response = data;
      t.tests = tests;
      t.fromHistory = false;
      recordHistory(t, tests);
      renderResponse(t);
      renderTabs();
      renderHistory();
    } catch (e) {
      t.response = { ok: false, error: (e && e.message) || String(e) };
      C.addConsole('error', 'request', 'Send failed: ' + ((e && e.message) || e));
      renderResponse(t);
      renderTabs();
    } finally {
      t.sending = false;
      btn.disabled = false;
      btn.textContent = 'Send';
    }
  }

  function applyVariableChanges(t, changes) {
    if (!changes || !changes.length) return;
    let changed = false;
    for (const ch of changes) {
      if (ch.scope === 'environment') {
        const env = C.activeEnv();
        if (!env) {
          C.addConsole('warn', 'script', `pm.environment.${ch.value === null ? 'unset' : 'set'}("${ch.name}") ignored — no active environment`);
          continue;
        }
        upsertVar(env.values, ch.name, ch.value);
        changed = true;
      } else if (ch.scope === 'globals') {
        upsertVar(C.S.globals.values, ch.name, ch.value);
        changed = true;
      } else if (ch.scope === 'request') {
        upsertVar(t.request.variables, ch.name, ch.value);
        changed = true;
      }
    }
    if (changed) {
      C.schedulePersist();
      renderEnvs();
      renderGlobals();
      if (C.S.settings.activePanel === 'vars') renderPanel('vars', t);
      C.addConsole('info', 'script', 'Script variable changes saved (' + changes.length + ')');
    }
  }

  function upsertVar(values, key, value) {
    if (!key) return;
    const existing = values.find((v) => v.key === key);
    if (value === null || value === undefined) {
      if (existing) values.splice(values.indexOf(existing), 1);
    } else if (existing) {
      existing.value = value;
    } else {
      values.push({ key, value, enabled: true });
    }
  }

  function recordHistory(t, tests) {
    const SH2 = SH.history;
    const entry = SH2.makeEntry({
      id: C.uid('hist'),
      ts: Date.now(),
      name: t.name,
      method: t.request.method,
      url: t.request.url,
      request: t.request,
      response: t.response,
      tests: tests || t.tests || [],
    });
    C.S.history = SH2.addEntry(C.S.history, entry);
    C.schedulePersist();
  }

  // ==================================================================
  // Save / codegen / import / export
  // ==================================================================
  async function openSaveDialog() {
    const t = C.activeTab();
    if (!t) return;
    if (!S0.collections.length) {
      C.toast('Create a collection first (sidebar → +)', 'warn');
      return;
    }
    const backdrop = C.el('div', { class: 'modal-backdrop' });
    const colSel = C.el('select', { 'aria-label': 'Collection' });
    for (const c of S0.collections) colSel.append(C.el('option', { value: c.id }, c.name));
    const folderSel = C.el('select', { 'aria-label': 'Folder' });
    const nameInput = C.el('input', { type: 'text', value: t.name, 'aria-label': 'Request name' });
    function fillFolders() {
      folderSel.innerHTML = '';
      const col = S0.collections.find((c) => c.id === colSel.value);
      folderSel.append(C.el('option', { value: '' }, '(root)'));
      (function walk(items, depth) {
        for (const it of items || []) {
          if (it.type === 'folder') {
            folderSel.append(C.el('option', { value: it.id }, '—'.repeat(depth) + ' ' + it.name));
            walk(it.items, depth + 1);
          }
        }
      })(col ? col.items : [], 0);
    }
    colSel.addEventListener('change', fillFolders);
    fillFolders();
    function close() { backdrop.remove(); }
    function save() {
      const col = S0.collections.find((c) => c.id === colSel.value);
      if (!col) return;
      const name = nameInput.value.trim() || 'Untitled request';
      let item = null;
      if (t.provenance && t.provenance.collectionId === col.id) {
        const found = findItem(col, t.provenance.itemId);
        item = found && found.item;
      }
      let items;
      if (folderSel.value) {
        const folder = findItemPath(col, folderSel.value);
        items = folder ? folder.item.items : col.items;
      } else {
        items = col.items;
      }
      if (!item) {
        item = { id: C.uid('it'), name, type: 'request', request: C.newRequest({}), auth: null, description: '' };
        items.push(item);
      }
      item.name = name;
      item.request = JSON.parse(JSON.stringify(t.request));
      if (t.request.auth && t.request.auth.type && t.request.auth.type !== 'inherit') {
        item.auth = JSON.parse(JSON.stringify(t.request.auth));
        item.request.auth = { type: 'inherit' };
      } else {
        item.auth = null;
        item.request.auth = { type: 'inherit' };
      }
      t.provenance = { collectionId: col.id, itemId: item.id };
      t.name = name;
      t.request.name = name;
      t.dirty = false;
      close();
      C.schedulePersist();
      renderCollections();
      renderTabs();
      C.toast('Saved to ' + col.name, 'ok');
    }
    backdrop.append(
      C.el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        C.el('div', { class: 'modal-head' }, [C.el('h3', null, 'Save request'), C.el('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, '✕')]),
        C.el('div', { class: 'modal-body' }, [
          C.el('div', { class: 'field' }, [C.el('label', null, 'Collection'), colSel]),
          C.el('div', { class: 'field' }, [C.el('label', null, 'Folder'), folderSel]),
          C.el('div', { class: 'field' }, [C.el('label', null, 'Request name'), nameInput]),
          C.el('div', { class: 'hint' }, 'Saved requests keep collection auth inheritance. Explicit auth types are stored on the request.'),
        ]),
        C.el('div', { class: 'modal-foot' }, [
          C.el('button', { class: 'btn', onclick: close }, 'Cancel'),
          C.el('button', { class: 'btn primary', onclick: save }, 'Save'),
        ]),
      ])
    );
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    $('modal-root').append(backdrop);
    nameInput.focus();
  }

  function openCodegenModal() {
    const t = C.activeTab();
    if (!t) return;
    const er = expandRequest(t);
    const built = buildRequestBody(er);
    const headers = (er.headers || []).filter((h) => h.enabled !== false && h.key !== '').map((h) => [h.key, h.value]);
    for (const [k, v] of built.headers) if (!headers.some(([hk]) => hk.toLowerCase() === k.toLowerCase())) headers.push([k, v]);
    const req = Object.assign({}, er, { headers, url: er.url });
    const snippets = SH.snippets.generateAll(req);
    const langs = [
      ['curl', 'cURL'],
      ['python', 'Python Requests'],
      ['fetch', 'JavaScript Fetch'],
      ['java', 'Java HttpClient'],
      ['postmanCli', 'Postman CLI'],
    ];
    let current = 'curl';
    const backdrop = C.el('div', { class: 'modal-backdrop' });
    const tabs = C.el('div', { class: 'snippet-tabs' });
    const out = C.el('pre', { class: 'code-out' });
    function render() {
      out.textContent = snippets[current];
      for (const b of tabs.children) b.classList.toggle('active', b.textContent === langs.find((l) => l[0] === current)[1]);
    }
    for (const [key, label] of langs) {
      tabs.append(
        C.el('button', { onclick: () => { current = key; render(); } }, label)
      );
    }
    function close() { backdrop.remove(); }
    backdrop.append(
      C.el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        C.el('div', { class: 'modal-head' }, [C.el('h3', null, 'Code'), C.el('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, '✕')]),
        C.el('div', { class: 'modal-body' }, [tabs, out, C.el('div', { class: 'script-note' }, 'Advanced signatures (OAuth1, AWS v4, EdgeGrid, Hawk, NTLMv2, JWT) are computed by API Manager locally and are not reproducible from a plain snippet — the output is labeled accordingly.')]),
        C.el('div', { class: 'modal-foot' }, [
          C.el('button', { class: 'btn', onclick: close }, 'Close'),
          C.el('button', { class: 'btn primary', onclick: () => { C.copyToClipboard(out.textContent).then(() => C.toast('Copied', 'ok')); } }, 'Copy'),
        ]),
      ])
    );
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    render();
    $('modal-root').append(backdrop);
  }

  // ----- file imports/exports -----
  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsText(file);
    });
  }

  async function importCollectionFile(file) {
    try {
      const text = await readAsText(file);
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        C.toast('Import failed: file is not valid JSON', 'err');
        return;
      }
      const col = SH.collection.normalizeCollection(json);
      S0.collections.push(col);
      S0.settings.selectedCollectionId = col.id;
      C.schedulePersist();
      renderCollections();
      C.addConsole('info', 'system', 'Imported collection "' + col.name + '" (' + countItems(col) + ' requests)');
      C.toast('Collection imported: ' + col.name, 'ok');
    } catch (e) {
      C.toast('Import failed: ' + e.message, 'err');
    }
  }

  function countItems(col) {
    let n = 0;
    (function walk(items) {
      for (const it of items || []) {
        if (it.type === 'request') n++;
        else walk(it.items);
      }
    })(col.items);
    return n;
  }

  async function importEnvironmentFile(file) {
    try {
      const text = await readAsText(file);
      const env = SH.collection.normalizeEnvironment(JSON.parse(text));
      S0.environments.push(env);
      C.schedulePersist();
      renderEnvs();
      C.toast('Environment imported: ' + env.name, 'ok');
    } catch (e) {
      C.toast('Import failed: ' + e.message, 'err');
    }
  }

  async function importBackupFile(file) {
    try {
      const text = await readAsText(file);
      const parsed = SH.collection.parseBackup(text);
      const ok = await C.confirmDialog(
        'Restore workspace backup? This replaces all collections, environments, globals, and history (' + parsed.collections.length + ' collections, ' + parsed.environments.length + ' environments, ' + parsed.history.length + ' history entries).',
        { title: 'Restore backup', danger: true, okLabel: 'Restore' }
      );
      if (!ok) return;
      S0.collections = parsed.collections;
      S0.environments = parsed.environments;
      if (parsed.globals) S0.globals = parsed.globals;
      S0.history = parsed.history.slice(0, SH.history.MAX_HISTORY);
      S0.settings.selectedCollectionId = S0.collections[0] ? S0.collections[0].id : null;
      S0.settings.activeEnvId = null;
      C.schedulePersist();
      renderAll();
      C.toast('Workspace restored from backup', 'ok');
    } catch (e) {
      C.toast('Restore failed: ' + e.message, 'err');
    }
  }

  async function importCurl() {
    const backdrop = C.el('div', { class: 'modal-backdrop' });
    const ta = C.el('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'cURL command', placeholder: 'curl -X POST https://api.example.com/users -H "Content-Type: application/json" -d \'{"name":"Ada"}\'' });
    function close() { backdrop.remove(); }
    function doImport() {
      try {
        const parsed = SH.curl.parseCurl(ta.value);
        const req = C.newRequest(parsed.request);
        newRequestTab(req, null);
        close();
        C.toast('cURL imported' + (parsed.warnings.length ? ' (' + parsed.warnings.length + ' options ignored)' : ''), 'ok');
        for (const w of parsed.warnings) C.addConsole('warn', 'import', 'cURL import: ' + w);
      } catch (e) {
        C.toast('cURL import failed: ' + e.message, 'err');
      }
    }
    backdrop.append(
      C.el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        C.el('div', { class: 'modal-head' }, [C.el('h3', null, 'Import cURL command'), C.el('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, '✕')]),
        C.el('div', { class: 'modal-body' }, [
          ta,
          C.el('div', { class: 'script-note' }, 'Supported: method (-X), headers (-H), data (-d/--data-raw), basic auth (-u), cookies (-b), user agent, referer, --max-time, -L, -I/HEAD, -F text fields, --url. File uploads (-F @file) and proxy options are ignored with a warning.'),
        ]),
        C.el('div', { class: 'modal-foot' }, [
          C.el('button', { class: 'btn', onclick: close }, 'Cancel'),
          C.el('button', { class: 'btn primary', onclick: doImport }, 'Import'),
        ]),
      ])
    );
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    $('modal-root').append(backdrop);
    ta.focus();
  }

  function exportBackup() {
    const backup = SH.collection.createBackup({
      collections: S0.collections,
      environments: S0.environments,
      globals: S0.globals,
      history: S0.history,
    });
    C.download('api-manager-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(backup, null, 2));
    C.toast('Workspace backup saved', 'ok');
  }

  // ==================================================================
  // About / docs
  // ==================================================================
  const VERSION = '1.0.0';
  const DEV_NAME = 'Manish Kumar Singh';
  const DEV_EMAIL = 'manishkumars264@gmail.com';

  function bugReportMailto() {
    const subject = 'API Manager v' + VERSION + ' - bug report';
    const body =
      'API Manager version: ' + VERSION +
      '\nOS: ' + (navigator.platform || 'unknown') +
      '\n\nSummary:\n\nDescription:\n\nSteps to reproduce:\n1. \n2. \n3. \n';
    return 'mailto:' + DEV_EMAIL + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  async function openAboutModal() {
    const backdrop = C.el('div', { class: 'modal-backdrop' });
    let info = { name: 'API Manager', version: VERSION };
    if (window.apim && window.apim.appInfo) {
      try {
        info = await window.apim.appInfo();
      } catch (e) {
        /* browser dev mode */
      }
    }
    const isDesktop = info.isElectron === true;
    function close() { backdrop.remove(); }
    backdrop.append(
      C.el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        C.el('div', { class: 'modal-head' }, [C.el('h3', null, 'About'), C.el('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, '✕')]),
        C.el('div', { class: 'modal-body' }, [
          C.el('div', { class: 'about-hero' }, [
            C.el('div', { class: 'logo' }, 'API Manager'),
            C.el('div', { class: 'ver' }, 'Version ' + info.version + (isDesktop ? ' · Electron ' + (info.electron || '') + ' · ' + info.platform : ' · browser development mode')),
          ]),
          C.el('div', { class: 'about-section' }, [
            C.el('h4', null, 'Developer'),
            C.el('div', { class: 'about-dev' }, [
              C.el('div', { class: 'avatar' }, 'MK'),
              C.el('div', null, [
                C.el('div', { style: 'font-weight:700; color:var(--text)' }, DEV_NAME),
                C.el('div', null, DEV_EMAIL),
              ]),
            ]),
          ]),
          C.el('div', { class: 'about-section' }, [
            C.el('h4', null, 'v1.0.0 — initial release'),
            C.el('ul', null, [
              'Local-first desktop app (Electron) with collections, environments, globals, and 200-entry history',
              'All 9 HTTP methods; query params, headers, raw/urlencoded/form-data/GraphQL/SOAP 1.1/1.2 bodies',
              '13 auth schemes incl. Digest, OAuth 1.0a, OAuth 2.0 client credentials, AWS v4, EdgeGrid, Hawk, NTLMv2, HMAC JWT',
              'Worker-isolated pre-request/test scripts with a documented pm subset and test results',
              'Postman collection v2.1 + environment import/export, workspace backup/restore, cURL import/export',
              'Code generation: cURL, Python, Fetch, Java, Postman CLI',
              'Loopback-only request proxy with timeout, redirect, and cookie handling',
            ]),
          ]),
          C.el('div', { class: 'about-section' }, [
            C.el('h4', null, 'Privacy'),
            C.el('p', null, 'Requests, collections, environments, and history never leave this machine. The only network calls API Manager makes are the API requests you send.'),
          ]),
          C.el('div', { class: 'about-links' }, [
            C.el('button', {
              class: 'btn primary',
              onclick: () => {
                if (window.apim && window.apim.openExternal) window.apim.openExternal(bugReportMailto());
                else window.location.href = bugReportMailto();
              },
            }, 'Report a bug'),
            C.el('button', {
              class: 'btn',
              onclick: () => {
                const url = 'https://github.com/manishkumars264/API-Manager-v1.0.0';
                if (window.apim && window.apim.openExternal) window.apim.openExternal(url);
                else window.open(url, '_blank', 'noopener');
              },
            }, 'GitHub'),
          ]),
        ]),
        C.el('div', { class: 'modal-foot' }, C.el('button', { class: 'btn', onclick: close }, 'Close')),
      ])
    );
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    $('modal-root').append(backdrop);
  }

  function openDocsModal() {
    const backdrop = C.el('div', { class: 'modal-backdrop' });
    function close() { backdrop.remove(); }
    backdrop.append(
      C.el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        C.el('div', { class: 'modal-head' }, [C.el('h3', null, 'Quick reference'), C.el('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, '✕')]),
        C.el('div', { class: 'modal-body' }, [
          C.el('div', { class: 'about-section' }, [
            C.el('h4', null, 'Basics'),
            C.el('p', null, 'Pick a method, enter a URL, and press Send (Ctrl+Enter). Query params live in the Params tab; the URL bar and the table stay in sync.'),
          ]),
          C.el('div', { class: 'about-section' }, [
            C.el('h4', null, 'Variables'),
            C.el('p', null, 'Reference variables anywhere in URLs, headers, bodies, and auth values as {{name}}. Precedence: request variables > active environment > globals. Dynamic values: {{$timestamp}}, {{$isoTimestamp}}, {{$guid}}, {{$uuid}}, {{$randomInt(min,max)}}, {{$randomFloat(min,max)}}, {{$randomBoolean()}}, {{$randomString(len)}}, {{$randomHex(len)}}.'),
          ]),
          C.el('div', { class: 'about-section' }, [
            C.el('h4', null, 'Scripts'),
            C.el('p', null, 'Pre-request and test scripts run in an isolated 5-second worker. pm.variables / pm.environment / pm.globals (get/set/unset), pm.request, pm.response, pm.test, pm.expect, and console are supported. See the README for the full documented subset.'),
          ]),
          C.el('div', { class: 'about-section' }, [
            C.el('h4', null, 'Shortcuts'),
            C.el('p', null, 'Ctrl+Enter send · Ctrl+T new tab · Ctrl+W close tab · Ctrl+D duplicate · Alt+←/→ switch tab · Ctrl+1…9 open tab n · Ctrl+Shift+U console · Ctrl+Shift+X code snippet.'),
          ]),
          C.el('div', { class: 'about-section' }, [
            C.el('h4', null, 'Data'),
            C.el('p', null, 'Everything is stored in local IndexedDB under the app origin. Use File → Save Workspace Backup… before reinstalling or moving machines.'),
          ]),
        ]),
        C.el('div', { class: 'modal-foot' }, C.el('button', { class: 'btn', onclick: close }, 'Close')),
      ])
    );
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    $('modal-root').append(backdrop);
  }

  // ==================================================================
  // Console
  // ==================================================================
  function renderConsole() {
    const list = $('console-list');
    if (!list) return;
    list.innerHTML = '';
    const f = S0.settings.consoleFilter;
    const items = S0.consoleLog.filter((c) => {
      if (f === 'all') return true;
      if (f === 'request') return c.tag === 'request';
      if (f === 'script') return c.tag === 'script';
      if (f === 'warn') return c.level === 'warn';
      if (f === 'error') return c.level === 'error';
      return true;
    }).slice(0, 200);
    for (const c of items) {
      list.append(
        C.el('div', { class: 'console-item ' + c.level }, [
          C.el('span', { class: 'ts' }, C.fmtTime(c.ts)),
          C.el('span', { class: 'tag' }, c.tag),
          C.el('span', { class: 'msg' }, c.message),
        ])
      );
    }
  }

  function toggleConsole() {
    S0.settings.consoleOpen = !S0.settings.consoleOpen;
    $('console-drawer').classList.toggle('hidden', !S0.settings.consoleOpen);
    C.schedulePersist();
  }

  // ==================================================================
  // Theme
  // ==================================================================
  function applyTheme() {
    document.documentElement.dataset.theme = S0.settings.theme || 'dark';
  }

  // ==================================================================
  // Events
  // ==================================================================
  function bindStaticEvents() {
    $('new-tab-btn').addEventListener('click', () => newRequestTab());
    $('empty-new-tab').addEventListener('click', () => newRequestTab());
    $('empty-import').addEventListener('click', () => $('file-collection').click());
    $('side-search').addEventListener('input', renderCollections);

    // sidebar actions
    document.querySelectorAll('#sidebar [data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'col:add') newCollection();
        else if (act === 'col:import') $('file-collection').click();
        else if (act === 'col:export') exportSelectedCollection();
        else if (act === 'env:add') newEnvironment();
        else if (act === 'env:import') $('file-environment').click();
        else if (act === 'env:export') exportActiveEnv();
        else if (act === 'globals:add') addGlobalVar();
        else if (act === 'history:clear') clearHistory();
      });
    });

    $('file-collection').addEventListener('change', (e) => {
      if (e.target.files[0]) importCollectionFile(e.target.files[0]);
      e.target.value = '';
    });
    $('file-environment').addEventListener('change', (e) => {
      if (e.target.files[0]) importEnvironmentFile(e.target.files[0]);
      e.target.value = '';
    });
    $('file-backup').addEventListener('change', (e) => {
      if (e.target.files[0]) importBackupFile(e.target.files[0]);
      e.target.value = '';
    });

    $('active-env-select').addEventListener('change', (e) => setActiveEnv(e.target.value || null));
    $('theme-toggle').addEventListener('click', () => {
      S0.settings.theme = S0.settings.theme === 'dark' ? 'light' : 'dark';
      C.schedulePersist();
      applyTheme();
    });

    // url bar
    $('req-method').addEventListener('change', (e) => {
      const t = C.activeTab();
      if (t) {
        t.request.method = e.target.value;
        C.markDirty(t);
        renderTabs();
      }
    });
    $('req-url').addEventListener('input', (e) => {
      const t = C.activeTab();
      if (t) {
        t.request.url = e.target.value;
        C.markDirty(t);
      }
    });
    $('req-url').addEventListener('change', () => {
      const t = C.activeTab();
      if (t) {
        parseUrlIntoParams(t);
        renderPanel('params', t);
      }
    });
    $('req-url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const t = C.activeTab();
        if (t) {
          parseUrlIntoParams(t);
          sendTab(t.id);
        }
      }
    });
    $('btn-send').addEventListener('click', () => {
      const t = C.activeTab();
      if (t) sendTab(t.id);
    });
    $('btn-run-again').addEventListener('click', () => {
      const t = C.activeTab();
      if (t) sendTab(t.id);
    });
    $('btn-save').addEventListener('click', openSaveDialog);
    $('btn-code').addEventListener('click', openCodegenModal);

    // panel tabs
    document.querySelectorAll('.panel-tabs [data-panel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        S0.settings.activePanel = btn.dataset.panel;
        C.schedulePersist();
        const t = C.activeTab();
        renderEditor();
        void t;
      });
    });

    // response tabs + actions
    document.querySelectorAll('.resp-tabs [data-rtab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        S0.settings.activeRTab = btn.dataset.rtab;
        C.schedulePersist();
        renderResponse(C.activeTab());
      });
    });
    document.querySelectorAll('#resp-view-switch [data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        S0.settings.view = btn.dataset.view;
        C.schedulePersist();
        renderResponse(C.activeTab());
      });
    });
    $('btn-wrap').addEventListener('click', () => {
      S0.settings.wrap = !S0.settings.wrap;
      C.schedulePersist();
      renderResponse(C.activeTab());
    });
    $('btn-zoom-in').addEventListener('click', () => {
      S0.settings.zoom = Math.min(300, S0.settings.zoom + 10);
      C.schedulePersist();
      renderResponse(C.activeTab());
    });
    $('btn-zoom-out').addEventListener('click', () => {
      S0.settings.zoom = Math.max(50, S0.settings.zoom - 10);
      C.schedulePersist();
      renderResponse(C.activeTab());
    });
    $('btn-copy-body').addEventListener('click', () => {
      const t = C.activeTab();
      if (t && t.response && t.response.ok) {
        C.copyToClipboard(t.response.body).then(() => C.toast('Body copied', 'ok'));
      }
    });
    $('btn-copy-full').addEventListener('click', () => {
      const t = C.activeTab();
      if (t && t.response && t.response.ok) copyFullResponse(t.response);
    });
    $('btn-download').addEventListener('click', () => {
      const t = C.activeTab();
      if (t && t.response && t.response.ok) downloadBody(t.response);
    });

    // console
    $('console-close').addEventListener('click', toggleConsole);
    $('console-clear').addEventListener('click', async () => {
      S0.consoleLog = [];
      await C.dbClear('console');
      renderConsole();
    });
    $('console-filter').addEventListener('change', (e) => {
      S0.settings.consoleFilter = e.target.value;
      C.schedulePersist();
      renderConsole();
    });

    // keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        const t = C.activeTab();
        if (t) sendTab(t.id);
      } else if (mod && !e.shiftKey && key === 't') {
        e.preventDefault();
        newRequestTab();
      } else if (mod && key === 'w') {
        e.preventDefault();
        const t = C.activeTab();
        if (t) closeTab(t.id);
      } else if (mod && key === 'd') {
        e.preventDefault();
        duplicateActiveTab();
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        cycleTab(1);
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        cycleTab(-1);
      } else if (mod && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        selectTabByIndex(parseInt(e.key, 10));
      } else if (mod && e.shiftKey && key === 'u') {
        e.preventDefault();
        toggleConsole();
      } else if (mod && e.shiftKey && key === 'x') {
        e.preventDefault();
        openCodegenModal();
      } else if (e.key === 'Escape') {
        C.hideContextMenu();
        const backdrop = document.querySelector('#modal-root .modal-backdrop');
        if (backdrop) backdrop.remove();
      }
    });

    // native menu commands (desktop)
    if (window.apim && window.apim.onMenuCommand) {
      window.apim.onMenuCommand(handleMenuCommand);
    }
  }

  function handleMenuCommand(cmd) {
    switch (cmd) {
      case 'tab:new': newRequestTab(); break;
      case 'tab:close': { const t = C.activeTab(); if (t) closeTab(t.id); break; }
      case 'tab:duplicate': duplicateActiveTab(); break;
      case 'tab:next': cycleTab(1); break;
      case 'tab:prev': cycleTab(-1); break;
      case 'import:collection': $('file-collection').click(); break;
      case 'import:environment': $('file-environment').click(); break;
      case 'import:curl': importCurl(); break;
      case 'import:backup': $('file-backup').click(); break;
      case 'export:collection': exportSelectedCollection(); break;
      case 'export:environment': exportActiveEnv(); break;
      case 'export:backup': exportBackup(); break;
      case 'view:console': toggleConsole(); break;
      case 'request:send': { const t = C.activeTab(); if (t) sendTab(t.id); break; }
      case 'request:codegen': openCodegenModal(); break;
      case 'help:docs': openDocsModal(); break;
      case 'app:about': openAboutModal(); break;
      default: break;
    }
  }

  // ==================================================================
  window.APIManagerApp = { init };
  document.addEventListener('DOMContentLoaded', () => {
    init().catch((e) => {
      console.error('API Manager failed to initialize', e);
      document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#fff">API Manager failed to start: ' + C.esc(e.message) + '</div>';
    });
  });
})();
