'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../core');

class MockElement {
  constructor() {
    this.innerHTML = ''; this.textContent = ''; this.value = ''; this.className = ''; this.hidden = false;
    this.style = {}; this.scrollTop = 0; this.scrollLeft = 0; this.handlers = {};
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }
  addEventListener(name, callback) { (this.handlers[name] ||= []).push(callback); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  scrollIntoView() {}
}

test('application boot binds the workspace and renders without missing DOM controls', async () => {
  const elements = new Map();
  const query = selector => {
    if (selector.startsWith('#')) {
      const id = selector.slice(1);
      if (!elements.has(id)) elements.set(id, new MockElement());
      return elements.get(id);
    }
    return null;
  };
  const document = {
    querySelector: query, querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => new MockElement(),
    body: { appendChild() {} }
  };
  const window = { APIManagerCore: Core, addEventListener() {} };
  const context = {
    window, document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, Promise, Date, Math, TextEncoder, URL, Blob, Uint8Array, btoa,
    console, navigator: {}, fetch, performance, crypto: globalThis.crypto
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), context, { filename: 'app.js' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(elements.get('request-tabs').innerHTML, /Untitled Request/);
  assert.match(elements.get('request-editor').innerHTML, /Query Params/);
  assert.match(elements.get('response-content').innerHTML, /Ready when you are/);
  assert.equal(elements.get('history-count').textContent, '0');
});
