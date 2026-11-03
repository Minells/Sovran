# Changelog

All notable changes to SOVRAN are documented here. Versions follow `major.minor.patch`; odd minor versions are
pre-releases and even minor versions are stable releases.

## Unreleased

### Added
- **Approval modes for Act mode: Ask, Auto-edit and Auto.** Choose them from the composer (<kbd>Alt+A</kbd> cycles), from Settings or with `Sovran: Change Approval Mode…`. Auto edits files and runs commands without asking; turning it on needs a confirmation once per window. New setting `sovran.approvals.mode` sets the mode a window starts in.
- **Guardrails** that always ask, in every mode and for allow-listed commands: recursive deletes, `sudo`, downloaded or hidden scripts (`curl | sh`, `eval`, nested shells), pushes, publishing, infrastructure changes, network uploads, credential stores, environment dumps, system services, global installs, protected files, and paths outside the workspace. The approval card says why Auto mode still asks.
- **"auto" badge** on every file change or command that ran without asking, with the reason (Auto mode, Auto-edit, allowed command).
- **Always allow…** on command approvals: run the command and add its prefix (for example `npm test`) to the allowed commands, after reviewing exactly what will be allowed.
- **Sovran Settings** in the panel, opened from the gear in the view title: Act and Plan models, providers, approval mode for this window and for new windows, allowed commands, protected files, limits and context options.
- **Guided setup** in three steps (choose, connect, model): Sovran saves the provider, asks for a key when needed, tests the connection and offers the models the server reports.
- The status bar shows `auto-edit` or `auto` when Act mode runs unattended.

### Security
- Provider requests no longer follow HTTP redirects. A redirect could forward a custom auth header (`api-key`) and the request body to another origin.
- The active file is attached only when it is inside the workspace and not protected. Previously a file opened from outside the workspace (for example `~/.aws/credentials`) was attached automatically.
- `@` mentions and attached files are verified through `realpath`, so a symbolic link cannot attach a file from outside the workspace.
- Path verification fails closed when something exists but cannot be resolved (a broken symbolic link).
- Untrusted content can no longer close its `<tool_result>`, `<file>` or `<context>` wrapper in the prompt.
- Allow-listed commands that trip a guardrail now ask (for example `git push` when `git` is allowed).
- `sovran.terminal.mirrorToTerminal` is user-scope only, so a workspace cannot hide the command mirror.
- Agent commands no longer inherit `ELECTRON_RUN_AS_NODE` from the extension host.

### Changed
- Settings are grouped into *Models*, *Approvals & Safety*, *Agent*, *Context* and *Chats* in the VS Code Settings editor. `sovran.approvals.fileEdits` is deprecated in favor of `sovran.approvals.mode` and is still honored when the new setting is unset.
- The view title shows New Chat, History and Settings; providers, approvals and logs moved to the `…` menu.
- The chip for a file Sovran does not share now says so instead of looking included.
- The loop guard compares tool arguments structurally, so whitespace or key order no longer hide a repeated failure.
- Provider presets are a proper list of buttons for screen readers.
- **New Sovran brand**: `[•]` symbol, lowercase wordmark and the motto "Own your intelligence.". New Marketplace icon and banner, and an Activity Bar icon in `currentColor`.
- **Minimal restyle**: surfaces, text and borders follow the VS Code theme. A single accent (`#FF5A36`) marks the primary action and active states as the logo's dot. Gradients and the separate Plan/Act colors are removed.
- **Status bar**: shows `sovran · <model> · <local | host>` with the logo glyph, so it is clear where requests go.

### Added
- **Exploration rows** group consecutive file reads and searches (*Explored · 3 files read, 1 search*).
- **"Latest" / "Approval needed" pill** appears when you scroll away from the end of a running conversation.
- **Keyboard hints** appear under the composer while it is focused.
- **Undo changes.** Each response that edits files records a checkpoint, and one click restores the pre-response state. The prompt protects files you changed afterwards, and the restore is itself undoable.
- **Retry, edit and resend.** Rewind the conversation, optionally undoing file changes from the discarded responses.
- **Conversation compaction.** Older turns are summarized when the context is full (`sovran.context.autoCompact`), or on demand with `/compact` or the context meter.
- **Context meter** in the composer, using an estimate first and then the token count reported by the server.
- **`@` file mentions** with fuzzy search, and **`/` slash commands** (built-in, plus `.sovran/commands/*.md` in trusted workspaces).
- **Separate Plan-mode model** (`sovran.planModel`).
- **ripgrep search** through VS Code's bundled binary. It respects `.gitignore` and excludes protected paths, which are filtered again in core.
- `SOVRAN: Compact Conversation` command.

## 0.1.0 — Preview

First preview release.

### Agent
- An agent loop with streaming, tool calling, an iteration cap, a loop guard and cancellation.
- Plan mode (read-only by construction) and Act mode (edits and commands with approval).
- Ten built-in tools: read, list, find and search files; workspace and editor context; write, edit and multi-edit files; run terminal commands.
- Edits use exact search/replace with CRLF preservation, a staleness check and undoable `WorkspaceEdit` writes.

### Providers
- Multiple OpenAI-compatible providers and models, with bearer or custom-header auth stored in Secret Storage.
- Automatic fallback to prompted tool calling when a server rejects native tools, remembered per model.
- Tolerant handling of non-streaming responses, `reasoning_content`, `<think>` and `<tool_call>` text.
- Connection test, model discovery, actionable error messages and timeouts.

### Experience
- An Activity Bar view with transcript, inline approvals, native diff review and a command terminal mirror.
- Context chips for the active file or selection and for attached files; native model Quick Pick; status bar item.
- Persistent, searchable chat history with rename and delete.
- Themed through VS Code tokens (dark, light and high contrast), with full keyboard support.

### Security
- Security settings are read from user scope only, and paths are confined to the workspace (symlink-aware).
- Protected paths, a command allow-list that rejects shell metacharacters, and a warning for invisible or bidi characters in commands.
- Strict CSP, markdown rendered with `html:false` plus DOMPurify, and zod-validated webview messages.
