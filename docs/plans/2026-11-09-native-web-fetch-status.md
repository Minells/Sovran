# P5 — Small native public Web fetch

Implemented on `feature/native-web-fetch`, created from `feature/workspace-diagnostics` at
`eda4ccaf50f3627e902b4a26bdcbb1b44a41a13f`. The branch contains unmerged P1/P2a/P2b/P3; review this increment against
P3 and preserve the earlier integration order. No merge or push was performed.

## Scope approved by the owner

One native `web_fetch` tool. The owner explicitly requested a small implementation after reviewing the Crawlee spike.
Crawlee adoption is removed as a prerequisite for this path; its experiment and no-go decision remain untouched.
No search provider, search-result scraping, crawler, sitemap discovery, persistent index, browser, OAuth/login,
cookie jar, custom request headers or private-network exception is introduced. Existing MCP configurations/presets
and website source are unchanged. There are no activation-time Web requests or parser loads.

## Implemented

- `web_fetch({ url, max_chars? })`: one public HTTP(S) URL, default ports only, URL length at most 2048 input
  characters. `max_chars` is 500–20,000 (default 12,000), additionally bounded by Sovran's tool-result setting.
  HTML becomes structured text preserving headings, code, lists, basic tables and resolved links; plain text,
  Markdown and JSON are returned as text. Source, effective URL, fetch time, title and shortening are explicit.
  At most 20 distinct links are listed. Extraction is best effort, not a complete browser rendering.
- Read-risk tool in trusted Plan/Act. A typed network action always requires approval, including Auto and command/
  edit grants. Preparation only validates arguments and constructs the dedicated Web approval card; it performs
  no DNS, robots or page I/O. There is no Always allow/session-grant control. Native Off/force-Ask settings apply.
- The core uses an optional `WebFetchPort`; the extension composes one shared `NativeWebFetcher`. One active job
  across chats, 30-second total budget, no retries, at most 8 requests (robots plus page and up to 3 redirects each).
  Cancellation destroys active requests/responses and terminates parsing workers. An already-started OS DNS lookup
  cannot be cancelled, but its result cannot dispatch after cancellation. Permission/trust rechecks run after DNS,
  immediately before socket creation, before subsequent requests and before returning content.
- Every DNS answer must be public; mixed answers, private/loopback/metadata, mapped/transition/documentation and
  reserved ranges fail closed. The socket destination is a validated numeric IP, with the original Host/SNI and
  explicit TLS hostname verification. A new connection validates DNS again; no pooled socket or independent
  hostname lookup can bypass it. Redirects are handled explicitly and stay within the approved origin. An external
  public redirect returns its URL so a new call can request separate approval; private destinations remain refused.
- VS Code can override `http(s).request` even with `agent: false`. The driver instead uses public `ClientRequest`,
  per-request agents and `new Socket().connect()` to the validated IP, then wraps that connected socket for TLS.
  The final runtime guard runs inside the agent immediately before that raw connection. Tests replace global HTTP/
  HTTPS/net.connect helpers with throwing wrappers and still read the local fixture; the same driver is exercised
  by the real extension-host and Node 20 probes. No private VS Code API or patched-function restoration is used.
- Direct transport only: no ambient cookie/authentication or proxy integration. TLS validation is always on.
  Where `tls.getCACertificates` is available, per-client CA roots combine Node's default and already-trusted system
  CAs, loaded lazily. Older runtimes retain Node's configured trust, including `NODE_EXTRA_CA_CERTS`. No global CA/
  TLS defaults, repository certificate file, workspace setting or model-provided CA is used.
- robots.txt uses the exact same transport. Missing 404/410 is allowed; other failed/oversized/non-text/unreadable
  robots responses fail closed. Rules and known crawl-delay are checked before each page request/redirect within
  a call; excessive delay fails rather than exceeding the job budget. No robots/sitemap helper has another HTTP path.
  No cross-call robots cache or scheduler is claimed.
- Page bodies: 1 MiB encoded and decoded; robots: 128 KiB encoded and decoded; response headers: 16 KiB.
  gzip/deflate/Brotli decoding is bounded while streaming. Unsupported MIME/encoding, HTTP errors, binary text and
  empty/script-only pages fail clearly. Browser script execution and automatic subresource loading never occur.
