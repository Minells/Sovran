# Changelog

All notable changes to SOVRAN are documented here. Versions follow `major.minor.patch`; odd minor versions are
pre-releases and even minor versions are stable releases.

## Unreleased

### Added
- **Chats in editor tabs.** **Open Chat in Editor** (the arrow icon in the view title) moves the view's chat into an editor tab and starts a new chat in the view; **New Chat in Editor** opens more. Chat tabs open beside your code and stay together in one group, are titled after the chat, and come back with the same chat after a restart. Each chat runs on its own, so chats in different tabs work **in parallel**. The view's chat list shows which chats are working, waiting for approval or open in a tab; selecting one focuses its tab, and each item can be opened in a tab.
- **Approval bar above the chat input.** A pending action is decided in a quiet card right above the input, where your eyes already are; it never scrolls away and takes the place of the run status line. **Reject** and **Apply / Run / Allow** sit on the right, and Apply uses VS Code's own button colours. <kbd>Enter</kbd> approves and <kbd>Esc</kbd> rejects, from the empty chat input or anywhere in the chat; text being typed, menus and focused buttons keep their keys, and Enter only counts once the bar has been on screen for 0.4 s. The bar also holds *Reject with feedback…*, *Always allow…* and *Apply future edits in this chat without asking*; commands, warnings and the reason Auto mode still asks are shown there in full.
- **Apply and Reject on the proposal's diff editor**, and <kbd>Ctrl+Enter</kbd> (<kbd>Cmd+Enter</kbd>) there to apply. Also `Sovran: Apply Proposed Change` and `Sovran: Reject Proposed Change`.
- **Your message stays pinned while you read its answer.** Scrolling through a conversation keeps the message that started the answer in view at the top (two lines, select it to go back to it), and the next message pushes it out as it arrives, so where each answer starts and ends is always clear.
- **Readable diffs in the chat:** line numbers, long lines wrapped instead of scrolled sideways, the first 80 lines with *Show N more lines*, and *Open diff editor*.
- **Model limits from the server.** When a model has no `contextWindow`, Sovran uses the window the server reports (vLLM/SGLang `max_model_len`, OpenRouter, LiteLLM `/model/info` and other common fields), else 32 768. A reported maximum output caps the reply reserve. Limits are read when testing a connection, discovering models, at start-up and for new providers.
- **Context window and max output per model in the panel**, next to the tool mode; empty fields show the value and its source (*server* or *default*), and Settings shows the limits of the selected model. Both were already available in `config.yaml` and settings.
- **`config.yaml` and Settings stay in sync both ways.** Saving the file updates Settings; changing providers in the panel (or the model you pick) updates the file, keeping its comments and formatting. A new file starts with the providers you already have. **Stop using config.yaml…** goes back to Settings only, keeping the file (ignored, `sovran.configFile.enabled`) or moving it to the trash; **Use config.yaml again** joins both sides. Sovran never writes into a file with problems or unsaved editor changes.
- **Clear authentication errors.** A 401/403 now says what the request carried (no key stored, the key as `Authorization: Bearer`, or the key in a custom header). Keys pasted with a `Bearer ` prefix, an `Authorization:` header name or quotes are cleaned up. The connection test checks chat directly when a gateway refuses `/models` to the key.
- **Configuration file `~/.sovran/config.yaml`** as an alternative to the panel: describe providers and models in YAML (same fields as `sovran.providers`, plus shorthands such as `auth: none` and plain model ids) and save. Sovran applies the file at once, connects to new or changed providers and asks for missing keys. Problems are underlined in the editor with fix hints, and the last valid version stays in use. Optional `defaultModel`, `planModel` and `titleModel` select models when the file changes. Open it from **Settings → Models**, the guided setup, the providers page or `Sovran: Open Model Config File`.
- **Chat titles written by the model** (on by default, `sovran.sessions.generateTitles`): a short title in the user's language, generated while the answer streams, optionally by a dedicated small model (`sovran.sessions.titleModel`). Falls back to the first words of the message on any failure, and never replaces a title the user set.
- **New start page** for every chat: the animated `[•]` mark, what Sovran is connected to (workspace, model, and whether it runs on this machine), the current mode, four starters built from the active file or selection, the three latest chats and a tip. The layout centres in tall sidebars and switches to one column in narrow ones; motion stops with *reduce motion*.
- **Attach menu** on the paperclip: search workspace files, pick from suggestions (active editor and open tabs), browse folders from the workspace root (protected files are marked), or **upload from your computer** with the system file dialog. Files toggle, so several can be added in a row; fully keyboard operable.
- **Keyboard shortcuts popover** under the composer, listing every shortcut including the global ones.
- **Copy response** button under each response.
- **Approval modes for Act mode: Ask, Auto-edit and Auto.** Choose them from the composer (<kbd>Alt+A</kbd> cycles), from Settings or with `Sovran: Change Approval Mode…`. Auto edits files and runs commands without asking; turning it on needs a confirmation once per window. New setting `sovran.approvals.mode` sets the mode a window starts in.
- **Guardrails** that always ask, in every mode and for allow-listed commands: recursive deletes, `sudo`, downloaded or hidden scripts (`curl | sh`, `eval`, nested shells), pushes, publishing, infrastructure changes, network uploads, credential stores, environment dumps, system services, global installs, protected files, and paths outside the workspace. The approval card says why Auto mode still asks.
- **"auto" badge** on every file change or command that ran without asking, with the reason (Auto mode, Auto-edit, allowed command).
- **Always allow…** on command approvals: run the command and add its prefix (for example `npm test`) to the allowed commands, after reviewing exactly what will be allowed.
- **Sovran Settings** in the panel, opened from the gear in the view title: Act and Plan models, providers, approval mode for this window and for new windows, allowed commands, protected files, limits and context options.
- **Guided setup** in three steps (choose, connect, model): Sovran saves the provider, asks for a key when needed, tests the connection and offers the models the server reports.
- The status bar shows `auto-edit` or `auto` when Act mode runs unattended.

