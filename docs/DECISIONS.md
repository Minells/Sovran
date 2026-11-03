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
| ADR-017 | Release through GitHub Actions with Marketplace Trusted Publishing (OIDC) behind a protected environment | Accepted | Azure DevOps global PATs retire on 2026-12-01. No long-lived secret in the repository |
