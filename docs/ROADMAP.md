# SOVRAN Roadmap

> The order differs from the original brief: the **core contracts come before the UI** (decision D7), so the UI is
> built against real behavior and never ships placeholder interactions.
> Effort estimates assume one senior engineer working with an AI pair. Current status is in
> [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md).

## M0 — Discovery & blueprint · ~0.5 d · ✅
- **Deliverables:** BLUEPRINT, PRODUCT_REQUIREMENTS, ARCHITECTURE, SECURITY, ROADMAP and DECISIONS.
- **Definition of done:** decisions listed with recommendations, risks identified, and the official publishing rules verified.

## M1 — Foundation · ~1 d · ✅
- **Objectives:** a reproducible build, lint, test and package pipeline, and an extension manifest that installs.
- **Tasks:**
  - `package.json` contributions: view container, view, commands, settings, keybindings, menus.
  - Strict tsconfigs, esbuild for the host, Vite for the webview.
  - vitest with node and jsdom environments.
  - ESLint 9 with the core-isolation rule, plus Prettier.
- **Acceptance:** `npm run check` and `npm run build` pass. `vsce package` produces a VSIX.
- **Risks:** toolchain version drift. *Mitigation:* pinned versions and a lockfile.

## M2 — Core engine · ~4 d · ✅
- **Objectives:** a portable, fully unit-tested agent engine.
- **Tasks:**
  - SSE parser, OpenAI-compatible provider, error normalization and capability store.
  - Tagged-stream parser (`<think>`, `<tool_call>`) and the prompted tool protocol.
  - Tool registry and the ten tools on ports, the edit engine, path confinement, command analysis and redaction.
  - Permission policy, context manager and AgentRunner.
- **Tests:** a mock OpenAI server with scenarios for native tools, split argument deltas, parallel calls,
  tools rejected (400), non-streaming JSON, `reasoning_content`, `<think>`, malformed arguments, abort, idle
  timeout, 401, 404 and 429. Plus agent-loop scenarios: multi-step, deny, reject, max iterations, loop guard, cancel.
- **Acceptance:** at least 85 % line coverage on `src/core`. Lint confirms there are no `vscode` imports.
- **Risks:** server quirks not covered by the fixtures. *Mitigation:* the manual matrix in M5.

## M3 — Host integration · ~3 d · ✅ (in-VS Code verification pending)
- **Tasks:**
  - Webview view provider with CSP and nonce, and the zod-validated protocol.
  - Controller and run lifecycle with delta batching.
  - SecretStorage, application-scoped settings reader, session repository with atomic writes.
  - Workspace adapter (buffer-aware reads, `WorkspaceEdit` writes).
  - Process runner with tree-kill and terminal mirror.
  - DiffPresenter (virtual documents), status bar, Quick Picks (model, attach files), commands.
- **Acceptance:** an end-to-end run against the mock server inside VS Code (manual), with sessions restored after reload.
- **Risks:** webview lifecycle (hidden view and rehydration). *Mitigation:* the host-authoritative snapshot.

## M4 — Premium UI · ~4 d · ✅
- **Tasks:**
  - Design tokens on VS Code variables.
  - Header, transcript (user, assistant, reasoning, tool rows), markdown and code blocks, approval cards.
  - Run status bar, composer (chips, mode toggle, model button, send and stop).
  - Empty, onboarding and provider-manager screens, history view, notices.
  - Keyboard shortcuts, plus a dev harness with mocked host events for visual QA and screenshots.
- **Tests:** component tests for streaming, approval flow, composer keys, mode visuals and accessibility attributes.
- **Acceptance:** correct in Dark+, Light+ and High Contrast. Fully keyboard operable.

## M5 — Hardening · ~3 d · 🟡 partial
- **Tasks:**
  - `security-review` pass and fixes.
  - `@vscode/test-electron` smoke tests (activation, commands, view).
  - Performance with a long-session fixture.
  - Accessibility audit and error-copy review.
- **Manual compatibility matrix:** Ollama, LM Studio, vLLM, LiteLLM and one enterprise gateway, crossed with native tools, prompted tools, streaming, discovery and cancellation.
- **Acceptance:** no high-severity findings open, and the matrix documented.

## M6 — Release readiness · ~2 d · 🟡 blocked on D1–D2
- **Tasks:**
  - Icon (PNG) and gallery banner.
  - README with screenshots from the harness, CHANGELOG, CONTRIBUTING and LICENSE (decision D3).
  - Third-party notices.
  - CI (Linux and Windows) plus a release workflow using **Trusted Publishing (OIDC)** behind a protected environment.
  - Pre-release `0.1.0`.
- **Acceptance:** the VSIX installs cleanly and `vsce ls` shows no development files. The release checklist in RELEASING.md is complete.
- **Blocked by:** D1 (name), D2 (publisher) and D3 (license).

## Post-v0.1 (v0.2 – v0.4)
| Item | Value |
|---|---|
| Checkpoints and rollback of agent edits | Trust and safety |
| MCP client (stdio and HTTP) with per-tool approvals | Extensibility |
| ripgrep-backed search (bundled VS Code `rg`) | Speed on large repositories |
| `@file` mentions and drag-and-drop context | UX |
| Admin-managed policies (allowed endpoints, forced approvals) | Enterprise |
| Token usage and latency panel per run | Model tuning |
| Copilot `LanguageModelChatProvider` bridge | Reach |
| Responses API and Anthropic-native adapters | Multi-protocol |
| CLI on the shared core | Portability |
