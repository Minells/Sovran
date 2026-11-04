# Architecture Decision Log

Short ADRs. Status values are *Accepted*, *Proposed* (awaiting owner approval) and *Superseded*.

| # | Decision | Status | Rationale |
|---|---|---|---|
| ADR-001 | Ports-and-adapters with a `vscode`-free core, enforced by ESLint | Accepted | Future CLI or other IDE reuse. Testability without the VS Code runtime |
| ADR-002 | The Extension Host is authoritative. The webview is a projection without `retainContextWhenHidden` | Accepted | Security (credentials and I/O stay in the host), lower memory use, survives webview disposal |
| ADR-003 | React 19 + Vite for the webview, with hand-built components on VS Code CSS variables | Accepted | The Webview UI Toolkit is deprecated (archived Jan 2025). Theme tokens give native theming including high contrast |
| ADR-004 | `apply_diff` = atomic search/replace blocks instead of unified diffs | Accepted | Local models are unreliable with line numbers and hunk headers |
| ADR-005 | Prompted tool protocol (`<tool_call>` JSON) as a fallback, with automatic downgrade on rejection | Accepted | Many OpenAI-compatible servers or models lack native tools |
| ADR-006 | Security-relevant settings are `application`-scoped and read from the global value only | Accepted | Blocks malicious repositories from redirecting credentials or auto-approving actions |
| ADR-007 | Writes go through `WorkspaceEdit`, with a staleness hash check | Accepted | Undo support, dirty-buffer safety, no silent overwrite |
| ADR-008 | Commands use `child_process` with a pseudoterminal mirror, not shell-integration execution | Accepted | Reliable output capture and exit codes on every platform. Shell integration is not always available |
| ADR-009 | Native `fetch` with a hand-written SSE parser, no OpenAI SDK | Accepted | Zero dependencies, full control over quirks, uses VS Code's patched fetch for proxies |
| ADR-010 | Sessions as JSON files in workspace storage with atomic writes | Accepted | globalState is not designed for large blobs. Scoping per workspace matches user expectations |
| ADR-011 | Model selection through a native Quick Pick instead of a custom dropdown | Accepted | Native, accessible, searchable and cheaper to build |
| ADR-012 | Core contracts before UI (milestone reorder) | Proposed (D7) | Avoids fake UI and rework |
| ADR-013 | No telemetry | Proposed (D4) | Product positioning |
| ADR-014 | Minimum VS Code `^1.95.0` | Proposed (D8) | Stable APIs used, `fetch` proxy support |
| ADR-015 | Command approval cards reveal invisible and bidi characters, and such commands never match the allow-list | Accepted | Prevents "Trojan Source"-style spoofing of what the user approves |
| ADR-016 | React state is derived during render instead of synchronized in effects (React 19 lint) | Accepted | Avoids cascading renders and stale UI |
| ADR-018 | MIT license | Accepted (owner decision D3) | Maximum adoption with minimal friction. All bundled dependencies are permissive. Note: MIT has no explicit patent grant, unlike Apache-2.0 |
| ADR-019 | Approval modes `ask` · `edits` · `auto` for Act mode. The mode is per window and starts from `sovran.approvals.mode`; turning on Auto needs a native confirmation once per window | Accepted | Mirrors the proven Claude Code model (per-session mode, explicit default). Per-window scope stops an Auto choice made in one repository from silently applying to the next. The native modal is informed consent and defense in depth against a compromised webview |
| ADR-020 | Guardrails beat every allowance: protected paths, high-risk command patterns, paths outside the workspace and hidden characters always ask, in Auto mode and for allow-listed commands | Accepted | Auto must stay recoverable: checkpoints undo file edits, but not a push, a deletion or a leaked secret. The patterns are heuristics, documented as not being a sandbox |
| ADR-021 | Provider requests never follow HTTP redirects (`redirect: 'manual'`) | Accepted | `fetch` keeps custom auth headers (e.g. `api-key`) and the POST body when following a redirect to another origin. A redirect becomes an actionable error instead |
| ADR-022 | Providers can also come from `~/.sovran/config.yaml`, merged with `sovran.providers` (the file wins on the same id), applied only when the whole file is valid, never containing keys | Accepted | A text file suits people who version their setup or configure many endpoints. The home folder (not the workspace) keeps ADR-006's guarantee. All-or-nothing with last-known-good avoids half-applied states while typing. Keys stay in Secret Storage; credential-looking fields and headers are rejected. Model choices apply once per content change so they do not fight with picks made in the UI |
| ADR-023 | Model-generated chat titles are opt-in and run in parallel with the first request | Accepted | An extra request has a cost on slow local servers and sends the first message once more (possibly to a different title model), so the user chooses it. The first-words title is shown at once and stays on any failure or rename |
| ADR-017 | Release through GitHub Actions with Marketplace Trusted Publishing (OIDC) behind a protected environment | Accepted | Azure DevOps global PATs retire on 2026-12-01. No long-lived secret in the repository |
