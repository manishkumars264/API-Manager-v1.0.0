'use strict';
/*
 * API Manager - browser development mode.
 * Serves the same renderer + proxy as the desktop app, bound to loopback.
 * Run: npm run dev:browser   (optionally -- --port 8080)
 */
const path = require('path');
const { createProxyServer } = require('./main/proxy');

async function main() {
  let port = 7318;
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--port');
  if (i !== -1 && argv[i + 1]) port = parseInt(argv[i + 1], 10) || port;

  let server;
  const tried = new Set();
  for (;;) {
    try {
      server = await createProxyServer({ staticDir: path.join(__dirname, 'renderer'), port, host: '127.0.0.1' });
      break;
    } catch (e) {
      if (e.code === 'EADDRINUSE' && !tried.has(port)) {
        tried.add(port);
        port += 1;
        continue;
      }
      throw e;
    }
  }
  const actual = server.address();
  console.log('');
  console.log('  API Manager (browser dev mode)');
  console.log('  --------------------------------');
  console.log('  UI:     http://127.0.0.1:' + actual.port + '/');
  console.log('  Proxy:  http://127.0.0.1:' + actual.port + '/proxy  (loopback only)');
  console.log('');
  console.log('  Ctrl+C to stop.');
}

main().catch((e) => {
  console.error('Failed to start dev server:', e);
  process.exit(1);
});
