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
| M6 Release readiness | 🟡 Partial | Icon, README, CHANGELOG, CI and release workflows, third-party notices and MIT LICENSE done. Blocked on D1 (name check), D2 (publisher) and the Marketplace setup |

## v0.2 features (branch `feat/trust-and-productivity`)

| Feature | Status | Evidence |
|---|---|---|
| F1 Checkpoints and Undo changes | ✅ Implemented | Recorder, restore planning and conflict handling unit-tested. UI footer tested |
| F2 Context meter | ✅ Implemented | `context` and `usage` events tested. Meter thresholds tested |
| F3 Retry, edit and rewind | ✅ Implemented | UI flows tested. Host orchestration is on the manual checklist |
| F4 Compaction (auto and `/compact`) | ✅ Implemented | Boundary planning, auto-compaction, fallback on failure tested |
| F5 ripgrep search | ✅ Implemented | Integration test against a real `rg` binary. Protected-path re-filtering tested |
| F6 `@` mentions and `/` commands | ✅ Implemented | Fuzzy ranking, parsing and expansion, custom commands, popup keyboard flows tested |
| F7 Plan-mode model | ✅ Implemented | UI test. Quick Pick behavior is on the manual checklist |

Manual checks for v0.2 (first F5 session):
- [ ] An agent edit followed by **Undo changes** restores the file, and Ctrl+Z in the editor brings the edit back.
- [ ] Undo after manually editing the file shows the conflict prompt.
- [ ] Retry with *Keep changes*, then Undo, returns to the state before the *first* attempt.
- [ ] Edit an older message with *Undo changes*: later responses' files are restored.
- [ ] A long session with a small `contextWindow` auto-compacts, and the divider shows the summary.
- [ ] `@` suggestions appear quickly in a large repository. `/` lists custom commands from `.sovran/commands`.
- [ ] Plan mode with a separate model: the status bar and the composer show the Plan model.

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

## Review, approvals and settings (branch `feat/review-settings-auto-mode`)

Quality and security review: [reviews/2026-11-03-review-qualita-sicurezza.md](reviews/2026-11-03-review-qualita-sicurezza.md).

| Feature | Status | Evidence |
|---|---|---|
| Approval modes Ask · Auto-edit · Auto | ✅ Implemented | Policy matrix, guardrails (positive and negative cases), live mode switch during a run and the *auto* label unit-tested. Picker, Alt+A and cards UI-tested |
| Always allow on command approvals | ✅ Implemented | Prefix suggestion and validation unit-tested; host re-check is on the manual checklist |
| Settings view (gear in the view title) | ✅ Implemented | UI tests for models, approvals, lists, numbers, toggles and workspace overrides; visual QA in dark and light |
| Guided setup | ✅ Implemented | UI tests for the success and failure paths; visual QA through the dev harness |
| Security fixes S1–S11 from the review | ✅ Implemented (S7 open) | Regression tests, including a real-server redirect test |

Manual checks for this branch (first F5 session):
- [ ] Turning on Auto shows the native confirmation once per window; the status bar shows `auto` with a warning background.
- [ ] In Auto, `npm run build` runs without a card and shows the *auto* badge; `git push` and `cat .env` still ask, with the reason.
- [ ] **Always allow…** on `npm test -- --watch=false` adds `npm test` to the allowed commands, and the next `npm test` in the same run does not ask.
- [ ] Every control in Settings writes the user setting and is reflected after a window reload; `sessions.persist` offers the reload.
- [ ] Guided setup with a bearer-key provider: the key prompt appears, the test runs, the discovered models are offered.
- [ ] Opening `~/.aws/credentials` shows a locked chip, and sending a message does not attach it.
- [ ] A provider that answers with a redirect shows the redirect error and its hint.

## Settings tabs, config.yaml and chat titles (branch `feat/settings-yaml-autotitle`)

| Feature | Status | Evidence |
|---|---|---|
| Settings areas as persistent tabs | ✅ Implemented | UI tests for selection, one visible area, keyboard (arrows, Home, End, one tab stop) and reopening the last area; visual QA at 280–420 px in dark and light |
| `~/.sovran/config.yaml` | ✅ Implemented | Unit tests for parsing, shorthands, positions of every problem, spelling hints, rejected secrets, model references, alias bombs and merging; UI tests for the Settings card and file providers; extension smoke test for diagnostics (runs in CI) |
| Model-generated chat titles | ✅ Implemented | Unit tests for the request, first-line cut-off, truncation of long messages, cleanup of model output and errors; UI tests for the toggle and the title model |

Manual checks for this branch:
- [ ] Create config.yaml from Settings, uncomment Ollama and save: the provider appears with the *config.yaml* badge and a "connected" notification.
- [ ] Save a typo (`base_url`): the squiggle and the Problems entry show the hint; Settings shows the problem; chatting still works with the last valid version.
- [ ] A bearer provider in the file asks for the key once; nothing is written to `settings.json`.
- [ ] With titles on, a new chat first shows the first words, then the generated title; renaming during generation keeps the user's title.

## Config sync, gateway auth and titles on by default (branch `feat/config-sync-auth`)

| Feature | Status | Evidence |
|---|---|---|
| Two-way sync Settings ⇄ `config.yaml`, stop (keep/trash), use again | ✅ Implemented | Unit tests for canonical comparison, in-place YAML edits that keep comments, the seeded template and stability; UI tests for every file state; extension smoke test for file → Settings, Settings → file (comment kept), ignored file, and joining on re-enable (runs in CI) |
| Auth diagnostics, key normalization, `/models` 401 fallback | ✅ Implemented | Integration tests against an APISIX-style mock gateway (Bearer only, custom message, `/models` refused) |
| "API key" default label, header badge | ✅ Implemented | UI tests |
| Titles on by default, reasoning-model budget | ✅ Implemented | Unit tests (always-reasoning stream, early stop) |

Manual checks for this branch:
- [ ] Create config.yaml from Settings with providers already configured: the file lists them; add a provider in the panel and it appears in the file with your comments intact.
- [ ] Open the file, make an unsaved edit, change a provider in the panel: Sovran warns and does not touch the file.
- [ ] Stop using config.yaml → Keep the File: Settings keep working; Use config.yaml again joins both sides.
- [ ] A company gateway: a wrong auth type or a missing key shows the matching hint.

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

- MCP tools.
- No conversation export. When it is added, it must reuse `redact()` (SECURITY T1).
- The webview JS is about 535 KB (185 KB gzip). highlight.js languages could be lazy-loaded.
- Auto-mode guardrails are heuristics, not a sandbox (see SECURITY.md). Sandboxed command execution is the next step.
