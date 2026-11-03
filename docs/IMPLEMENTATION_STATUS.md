# Implementation Status

This is the source of truth for progress. *Verified* means checked by an automated test or a build step that was
actually run. Anything else is labelled.

_Last updated: 2026-11-03 · version 0.1.0 (preview)_

## Milestones

| Milestone | Status | Evidence |
|---|---|---|
| M0 Blueprint | ✅ Done | `docs/BLUEPRINT.md` and companion documents |
| M1 Foundation | ✅ Done | `npm run check` and `npm run build` pass. VSIX packages (14 files, ~417 KB) |
| M2 Core engine | ✅ Done | 60 node tests. Core line coverage about 91 % (target 85 %) |
| M3 Host integration | ✅ Implemented · ⚠️ not run inside VS Code here | Typecheck, lint and bundle pass. Smoke tests in `tests/extension` run in CI only (see below) |
| M4 Premium UI | ✅ Done | 13 component tests. Visual QA in dark and light themes through the dev harness |
| M5 Hardening | 🟡 Partial | Security self-review done (spoofing defense added). Manual compatibility matrix pending |
| M6 Release readiness | 🟡 Partial | Icon, README, CHANGELOG, CI and release workflows, third-party notices done. Blocked on D1–D3 and the publisher setup |

## What was verified in the development environment

- **Provider compatibility** against a real local HTTP server:
  - streaming text
  - split and parallel tool-call deltas
  - plain JSON responses with object arguments
  - `reasoning_content`, CRLF framing and a missing `[DONE]`
  - tool rejection mapped to `tools_unsupported`
  - 401, 404, 429, 503 and context-length errors
  - in-stream errors, cancellation, idle timeout, connection refused
  - custom auth headers
  - three `/models` response shapes
- **Agent loop:**
  - multi-step read → edit with approval
  - Plan mode cannot write even if the model tries
  - rejection feedback, self-correction after validation errors
  - automatic downgrade to prompted tools (persisted)
  - `<think>` splitting, iteration cap, loop guard
  - command allow-list versus shell operators
  - untrusted workspace, cancellation during approval, session edit grant
- **Security units:**
  - path traversal (POSIX and Windows rules), symlink escape
  - protected paths excluded from search
  - redaction
  - invisible and bidi characters in commands
  - markdown sanitization (no raw HTML, no `javascript:` links)
- **Packaging:** `vsce package --pre-release` succeeds, and the VSIX contains only build output, icon and docs.

## What was NOT verified here (and why)

| Item | Reason | How it will be verified |
|---|---|---|
| Running inside a real VS Code instance | The environment's network policy blocks the VS Code download | `npm run test:extension` in CI (`ci.yml`, xvfb on Linux plus Windows and macOS) and a manual F5 session |
| Real model servers (Ollama, LM Studio, vLLM, LiteLLM, gateways) | No model server is available in this environment | Manual matrix in `docs/DEVELOPMENT.md` |
| Native diff editor, terminal mirror, SecretStorage, Quick Picks | Need a running VS Code | Manual QA checklist below, plus the CI smoke tests for activation and commands |
| Windows process-tree kill (`taskkill /T`) | Linux environment | CI matrix and manual test |
| Webview inside VS Code with real theme variables | Visual QA used the harness, which emulates the Dark and Light Modern variables | Manual QA in Dark+, Light+ and High Contrast |

## Manual QA checklist (first F5 session)

- [ ] Onboarding: add Ollama from the preset, test the connection, add a discovered model, chat.
- [ ] A bearer-key provider: the key prompt is a password box. The webview never shows the key. `hasKey` badge appears.
- [ ] Act mode: an edit opens the native diff. Apply writes the file, and Ctrl+Z undoes it. Reject with feedback reaches the model.
- [ ] A command runs only after approval. Output streams into the row and the SOVRAN terminal. Esc cancels a long command.
- [ ] Plan mode never offers write or exec tools.
- [ ] Reloading the window restores the chat. History rename and delete work.
- [ ] Restricted Mode: the banner shows and Act is disabled.
- [ ] High Contrast theme: borders are visible and focus is visible.

## Known gaps (tracked in ROADMAP)

- Checkpoints and rollback of a whole run, MCP tools, ripgrep-backed search, `@file` mentions.
- No "retry" action on failed responses, and no token usage display.
- No conversation export. When it is added, it must reuse `redact()` (SECURITY T1).
- The extension bundle is about 557 KB and the webview JS about 488 KB (175 KB gzip). Both are within NFR-2, but highlight.js languages could be lazy-loaded.
