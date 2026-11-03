# SOVRAN Product Requirements

**Vision:** *Own Your Intelligence.* SOVRAN is a first-class agentic coding experience in VS Code, powered by models you
control.

## Personas

| Persona | Context | Primary need |
|---|---|---|
| **Indie / privacy-minded developer** | Ollama or LM Studio on a workstation GPU | A capable agent without sending code to a third party |
| **Enterprise developer** | An internal LLM gateway (LiteLLM, Azure-style, custom) behind a proxy, with an internal CA | A tool that works with the company endpoint and passes security review |
| **Platform / ML engineer** | Runs vLLM or TGI on a GPU cluster | Validates their deployment with a real coding workload and per-model tuning |

## Functional requirements

IDs are referenced by tests and the roadmap. **P0** is required for v0.1 (preview). **P1** is targeted for v0.1. **P2** comes later.

### Providers and models
| ID | Requirement | P |
|---|---|---|
| FR-P1 | Configure multiple OpenAI-compatible providers (name, base URL, auth type, models) | P0 |
| FR-P2 | Store API keys only in SecretStorage. Support bearer and custom-header auth | P0 |
| FR-P3 | Test the connection with latency, model count and an actionable error | P0 |
| FR-P4 | Discover models through `GET /models`, with a manual list as fallback | P0 |
| FR-P5 | Select a model from the composer, a native Quick Pick and the status bar | P0 |
| FR-P6 | Per-model tool mode (`auto/native/prompted/none`), context window and max output | P0 |
| FR-P7 | Automatically downgrade to prompted tools when native tools are rejected, and tell the user | P0 |
| FR-P8 | Streaming with non-streaming fallback. Display reasoning separately | P0 |
| FR-P9 | Provider presets (Ollama, LM Studio, vLLM, LiteLLM, Custom) as form templates only | P1 |

### Conversation
| ID | Requirement | P |
|---|---|---|
| FR-C1 | Streamed markdown with syntax-highlighted code and copy and insert actions | P0 |
| FR-C2 | Enter sends, Shift+Enter inserts a newline. Esc or the Stop button cancels | P0 |
| FR-C3 | New, list, open, rename and delete sessions. Persist and restore after restart | P0 |
| FR-C4 | Context chips: active editor or selection (toggle), attached files (Quick Pick) | P0 |
| FR-C5 | Empty, loading, error, no-provider and untrusted-workspace states are all designed | P0 |
| FR-C6 | A "Ask SOVRAN about selection" command in the editor context menu | P1 |

### Agent
| ID | Requirement | P |
|---|---|---|
| FR-A1 | Agent loop with tool calling, iteration cap, loop guard, cancellation and timeouts | P0 |
| FR-A2 | Plan mode is read-only by construction. Act mode allows write and exec with approvals | P0 |
| FR-A3 | The ten built-in tools from ARCHITECTURE §6, with schema validation | P0 |
| FR-A4 | Edits previewed in the native diff editor. Approve or reject inline. Undo through the editor | P0 |
| FR-A5 | Commands previewed and approved, output streamed and mirrored to a VS Code terminal | P0 |
| FR-A6 | Live activity indicator (current tool, step n of max) | P0 |
| FR-A7 | "Allow edits for this session" grant | P1 |
| FR-A8 | `AGENTS.md` project instructions (trusted workspaces only) | P1 |
| FR-A9 | Checkpoints and rollback, MCP tools, codebase index | P2 |

## Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | No SOVRAN backend, no telemetry, no account. Works fully offline with local endpoints |
| NFR-2 | Activation under 150 ms (lazy: on view open or command). Extension bundle under 1 MB, webview bundle under 600 KB gzipped |
| NFR-3 | Responsive streaming: the UI reflects deltas within 50 ms of host receipt. No jank in long sessions (200+ messages) |
| NFR-4 | Theming: correct in dark, light and high-contrast themes using VS Code tokens |
| NFR-5 | Accessibility: keyboard-complete, visible focus, labelled controls, live-region status |
| NFR-6 | Security controls listed in SECURITY.md are implemented and tested |
| NFR-7 | The core has no `vscode` dependency (lint-enforced) |
| NFR-8 | Windows, macOS and Linux (path handling and process kill on each) |

## Out of scope for v0.1

Inline completions (ghost text), codebase embeddings or RAG, MCP, multi-agent orchestration,
image input, remote SOVRAN services, cloud sync of sessions.

## Release acceptance (v0.1 preview)

- Every P0 requirement is implemented and covered by an automated test or a documented manual check.
- `npm run check` (typecheck, lint, test) passes. `npm run package` produces a VSIX that installs in VS Code.
- The manual compatibility matrix in ROADMAP M5 has been run against at least one real server.
