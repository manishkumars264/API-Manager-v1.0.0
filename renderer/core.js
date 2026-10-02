'use strict';
/*
 * API Manager - renderer core: IndexedDB persistence, app state, utilities.
 * All data lives in local IndexedDB under the stable loopback origin;
 * nothing is sent anywhere except the user's explicit API requests.
 */
(function () {
  const V = window.APIManager.variables;

  // ------------------------------------------------------------------
  // IndexedDB
  // ------------------------------------------------------------------
  const DB_NAME = 'api-manager-db';
  const DB_VERSION = 1;
  const STORES = ['kv', 'collections', 'environments', 'tabs', 'history', 'console'];
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: name === 'kv' ? 'key' : 'id' });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(db, store, mode) {
    return db.transaction(store, mode).objectStore(store);
  }

  function dbAll(store) {
    return openDB().then((db) =>
      new Promise((resolve, reject) => {
        const req = tx(db, store, 'readonly').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      })
    );
  }

  function dbPut(store, value) {
    return openDB().then((db) =>
      new Promise((resolve, reject) => {
        const req = tx(db, store, 'readwrite').put(value);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      })
    );
  }

  function dbBulkPut(store, values) {
    return openDB().then((db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, 'readwrite');
        const os = t.objectStore(store);
        for (const v of values) os.put(v);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      })
    );
  }

  function dbDelete(store, id) {
    return openDB().then((db) =>
      new Promise((resolve, reject) => {
        const req = tx(db, store, 'readwrite').delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      })
    );
  }

  function dbClear(store) {
    return openDB().then((db) =>
      new Promise((resolve, reject) => {
        const req = tx(db, store, 'readwrite').clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      })
    );
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const S = {
    loaded: false,
    tabs: [],
    activeTabId: null,
    collections: [],
    environments: [],
    globals: { id: 'globals', name: 'Globals', values: [] },
    history: [],
    consoleLog: [],
    settings: {
      activeEnvId: null,
      consoleOpen: false,
      consoleFilter: 'all',
      activePanel: 'params',
      activeRTab: 'body',
      view: 'pretty',
      wrap: true,
      zoom: 100,
      theme: 'dark',
      selectedCollectionId: null,
      expanded: [],
      tabSeq: 1,
    },
  };

  let persistTimer = null;
  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow().catch((e) => console.error('persist failed', e));
    }, 350);
  }

  async function persistNow() {
    const tabs = S.tabs.map((t) => {
      const r = t.response || null;
      return {
        id: t.id,
        name: t.name,
        request: t.request,
        provenance: t.provenance || null,
        dirty: !!t.dirty,
        response: r
          ? {
              ok: r.ok,
              status: r.status || 0,
              statusText: r.statusText || '',
              url: r.url || '',
              headers: (r.headers || []).slice(0, 200),
              cookies: r.cookies || [],
              body: typeof r.body === 'string' ? r.body.slice(0, 300 * 1024) : '',
              bodyEncoding: r.bodyEncoding || 'utf8',
              sizeBytes: r.sizeBytes || 0,
              durationMs: r.durationMs || 0,
              truncated: !!r.truncated || (typeof r.body === 'string' && r.body.length >= 300 * 1024),
              error: r.error || '',
            }
          : null,
        tests: t.tests || [],
      };
    });
    await Promise.all([
      dbBulkPut('tabs', tabs),
      dbBulkPut('collections', S.collections),
      dbBulkPut('environments', S.environments),
      dbBulkPut('history', S.history),
      dbBulkPut('console', S.consoleLog.slice(0, 200)),
      dbPut('kv', { key: 'globals', value: S.globals }),
      dbPut('kv', { key: 'settings', value: S.settings }),
    ]);
  }

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------
  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c.nodeType ? c : document.createTextNode(String(c)));
      }
    }
    return node;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function fmtDuration(ms) {
    if (ms == null) return '';
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + fmtTime(ts);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 500);
  }

  function toFileBlob(text, mime) {
    return new Blob([text], { type: mime || 'application/json' });
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    const ta = el('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      /* ignore */
    }
    ta.remove();
  }

  let toastSeq = 0;
  function toast(message, kind) {
    const box = document.getElementById('toasts');
    const t = el('div', { class: 'toast ' + (kind || 'info'), role: 'status' }, message);
    box.append(t);
    const id = ++toastSeq;
    setTimeout(() => t.remove(), 4200);
    t.addEventListener('click', () => t.remove());
    void id;
  }

  function confirmDialog(message, opts) {
    return new Promise((resolve) => {
      const backdrop = el('div', { class: 'modal-backdrop' });
      const modal = el('div', { class: 'modal small', role: 'alertdialog', 'aria-modal': 'true' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', null, (opts && opts.title) || 'Are you sure?'),
          el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => { backdrop.remove(); resolve(false); } }, '✕'),
        ]),
        el('div', { class: 'modal-body' }, el('p', { style: 'margin:4px 0; line-height:1.5' }, message)),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn', onclick: () => { backdrop.remove(); resolve(false); } }, (opts && opts.cancelLabel) || 'Cancel'),
          el('button', { class: (opts && opts.danger) ? 'btn primary' : 'btn primary', style: (opts && opts.danger) ? 'background:var(--red);border-color:var(--red)' : '', onclick: () => { backdrop.remove(); resolve(true); } }, (opts && opts.okLabel) || 'OK'),
        ]),
      ]);
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          backdrop.remove();
          resolve(false);
        }
      });
      backdrop.append(modal);
      document.getElementById('modal-root').append(backdrop);
    });
  }

  function promptDialog(title, label, initial, opts) {
    return new Promise((resolve) => {
      const backdrop = el('div', { class: 'modal-backdrop' });
      const input = el('input', { type: 'text', value: initial || '', 'aria-label': label });
      const onKey = (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      };
      function finish(ok) {
        backdrop.remove();
        resolve(ok ? input.value : null);
      }
      const modal = el('div', { class: 'modal small', role: 'dialog', 'aria-modal': 'true' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', null, title),
          el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => finish(false) }, '✕'),
        ]),
        el('div', { class: 'modal-body' }, [
          el('label', { class: 'field' }, [el('label', null, label), input]),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
          el('button', { class: 'btn primary', onclick: () => finish(true) }, (opts && opts.okLabel) || 'OK'),
        ]),
      ]);
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) finish(false);
      });
      document.getElementById('modal-root').append(backdrop);
      input.focus();
      input.select();
      input.addEventListener('keydown', onKey);
    });
  }

  // Context menu
  function showContextMenu(x, y, items) {
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    for (const it of items) {
      if (it === '-') {
        menu.append(el('hr'));
        continue;
      }
      menu.append(
        el('button', {
          class: it.danger ? 'danger' : '',
          role: 'menuitem',
          onclick: () => {
            hideContextMenu();
            it.action();
          },
        }, it.label)
      );
    }
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = Math.max(4, left) + 'px';
    menu.style.top = Math.max(4, top) + 'px';
  }
  function hideContextMenu() {
    document.getElementById('context-menu').classList.add('hidden');
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#context-menu')) hideContextMenu();
  });
  window.addEventListener('blur', hideContextMenu);

  // ------------------------------------------------------------------
  // Request helpers
  // ------------------------------------------------------------------
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];

  function newRequest(def) {
    return {
      name: 'Untitled request',
      method: 'GET',
      url: '',
      query: [],
      headers: [],
      auth: { type: 'inherit' },
      body: {
        mode: 'none',
        raw: '',
        rawLang: 'json',
        urlencoded: [],
        formdata: [],
        graphql: { query: '', variables: '' },
        soap: { version: '1.1', action: '', envelope: '' },
      },
      scripts: { pre: '', test: '' },
      variables: [],
      settings: { timeoutMs: 30000, redirect: 'follow' },
      ...(def || {}),
    };
  }

  function newTab(request, provenance) {
    const t = {
      id: uid('tab'),
      name: request ? request.name : 'Untitled request',
      request: request || newRequest(),
      provenance: provenance || null,
      response: null,
      tests: [],
      dirty: false,
      sending: false,
      fromHistory: false,
    };
    S.tabs.push(t);
    S.activeTabId = t.id;
    schedulePersist();
    return t;
  }

  function activeTab() {
    return S.tabs.find((t) => t.id === S.activeTabId) || null;
  }

  function markDirty(tab) {
    if (tab) {
      tab.dirty = true;
      schedulePersist();
      renderTabs();
    }
  }

  // Resolve an 'inherit' auth by walking the collection tree from provenance:
  // nearest folder with auth wins, then the collection itself, then none.
  function resolveInheritedAuth(auth) {
    if (!auth || auth.type !== 'inherit') return auth || { type: 'none' };
    const p = (activeTab() || {}).provenance;
    if (!p || !p.collectionId) return { type: 'none' };
    const col = S.collections.find((c) => c.id === p.collectionId);
    if (!col) return { type: 'none' };
    let node = null;
    const ancestors = [];
    (function walk(items) {
      for (const it of items || []) {
        if (it.id === p.itemId) {
          node = it;
          return true;
        }
        if (it.type === 'folder') {
          ancestors.push(it);
          if (walk(it.items)) return true;
          ancestors.pop();
        }
      }
      return false;
    })(col.items);
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i];
      if (a.auth && a.auth.type && a.auth.type !== 'none' && a.auth.type !== 'inherit') return a.auth;
    }
    if (col.auth && col.auth.type && col.auth.type !== 'none' && col.auth.type !== 'inherit') return col.auth;
    return { type: 'none' };
  }

  function activeEnv() {
    return S.environments.find((e) => e.id === S.settings.activeEnvId) || null;
  }

  function buildResolver(tab) {
    const req = (tab && tab.request) || activeTab().request;
    return V.buildResolver({
      requestVariables: req.variables,
      environmentVariables: activeEnv() ? activeEnv().values : [],
      globalVariables: S.globals.values,
    });
  }

  // ------------------------------------------------------------------
  // Console
  // ------------------------------------------------------------------
  function addConsole(level, tag, message) {
    const entry = { id: uid('log'), ts: Date.now(), level: level || 'info', tag: tag || 'system', message: String(message) };
    S.consoleLog.unshift(entry);
    if (S.consoleLog.length > 500) S.consoleLog.length = 500;
    schedulePersist();
    renderConsole();
  }

  window.Core = {
    S, V,
    openDB, dbAll, dbPut, dbBulkPut, dbDelete, dbClear,
    persistNow, schedulePersist,
    uid, el, esc, fmtSize, fmtDuration, fmtTime, fmtDate,
    download, toFileBlob, copyToClipboard, toast, confirmDialog, promptDialog,
    showContextMenu, hideContextMenu,
    METHODS, newRequest, newTab, activeTab, markDirty,
    resolveInheritedAuth, activeEnv, buildResolver,
    addConsole,
  };
})();
