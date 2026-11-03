# SOVRAN — Product & Engineering Blueprint

> Milestone 0 deliverable. This is the executive document. Details are in the companion documents:
> [PRODUCT_REQUIREMENTS](PRODUCT_REQUIREMENTS.md) · [ARCHITECTURE](ARCHITECTURE.md) · [SECURITY](../SECURITY.md) ·
> [ROADMAP](ROADMAP.md) · [DEVELOPMENT](DEVELOPMENT.md) · [RELEASING](RELEASING.md) · [DECISIONS](DECISIONS.md) ·
> [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)

## 1. Product understanding and differentiation

SOVRAN is an agentic coding assistant for VS Code. It runs entirely in the Extension Host and talks
directly to model endpoints that the developer or their organization controls. There is no SOVRAN
backend, no account and no telemetry.

**Where it competes.** The space is crowded. Cline, Roo Code, Continue and Kilo Code all support
OpenAI-compatible endpoints. GitHub Copilot Chat has "bring your own key" and Ollama support, and
VS Code exposes a `LanguageModelChatProvider` API that lets third parties plug models into
Copilot Chat. Supporting local models is therefore **not** a differentiator by itself. The
specification acknowledges this, and this blueprint sharpens the positioning:

> **SOVRAN is the coding agent for the models your organization already runs.**

What SOVRAN does that others don't:

| Pillar | What it means concretely |
|---|---|
| Gateway-first compatibility | A compatibility layer that *assumes servers are imperfect*. It detects at runtime whether tool calling, streaming and model listing work. It falls back to a prompted tool protocol, stores per-model capability overrides and returns normalized, actionable errors. Custom auth headers cover enterprise gateways. |
| Governed agency | Permissions are enforced in code, not in the prompt. Plan mode **physically cannot** call write or exec tools. Writes are previewed in the native diff editor. Commands always need approval unless they are explicitly allow-listed *and* contain no shell metacharacters. VS Code Restricted Mode disables Act mode. |
| Zero-trust data flow | Credentials live only in SecretStorage and the Extension Host. The webview never sees them. Logs, errors and exports are redacted. Nothing leaves the machine except calls to endpoints you configured. |
| Native, quiet, precise UI | The UI uses VS Code theme tokens instead of a foreign skin, so it fits every theme, including high contrast. Brand comes from typography, rhythm and a deliberate use of mode colors. Native diff, terminal, quick picks and status bar are used wherever they exist. |
| Portable core | The agent engine has zero `vscode` imports (enforced by lint). The core can be extracted later for a CLI or another IDE. |

### Critique of the specification (and proposed changes)

1. **Milestone order.** The spec puts "Premium UX" (M2) before "LLM connectivity" (M3) and the
   "Agent engine" (M4). Building UI before the contracts exist leads to fake buttons and rework.
   **Proposal:** build the *core contracts first* (provider → tools → agent loop, all unit-tested), then the
   host integration, then the UI against the real protocol. See [ROADMAP](ROADMAP.md).
2. **`apply_diff` as unified diff.** Small and mid-size local models produce unreliable line numbers
   and hunk headers. **Proposal:** `apply_diff` takes an array of exact *search/replace* blocks and
   applies them atomically, after checking that each match is unique. Unified diffs are generated
   *by SOVRAN* for display, never parsed from the model.
3. **Ten tools for small models.** Every tool schema costs context, and weak models pick the wrong
   tool more often when there are more choices. Descriptions are kept terse, Plan mode exposes
   only six read tools, and the tool mode can be set per model (`native` / `prompted` / `none`).
4. **The "comparable to Claude Code" expectation.** UX polish is achievable. Agent *quality* is mostly
   bounded by the model you point it at. The README will state this honestly and recommend models
   trained for tool use.
5. **Missing from the spec: MCP and checkpoints.** The Model Context Protocol is the de facto
   standard for extending agents with tools. Checkpoints (rollback of agent edits) are the strongest
   trust feature in agentic tools. Neither fits v0.1. Both are planned for v0.2–v0.3, and the tool
   registry is designed so MCP tools plug in without changing the agent loop.
6. **The Copilot `LanguageModelChatProvider` alternative.** Registering SOVRAN's providers into
   Copilot Chat would be cheap. However, it requires the Copilot Chat extension and a GitHub sign-in,
   and it hands the UX to another vendor. That contradicts "your control" and is often blocked
   in enterprises. **Decision:** build our own UI. Consider exposing the providers to Copilot later as a
   secondary integration (roadmap).
