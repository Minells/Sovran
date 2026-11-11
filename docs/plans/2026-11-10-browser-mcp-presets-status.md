# P8b — reviewed MCP profiles

Branch: `feature/browser-mcp-presets`, based on P8a `b262dda`. No merge or push.

## Implemented

- Playwright `0.0.84`: isolated system Chrome by default; navigation, inline snapshots and interactions. Explicit
  existing-profile mode asks for the Chrome profile directory name, requires the companion extension and its tab
  consent, and is unavailable on Remote hosts. No automatic profile discovery, debugging-port forwarding or browser
  installation. Screenshots, evaluation, arbitrary code, upload/install and page-defined tools are not exposed.
- Chrome DevTools `1.12.0`: isolated system Chrome; console, network, snapshots and performance tool allowlist.
  Usage statistics, CrUX, update checks, JavaScript evaluation, file navigation and unnecessary categories disabled.
- GitHub hosted server: read-only issues/PR profile using explicit `X-MCP-Tools` and `X-MCP-Readonly`; collaboration
  adds three write tools on Ask. Managed endpoint and headers are validated at connection time. Tokens remain in
  Secret Storage. Converting to a custom configuration requires the existing native confirmation.
- Profile allowlists apply on initial discovery, list changes and final dispatch, independently of per-tool Allow.
  Browser calls reject caller-selected output paths and navigation schemes other than HTTP(S). Custom servers retain
  their existing behavior. A browser integration is privileged and does not inherit native fetch's public-IP checks.
- Chrome is resolved from known system installation locations outside workspace roots; missing Chrome produces
  instructions before connection. Playwright output goes to extension storage, with a 20 MiB eviction threshold.
  Browser interactions can still initiate downloads; this threshold is not a hard disk quota or retention guarantee.
  Browser artifacts are separate from chat storage and are not deleted by deleting a chat.

## Observed locally (macOS arm64, Node 22.23.4, 2026-11-10)

- Real locked npm packages previously installed with scripts disabled; both pinned CLI help outputs checked.
- Opt-in `SOVRAN_MCP_SMOKE_STORAGE=/tmp/sovran-managed-mcp-p8 npx vitest run tests/integration/managedBrowsers.test.ts`:
  two real stdio handshake/list/call/close tests passed using headless isolated system Chrome and localhost fixtures.
  Playwright navigation → explicit inline snapshot → click → snapshot → close; DevTools new page → snapshot →
  console/network reads. Excluded direct calls rejected. No credentials or personal browser profiles used.
- The pinned Playwright version returns snapshot file links after actions: call `browser_snapshot` without a filename
  for inline text. Sovran never opens server-returned filesystem paths. DevTools calls require explicit `pageId`.
- Process inspection after disposal found no remaining fixture server or isolated test-browser processes.
- Typecheck, lint, full tests, production build and real VS Code 1.145.2 smoke passed. VSIX packaged successfully
  (`/tmp/sovran-browser-mcp-presets.vsix`, 29 files, approximately 1.22 MB), with manifests/locks and no browser bundle.

## Remaining release gates

Authenticated Playwright companion-extension/tab consent and GitHub PAT/scopes require an opted-in test account.
No account smoke is claimed. Only system Chrome on local macOS was exercised; Windows, Linux, Remote, browser
version coverage, fresh install/upgrade, narrow layout and model native/prompted modes are tracked in P9. Edge,
Firefox and WebKit are not managed preset options. No claim of completing those gates from configuration alone.
