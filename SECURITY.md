# Security

SOVRAN executes actions on your machine on behalf of a language model. Security is a product
feature, not a disclaimer. This document describes the threat model, the controls that are
**implemented**, and the known limitations.

## Reporting a vulnerability

Please **do not** post exploit details, credentials, or sensitive logs in a public issue. If GitHub's private
vulnerability reporting is enabled, use **Security → Report a vulnerability** on this repository:
[private report form](https://github.com/Minells/sovran/security/advisories/new).

If that option is not available, a confidential maintainer contact has not been published. You can open a minimal
issue asking the maintainer to enable private reporting, without vulnerability details. Keep those details private
until a confidential route is available. Response times depend on maintainer availability.

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
| MCP servers the user configured | Trusted to run (the user chose them), but their tool descriptions, annotations and results are **untrusted** |

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
| T11 | Network exfiltration through the extension | SOVRAN contacts configured provider/MCP endpoints and public Web URLs explicitly approved by the user. Web approval includes robots.txt and bounded redirects within the same origin. There is no telemetry and no SOVRAN backend |
| T12 | Unattended actions in Auto mode | Auto is opt-in per window and needs a native confirmation (a webview message alone cannot enable it). It requires a trusted workspace and never applies in Plan mode. Guardrails (T4) and protected paths still ask. The mode is always visible in the composer and the status bar, and every action that ran without asking is labelled with the reason |
| T13 | Credentials or code forwarded by an HTTP redirect | Provider requests never follow redirects. `fetch` would keep custom auth headers such as `api-key` and re-send the body to another origin on a 307/308; Sovran reports the redirect target instead |
| T14 | Files outside the workspace sent as context | The active file is attached automatically only when it is inside the workspace and not protected; otherwise its chip says it is not shared. `@` mentions and attached files are re-verified through `realpath` at send time, so a symbolic link cannot pull in a file from outside |
| T15 | Untrusted text breaking out of its data wrapper | In the prompted tool protocol and in attached files, closing tags such as `</tool_result>`, `</file>` and `</context>` inside the content are neutralized, and wrapper attributes are escaped |
| T16 | Malicious documents: parser exploits, ZIP bombs, entity expansion, pathological sizes | Documents are parsed only in a worker thread (`dist/documentWorker.js`) with its own heap limit (768 MB) and a 60 s timeout, started per conversion with no inherited command-line options and terminated when it answers; the parsers never load in the extension host (an ESLint rule enforces it). pdf.js runs with `isEvalSupported: false` (the CVE-2024-4367 fix), no font loading and no rendering. The ZIP reader checks each entry's declared size (64 MB) and the total (160 MB) before inflating, and never inflates past the declared size. The XML reader skips DTDs and decodes only the predefined entities, so documents cannot define or fetch entities. Repeated spreadsheet rows and columns are expanded only up to a bound. Files are classified by signature, not extension, and protected files ask before they are read |
| T17 | Images: oversized or disguised data, data kept longer than expected | Only PNG, JPEG, WebP and GIF are sent, recognized by signature (never by name or by the MIME type a paste claims), up to 8 MB each and 8 per message. A paste is bounded and checked as base64 by the message schema before it is decoded. Images go only to the configured endpoint, as data URLs. They are stored per chat in workspace storage (in memory when `sovran.sessions.persist` is off), never in session files or webview messages, and deleted with the chat |
| T18 | MCP servers: a repository starting a process or redirecting a token, tool calls nobody approved, tokens leaking, injected instructions in tool descriptions or results | `sovran.mcp.servers` is `application`-scoped and read from the user value only, so a workspace can never add, change or start a server; servers start only in trusted workspaces. MCP tools exist only in Act mode and **ask before every call in every approval mode**, Auto included, until the user allows that specific tool (Off / Ask / Allow per tool; *Always allow* names the tool from the pending request, never from the webview). The approval card shows the server, the tool and the exact arguments, with invisible characters revealed; the server's annotations are shown as its claims. Tokens are kept in Secret Storage (the webview only receives `hasToken`), passed to the server as a header or environment variable, masked in logs, errors, server output and tool results. Remote servers: redirects are followed only within the same origin. Local servers receive a minimal environment (the SDK's set plus proxy and certificate variables) and what the user lists, not the whole environment of the editor. Descriptions are capped and labelled with their server, schemas over 16 000 characters are replaced, results are capped and truncated, and tool output is treated as data like any other tool result. Stopping a run cancels the call; closing the window stops local servers |
| T19 | Disabled, stale or guessed tools; permissions changed during approval | The runner captures offered definitions for every model request, rejects unoffered or replaced tools, and checks live availability, workspace trust and cancellation before preparation and dispatch, and re-evaluates permission policy after approval. Native disabled/force-Ask settings are user-scoped. Dynamic source name collisions fail closed. Per-chat group exclusions are also checked live at request and dispatch, including pending approvals. Managed MCP profile allowlists filter initial and updated lists and bound direct dispatch independently of Allow. MCP Off is also checked at the dispatch boundary; Ask/Allow changes are evaluated again after approval |
| T20 | Public Web reads reaching private services, bypassing approval or exhausting the extension host | `web_fetch` requires a trusted workspace and approval for each URL in Plan/Act and every approval mode. Preparation does no DNS or HTTP. Every connection validates all resolved addresses, rejects private/special ranges and connects to a validated numeric IP, preserving the original Host and TLS hostname verification. No shared agent, ambient authentication, proxy, cookies or automatic redirects. Robots and pages use the same transport; cross-origin redirects and non-default ports are refused. Bodies are bounded before/after decompression. HTML and robots parsing run in a disposable 128 MB worker with a 5 s timeout; one shared Web job has a 30 s total timeout and at most 8 requests. Live authorization is checked after DNS immediately before socket creation and before returning content |