7. **Marketplace timing.** Azure DevOps **global PATs retire on Dec 1, 2026**, and publishing via
   GitHub Actions should use **Trusted Publishing (OIDC, `vsce publish --oidc`)**. The verified-publisher
   badge needs at least 6 months on the Marketplace plus a non-subdomain domain at least 6 months old.
   It cannot be part of v0.1.
8. **Naming and trademark risk.** "Sovran" is an existing word used by several companies. A
   trademark and Marketplace-name availability check is needed *before* investing in brand
   assets. This is flagged as a decision.

## 2. Skills inspected and how they are used

The available skills were inspected. No skill dedicated to React, frontend architecture or
accessibility is installed. The relevant ones:

| Skill | Relevance | Use |
|---|---|---|
| `artifact-design` | Design fundamentals: tokens, theming, typography, copy, anti-patterns of "AI-looking" UI | Its principles drive the UI direction (§5). Especially relevant: *respect the existing design system* (here: VS Code's theme), *structure is information*, *state encoded in form*, copy rules, focus and reduced-motion |
| `run` | Launch and drive the app to verify changes | Used to run and screenshot the webview harness |
| `security-review` | Review pending changes for security issues | Used in the hardening milestone |
| `code-review` / `simplify` | Correctness and quality review | Used before release |
| `artifact-diagramming`, `dataviz` | Not relevant (no charts; architecture diagrams use Mermaid) | Not used |

No other skills are claimed. Frontend craft beyond `artifact-design` comes from engineering judgment.

## 3. Technology stack

| Concern | Choice | Why (and rejected alternatives) |
|---|---|---|
| Language | TypeScript 5.x, `strict` | Type safety across three runtimes (host, webview, core) |
| Extension bundling | **esbuild** → single CJS file | Fast, standard for extensions. webpack is rejected as slower with no benefit here |
| Webview UI | **React 19 + Vite** | The team (and the user) learning frontend benefit from the largest ecosystem and the best testing story (Testing Library). Svelte or Preact would be lighter, but bundle size matters little for a local webview |
| UI primitives | Hand-built components on **VS Code CSS variables** + **@vscode/codicons** | The Webview UI Toolkit was **deprecated on Jan 1, 2025 and archived**, so it is rejected. Tailwind is rejected: theme tokens already form the design system |
| Markdown | **markdown-it** (`html: false`) + **highlight.js** (curated languages) + **DOMPurify** | Raw HTML is disabled at the parser *and* the output is sanitized (defense in depth). Shiki is rejected (WASM plus heavy themes). highlight.js classes are mapped to VS Code theme colors |
| Validation | **zod 4** | One schema yields both runtime validation and JSON Schema for tool definitions (`z.toJSONSchema`) |
| HTTP | Native `fetch` + hand-written SSE parser | Zero dependencies. VS Code patches `fetch` for proxy support |
| Diffs | **diff** (jsdiff) | Unified diff text for tool results and transcripts |
| Tests | **vitest** (core, host logic, webview with jsdom + Testing Library), **@vscode/test-electron** (extension smoke tests) | One runner for everything except the real-VS Code tests |
| Lint/format | ESLint 9 flat config + typescript-eslint, Prettier | Includes a `no-restricted-imports` rule that blocks `vscode` inside `src/core` |
| Packaging | **@vscode/vsce** | The official tool |
| Min VS Code | `^1.95.0` | Stable WebviewView, SecretStorage and l10n. Recent `fetch` proxy support. Node ≥ 20 in the host |

## 4. Architecture (summary)

Ports and adapters. The core is pure TypeScript. The host adapts VS Code to the core's ports.
The webview is a thin projection of host state. Full detail is in [ARCHITECTURE](ARCHITECTURE.md).

```
webview (React)  ⇄ typed, zod-validated messages ⇄  host (VS Code adapters, controller, persistence)
                                                        │ implements ports
                                                        ▼
                                  core: agent loop · providers · tools · permissions · context · sessions
```

The Extension Host is authoritative for conversations, runs, approvals, credentials and HTTP.

## 5. UX/UI direction

**Concept: "Instrument, not chatbot."** SOVRAN should read like a precision instrument panel
in your editor, closer to a terminal transcript or a flight log than to a messaging app.

- **Native palette, branded behavior.** All colors come from `--vscode-*` tokens, so SOVRAN looks right in
  every theme, light, dark and high-contrast alike. The brand lives in a few deliberate places: the
  monogram mark, a letter-spaced wordmark, a strict 4 px spacing rhythm, and **mode colors that encode
  risk**:
  - **Plan** uses the theme's informational blue and means read-only.
  - **Act** uses the theme's warning amber and means the agent can change things.

  The composer border, the mode chip and approval cards carry the mode color, so the current authority
  level is visible at a glance.
- **Transcript, not bubbles.** User turns are full-width blocks on a subtle surface. Assistant turns are
  unboxed text with a small label (`SOVRAN · model`). Tool activity shows as compact one-line rows
  (`icon · verb · target · meta`) that expand to arguments and output. Approvals are the only "cards".
- **Typography.** Inherit the VS Code UI font and editor font. Use a tight type scale (11/12/13/15 px),
  uppercase micro-labels with letter-spacing, and tabular numerals for counts and timings.
- **Motion.** Use only a 120–160 ms fade or slide for new items, a streaming caret, and a progress shimmer on the
  running tool row. Everything is disabled under `prefers-reduced-motion`.
- **States are designed, not default.** The empty state shows the wordmark, the connected model and
  context-aware starters. A first run with no provider opens onboarding with presets. Errors explain the
  cause and the fix (for example *"The server rejected tool definitions. SOVRAN switched this model to prompted
  tools."*).
- **Native first.** Diffs open in VS Code's diff editor. Command output is mirrored in a VS Code
  terminal. File pickers use Quick Pick. The model and connection status appear in the status bar.
  API keys are entered in a native password input box.
- **Accessibility.** Full keyboard operation, visible focus, ARIA live region for streaming status,
  labelled controls and WCAG AA contrast (inherited from the themes).

## 6. Provider compatibility strategy (summary)

*OpenAI-compatible* is treated as a spectrum. Each model has a resolved `Capabilities` record:

| Capability | Detection | Fallback |
|---|---|---|
| Streaming | Response `content-type` is checked; JSON bodies are accepted even when `stream:true` was requested | Non-streaming parse |
| Native tool calls | Optimistic in `auto` mode. A 400/422 whose body mentions tools triggers one retry in **prompted** mode, and the downgrade is remembered | `<tool_call>{json}</tool_call>` text protocol |
| Tool calls in text | Some servers or models emit Hermes-style `<tool_call>` tags in content even in native mode | The same parser runs, only for registered tool names |
| Parallel tool calls | Deltas are accumulated by `index` | Sequential execution regardless |
| Arguments as JSON | `JSON.parse`, then a light repair (code fences, trailing commas) | A validation error goes back to the model so it can self-correct |
| Model discovery | `GET /models` | Manually configured model list |
| Reasoning | `reasoning_content` / `reasoning` deltas and `<think>` tags | Shown in a collapsible "Reasoning" section and never sent back |
| Context window | Configured per model only. It is never assumed | Conservative default (32k) plus truncation |
| Cancellation | `AbortController` through fetch | — |

Every scenario has a mocked-server test. See [ARCHITECTURE §4](ARCHITECTURE.md#4-provider-layer).

## 7. Agent engine (summary)

The loop is: build context → stream the completion → collect text, reasoning and tool calls →
for each call, validate (zod) → permission policy → approval if required → execute with a timeout →
truncate the result → append it → repeat until no tool calls remain, `maxIterations` is reached,
cancellation, or a fatal error. Validation and execution errors are returned to the model as tool
results, so it can self-correct. Repeated identical failing calls trip a loop guard.
See [ARCHITECTURE §5–7](ARCHITECTURE.md#5-agent-loop).

## 8. Security model (summary)

The host is trusted. Everything else is untrusted: repository content, tool output, terminal
output, model output and webview messages. The controls are:

- workspace path confinement (realpath-based, symlink-aware)
- protected-path globs
- approval gates
- a metacharacter-aware command allow-list
- zod validation of every webview message
- a strict CSP with a nonce, `html:false` markdown plus DOMPurify
- secrets only in SecretStorage, redaction in logs and errors
- Act mode disabled in Restricted Mode

See [SECURITY.md](../SECURITY.md).

## 9. Roadmap (summary)

| # | Milestone | Outcome |
|---|---|---|
| M0 | Discovery & blueprint | This document set |
| M1 | Foundation | Build, lint, test and package pipeline. Manifest. Design tokens |
| M2 | Core engine | Providers + compatibility layer, tools, permissions, context, agent loop. Mocked-API tests |
| M3 | Host integration | Webview view, protocol, SecretStorage, settings, sessions, diff, terminal, status bar |
| M4 | Premium UI | Transcript, composer, modes, model picker, onboarding, history, approvals, states |
| M5 | Hardening | Security review, extension tests, accessibility, performance, compatibility matrix |
| M6 | Release readiness | Icon and branding, README, VSIX, CI/CD with Trusted Publishing, license audit |
| v0.2+ | Growth | Checkpoints, MCP, ripgrep search, @-mentions, managed policies, Copilot provider bridge |

## 10. Testing strategy (summary)

| Layer | Approach |
|---|---|
| Core | Unit tests with fake ports and fake providers (target ≥ 85 % line coverage) |
| Provider | Integration tests against a real local HTTP server replaying SSE fixtures per compatibility scenario |
| Webview | Component tests (jsdom) for rendering, streaming, approvals, keyboard and accessibility attributes |
| Extension | `@vscode/test-electron` smoke tests in CI (activation, commands, view registration) |
| Gates | CI runs `typecheck`, `lint`, `test` and `package` |

See [DEVELOPMENT](DEVELOPMENT.md).

## 11. Marketplace publication strategy (summary)

The steps are:

1. Reserve the publisher ID. It is permanent, so it needs a decision.
2. Ship pre-releases first, on odd minor versions (`0.1.x`).
3. Use stable releases on even minor versions (`0.2.x`).
4. Use only `major.minor.patch` versions.
5. Use a PNG icon of at least 128 px with no SVG images in the README.
6. Release from GitHub Actions with **Trusted Publishing (OIDC)**, gated by a protected environment.

Nothing is published without explicit authorization. See [RELEASING](RELEASING.md).

## 12. Top risks

| Risk | Impact | Mitigation |
|---|---|---|
| Weak local models misuse tools | Poor perceived quality | Prompted fallback, strict validation with self-correction, loop guard, honest docs, per-model tool mode |
| Server quirks (vLLM, LM Studio, Ollama, gateways) | Broken runs | Compatibility layer, mocked scenario tests, a manual matrix in M5 |
| Enterprise TLS and proxies (internal CA, MITM proxies) | Cannot connect | Rely on VS Code proxy and certificate handling. Document `http.proxy` and system certificates. A diagnostic "Test connection" reports TLS errors clearly. TLS verification is never disabled |
| Prompt injection from repository files | Unwanted actions | Approval gates for every write and exec, protected paths, no auto-exec of metacharacter commands |
| Webview memory and performance on long chats | Slowness | Host-side delta batching (≈40 ms), memoized message rendering, no `retainContextWhenHidden` (rehydrate from host) |
| Trademark or name collision | Rebrand cost | Check before publishing (decision D1) |
| Scope versus budget | Unfinished features | Small number of features, finished properly. Status is tracked in IMPLEMENTATION_STATUS |

## 13. Decisions that need your approval (prioritized)

| ID | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | Product name and Marketplace extension ID (`sovran`), after a trademark check | Keep "SOVRAN" if the check is clear | Publication |
| D2 | **Publisher ID** (permanent) | e.g. `sovran` or your personal or company handle | Publication (the manifest uses a placeholder) |
| D3 | **License** | ✅ Decided: **MIT** (2026-11-03). Dependency audit: all 17 bundled packages are permissive | — |
| D4 | Telemetry | None. It is part of the positioning | — |
| D5 | Default approval policy for file edits | `ask` (with an "allow edits for this session" toggle) | — |
| D6 | Session persistence default | On, stored in VS Code workspace storage (plaintext JSON) with an opt-out | — |
| D7 | Milestone reordering (core before UI) | Approve | Already applied |
| D8 | Minimum VS Code version `^1.95.0` | Approve | — |

Defaults have been applied for D4–D8 so that work can proceed. D3 is decided (MIT). D1 and D2 are needed before publishing.
