# SOVRAN Roadmap

> **Principle: recoverability before reach.** Agents built on local and self-hosted models make more mistakes, so the
> features that make mistakes cheap to undo and the agent's limits visible come before new integrations. Per-feature
> designs are in [plans/v0.2-plan.md](plans/v0.2-plan.md). Current state is in
> [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md).

## v0.1 — Foundation (done, merged in `main` through Minells/sovran#1)

| Milestone | Status |
|---|---|
| M0 Blueprint · M1 Foundation · M2 Core engine · M3 Host · M4 UI | ✅ |
| M5 Hardening | 🟡 Manual compatibility matrix still to run on real servers |
| M6 Release readiness | 🟡 Blocked on D1 (name check) and D2 (publisher). License decided: MIT |

## Release path

| Step | Owner | Gate |
|---|---|---|
| 1. CI green on Linux, Windows and macOS (includes real-VS Code smoke tests) | Automated | `ci.yml` |
| 2. First F5 session and manual QA checklist | Owner | `IMPLEMENTATION_STATUS.md` |
| 3. Compatibility matrix: Ollama, LM Studio, vLLM or LiteLLM | Owner | `DEVELOPMENT.md` |
| 4. Trademark and Marketplace name check (D1) | Owner | — |
| 5. Publisher, Trusted Publishing, `marketplace` environment (D2) | Owner | `RELEASING.md` |
| 6. Pre-release `v0.1.x` on the Marketplace and Open VSX | Tag | `release.yml` |
| 7. Stable `v0.2.0` after feedback | Tag | — |

## Feature roadmap

Effort assumes one engineer with an AI pair. **P** is priority (1 = highest).

### Wave 1 — Trust & recovery · target v0.2 · branch `feat/trust-and-productivity`

| ID | Feature | P | Effort | Why |
|---|---|---|---|---|
| F1 | Checkpoints and run rollback ("Undo changes" per response, conflict-aware) | 1 | M | Mistakes become cheap, so users let the agent do more |
| F2 | Context meter in the composer | 1 | S | Small context windows are the main cause of the agent "forgetting" |
| F3 | Retry, edit message and rewind (optionally undoing later file changes) | 1 | M | Recover from bad turns without starting over |
| F4 | Conversation compaction (auto and `/compact`) | 1 | M | Long tasks keep their goal and decisions instead of losing turns |
| F5 | ripgrep-backed search (VS Code's bundled `rg`) | 2 | S | Speed and `.gitignore` awareness on large repositories |

### Wave 2 — Productivity · target v0.2 · same branch

| ID | Feature | P | Effort | Why |
|---|---|---|---|---|
| F6 | `@` file mentions and `/` slash commands (built-in and `.sovran/commands/*.md`) | 2 | M | Faster context and repeatable workflows |
| F7 | A separate model for Plan and Act | 2 | S | A big model plans and a fast model executes, which makes good use of limited local hardware |

### Wave 3 — Extensibility & enterprise · target v0.3–v0.4

| ID | Feature | P | Effort | Why |
|---|---|---|---|---|
| F8 | MCP client (stdio and Streamable HTTP, user-scope config, per-tool approvals) — ✅ implemented on `feat/mcp-client` (tools; resources, prompts and OAuth are next) | 2 | L | De facto standard for connecting tools and data |
| F9 | Admin-managed policies (allowed hosts, forced approvals, no auto-approve) | 2 | M | Required to pass enterprise security reviews |
| F10 | Native adapters: OpenAI Responses API and Anthropic Messages | 3 | M | Covers gateways that are not Chat Completions |
| F11 | Usage and latency panel (tokens per second per model) | 3 | S | Helps tune self-hosted deployments |

### Wave 4 — Reach · target v0.5+

| ID | Feature | P | Effort | Why |
|---|---|---|---|---|
| F12 | Open VSX publishing | 2 | S | Cursor, Windsurf and VSCodium users cannot use the Microsoft Marketplace |
| F13 | Copilot Chat bridge (`LanguageModelChatProvider`) | 3 | M | Use SOVRAN providers in Copilot (optional) |
| F14 | CLI on the shared core | 3 | L | Terminal and CI use. Proves the portable-core architecture |
| F15 | Image input for vision models — ✅ implemented on `feat/document-attachments` | 3 | M | Screenshots of UI bugs and diagrams |

### Deliberately deferred

| Item | Reason |
|---|---|
| Embedding index / RAG | Costly to keep fresh. Agentic search with ripgrep covers most needs. Revisit with data |
| Inline completions (ghost text) | A different product with strict latency requirements. Better served by dedicated FIM tools |
| Multi-agent orchestration | Adds cost and failure modes before single-agent reliability is proven on local models |
