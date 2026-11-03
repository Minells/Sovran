# Security

SOVRAN executes actions on your machine on behalf of a language model. Security is a product
feature, not a disclaimer. This document describes the threat model, the controls that are
**implemented**, and the known limitations.

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private vulnerability reporting
(*Security → Report a vulnerability*) on this repository. We aim to acknowledge reports within 5 business days.

## Trust model

| Component | Trust |
|---|---|
| Extension Host (SOVRAN host code) | Trusted |
| VS Code SecretStorage | Trusted credential store |
| Model output (text, tool calls, arguments) | **Untrusted** |
| Repository files, file names, `AGENTS.md` | **Untrusted** (may contain prompt injection) |
| Terminal output, tool results | **Untrusted** |
| Webview | Sandboxed. Its messages are **validated** as untrusted input |
| Workspace settings (`.vscode/settings.json`) | **Untrusted** for security-relevant keys |

## Threats and controls

| # | Threat | Controls |
|---|---|---|
| T1 | Credential theft | API keys are stored only in SecretStorage, keyed by provider ID. They are never written to settings, sessions, logs, exports or webview messages (the webview only receives `hasKey: boolean`). Errors and logs pass through redaction, which masks known secrets plus bearer and key patterns |
| T2 | A malicious repository redirects credentials by overriding `sovran.providers` in workspace settings | Security-relevant settings (`providers`, `approvals.*`, `security.*`, `terminal.*`) are declared with `"scope": "application"`, and the host reads **only the user (global) value** through `inspect()`. Workspace values are ignored |
| T3 | Path traversal or a write outside the workspace | Every path is resolved against the workspace roots. `..` escapes and absolute paths outside the roots are rejected. Symlinks are resolved with `realpath` (for new files, the nearest existing parent) and re-checked |
| T4 | Destructive or exfiltrating shell commands (including via prompt injection) | `execute_terminal` is unavailable in Plan mode and in untrusted workspaces. Every command needs explicit approval with a full preview. The allow-list only matches commands **without** shell metacharacters, so `npm test; curl evil` never auto-runs. `cwd` is confined to the workspace. Timeouts, cancellation and process-tree kill are enforced |
| T5 | Silent overwriting of user content | Writes require approval by default, previewed in the native diff editor. A staleness check (content hash) aborts if the file changed after the proposal. Writes go through `WorkspaceEdit`, so they can be undone. Protected paths (`.env*`, keys, certificates, `.git/`) always require approval, even when edits are auto-approved |
| T6 | Prompt injection in files or tool output | Tool results are wrapped and labelled as data, and the system prompt instructs the model to treat them as untrusted. **This is not a guarantee.** The real defense is that no write or exec happens without the controls in T4 and T5 |
| T7 | Malicious markdown or HTML in model output (XSS in the webview) | markdown-it runs with `html: false`. Output is sanitized with DOMPurify, and links are restricted to `http(s)`/`mailto` and opened by the host. A strict CSP applies: `default-src 'none'`, scripts only with a per-load nonce, no `unsafe-eval`, no remote origins |
| T8 | Forged or malformed webview messages | Every inbound message is parsed with a zod schema. Unknown or invalid messages are dropped and logged without their payload |
| T9 | Runaway agent | Iteration cap, repeated-failure loop guard, request and idle timeouts, user cancellation at any point |
| T10 | Sensitive data in session files | Sessions are stored in VS Code's per-workspace storage as plaintext JSON. They never contain credentials, but they do contain code and conversation text. Persistence can be disabled (`sovran.sessions.persist`) |
| T11 | Network exfiltration through the extension | SOVRAN only contacts endpoints configured by the user. There is no telemetry and no SOVRAN backend |

## Known limitations

- SOVRAN does **not** sandbox approved commands. An approved command runs with your user's
  privileges.
- Read tools are auto-approved (except protected paths). A model can read any non-protected file in
  the workspace and send it to the configured endpoint. Choose endpoints you trust.
- TLS verification is never disabled. Internal CAs must be trusted by the OS or VS Code
  (`http.systemCertificates`). Corporate proxies use VS Code's `http.proxy` settings.
- Session files are not encrypted at rest.
- Prompt injection cannot be fully prevented at the model level. The controls above limit its impact.
