# API Manager

**API Manager** is a local-first desktop-style API workspace for building, sending, organizing, and testing HTTP and SOAP requests. It has a Postman-inspired workflow, but it does not have accounts, sign-in, workspace sync, or cloud storage: collections, variables, request tabs, scripts, history, and response snapshots are saved in the current browser on the device where the application is running.

> **Initial release:** v1.0.0. API Manager is an independent project and is not affiliated with or endorsed by Postman.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [First request](#first-request)
- [Request tabs and session restore](#request-tabs-and-session-restore)
- [Requests, parameters, headers, and bodies](#requests-parameters-headers-and-bodies)
- [SOAP](#soap)
- [Authorization](#authorization)
- [Environments, globals, and dynamic variables](#environments-globals-and-dynamic-variables)
- [Pre-request and post-response scripts](#pre-request-and-post-response-scripts)
- [Responses](#responses)
- [Collections](#collections)
- [Import and export](#import-and-export)
- [Code generation](#code-generation)
- [History and console](#history-and-console)
- [Developer details, release notes, and bug reports](#developer-details-release-notes-and-bug-reports)
- [Local data, privacy, and limitations](#local-data-privacy-and-limitations)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

## Features

- Familiar request workspace with a collection sidebar, request tabs, method picker, URL bar, environment selector, response panel, and console.
- GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, TRACE, and CONNECT methods.
- Query parameter and request header key/value editors with enable/disable controls.
- Raw JSON, XML, text, JavaScript, HTML, URL-encoded, text multipart form-data, and GraphQL request bodies.
- SOAP 1.1 and SOAP 1.2 content types, SOAPAction support, and envelope templates.
- Authorization helpers: No Auth, Inherit, API Key, Bearer Token, Basic, Digest, OAuth 1.0, OAuth 2.0 access token and client credentials, Hawk, AWS Signature Version 4, Akamai EdgeGrid, NTLMv2, and HMAC JWT (HS256/384/512).
- Pre-request and post-response scripts executed in a Web Worker, with Postman-style variable/request/response helpers and test results.
- Local collections and environments; import/export of Postman Collection v2.1 and Postman environment JSON.
- cURL import and export, and generated JavaScript Fetch, Python Requests, Java HttpClient, and Postman CLI snippets.
- Environment and global variables, plus dynamic variables such as `{{$timestamp}}`, `{{$guid}}`, `{{$randomInt}}`, and `{{$randomEmail}}`.
- Local history of the most recent 200 request runs, including response bodies, with open and run-again actions.
- Response status, timing, size, headers, cookies, JSON/XML beautify, raw/pretty/preview display, line wrapping, zoom, copy body, copy body with headers, and `.json` download.
- Session restoration for open request tabs, selected tab, active environment, current request editor and view settings.
- Developer and release details plus an email-ready bug-report template.

## Requirements

- Node.js 18 or later (Node.js 20+ recommended).
- A modern browser with IndexedDB, Web Workers, Fetch, and Clipboard support (Chrome, Edge, Firefox, or Safari recent versions).
- Network access to the API hosts you want to call. The app itself has no third-party runtime dependencies and can be run without an account.

## Install and run

### From a source checkout

```bash
git clone https://github.com/manishkumars264/API-Manager-v1.0.0.git
cd API-Manager-v1.0.0
npm start
```

Open **http://localhost:4173** in your browser. The local Node server serves the interface and provides a same-origin request proxy so browser CORS restrictions do not block normal API calls. The server listens on `0.0.0.0` by default; set `PORT` to use another port:

```bash
PORT=5050 npm start
```

No `npm install` step is needed for the initial release: the application uses Node.js built-ins and browser APIs only. Keep the local server running while you use the application.

### Development and tests

```bash
npm run dev       # start the local app
npm test          # run the automated Node test suite
```

## First request

1. Start the application and open the local address in your browser.
2. Select an HTTP method (GET is selected by default).
3. Enter a complete URL, for example `https://httpbin.org/get`.
4. Add query parameters, headers, authorization, or a body using the tabs below the URL bar.
5. Select **Send** or press **Ctrl/Cmd + Enter**.
6. Inspect status, elapsed time, body, response headers, cookies, and any test results in the response panel.

The response is saved in local history automatically. Use **Save** to add the request to a collection.

## Request tabs and session restore

- Select **New** or the `+` beside the request tabs to open another request. Multiple request tabs remain open side-by-side; scroll the tab strip horizontally or use **Alt + Left/Right** to move between them.
- Tabs, the selected tab, request method/URL/editor contents, active environment, sidebar view, response display mode, zoom, wrapping, and console state are restored from this browser the next time API Manager opens.
- An orange dot marks a request with unsaved changes. Use **Save** to update its collection copy or save it to a collection for the first time.
- Close a tab with its `×`. API Manager asks before discarding unsaved changes.
- Useful shortcuts: **Ctrl/Cmd + Enter** sends the active request; **Ctrl/Cmd + N** opens a request; **Ctrl/Cmd + K** focuses search; **Ctrl/Cmd + Alt + C** toggles the console; **Alt + Left/Right** cycles request tabs.

## Requests, parameters, headers, and bodies

### Methods and URL

The method picker supports GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, TRACE, and CONNECT. Enter a complete `http://` or `https://` URL. Pasting a cURL command directly into the URL field imports its method, URL, headers, body, and basic authorization where those options are recognized.

### Query parameters

Open **Params** to add, edit, enable, disable, or remove URL query parameters. Values entered here are URL-encoded when the request is sent. Existing query values are populated into the table when a URL is entered.

### Headers

Open **Headers** to add or disable request headers. Authorization helpers and body modes may add generated headers at send time. Generated headers are not written back to the manual header table.

### Request bodies

Open **Body** and choose a mode:

- **none** — no request body.
- **raw** — JSON, XML, text, JavaScript, or HTML. JSON and XML request bodies can be beautified.
- **x-www-form-urlencoded** — key/value fields encoded as an HTTP form body.
- **form-data** — text fields encoded as multipart form-data. File attachments are not supported in this initial release.
- **GraphQL** — a GraphQL query with a JSON variables object, sent as a JSON request body.

API Manager adds a suitable content type when one is not already present. It does not replace an explicit Content-Type header.

## SOAP

For SOAP, choose **Body → raw → XML**. Select **SOAP 1.1** or **SOAP 1.2**, enter a SOAPAction if needed, then select **Insert SOAP envelope** to add a starter envelope. API Manager selects POST when inserting a template into a GET request. SOAP 1.1 sends `text/xml` and the `SOAPAction` header; SOAP 1.2 sends `application/soap+xml` and adds an `action` parameter when provided. Edit the generated XML for the service's operation and namespaces before sending.

## Authorization

Choose a helper from **Authorization**. Credentials and tokens are retained only in the current browser's local data store.

| Type | How it works |
| --- | --- |
| No Auth | Sends no helper-generated authorization. Manually entered Authorization headers remain available. |
| Inherit auth | Available for imported collection compatibility; a standalone request has no parent to inherit from. |
| API Key | Adds the selected key/value as a header or query parameter. |
| Bearer Token | Adds `Authorization: Bearer <token>` (the prefix can be changed or left empty). |
| Basic Auth | Builds a UTF-8 Basic Authorization header from username and password. |
| Digest Auth | Responds to a supported MD5 or MD5-sess Digest challenge; supports `auth` and `auth-int` qop. |
| OAuth 2.0 | Use a pasted access token, or choose Client Credentials to request a token from a token URL at send time. The token can be added to headers or query parameters. |
| OAuth 1.0 | Generates per-request HMAC-SHA1, HMAC-SHA256, PLAINTEXT, or RSA-SHA1 signatures from consumer credentials and optional token/secret, callback, realm, verifier, or PEM private key. |
| Hawk | Generates a Hawk request MAC using SHA-256 or SHA-1, with optional payload hashing and extension data. |
| AWS Signature | Signs requests locally with AWS Signature Version 4 using access key, secret, region, service, and optional session token. |
| Akamai EdgeGrid | Generates an EG1-HMAC-SHA256 authorization signature locally from client token, client secret, and access token. |
| NTLM | Performs a local NTLMv2 challenge-response exchange using username, password, domain, and workstation. NTLM server behavior and connection reuse can vary. |
| JWT Bearer | Creates an HMAC-signed HS256, HS384, or HS512 JWT from the supplied payload and secret. |

OAuth 2.0 authorization-code and interactive browser login flows are not included in v1.0.0; paste an access token into the helper or use the Client Credentials option. Private keys and passwords are sent to the requested API only when required by the selected scheme. Review the request destination before sending credentials.

## Environments, globals, and dynamic variables

Select an environment from the request header area, or open **Environments** in the sidebar to create, edit, import, export, or delete one. Environment values are local and can be enabled or disabled. Use **Manage globals** to edit workspace-wide fallback variables.

Use double braces in URLs, headers, body content, and supported authorization fields:

```text
{{baseUrl}}/v1/users/{{userId}}
Authorization: Bearer {{accessToken}}
```

The active environment takes precedence over globals. Built-in dynamic variables include:

- `{{$timestamp}}` — current Unix time in seconds.
- `{{$isoTimestamp}}` — current ISO-8601 time.
- `{{$guid}}` and `{{$randomUUID}}` — random UUID.
- `{{$randomInt}}` — random integer from 0 through 999.
- `{{$randomBoolean}}`, `{{$randomEmail}}`, `{{$randomFirstName}}`, `{{$randomLastName}}`, `{{$randomPassword}}`, `{{$randomPhoneNumber}}`, and `{{$randomAlphaNumeric}}`.

Values such as timestamps and random values are generated when a request is prepared. Export environments to Postman-compatible environment JSON; open **Manage globals → Export** to download a Postman-compatible globals file.

## Pre-request and post-response scripts

Scripts are optional JavaScript executed in a short-lived **Web Worker**, not in the page's window context. Scripts do not have direct access to the application DOM or localStorage. Use the **Pre-request Script** tab to prepare variables and the **Post-response Script** tab to inspect a response and run tests.

Supported examples:

```javascript
// Pre-request
pm.environment.set('requestStartedAt', new Date().toISOString());
console.log('Preparing request');
```

```javascript
// Post-response
pm.test('Status is successful', () => pm.response.to.have.status(200));
const data = pm.response.json();
pm.expect(data).to.have.property('id');
```

The worker provides `pm.environment`, `pm.globals`, `pm.collectionVariables`, `pm.variables`, `pm.request`, `pm.response`, `pm.test`, `pm.expect`, and a captured `console`. Common `pm.request.headers` methods (`add`, `upsert`, `remove`, `has`, `get`, and `all`) are supported for pre-request changes. Variable changes are saved locally. Post-response test results appear in the **Test Results** response tab and script messages appear in **Console**.

A script that does not complete within five seconds is terminated. As with any API client, only run scripts you trust; imported scripts are stored as code and execute only when you send a request.

## Responses

The response header shows the HTTP status, elapsed time, and response size. Response tabs include:

- **Body** — Pretty, Raw, or (for HTML) sandboxed Preview. JSON is pretty-printed when valid; XML can be formatted with **Beautify**.
- **Cookies** — cookies returned in Set-Cookie response headers.
- **Headers** — response headers and values.
- **Test Results** — pass/fail results from post-response `pm.test()` calls.

Body controls:

- **Beautify** formats valid JSON or XML.
- **Wrap lines** toggles line wrapping.
- **Zoom in/out** changes the response code font size.
- **Copy** copies the response body as received.
- **H** copies a text response including its HTTP status line and response headers.
- **Download** saves a `.json` file. Valid JSON is formatted; a non-JSON response is saved as a JSON string so the download remains valid JSON.

The local request proxy displays response bodies up to 12 MB. The limit prevents a large response from exhausting browser storage or the local application process.

## Collections

Choose **Collections → +** to create a collection. Save a request with **Save**, pick a collection, and give the request a name. Click a saved item to open it in a request tab. Collection menus can create a request, edit collection-level authorization, export a Postman Collection v2.1 JSON file, duplicate, rename, or delete a collection. A request set to **Inherit auth** uses its collection's configured helper. Request menus can open, run, rename, delete, copy cURL, or generate code.

Imported Postman collections retain their request methods, URLs, query parameters, headers, supported authorization fields, raw/form bodies, collection variables, and pre-request/test event scripts. Folder structure is retained. Exported collections use the Postman Collection v2.1 schema.

## Import and export

Select **Import** in the top bar, then choose a file or paste text. API Manager detects:

- **cURL command** — opens a new request tab. Common options such as `-X`, `-H`, `-d`, `--data-raw`, `-u`, `-G`, `-I`, `-F`, `-b`, and `-A` are recognized.
- **Postman collection** — imports Collection v2.1 JSON into the sidebar.
- **Postman environment** — imports environment values and makes it the active environment.
- **Request JSON** — imports a Postman-style single request object.

Collection and environment export buttons download Postman-compatible JSON files. From a request menu, choose **Copy request as cURL**. The settings menu can export a workspace backup JSON, including local state, collections, environments, globals, open tabs, and history. Treat backups as sensitive if they contain API credentials.

## Code generation

Select **Code** beside the request tabs to generate a request snippet in:

- cURL
- Python Requests
- JavaScript Fetch
- Java HttpClient
- Postman CLI (`postman collection run ...`)

Select a language, copy its output, or download it as a text file. Code is generated locally. It is a starting point: check the generated headers, body encoding, authorization fields, environment values, and escaped secrets before running or sharing it. Advanced dynamic signature schemes may need additional signing code in the destination language.

## History and console

Every request attempt is added to **History**, including HTTP errors and local network/proxy failures. Up to 200 runs are retained locally with the request snapshot, response details when available, and any error message. Select **Open** to inspect a previous result in a new request tab, or **Run again** to send that request again. History is browser-local and can be cleared in **Settings**.

Open **Console** from the sidebar or status bar to see outgoing request lines, response status/timing, script messages, and errors. The console can be cleared independently of request history. Shortcuts: **Ctrl/Cmd + Alt + C** toggles the panel.

## Developer details, release notes, and bug reports

Select the help icon or developer avatar to see application details and release notes.

- **Developed by:** Manish Kumar Singh
- **Email:** [manishkumars264@gmail.com](mailto:manishkumars264@gmail.com)
- **Version:** 1.0.0 (initial release)

The **Report a bug** button opens an email addressed to `manishkumars264@gmail.com` with a pre-filled subject and a body containing **Summary**, **Description**, and **Steps to reproduce** sections. Add a concise reproduction and relevant request/response details before sending. Avoid including passwords, access tokens, or private API data in a report.

### v1.0.0 — Initial release

Includes local multi-tab sessions; HTTP/SOAP request editing; API Key, Bearer, Basic, Digest, OAuth 1.0/2.0, Hawk, AWS Signature v4, Akamai EdgeGrid, NTLMv2, and HMAC JWT authorization; environments, globals and dynamic variables; pre-request/post-response scripts; Postman collection/environment import/export; cURL import/export; language code generation; response inspection, beautify, zoom, wrap, copy and JSON download; 200-run history; console; workspace backup; and developer/bug-report details.

## Local data, privacy, and limitations

- The app has **no login, account, cloud synchronization, telemetry, or application database server**. Workspace data is stored by the browser on the device that runs the UI, using IndexedDB with a localStorage fallback.
- The local Node server is a request proxy and static-file server. It does not keep API request data in a server-side collection store. When you send a request, the URL, headers, body, and selected credentials necessarily travel through the local proxy to the destination service.
- If you access a hosted preview or deploy the app on another machine, the browser's data is local to that browser/origin. The Node proxy has access to networks available to the host machine. Do not expose an unauthenticated instance as a public service.
- Browser storage can be cleared by browser settings or private/incognito session cleanup. Use workspace backups for portable copies. Backups contain sensitive data if your workspace contains credentials.
- Request bodies support text fields for form-data; file upload, binary response visualization, OAuth interactive authorization-code flows, team sharing, remote sync, and full parity with every Postman feature are not part of this initial implementation.
- Digest, NTLM and uncommon service implementations vary; verify generated signatures against the service documentation. NTLM may depend on server connection behavior. Code-generation output for advanced signing schemes is a scaffold rather than a complete external-language signer.
- The proxy limits incoming JSON request payloads to 2 MB, outgoing API response bodies to 12 MB, and individual request timeouts to 120 seconds.

## Testing

Run:

```bash
npm test
```

The automated suite exercises cURL and Postman format conversions, code generation, dynamic variables, local HTTP requests, request/response handling, scripts, and authorization signing helpers. For a manual smoke test, send `GET https://httpbin.org/get?hello=world`, then try a POST with a JSON body, add an environment variable, import/export a cURL or Postman JSON file, run a pre/post script, and inspect the saved history entry.

## Troubleshooting

- **The app does not open:** confirm Node.js 18+ is installed, restart `npm start`, and open the port printed in the terminal. Set `PORT=5050` if another process is using 4173.
- **A request fails with a browser network or proxy error:** confirm the local server is still running, the destination URL begins with HTTP or HTTPS, and the destination is reachable from the machine running Node.
- **CORS or network restriction:** the app routes requests through its same-origin local Node proxy, but a remote API, firewall, VPN, corporate proxy, or sandbox egress policy may still block the request.
- **A variable remains visible as `{{name}}`:** verify spelling and enable the variable in the active environment or globals. Environment values override globals.
- **Local data is missing:** make sure you are using the same browser and origin. Different ports/domains have separate browser storage. Check that browser storage is not disabled; restore a workspace backup if available.
- **An imported file is rejected:** verify that it is JSON in Postman Collection v2.1 or environment format, or paste a complete cURL command.

For bugs or feature requests, use the application’s **Report a bug** action or email [manishkumars264@gmail.com](mailto:manishkumars264@gmail.com).
