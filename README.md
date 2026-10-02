# API Manager

**API Manager** is a local-first, Postman-inspired desktop API client built with Electron.
Create, send, and organize API requests with collections, environments, scripts, and code
generation — with **all data stored on your machine**. No accounts, no login, no telemetry,
no cloud.

- **Developer:** Manish Kumar Singh (manishkumars264@gmail.com)
- **Version:** 1.0.0
- **License:** MIT

---

## Features

- **Requests** — GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, and CONNECT. Multi-tab editor
  with method + URL bar, query and header tables (enable/disable per row), and full body support:
  none, raw (JSON / XML / text / JavaScript / HTML), urlencoded, text-only form-data,
  GraphQL (+ JSON variables), and **SOAP 1.1 / 1.2** with prebuilt envelopes, `SOAPAction`,
  and correct content types.
- **Auth (computed locally in the main process)** — No Auth / inherit, API Key (header or query),
  Bearer (with prefix), Basic, **Digest** (full 401 challenge handshake, RFC 2069 + qop),
  **OAuth 1.0a** (HMAC-SHA1 / PLAINTEXT), **OAuth 2.0** (access token + Client Credentials flow),
  Hawk, **AWS Signature v4**, **Akamai EdgeGrid**, **NTLMv2** (3-message handshake, RFC 1320 MD4),
  and **HMAC JWT** (HS256 / HS384 / HS512).
- **Collections & folders** — full CRUD, inheritance of auth, Postman **Collection v2.1**
  import/export, environment and globals import/export.
- **Environments & variables** — request / environment / globals scopes with
  request > environment > globals precedence, plus Postman-style dynamic variables:
  `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$guid}}` / `{{$uuid}}`,
  `{{$randomInt(min,max)}}`, `{{$randomFloat(min,max)}}`, `{{$randomBoolean}}`,
  `{{$randomString(len)}}`, `{{$randomHex(len)}}`.
- **Scripts** — pre-request and post-response scripts run in an isolated, time-limited Web
  Worker (5 s budget) with a documented `pm` subset: `pm.variables`, `pm.environment`,
  `pm.globals`, `pm.request`, `pm.response` (`.json()`, `.text()`, `.code`, `.headers`,
  `.time`, `.size`), `pm.test`, a chai-like `pm.expect` chain, and `console.log/info/warn/error`.
  Variable changes and test results persist with the request.
- **Responses** — status, duration, size, body, headers, cookies; pretty / raw / HTML preview,
  JSON and XML beautify, wrap/unwrap, zoom, copy body, copy with status + headers, and `.json`
  download (non-JSON downloads are wrapped in a JSON envelope so the file stays valid JSON).
- **History** — the latest 200 attempts (including failures) with one-click restore and re-run.
- **Code generation** — cURL, Python (requests), Fetch, Java (HttpClient), and Postman CLI
  collection. Snippets for advanced signature schemes (AWS / EdgeGrid / NTLM / …) carry an
  explicit "computed locally by API Manager" note because those signatures are not
  reproducible from a plain snippet.
- **Security posture** — `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer;
  all outbound API traffic goes through a **loopback-only** Node proxy; external links open in
  your system browser; navigation is locked down; a single-instance lock prevents duplicate
  proxy servers; a stable app origin (persisted loopback port) keeps IndexedDB state across
  launches. No CDNs, no external fonts, no third-party runtime services.

---

## Requirements

- **Node.js ≥ 18** (Node 22 tested) and npm, for development.
- A desktop OS with a display for the Electron app (Windows 10+, macOS 11+, or Linux with a
  desktop session). Browser dev mode additionally works headlessly for server-side checks.

## Installation

```bash
git clone https://github.com/manishkumars264/API-Manager-v1.0.0.git
cd API-Manager-v1.0.0
npm install          # installs electron + electron-builder (dev dependencies)
```

> The Electron postinstall downloads the platform binary. If your network blocks the download,
> set `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install` and use browser dev mode instead.

## Running

### Desktop app (Electron)

```bash
npm start            # normal mode
npm run dev          # dev mode (disables some packaging-specific behavior)
```

The app binds one loopback proxy server (default port **7317**; if the port is taken it picks
a free one and **remembers it** so your IndexedDB-backed state survives restarts) and opens a
single native window.

### Browser dev mode

The exact same renderer + proxy run in a plain browser (handy for development or
headless environments):

```bash
npm run dev:browser              # http://127.0.0.1:7318/
npm run dev:browser -- --port 9000
```

Browser dev mode stores data in the browser's IndexedDB/Local Storage for the loopback origin;
the desktop app stores data in Electron's `userData` profile. The two stores are separate.

## Packaging

```bash
npm run dist            # platform default
npm run dist:win        # NSIS installer (Windows)
npm run dist:mac        # dmg/zip (macOS)
npm run dist:linux      # AppImage/deb (Linux)
npm run dist:dir        # unpacked directory (quick check)
```

Output lands in `dist/`. Packaging uses `electron-builder` (config in `package.json` → `build`);
code signing / notarization are not configured in this repository.

## Using the app

1. **Send a request** — pick a method, enter a URL, add query/header rows, add a body if
   needed, and hit Send. The response panel shows status, time, size, headers, cookies, and
   the body with pretty-printing.
2. **Organize** — create collections and folders (sidebar), add requests to them; requests
   inherit auth from their collection/folder when set to *inherit*.
3. **Environments** — manage environments and globals (sidebar), select the active one;
   `{{var}}` placeholders expand in URLs, headers, bodies, and auth fields.
4. **Scripts** — open a request's *Scripts* tab: *Pre-request* runs before sending, *Tests*
   run after the response. Test results appear in the response panel; console output goes to
   the console view.
5. **History** — every attempt (success or failure) is kept (latest 200); hover → restore /
   re-run.
6. **Import / export** — File menu and the collections sidebar: Postman Collection v2.1,
   environments/globals, full workspace backup (single JSON file) and cURL import in the
   request editor (paste a `curl …` command).
7. **Codegen** — response panel → *Generate* for cURL / Python / Fetch / Java / Postman CLI.
8. **About & bug reports** — Help → About shows version info and release notes;
   Help → Report a Bug opens a prefilled email (to manishkumars264@gmail.com) with
   Summary / Description / Steps to reproduce sections.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + Enter` | Send request |