### Fixed
- Scrolling the chat while Sovran streams or waits for approval: the conversation no longer animates every streamed chunk (which fought the mouse wheel), and diffs no longer have their own scroll area that caught the wheel. A new proposal that is taller than the view is shown from its start.
- The approval buttons can no longer end up below a long diff or be folded away with the tool row.
- <kbd>Esc</kbd> in the empty chat input rejects a pending action instead of stopping the whole run (the Stop button still stops it).
- A removed line that starts with `-- ` (an SQL or Lua comment) was hidden from diffs in the chat.

### Security
- Dependency install scripts are denied in `allowScripts` (none is needed: esbuild, vsce-sign, ttf2woff2, es5-ext), which silences npm 12's warning, and CI installs with `--ignore-scripts` to check the same setup.
- Development tooling: `minimatch` and `glob` are overridden to their patched majors (GHSA-g3hv-75wg-m249, GHSA-3g3m-2fjr-6pw4), until ESLint, typescript-eslint, vsce and fantasticon accept them. `npm audit` reports no vulnerabilities and the `glob` deprecation warnings are gone. The extension itself was not affected: none of these packages ships in the VSIX.
- Attaching a file that matches `sovran.security.protectedPaths` asks for confirmation first, whether it comes from `@`, the attach menu or the file dialog.
- Files outside the workspace can be attached only through the system file dialog that the extension host opens; a path sent by the webview is still confined to the workspace.
- Provider requests no longer follow HTTP redirects. A redirect could forward a custom auth header (`api-key`) and the request body to another origin.
- The active file is attached only when it is inside the workspace and not protected. Previously a file opened from outside the workspace (for example `~/.aws/credentials`) was attached automatically.
- `@` mentions and attached files are verified through `realpath`, so a symbolic link cannot attach a file from outside the workspace.
- Path verification fails closed when something exists but cannot be resolved (a broken symbolic link).
- Untrusted content can no longer close its `<tool_result>`, `<file>` or `<context>` wrapper in the prompt.
- Allow-listed commands that trip a guardrail now ask (for example `git push` when `git` is allowed).
- `sovran.terminal.mirrorToTerminal` is user-scope only, so a workspace cannot hide the command mirror.
- Agent commands no longer inherit `ELECTRON_RUN_AS_NODE` from the extension host.

### Fixed
- `config.yaml` saved with another program is applied within about two seconds on every system: file watching misses or delays changes to a file outside the workspace that no editor has open (Linux, macOS), so Sovran also checks the file's date and size.
- A repeated or late file event, Sovran's own write or Reload no longer undoes a provider just changed in Settings: the sync now decides by content whether the file changed. If both change at the same moment, the file's hand edit wins and Sovran says so.
- Emptying a limit in the provider form now removes it (it used to keep the old value).
- Learning that a model needs prompted tools no longer drops what else Sovran learned about it.

### Changed
- The sidebar shows **Sovran** instead of *Sovran: Agent*: the view is named like its container, which VS Code then shows once. `Sovran: Focus Agent` is now `Sovran: Focus Panel`.
- **"API key" is the labelled default authentication** (sent as `Authorization: Bearer <key>`, the OpenAI standard), listed first and explained in the form; providers using a custom header show it on their card.
- **Chat titles are written by the model by default**, with room for models that always reason (GLM, DeepSeek-R1); turn it off in Settings.
- Build: the Vite and Vitest configs are ESM (`.mts`), which removes Vite's `configLoader` warning without making the CommonJS extension bundle an ES module. The webview bundle has a 650 kB size budget instead of Vite's 500 kB default for network-loaded pages: it is read from local disk, and the budget still warns about accidental heavy imports.
- **Settings areas are tabs.** *Models*, *Approvals*, *Agent*, *Context* and *Data* stay at the top; the selected area is larger and highlighted, and only its settings are shown. Arrow keys, Home and End move between areas, and Settings reopens on the last area. In narrow sidebars the other areas shrink to their icon.
- **Retry** under the last response is now a quiet icon that appears on hover or keyboard focus, next to Copy. Errors keep their visible Retry button.
- `@` with nothing typed yet suggests the active editor and open tabs first.
- Binary files and files larger than 5 MB are refused with a notice when attached, instead of being sent as unreadable text.
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
- **Keyboard hints** under the composer, on one line that follows what the keys do right now (send, choose a suggestion, stop). It is always shown, so focusing the composer no longer shifts the layout.
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
