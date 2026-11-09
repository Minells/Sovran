# Changelog

All notable changes to SOVRAN are documented here. Versions follow `major.minor.patch`; odd minor versions are
pre-releases and even minor versions are stable releases.

## Unreleased

### Added
- Optional integration catalog for Playwright MCP, Chrome DevTools MCP and GitHub MCP. Selecting a card has no
  installation/launch effect; managed entries start disconnected, install reviewed locked packages on demand, then
  connect separately. Custom commands, remote servers, JSON import, saved tokens and tool policies are preserved.
- Native `web_fetch`: one public HTTP(S) URL, readable HTML/text/Markdown/JSON and source links, with explicit approval
  in trusted Plan/Act even in Auto. Direct IP-bound connections, same-origin redirects, robots checks, bounded
  compressed/decoded bodies, cancellation and an isolated HTML/robots worker. No Crawlee, browser, global search,
  login, persistent Web index or automatic background requests.
- Native `get_diagnostics`: cached VS Code Problems for the active file or all workspace roots, with literal
  file/directory, severity and result-count filters. Read-only in Plan/Act, bounded by the result-size setting, with
  protected/external/unverifiable paths omitted. No documents opened, language providers invoked or checks run.
- Controlled `git_stage`, `git_unstage` and `git_commit`: individual saved-file selections, repository/branch/file and
  commit-message previews, mandatory approval in every mode, stale-index/HEAD/config/content checks and final runtime
  authorization before spawning Git. Hooks, filters and signing remain explicit privileged effects without checkpoint
  undo; failed or cancelled actions ask users to inspect status before retrying.
- Read-only native Git tools: `git_status`, `git_diff`, `git_log`, `git_show` and `git_branches`, available in trusted
  Plan/Act workspaces. Explicit repository selection, literal argv/pathspecs, protected-content filtering, paging,
  bounded process execution and worktree support require no Git MCP server or network access.
- Native tool controls in **Settings → Agent**: disable tools or always review them, including reads in Auto mode.
  The user settings are `sovran.tools.disabled` and `sovran.tools.forceAsk`.
- Project presentation: official website links, a concise README with a preserved full user guide, community standards,
  issue and pull request templates, dependency update configuration, and clearer security reporting instructions.
- **MCP servers.** Connect Model Context Protocol servers in the new **Settings → MCP** area and the agent can use their tools in Act mode. Local servers are commands Sovran starts (stdio); remote servers are reached over Streamable HTTP. Add one from a common server (Filesystem, Git, Fetch, GitHub), with the form, or by pasting the JSON snippet from its README (Claude Desktop, Cursor, Cline and VS Code formats; a token in it moves to Secret Storage). Tokens are kept in VS Code Secret Storage and sent as a bearer token, in a header or as an environment variable; `${workspaceFolder}`, `${userHome}` and `${env:NAME}` are expanded. Each server card shows its status (with the reason and *Try again* when it is not connected), its tools with what the server says about them (*read-only*, *can change data*), an estimate of the context they cost, and an **Off / Ask / Allow** choice per tool. Every MCP tool asks before it runs, in every approval mode, until you allow it, also with **Always allow** on the approval card, which shows the tool, its server and the exact arguments. The list is the user setting `sovran.mcp.servers`; servers start only in trusted workspaces and stop with the window. Built on the official MCP TypeScript SDK (`@modelcontextprotocol/client` v2).
- **Images for vision models.** Paste a screenshot into the chat input or attach a PNG, JPEG, WebP or GIF file (up to 8 per message, 8 MB each): the model receives each image after a label with its name and size, then your question. Whether a model accepts images is found out automatically: a refusal from the server makes Sovran remember the model as text-only, say so and retry with the images' names. The new model option `vision` (`true` or `false`, in Settings and `config.yaml`) decides it explicitly. Images are stored with the chat in the workspace storage (in memory when chats are not persisted), never in the chat file or the webview, and deleted with the chat. Chips show the image's type and size; images from the workspace open in VS Code's image preview.
- **`read_file` reads documents.** The agent can read PDF, Word, Excel, PowerPoint and OpenDocument files in the workspace as Markdown and page through them by line, through the same isolated converter and cache as attachments. It decodes UTF-16 text, and tells the model to ask for an image to be attached instead of returning its bytes.
- **Documents as attachments.** PDF, Word (`.docx`), Excel (`.xlsx`), PowerPoint (`.pptx`), OpenDocument (`.odt`, `.ods`, `.odp`) and ZIP files can be attached; Sovran converts them to Markdown on your machine and tells the model what each one is (*PDF document, 12 pages*) and that images and layout are not included. Headings, lists, tables, links, every sheet and slide, speaker notes and Excel dates are kept; tracked deletions, comments and duplicated text-box copies are left out. A ZIP is listed, not extracted. The conversion runs in a separate worker thread with a memory limit and a 60-second timeout, and a converted file is reused until it changes. UTF-16 text files with a byte-order mark are read too. Images, audio, video, old binary Office files and other archives are refused with a message that says what to do instead.
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
- Recheck native tool permissions, trust, workspace scope and unsaved-file state at delayed Git process dispatch.
- Remove the basic Git MCP shortcut now that native inspection and controlled writes are available, preserving saved
  servers, custom forms and import workflows.
- Tool calls must use the definitions offered in that model request and remain enabled at execution. Sovran checks
  workspace trust and permissions after approvals, rejects ambiguous dynamic names and stale definitions, and
  rechecks MCP Off / Ask / Allow before dispatch.
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
