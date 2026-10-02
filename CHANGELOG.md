# Changelog

All notable changes to **API Manager** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/) and the project
follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-02

Initial release.

### Added

- **Electron desktop app** ("API Manager") with a native window, native menus and keyboard
  shortcuts, and a secure sandboxed renderer (`contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`). External links open in the system browser.
- **Browser dev mode** (`npm run dev:browser`) running the identical renderer + loopback
  proxy in a plain browser.
- **Request editor**: GET–CONNECT methods, multi-tab UI, query/header tables with per-row
  enable/disable, timeout and redirect (none / limit / follow) settings.
- **Body modes**: none, raw (JSON/XML/text/JS/HTML), urlencoded, text-only form-data,
  GraphQL with JSON variables, and SOAP 1.1/1.2 with templates, `SOAPAction`, and correct
  content types.
- **Authentication (all computed locally in the main process)**: No Auth / inherit,
  API Key (header or query), Bearer with prefix, Basic, Digest (RFC 2069 + qop, full 401
  handshake), OAuth 1.0a (HMAC-SHA1 / PLAINTEXT), OAuth 2.0 (access token + Client
  Credentials), Hawk, AWS Signature v4 (incl. session tokens), Akamai EdgeGrid, NTLMv2
  (3-message handshake; pure-JS RFC 1320 MD4), and HMAC JWT HS256/384/512.
- **Collections & folders** with CRUD and auth inheritance; **Postman Collection v2.1**
  import/export; environment and globals import/export; full **workspace backup/restore**
  to a single JSON file.
- **Environments & variables**: request > environment > globals precedence, disabled
  variables, and dynamic variables `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$guid}}`,
  `{{$uuid}}`, `{{$randomInt}}`, `{{$randomFloat}}`, `{{$randomBoolean}}`,
  `{{$randomString}}`, `{{$randomHex}}`.
- **Pre-request & post-response scripts** in an isolated, time-limited (5 s) Web Worker
  with a documented `pm` subset (variables, request/response helpers, `pm.test`,
  chai-like `pm.expect`, `console`); variable changes and test results persist.
- **Response panel**: status/duration/size, headers, cookies, pretty/raw/HTML views,
  JSON/XML beautify, wrap/unwrap, zoom, copy body, copy with status + headers, and `.json`
  download (non-JSON responses wrapped in a JSON envelope).
- **History** of the latest 200 attempts including failures, with restore and re-run.
- **Console** for script output and app activity.
- **Code generation**: cURL, Python (requests), Fetch, Java HttpClient, and Postman CLI —
  with advanced-signing schemes labeled as not reproducible from the snippet.
- **cURL import** (paste) and cURL export for requests.
- **Local-only data model** with stable app origin (persisted loopback port) so state
  restores on reopen; single-instance lock; loopback-only proxy; no CDNs, no external
  fonts, no telemetry.
- **Automated test suite**: 82 `node:test` tests covering auth, collections, cURL,
  snippets, history, the live proxy, the script sandbox, and variables, plus a syntax-check
  script (`npm run syntax`).

### Limitations

- Form-data is text-only (no file uploads); multipart file fields in cURL import are
  skipped with a warning.
- Response bodies capped at 20 MB; redirects follow up to 5 hops.
- CONNECT performs a plain handshake (not a full TLS tunnel manager).
- Code signing / notarization not configured; packaged binaries trigger OS security
  prompts on first launch.

### Verification notes

- Syntax checks pass on all 26 application JS files; full test suite passes (82/82) on
  Node 22 (Linux, headless).
- The desktop GUI, the Electron binary download, and code-signing were **not** exercised
  in this environment (no display, no signed identity); browser dev mode and the loopback
  proxy were verified live instead.