| `Ctrl/Cmd + T` | New tab |
| `Ctrl/Cmd + W` | Close tab |
| `Ctrl/Cmd + Shift + E` | Switch environment |
| `Ctrl/Cmd + K` | Focus URL bar |
| `Ctrl/Cmd + ,` | Settings |

*(Menus are native on macOS/Windows/Linux; shortcuts are registered via the app menu.)*

## Privacy

- **Everything stays local.** Requests, responses (truncated), history, collections,
  environments, and credentials are stored in Electron's `userData` directory
  (`%APPDATA%/API Manager` on Windows, `~/Library/Application Support/API Manager` on macOS,
  `~/.config/API Manager` on Linux).
- The app makes **no** network calls except the ones *you* send through the local proxy.
  There is no analytics, crash reporting, update pinging, or any other telemetry.
- The proxy listens on `127.0.0.1` only.

## Backups

- **Workspace backup** (File → Backup workspace) exports collections, environments, globals,
  and requests to one JSON file; **Restore** reads it back (validated before applying).
- You can also copy the `API Manager` folder from your OS's app-data location (see *Privacy*)
  while the app is closed for a full state backup.

## Testing

```bash
npm run syntax         # node --check every app JS file (fast first gate)
npm test               # full suite (node:test), 82 tests
```

Test files cover: auth computations (MD4 vectors, OAuth 1.0a RFC example, Digest, Hawk,
AWS v4, EdgeGrid, NTLMv2 message structure, JWT), collection/import-export round-trips,
cURL parse/export, snippets (5 languages), history behavior, the live loopback proxy
(redirects, timeouts, cookies, digest handshake, OAuth2 exchange, security headers,
traversal), script sandbox (`pm` subset, worker-isolated timeouts), and variable
expansion/precedence.

### Troubleshooting

- **Port already in use** — the app automatically falls back to a free port and persists it;
  check the console at startup. In browser dev mode, pass `--port`.
- **Electron binary missing** (corporate proxy, offline dev) — use `npm run dev:browser`, or
  reinstall with network access.
- **State lost after an upgrade or profile wipe** — restore a workspace backup
  (File → Restore workspace).
- **Scripts time out** — scripts get a 5-second budget by design; long-running work should
  live in the API itself, not in request scripts.
- **A request fails with `ECONNREFUSED`** — the proxy could not reach the target; the target
  URL must be `http(s)` and the server must accept traffic from your machine.

## Limitations (documented, not bugs)

- **CONNECT** is supported for plain HTTP proxy-style handshakes; it is not a full TLS tunnel
  manager.
- **NTLMv2 / Digest / AWS / EdgeGrid / Hawk / OAuth** are computed locally in the main
  process for correctness and to keep secrets out of the renderer; generated code snippets
  for those schemes are labeled as not reproducible from the snippet alone.
- **Form-data is text-only** — file uploads in multipart bodies are not implemented (cURL
  import of `-F file=@…` skips the field with a warning).
- **Response bodies are capped at 20 MB**; larger bodies are truncated and marked.
- **Redirects follow up to 5 hops** in `follow` mode; a loop produces a clean error.
- **No built-in mock server / mock web service.**
- **Code signing / notarization** are not configured; packaged binaries will trigger OS
  security prompts on first launch.
- **Browser dev mode vs desktop** use separate local stores; data does not migrate between
  them.

## Project layout

```
main/            Electron main process
  main.js        app lifecycle, single-instance, window, stable-port bootstrap
  proxy.js       loopback-only proxy: static UI + /proxy (outbound requests)
  menu.js        native menus + shortcuts
  preload.js     contextBridge surface (external links, app info)
  lib/auth.js    all auth schemes (Digest/NTLM handshakes, SigV4, EdgeGrid, …)
  lib/md4.js     RFC 1320 MD4 + HMAC-MD4 (pure JS; OpenSSL 3 dropped MD4)
shared/          logic shared by main, renderer, worker, and tests
  collection.js  Postman v2.1 import/export + normalization
  curl.js        cURL import/export
  history.js     history entries, truncation
  pmsubset.js    pm.* subset, chai-like expect, worker-isolated runScript
  snippets.js    cURL / Python / Fetch / Java / Postman codegen
  soap.js        SOAP 1.1/1.2 envelopes
  variables.js   {{var}} + {{$dynamic}} expansion, precedence
renderer/        sandboxed UI (no Node access)
  index.html, styles.css, app.js (UI), core.js (state/store), worker.js (script sandbox)
test/            node:test suites (82 tests)
scripts/syntax-check.js
dev-server.js    browser dev mode
```

## Release notes

See [CHANGELOG.md](./CHANGELOG.md) for v1.0.0 release notes.

## Bug reports

Open an issue on GitHub, or use Help → Report a Bug in the app (prefilled email to
manishkumars264@gmail.com). Please include the Summary, Description, and Steps to reproduce.
