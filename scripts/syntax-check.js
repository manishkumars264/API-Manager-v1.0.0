'use strict';
/*
 * API Manager - syntax check for every app JavaScript file.
 *
 * Runs `node --check` on all .js files in main/, shared/, renderer/ and the
 * dev server / test helpers. Exits non-zero on the first syntax error and
 * prints a summary. This is the fastest first gate before running the test
 * suite (a single syntax error otherwise crashes an entire test file at
 * load time and can look like a hang).
 *
 * Usage: node scripts/syntax-check.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIRS = ['main', 'shared', 'renderer', 'scripts', 'test'];
const FILES = ['dev-server.js'];

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) walk(path.join(dir, entry.name), rel, out);
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
}

function collect() {
  const out = [];
  for (const dir of DIRS) {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) walk(abs, dir, out);
  }
  for (const f of FILES) {
    if (fs.existsSync(path.join(ROOT, f))) out.push(f);
  }
  return out.sort();
}

const files = collect();
let failed = 0;
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    console.log('  ok   ' + rel);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + rel);
    const err = (e.stderr || e.stdout || e.message).toString().trim();
    for (const line of err.split('\n').slice(0, 6)) console.log('         ' + line);
  }
}

console.log('');
console.log(files.length + ' files checked, ' + failed + ' failed.');
if (failed > 0) process.exit(1);
