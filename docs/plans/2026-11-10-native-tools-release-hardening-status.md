# P9 — native tools release hardening

Branch: `feature/native-tools-release-hardening`, based on P8b `7bd3bf7`.

Progressive chain, intentionally unmerged:

1. `feature/native-web-fetch` — `db8854a` (contains Git and diagnostics increments).
2. `feature/mcp-integration-catalog` — `b262dda` (P8a).
3. `feature/browser-mcp-presets` — `7bd3bf7` (P8b).
4. `feature/native-tools-release-hardening` — P9.

No merge, push, release, search provider or website change. Native Web remains a single approved URL read; P6/P7 and
Crawlee adoption are outside this increment. P9 implementation is complete; the release matrix below remains partial.

## Implementation

- Settings retains six areas, presenting **Tools** instead of MCP while keeping the internal `mcp` route compatible.
  Built-in groups show individual enabled/always-review controls, with advanced list overrides retained. Custom MCP
  servers/import, tokens and Off/Ask/Allow stay available alongside the optional catalog.
- Chat input and Tools settings expose deterministic per-chat groups with available counts and estimated definition
  cost before selection. `Session.excludedToolGroups` persists exclusions; older/new chats default to all groups.
  Disconnected/Off tools are absent, and Plan/trust/native-disabled restrictions still apply. A model configured with
  tool mode None has zero offered-definition cost. Estimates are not billed tokens or a silent eviction budget.
- The existing registry filters both requests and live dispatch. Offered-definition checks, approval revalidation,
  delayed-effect checks and per-chat exclusions compose with native user policy and MCP policy. Tests cover native
  and prompted calls, guessed names, MCP Allow, deselection during approval, independent surfaces and persistence.
- Browser hardening also rejects managed local entries redirected to custom endpoints/environments and explicitly
  enables Playwright's browser sandbox. Explicit custom conversion remains available.
- VSIX verifier reads the ZIP and checks host/webview/workers/notices, exact bundled manifest/lock bytes, no browser/
  server dependencies or binaries, source/tests/private files/maps. No root runtime dependency was added.
- Extension tests now create and clean unique temporary user-data/extension/config directories. An installed VSIX
  can be tested in Test mode; optional previous-VSIX activation seeds policy fixtures before replacement and checks
  preservation. Minimum-host smoke is configured on all three CI systems. Package/release jobs verify assets and
  run installed-VSIX smoke before publication. CI was not triggered by this local work.
- README, user guide, architecture, SECURITY, decisions, development/release docs and the original plan are aligned.

## Local evidence — 10 November 2026

Environment: macOS arm64, Node 22.23.4, VS Code 1.145.2, system Google Chrome.

| Check | Observed result |
| --- | --- |
| `npm run check` | Typecheck and lint passed; 636 tests passed across 34 files, two opt-in browser cases skipped in their separate file |
| Real optional browser cases | Two passed using the locked installed packages, real stdio handshakes/list/calls, isolated headless Chrome, localhost fixtures and process termination checks; final P9 flags included |
| Production build | Host and both workers plus webview passed; no browser/server package bundled |
| Source extension smoke | Passed in an actual fresh temporary VS Code profile, including runtime assets, cached diagnostics, packaged Web worker and regression commands/chats |
| Installed VSIX smoke | Passed using the actual packaged files in a temporary extensions directory and Test mode, confining config.yaml to test storage |
| P8b → P9 replacement | Both development VSIX packages are 0.1.0; previous artifact activated, native disabled/Ask overrides and disabled custom/managed servers saved, P9 force-installed and activated, ids/profiles/enable flags/tool policies retained; full smoke passed afterwards |
| UI harness | Inspected dark Tools/preset layouts at 320/420 px and chat menu at 320 px; no document/composer horizontal overflow; theme fallback corrected for opaque readable menu; light theme at 320 px plus Escape/focus return and outside-click dismissal passed |
| VSIX | `/tmp/sovran-native-tools-p9.vsix`, 29 files, approximately 1.22 MB; asset verifier passed |

Logs are temporary local artifacts: `/tmp/sovran-p9-check.log`, `/tmp/sovran-p9-installed-smoke.log` and `/tmp/sovran-p9-fresh-installed-smoke.log`.
The replacement test verifies saved configuration, not a genuine version-number migration or live credential migration.
No personal profile, token, production endpoint or authenticated account was used.

## Remaining release gates — not inferred from implementation or CI definitions

| Area | Status / next verification |
| --- | --- |
| Minimum VS Code 1.95.0 | Not exercised. Official metadata resolved, but archive requests yielded an empty body/checksum mismatch (one curl redirect attempt returned 403). Integrity/TLS checks stayed enabled; another cached version was not substituted. Retry from a working download environment; CI has explicit minimum-version jobs |
| Windows / Linux | Unit/host/package CI configured; no local run or remote CI result observed here. Exercise system Node/npm/Chrome paths, process cancellation, `.cmd` behavior, Git hooks/signing and VSIX lifecycle |
| Remote SSH / WSL / containers | Host labels and unsupported desktop-profile checks implemented/tested. Actual remote installation, host storage/browser dependencies and cancellation still need environment tests. No ports forwarded |
| Authenticated Playwright | Explicit profile selection/cancel/Remote rejection tested. Companion extension, tab consent, cookies/session access and logout require an opted-in test browser profile |
| GitHub PAT | Narrow server headers/client allowlists tested locally. Real token scopes, read-only account access, opt-in writes, expired credentials and Secret Storage migration require a test account |
| Real model/user review | Automated native/prompted fixtures pass. Still exercise actual chosen models, Git approval cards/signing/hooks, network approval, errors/cancel and high-contrast/keyboard use in VS Code |
| Versioned upgrade / retained data | Actual same-version VSIX replacement passed. Genuine versioned upgrade with persisted chats, real Secret Storage, old custom policies and window restart remains manual |

Keep these feature branches where they are for the owner's joint integration review. Do not describe the release
matrix as passed until its actual platform/account evidence is recorded.