Native Web is a public GET-only reader. `url` and `max_chars` are its only arguments; the model cannot supply
credentials, arbitrary headers, private-address exceptions or a proxy. It reads robots.txt first (128 KiB cap),
accepts 404/410 as absent, and refuses other failed or unverifiable robots responses. Page bodies have a 1 MiB
encoded and decoded cap, up to three same-origin redirects per resource, no retries and no script/resource loading.
TLS chain and hostname validation remain enabled. Newer hosts add already-trusted OS CAs to Node's default roots
per Web client; Node 20 retains its normal configured trust (including `NODE_EXTRA_CA_CERTS`). No global TLS setting
is changed. VS Code's proxy/credential settings and browser sessions are not used.
HTML extraction is a best-effort reading of returned markup; JavaScript-dependent and authenticated pages may be
unavailable. The worker protects responsiveness and limits parsing resources; it is not an OS sandbox.

URL paths/queries are sent to the approved site, and the page text returned in tool results can be sent to the
configured model and saved as plaintext chat history. There is no separate Web cache or index to clear. Public Web
text is untrusted tool data and cannot authorize tool calls, broaden URL scope or grant future approvals.

Native Git inspection uses structured argv with an explicitly selected workspace repository and working tree.
It disables optional index locks, lazy fetch, replace objects, pagers, fsmonitor, submodule recursion, external diff,
textconv and effective clean/process filters. The executable is resolved outside workspace roots; structured
processes inherit a minimal host environment without ambient Git redirection, credentials or runtime preloads.
Bulk patches omit protected paths and detected protected rename sources; explicit protected-file inspection uses
approval. Paths and revisions have separate contracts, metadata must be complete before parsing, and raw process
output is never streamed to chat or mirrored before filtering. A host Git without `--no-lazy-fetch` is used only for repositories that are not partial clones (no promisor remote or `extensions.partialClone`), checked before every operation; partial clones are refused there.


Native Git index changes and commits are separate execute-risk tools that require one-time approval in Act even in
Auto, independently of command allow-lists or chat edit grants. Approval shows repository, branch, exact selected
paths, bounded change preview and the commit message. Raw-index, HEAD/branch, administrative-directory, configuration
and saved-file fingerprints reject changes during approval. Native writes on a repository are serialized inside
Sovran; executable resolution finishes before a final live authorization/trust/workspace/dirty-buffer check.
Directory-wide selections, implicit stage-all, amend/force and remote/history rewrite arguments are unavailable.

