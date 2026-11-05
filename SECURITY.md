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
| Attached documents (PDF, Office, OpenDocument, ZIP) | **Untrusted**. Parsed only in an isolated worker thread |
| Terminal output, tool results | **Untrusted** |
| Webview | Sandboxed. Its messages are **validated** as untrusted input |
| Workspace settings (`.vscode/settings.json`) | **Untrusted** for security-relevant keys |

## Threats and controls

| # | Threat | Controls |
|---|---|---|
| T1 | Credential theft | API keys are stored only in SecretStorage, keyed by provider ID. They are never written to settings, sessions, logs, exports or webview messages (the webview only receives `hasKey: boolean`). Errors and logs pass through redaction, which masks known secrets plus bearer and key patterns |
| T2 | A malicious repository redirects credentials by overriding `sovran.providers` in workspace settings | Security-relevant settings (`providers`, `approvals.*`, `security.*`, `terminal.*`) are declared with `"scope": "application"`, and the host reads **only the user (global) value** through `inspect()`. Workspace values are ignored |
| T3 | Path traversal or a write outside the workspace | Every path is resolved against the workspace roots. `..` escapes and absolute paths outside the roots are rejected. Symlinks are resolved with `realpath` (for new files, the nearest existing parent) and re-checked |
| T4 | Destructive or exfiltrating shell commands (including via prompt injection) | `execute_terminal` is unavailable in Plan mode and in untrusted workspaces. In Ask and Auto-edit mode every command needs explicit approval with a full preview. The allow-list only matches commands **without** shell metacharacters, so `npm test; curl evil` never auto-runs. **Guardrails** always ask, even for allow-listed commands and in Auto mode: recursive deletes, `sudo`, downloaded scripts, `eval` and nested shells, pushes and force-pushes, publishing, infrastructure changes, network uploads and raw connections, credential stores, environment dumps, system services, global installs, protected paths, home-directory, `..` and absolute paths outside the workspace, and invisible characters. `cwd` is confined to the workspace. Timeouts, cancellation and process-tree kill are enforced |
| T5 | Silent overwriting of user content | Writes require approval by default (Ask mode), previewed in the native diff editor. In Auto-edit and Auto mode they are applied without asking, labelled *auto* in the transcript and undoable per response through checkpoints. A staleness check (content hash) aborts if the file changed after the proposal. Writes go through `WorkspaceEdit`, so they can be undone. Protected paths (`.env*`, keys, certificates, `.git/`) always require approval, even when edits are auto-approved |
| T6 | Prompt injection in files or tool output | Tool results are wrapped and labelled as data, and the system prompt instructs the model to treat them as untrusted. **This is not a guarantee.** The real defense is that no write or exec happens without the controls in T4 and T5 |
| T7 | Malicious markdown or HTML in model output (XSS in the webview) | markdown-it runs with `html: false`. Output is sanitized with DOMPurify, and links are restricted to `http(s)`/`mailto` and opened by the host. A strict CSP applies: `default-src 'none'`, scripts only with a per-load nonce, no `unsafe-eval`, no remote origins |
| T8 | Forged or malformed webview messages | Every inbound message is parsed with a zod schema. Unknown or invalid messages are dropped and logged without their payload |
| T9 | Runaway agent | Iteration cap, repeated-failure loop guard, request and idle timeouts, user cancellation at any point |
| T10 | Sensitive data in session files | Sessions are stored in VS Code's per-workspace storage as plaintext JSON. They never contain credentials, but they do contain code and conversation text. Images sent in a chat are stored next to them as files, unencrypted. Persistence can be disabled (`sovran.sessions.persist`) |
| T11 | Network exfiltration through the extension | SOVRAN only contacts endpoints configured by the user. There is no telemetry and no SOVRAN backend |
| T12 | Unattended actions in Auto mode | Auto is opt-in per window and needs a native confirmation (a webview message alone cannot enable it). It requires a trusted workspace and never applies in Plan mode. Guardrails (T4) and protected paths still ask. The mode is always visible in the composer and the status bar, and every action that ran without asking is labelled with the reason |
| T13 | Credentials or code forwarded by an HTTP redirect | Provider requests never follow redirects. `fetch` would keep custom auth headers such as `api-key` and re-send the body to another origin on a 307/308; Sovran reports the redirect target instead |
| T14 | Files outside the workspace sent as context | The active file is attached automatically only when it is inside the workspace and not protected; otherwise its chip says it is not shared. `@` mentions and attached files are re-verified through `realpath` at send time, so a symbolic link cannot pull in a file from outside |
| T15 | Untrusted text breaking out of its data wrapper | In the prompted tool protocol and in attached files, closing tags such as `</tool_result>`, `</file>` and `</context>` inside the content are neutralized, and wrapper attributes are escaped |
| T16 | Malicious documents: parser exploits, ZIP bombs, entity expansion, pathological sizes | Documents are parsed only in a worker thread (`dist/documentWorker.js`) with its own heap limit (768 MB) and a 60 s timeout, started per conversion with no inherited command-line options and terminated when it answers; the parsers never load in the extension host (an ESLint rule enforces it). pdf.js runs with `isEvalSupported: false` (the CVE-2024-4367 fix), no font loading and no rendering. The ZIP reader checks each entry's declared size (64 MB) and the total (160 MB) before inflating, and never inflates past the declared size. The XML reader skips DTDs and decodes only the predefined entities, so documents cannot define or fetch entities. Repeated spreadsheet rows and columns are expanded only up to a bound. Files are classified by signature, not extension, and protected files ask before they are read |
| T17 | Images: oversized or disguised data, data kept longer than expected | Only PNG, JPEG, WebP and GIF are sent, recognized by signature (never by name or by the MIME type a paste claims), up to 8 MB each and 8 per message. A paste is bounded and checked as base64 by the message schema before it is decoded. Images go only to the configured endpoint, as data URLs. They are stored per chat in workspace storage (in memory when `sovran.sessions.persist` is off), never in session files or webview messages, and deleted with the chat |

## Known limitations

- SOVRAN does **not** sandbox commands. An approved command, or a command that runs in Auto mode, runs with your user's
  privileges and inherits the editor's environment variables.
- Auto-mode guardrails are heuristics over the command text, not a shell interpreter. They catch the common dangerous
  shapes; they cannot see what a script, a build step or a package's install hooks do once they run. Dependency
  installs (`npm install`, `pip install`) and project scripts run in Auto mode. Use Auto only in repositories you trust.
- Read tools are auto-approved (except protected paths). A model can read any non-protected file in
  the workspace and send it to the configured endpoint. Choose endpoints you trust.
- TLS verification is never disabled. Internal CAs must be trusted by the OS or VS Code
  (`http.systemCertificates`). Corporate proxies use VS Code's `http.proxy` settings.
- Session files are not encrypted at rest.
- Prompt injection cannot be fully prevented at the model level. The controls above limit its impact.
- A converted document can carry text you never saw: white or hidden text, text behind an image, a hidden sheet or
  slide. It reaches the model like the rest of the document (hidden sheets and slides are labelled). Treat documents
  from others like any untrusted file, especially in Auto mode.
