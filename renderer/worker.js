'use strict';
/*
 * API Manager - script execution Web Worker.
 * Pre-request and test scripts run here, isolated from the UI.
 * The host (app.js) terminates the worker after a fixed time budget, so a
 * runaway script cannot hang the application.
 */
importScripts('shared/pmsubset.js');

self.onmessage = (event) => {
  const msg = event.data || {};
  const id = msg.id;
  const stage = msg.stage;
  const script = msg.script || '';
  const context = msg.context || {};
  const post = (data) => self.postMessage(data);

  let logs = [];
  let changes = [];
  try {
    const toMap = (vals) => {
      const m = new Map();
      for (const v of vals || []) {
        if (v && v.enabled !== false && v.key !== '' && v.key != null) m.set(String(v.key), v.value == null ? '' : String(v.value));
      }
      return m;
    };
    const maps = {
      request: toMap(context.requestVariables),
      environment: toMap(context.environmentVariables),
      globals: toMap(context.globalVariables),
    };
    const ctx = {
      resolve: (name) =>
        maps.request.has(name) ? maps.request.get(name) : maps.environment.has(name) ? maps.environment.get(name) : maps.globals.has(name) ? maps.globals.get(name) : null,
      getVariable: (scope, name) => (maps[scope] && maps[scope].has(name) ? maps[scope].get(name) : undefined),
      setVariable: (scope, name, value) => {
        if (!maps[scope]) return;
        maps[scope].set(name, value);
        changes.push({ scope, name, value });
      },
      unsetVariable: (scope, name) => {
        if (maps[scope] && maps[scope].has(name)) {
          maps[scope].delete(name);
          changes.push({ scope, name, value: null });
        }
      },
      request: {
        method: context.request ? context.request.method : 'GET',
        url: context.request ? context.request.url : '',
        headers: context.request ? context.request.headers : [],
        body: context.request ? context.request.body : '',
      },
      response: context.response || null,
      onLog: (args, level) => logs.push({ level: level || 'log', message: args.join(' ') }),
    };
    const { pm, console: con, tests } = APIManager.pmSubset.createPm(ctx);
    const fn = new Function('pm', 'console', 'tests', '"use strict";\n' + script);
    fn(pm, con, tests);
    post({ id, ok: true, stage, tests, logs, changes });
  } catch (e) {
    post({ id, ok: false, stage, error: (e && e.message) || String(e), tests: [], logs: logs || [], changes: changes || [] });
  }
};
