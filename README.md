<p align="center">
  <img src="media/brand/sovran-banner-dark.png" alt="Sovran — Own your intelligence.">
</p>

<p align="center">An agentic AI coding assistant for VS Code that runs on the models <em>you</em> control:<br>
local, self-hosted, or behind your company's AI gateway.</p>

<p align="center">
  <img src="media/screenshots/conversation-dark.png" width="380" alt="Sovran proposing an edit and waiting for approval">
  &nbsp;
  <img src="media/screenshots/conversation-light.png" width="380" alt="Sovran in a light theme">
</p>

> **Status: preview (0.1).** The core engine, tools, UI and security controls are implemented and covered by automated
> tests. Real-world compatibility testing against every server type is ongoing. See [Known limitations](#known-limitations).

---

## Why Sovran

Most AI coding tools assume a specific vendor, a cloud account or a separate editor. Sovran assumes none of that.

- **Your models.** Sovran works with any OpenAI-compatible Chat Completions endpoint, including Ollama, LM Studio, vLLM, LiteLLM, llama.cpp, LocalAI and internal gateways.
- **Your infrastructure.** The extension talks directly to your endpoint. There is no Sovran server, no account and no telemetry.
- **Your code.** Nothing leaves your machine except the requests you send to endpoints you configured.
- **Your control.** By default every file change is previewed in VS Code's diff editor and every command needs your approval. When you trust the task, Auto-edit and Auto hand over more, while guardrails in code still stop risky actions. Plan mode is read-only by construction, not by prompt.

## Features

**A real agent, not a chat box.** Sovran runs a full agent loop:

1. It reads and searches the workspace.
2. It proposes edits and runs commands.
3. It reads the results and continues until the task is done, with a step limit, a loop guard and cancellation at any time.

It works through ten built-in tools:

| Tool | What it does |
|---|---|
| `read_file` | Reads a file or a line range of it |
| `list_directory` | Lists the contents of a folder |
| `find_files` | Finds files by glob pattern |
| `search_files` | Searches file contents for text or a regular expression |
| `get_workspace_info` | Reports the workspace layout, OS, shell and git branch |
| `get_active_editor_context` | Reads the open file, selection, tabs and diagnostics |
| `write_file` | Creates a new file or replaces one |
| `edit_file` | Replaces one exact piece of text in a file |
| `apply_diff` | Applies several exact edits to one file at once |
| `execute_terminal` | Runs a shell command after you approve it |

**Plan and Act modes.**

| | Plan | Act |
|---|---|---|
| Read & search the workspace | ✓ | ✓ |
| Produce a structured plan | ✓ | ✓ |
| Edit files | ✗ (tools are not even offered) | ✓ (see approvals below) |
| Run commands | ✗ | ✓ (see approvals below) |

**Approvals in Act mode: Ask, Auto-edit and Auto.** Pick how much Sovran may do without asking from the composer
(<kbd>Alt+A</kbd> cycles), from Settings or with `Sovran: Change Approval Mode…`:

| | Ask (default) | Auto-edit | Auto |
|---|---|---|---|
| File changes | Diff review for each | Applied without asking | Applied without asking |
| Commands | Approve each (allowed commands run directly) | Approve each | Run without asking |
| Protected files, risky commands | Ask | Ask | **Still ask** |

Auto works like Claude Code's auto-accept, with guardrails enforced in code: commands that delete recursively, push or
force-push, publish, use `sudo`, run downloaded or hidden scripts, reach the network, read credentials or touch paths
outside the workspace always stop for you, and so do protected files. The card says why. Everything that ran without
asking carries an *auto* badge, and each response can still be undone with **Undo changes**. Turning Auto on asks for
confirmation once per window, and new windows start in the mode set by `sovran.approvals.mode` (Ask by default).

<p align="center">
  <img src="media/screenshots/approval-modes-dark.png" width="320" alt="The approvals menu with Ask, Auto-edit and Auto">
  &nbsp;
  <img src="media/screenshots/auto-mode-dark.png" width="320" alt="Auto mode: edits and tests ran without asking, a push still asks">
</p>

On a command card, **Always allow…** adds the command's prefix (for example `npm test`) to your allowed commands after
showing you exactly what will be allowed.

The current mode is always visible in the composer and the status bar.

**Built for imperfect servers.** "OpenAI-compatible" covers a wide range of behavior, so Sovran detects what each model supports:

- **Rejected tool definitions:** when a server rejects native tool calling, Sovran switches that model to a prompted tool protocol automatically and remembers it.
- **Unusual response formats:** it handles servers that ignore streaming and models that emit `<tool_call>` or `<think>` tags as text.
- **Reasoning output:** reasoning streams (`reasoning_content`) are shown separately and never sent back to the model.

Errors tell you what went wrong and how to fix it.

**Native to VS Code.** Proposed edits open in the native diff editor and are applied as undoable edits (Ctrl+Z works). Commands are mirrored in a Sovran terminal. Other native touches:

- The model picker is a Quick Pick, and the status bar shows the model and mode.
- The UI follows your theme, including high contrast.
- Keyboard first: <kbd>Enter</kbd> sends, <kbd>Shift+Enter</kbd> adds a newline, <kbd>Esc</kbd> stops, <kbd>Alt+M</kbd> switches mode, <kbd>Alt+A</kbd> cycles approvals. A hint line under the composer shows what the keys do right now, and **Shortcuts** lists them all.
- **A start page for every chat:** the model and where it runs, the current mode, starters built from the active file or selection, your latest chats and a tip.
- **Settings in the panel.** The gear in the view title opens Sovran Settings: Act and Plan models, providers, approvals, allowed commands, protected files, limits and context options, without editing JSON.

**Context you can see.** The active file or selection is attached as a chip you can toggle. Files outside the workspace and protected files are never attached automatically, and their chip says so. The paperclip opens the **attach menu**: search the workspace, pick a suggested file (the active editor and open tabs), browse folders from the workspace root, or **upload from your computer** through the system file dialog. Protected files ask before they are attached, and binary files are refused. Large files are paged and long conversations are trimmed to the model's context window.

<p align="center">
  <img src="media/screenshots/start-dark.png" width="320" alt="The start page of a new chat: model, mode, starters and recent chats">
  &nbsp;
  <img src="media/screenshots/attach-dark.png" width="320" alt="The attach menu with suggested files, the workspace folders and Upload from computer">
</p>

**Conversations that persist.** Chats are saved per workspace and restored after restart, and you can search, rename or delete them.

**Mistakes are cheap to undo.** Every response that changed files ends with a footer: *2 files changed · Undo changes*. Undo puts every file back the way it was before that response and deletes files the agent created. If you edited a file afterwards, Sovran asks before overwriting it.
- **Retry** generates a response again. It sits next to **Copy** under the last response and appears when you hover it or reach it with the keyboard.
- **Edit** (pencil on any message) rewrites a message and continues from there, and can undo the file changes of the discarded responses too.

**You can see the context window.** A meter in the composer shows how full the model's context is. When it fills up, Sovran **summarizes older messages** instead of silently forgetting them. The full transcript stays visible to you. You can also summarize on demand with `/compact` or by clicking the meter.

**`@` files and `/` commands.**
- **`@`:** type `@` to fuzzy-find a workspace file and attach it.
- **Built-in commands:** type `/` for `/explain`, `/fix`, `/test`, `/review`, `/doc`, `/compact` and `/new`.
- **Your own commands:** add Markdown files to `.sovran/commands/` (for example `.sovran/commands/release-notes.md`, using `$ARGUMENTS` for the text you type after the command). They load only in trusted workspaces.

<p align="center"><img src="media/screenshots/slash-commands-dark.png" width="320" alt="Slash command suggestions"></p>

**A model for each mode.** Plan can use a larger reasoning model while Act uses a fast coder. In Plan mode, pick the model from the composer, or choose *Same as Act model*.

## Installation

From the VS Code Marketplace (once published): search for **Sovran** in the Extensions view.

From a VSIX file:

```bash
code --install-extension sovran-0.1.0.vsix
```

Requires VS Code 1.95 or later.

## Quick start

1. Click the **Sovran** icon in the Activity Bar. A three-step setup opens.
2. **Choose** where your model runs: Ollama, LM Studio, vLLM, LiteLLM or a **custom endpoint** such as your company gateway.
3. **Connect**: check the URL and authentication. If the endpoint needs a key, VS Code asks for it in a secure input. Keys are stored in VS Code Secret Storage, never in settings. Sovran tests the connection right away.
4. **Choose a model** from the ones the server reports (or type its ID) and start chatting.

Everything else (a separate Plan model, more providers, approvals and limits) lives behind the gear in the view title.

<p align="center">
  <img src="media/screenshots/onboarding-dark.png" width="320" alt="Guided setup with provider presets">
  &nbsp;
  <img src="media/screenshots/settings-dark.png" width="320" alt="Sovran Settings in the panel">
</p>

## Provider setup examples

Providers live in your **user** settings (`sovran.providers`). Workspace settings are ignored for security; see [Security](#security). The guided setup and **Settings → Manage providers** write these entries for you; the examples below are for reference and for advanced options such as extra headers.

**Ollama (local)**
```jsonc
{ "id": "ollama", "name": "Ollama", "baseUrl": "http://localhost:11434/v1",
  "auth": { "type": "none" }, "models": [{ "id": "qwen2.5-coder:14b", "contextWindow": 32768 }] }
```

**LM Studio (local)**
```jsonc
{ "id": "lmstudio", "name": "LM Studio", "baseUrl": "http://localhost:1234/v1", "auth": { "type": "none" },
  "models": [{ "id": "your-loaded-model" }] }
```

**vLLM on a GPU server**
```jsonc
{ "id": "vllm", "name": "GPU cluster", "baseUrl": "https://vllm.internal.example/v1",
  "auth": { "type": "bearer" }, "timeoutSeconds": 300,
  "models": [{ "id": "my-coder", "contextWindow": 131072, "toolMode": "native" }] }
```
For native tool calling, start vLLM with tool parsing enabled (for example `--enable-auto-tool-choice --tool-call-parser <parser>`). Otherwise use `"toolMode": "prompted"`.

**Enterprise gateway with a custom auth header**
```jsonc
{ "id": "corp", "name": "Company AI Gateway", "baseUrl": "https://ai-gateway.example.com/v1",
  "auth": { "type": "header", "headerName": "api-key" },
  "headers": { "X-Team": "platform" },
  "models": [{ "id": "coder-large", "contextWindow": 128000 }] }
```

### Model options

| Field | Meaning |
|---|---|
| `contextWindow` | Tokens the model accepts. Sovran never guesses; the default is 32 768 |
| `maxOutputTokens` | Reserved for the reply (default 4 096) |
| `toolMode` | `auto` (detect, the default), `native`, `prompted` or `none` |
| `temperature` | Sent only when set |

## Settings

| Setting | Default | Description |
|---|---|---|
| `sovran.providers` | `[]` | Model endpoints. User scope only |
| `sovran.defaultModel` | `""` | `providerId/modelId` for new chats (the Act model) |
| `sovran.planModel` | `""` | Model for Plan mode. Empty means the same as Act |
| `sovran.agent.maxIterations` | `25` | Maximum model round-trips per request |
| `sovran.approvals.mode` | `ask` | Approval mode a new window starts in: `ask`, `edits` (Auto-edit) or `auto`. User scope only |
| `sovran.approvals.allowedCommands` | `[]` | Commands that run without asking, for example `npm test`. Never applies to commands that contain shell operators or trip a guardrail |
| `sovran.security.protectedPaths` | `.env`, keys, `.git/` and others | Always ask before reading, changing or naming these in a command, in every mode. Their contents are excluded from search |
| `sovran.terminal.timeoutSeconds` | `120` | Command timeout |
| `sovran.terminal.mirrorToTerminal` | `true` | Show command output in a Sovran terminal |
| `sovran.context.includeActiveEditor` | `true` | Attach the active file or selection by default |
| `sovran.context.maxToolResultChars` | `20000` | Size cap for each tool result sent to the model |
| `sovran.context.autoCompact` | `true` | Summarize older messages when the context window is full |
| `sovran.context.projectInstructions` | `true` | Use `AGENTS.md` from the workspace root (trusted workspaces only) |
| `sovran.sessions.persist` | `true` | Save chats in VS Code workspace storage |
| `sovran.diff.openOnProposal` | `true` | Open the diff editor automatically for proposed edits |
| `sovran.approvals.fileEdits` | `ask` | *Deprecated*: use `sovran.approvals.mode`. `auto` here still starts windows in Auto-edit |

All of these can be changed from **Sovran Settings** (the gear in the view title); the VS Code Settings editor groups them under *Models*, *Approvals & Safety*, *Agent*, *Context* and *Chats*.

## Security

Sovran executes actions on your behalf, so its safety controls are enforced in code rather than in the prompt:

- **Credentials:** API keys stay in Secret Storage and in the extension host. They are never sent to the UI and are redacted from logs and errors.
- **Approvals:** in Ask mode every file write is reviewed in a diff and checked for changes made while it waited, and every command is previewed with warnings about risky patterns and invisible characters. Auto-edit and Auto skip those questions, but protected files and risky commands still ask, and the transcript marks what ran unattended.
- **Endpoints:** requests never follow redirects, so your key and code only go to the address you configured. A key sent over plain `http` to another machine is flagged in the UI.
- **Workspace boundary:** paths are confined to the workspace, including through symlinks. Commands run inside the workspace with a timeout and can be cancelled.
- **Untrusted repositories:** a cloned repository cannot change your providers, approval policy or allow-list, because those settings are read from user scope only. In Restricted Mode, Sovran stays in Plan mode.

Read [SECURITY.md](SECURITY.md) for the threat model and known limitations. Choose endpoints you trust: everything the agent reads is sent to the model you configured.

## Known limitations

- **Quality depends on the model.** Tool-trained coding models work best. Small models may need `"toolMode": "prompted"`, and some still struggle with multi-step tasks.
- **Undo covers only what the agent writes.** Changes made by terminal commands, such as code generators or `git checkout`, are not covered.
- **No MCP support yet** (planned in v0.3).
- **Search uses VS Code's bundled ripgrep.** It falls back to a slower built-in scan when ripgrep cannot be found.
- **Long-running commands time out.** Watchers and dev servers are not supported as agent commands.
- **Session files are plaintext.** They are not encrypted at rest.
- **Not yet verified on every server.** Compatibility is covered by mocked-server tests, and the real-server compatibility matrix is still being run. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

## Development

```bash
npm install
npm run build
npm run check
```

`npm run check` runs typecheck, lint and tests. Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the architecture, the UI dev harness and the testing strategy, and [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Documentation: [Architecture](docs/ARCHITECTURE.md) · [Product requirements](docs/PRODUCT_REQUIREMENTS.md) · [Roadmap](docs/ROADMAP.md) · [Decisions](docs/DECISIONS.md) · [Releasing](docs/RELEASING.md)

## License

Sovran is released under the [MIT License](LICENSE). Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