- Lazy `dist/webWorker.js`: pure HTML and robots processing, fresh worker per operation, empty environment,
  no inherited inspector arguments, 128 MiB old-generation heap and a 5-second operation timeout. Host imports of
  these parsers are prohibited by the existing worker-isolation lint rule. This is not an OS sandbox.
- Exact direct dependencies: `htmlparser2@10.0.0`, `ipaddr.js@2.5.0`, `robots-parser@3.0.1`. HTML parser 12 requires
  Node >=20.19, so it was not selected for the 20.18.0 floor. Eight additional locked package locations, no browser
  binary or Crawlee dependency. Notices cover all production versions, including both `entities` 4.5.0 and 6.0.1:
  the generator now reads each actual installed location instead of collapsing nested versions by package name.
- Settings Data text and SECURITY explain that approved URLs are contacted and returned page text can go to the
  configured model and persist in ordinary chat history. There is no separate Web content cache or index.

## Verification observed

Environment: macOS arm64, Node **22.23.4**, real VS Code **1.145.2**, minimum-runtime probe **Node 20.18.0**.

- `npm run check`: typecheck, lint and **600 tests in 32 files passed** (P3: 506 in 30).
  New coverage: 62 core/URL/extraction/runtime tests, 31 transport/worker integration tests and one Web approval UI test.
  Local-server tests ran with loopback access outside the restricted sandbox.
- Controlled real HTTP sockets test mixed/rebinding DNS, pinned connection options, robots and page redirects,
  rules, encoding/MIME, output/request/body limits, compression bombs, stalled streams/DNS, late permission changes,
  concurrency and cancellation. HTTPS fixture performs real TLS: a trusted certificate succeeds, missing trust and
  a different hostname both fail, and the intended DNS name is sent as SNI. Its disposable test-only key never ships.
- `npm run test:extension`: production adapters and packaged Web worker passed the new local-fixture smoke probe;
  existing activation/settings/diagnostics/views/chat regressions also passed. The runner reused cached VS Code after
  an issuer-certificate error fetching version metadata; TLS verification was not disabled.
- `/tmp/node-v20.18.0-darwin-arm64/bin/node scripts/verify-web-runtime.mjs`: actual Node 20.18.0 ran a minified bundled
  transport probe and Web worker from a temporary directory without adjacent node_modules. HTML, robots, source
  links and code extraction passed; the injected loopback fixture was the only test destination.
- Public HTTPS probe against `https://example.com/`: returned **Example Domain** and 156 text characters. The initial
  plain-Node attempt exposed the missing system CA in this environment. After adding the system-trust API path,
  the same read succeeded with chain and hostname validation enabled. No auth, browser session or TLS bypass used.
- Production host/document/Web worker and webview build passed; VSIX packaging passed with **25 files**, reported
  **1.21 MB** (P3: 24 files, about 1.14 MB). Web worker is about **179 KB**, versus P4's roughly 2.6 MB experiment worker.
  The generated package includes the worker and notices, and excludes test probes/certificates and node_modules.
- `git diff --check` passed. Dependency installation used `--ignore-scripts`; npm reported no vulnerabilities.

## Remaining gates

Not exercised: manual model calls, manual narrow-layout review, Windows/Linux, Remote SSH/WSL/container, real minimum
VS Code, fresh VSIX installation or upgrade. These remain P9; the Node minimum probe is not a minimum VS Code test.
System-CA discovery requires the newer Node API and has been observed only on macOS. Authenticated/JS-rendered sites,
proxy-only networks, non-default ports and private destinations remain outside this tool's contract.

The scoped public-fetch gate has evidence independently of Crawlee. P6/P7 and browser/search capabilities remain
separate future choices, with no global Internet-search promise made by this tool.

Primary references checked alongside local source/tests:
[Node TLS and system CA API](https://nodejs.org/download/release/latest-v22.x/docs/api/tls.html),
[VS Code proxy wrapper](https://github.com/microsoft/vscode-proxy-agent/blob/main/src/index.ts),
[HTML parser](https://github.com/fb55/htmlparser2), [IP parser](https://github.com/whitequark/ipaddr.js),
[robots parser](https://github.com/samclarke/robots-parser).
