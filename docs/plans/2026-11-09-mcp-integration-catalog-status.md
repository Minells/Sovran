# P8a — Optional integration catalog

Branch `feature/mcp-integration-catalog`, based on `feature/native-web-fetch` at `db8854a`.
All earlier feature branches remain unmerged and unpushed. P8b starts from this increment, P9 from P8b.
No general Web search, native crawler/index or website change is included.

## Implemented

- Three catalog entries: Playwright MCP, Chrome DevTools MCP and hosted GitHub MCP. Filesystem/Git/Fetch shortcuts
  are replaced by the native equivalents; configured servers, their IDs, tokens, commands and policies remain intact.
  Custom local/remote servers and JSON import remain available, including with catalog entries already configured.
- Selecting an entry only reveals metadata. Add integration saves a disconnected entry with Ask policies. Explicit
  Install dependencies uses a native confirmation, host location and cancellable progress; Connect is a separate
  native confirmation. Adding a token to a disconnected integration does not start it.
- Managed local packages use extension-storage directories, bundled package manifests and full npm lockfiles.
  Installation uses the host's Node/npm, `npm ci --ignore-scripts`, an extension-storage cache, no audit/fund requests
  and no browser installation. Staging folders are unique and removed on failure; failed entries stay retryable.
  Installed versions/lockfiles/entrypoints are checked; launch uses the installed CLI and absolute host Node path,
  never `npx -y` or a floating version. No managed server can launch without its installer/host support.
- System Node must live outside workspace roots. The pinned Playwright dependency graph needs Node 20+ although
  the top-level MCP manifest says >=18. DevTools requires 20.19+, 22.12+ or >=23; the embedded minimum VS Code Node
  20.18 is not assumed sufficient. Missing/incompatible runtimes are reported with requirements and retry guidance.
- Managed provenance round-trips through settings. Generic editing asks before converting an integration to a
  custom server, preserves enabled state and tool policies, and never silently overwrites a custom command.
  Managed metadata changes invalidate the connection generation. User-only settings/trust boundaries remain enforced.
- The local package manager aborts installs on disposal. It serializes installation jobs and refuses reinstallation
  while an integration is enabled. Packages are installed only on explicit user action; startup only inspects files.
  A previously connected enabled integration starts again in trusted windows, as stated in Connect confirmation.

## Verification observed

macOS arm64, Node 22.23.4:

- `npm run check`: typecheck, lint and **619 tests in 33 files passed** (P5: 600 in 32).
- New core/host/UI tests cover candidate versions and runtime engines, typed messages, preservation of custom entries,
  disconnected creation/token storage, explicit custom conversion, selection without I/O, locked installs, retry,
  cancellation/trust rejection, modified lockfile refusal and installed-entrypoint launch. Existing MCP regressions pass.
- The actual installer installed `@playwright/mcp@0.0.84` and `chrome-devtools-mcp@1.12.0` with their bundled lockfiles
  into `/tmp/sovran-managed-mcp-p8`, without scripts or browsers. Exact published CLIs accepted `--help`; flags and
  executable entrypoints were inspected. These are compatibility observations, not browser or account smoke claims.
- Production build and `/tmp/sovran-mcp-integration-catalog.vsix` passed: **29 files**, reported **1.22 MB**, including
  all four managed package manifest/lock files, no managed node_modules or browser binaries. Root dependencies unchanged.
- Real VS Code 1.145.2 extension smoke tests passed: activation, secure defaults, settings/configuration sync,
  native diagnostics/Web fixtures, views and editor chats. Cached VS Code was used after the version lookup's
  certificate-chain error, with TLS verification enabled.
- `git diff --check` passed. The settings catalog uses existing VS Code theme tokens and keyboard-accessible buttons;
  narrow-layout visual inspection and real model/browser use are part of the subsequent increments.

P8b finalizes and actually exercises browser profiles, filters, privacy flags and cleanup. Hosted GitHub requires an
explicit user PAT; no user credential or account was accessed during this increment. Cross-platform, Remote,
minimum-host and installation/upgrade checks are tracked in P9 rather than inferred from CI configuration.