Preparation uses only the read-only Git client and saved bytes; it does not run write-time filters, hooks or signing.
An approved commit additionally forwards the host signing locations `SSH_AUTH_SOCK`, `GNUPGHOME` and `GPG_TTY`;
these names are fixed by trusted code, never model arguments. Ambient Git redirection, runtime preloads and arbitrary
plaintext token variables remain excluded. Actual stage/commit honors configured programs after approval: these have the user's privileges and may modify files
or index, contact services or change the commit content. The warnings describe that boundary. Index changes and
commits do not create a fictitious file checkpoint. Failure, timeout or cancellation can occur after a commit or index
change; results require status/log inspection and never claim automatic rollback. Concurrent external Git changes
and arbitrary hook behavior are not an OS sandbox or a cross-process transaction guarantee.

These are read safeguards for trusted repositories, not an OS sandbox or content classification system. Git metadata
may name protected files; moving/copying secrets into an unprotected path does not make that path protected by history.
A linked worktree's ordinary `.git` file can reference its administrative Git directory outside that worktree.

## Optional managed MCP integrations

Catalog selection has no installation or launch side effect. Explicit installation runs locked npm dependencies with
scripts disabled outside the workspace; explicit Connect starts the component, and enabled entries reconnect in
trusted windows. No browser binary ships in the VSIX. Chrome is resolved from known system locations outside workspace
roots. Managed launch validates the configured hosted endpoint and required headers before loading its credential.
Custom local servers require confirmation of the configured command on Connect. Changing a server's connection in
the UI clears the prior credential and requires a new Connect action.

Browser isolation separates cookies/profile state; it is not a network boundary. Browser tools can reach internal
services, interact with signed-in sites in opted-in extension mode, and initiate downloads. Native fetch's public-IP,
robots and redirect policy does not apply to MCP. Output paths chosen by a tool caller and non-HTTP(S) navigation are
rejected by managed browser profiles; returned local paths are never read automatically. Playwright artifacts persist
separately from chats, with a best-effort eviction threshold rather than a hard quota. DevTools telemetry/CrUX/update
checks are disabled by the managed preset; a custom server has its own behavior. GitHub's default read-only filter is
also enforced by a client allowlist; write profile selection does not grant token scopes or auto-approve tools.

Context7 receives documentation queries at its hosted endpoint. Use public library names and documentation questions
that contain no credentials or private code. The preset offers only library resolution and documentation lookup
with reviewed descriptions. Server schemas and returned documentation still contain untrusted data.

## Known limitations

- An MCP server runs with your privileges and can do whatever its code does: an allowed tool, or a call you approve,
  acts outside Sovran's guardrails and checkpoints. Install servers only from sources you trust, and keep tools that
  change data on *Ask*.
- SOVRAN does **not** sandbox commands. An approved command, or a command that runs in Auto mode, runs with your user's
  privileges and inherits the editor's environment variables.
- Auto-mode guardrails are heuristics over the command text, not a shell interpreter. They catch the common dangerous
  shapes; they cannot see what a script, a build step or a package's install hooks do once they run. Dependency
  installs (`npm install`, `pip install`) and project scripts run in Auto mode. Use Auto only in repositories you trust.
- Enabled read tools are auto-approved except protected paths and tools listed in `sovran.tools.forceAsk`. A model can read any non-protected file in
  the workspace and send it to the configured endpoint. Choose endpoints you trust.
- TLS verification is never disabled. Internal CAs must be trusted by the OS or VS Code
  (`http.systemCertificates`). Corporate proxies use VS Code's `http.proxy` settings.
- Session files are not encrypted at rest.
- Prompt injection cannot be fully prevented at the model level. The controls above limit its impact.
- A converted document can carry text you never saw: white or hidden text, text behind an image, a hidden sheet or
  slide. It reaches the model like the rest of the document (hidden sheets and slides are labelled). Treat documents
  from others like any untrusted file, especially in Auto mode.
