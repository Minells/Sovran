# P1 — Tool availability and live permissions

Implemented on `codex/tool-availability-policy`, based on freshly fetched `main`
`84954828aac2f5a1b7b09ebbda6687ed697bf7dd`. The owner authorized implementation of the native-tools/MCP plan on
9 November 2026. This increment implements P1; Git, diagnostics, Web and the MCP catalog remain separate increments.

## Implemented

- Native tool provenance and groups; optional trust and synchronous availability requirements for future tools.
- One registry selection rule for model visibility and execution. Native names win; ambiguous dynamic names are
  excluded. Schema caching follows definition identity rather than names.
- A definition snapshot for each model request, including prompted mode and automatic fallback. Unoffered, replaced,
  disabled and stale calls cannot prepare or execute.
- User-only `sovran.tools.disabled` and `sovran.tools.forceAsk`, validated at the host boundary, exposed in
  Settings → Agent. Defaults preserve current behavior. MCP retains its independent Off / Ask / Allow controls.
- Availability/trust/cancellation checks before prepare and dispatch; permission re-evaluation after prepare and
  after approval. A newly required approval refuses the pending call and asks the model to request it again.
- Current protected-path command checks at dispatch. Explicit approvals are not labelled automatic when policy
  changes to Allow while the approval is open.
- MCP definitions stay stable for policy-only changes, but expire on discovery changes and reconnects. Off and
  cancellation are checked in the final hub dispatch as well as the agent pipeline.

## Automated verification observed

- `npm run check`: typecheck, lint and **417 tests in 25 files passed** (baseline suite: 392 tests in 23 files).
- `npm run build`: production host, document worker and webview passed.
- `npm run test:extension`: all smoke checks passed in real **VS Code 1.145.2 on macOS arm64**, including secure
  defaults, configuration sync, opening settings and editor chats. This does not verify the minimum supported VS Code.
- `vsce package --no-dependencies --pre-release --out /tmp/sovran-tool-availability-policy.vsix`: passed,
  **24 files, reported 1.12 MB**. Existing runtime assets retained. No production dependency added.
- Independent website `main` `45381b381af0133aeb49225e7b50ec3a64306eef`: `npm run verify` passed: Astro diagnostics,
  build, four HTML pages, 115 local references and metadata/assets/sitemap checks. Website source unchanged.

Tests explicitly cover guessed/disabled/replaced definitions, native and prompted modes, source collisions,
force-Ask reads, Plan hard denial, trust changes during approval, cancellation just before dispatch, updated protected
command paths, user-scope-only settings, UI intents, MCP policy changes and stale reconnect definitions.

The first sandboxed suite could not open loopback sockets (`EPERM`); the complete passing run above was repeated
outside that restriction. Host CLI runtime: Node 26.13.0, **not** the minimum Node 20.18 runtime.

## Manual verification and remaining gates

No manual UI layout review, Windows/Linux execution, Remote SSH/WSL/container checks, minimum-runtime verification
or fresh VSIX install/upgrade was performed in P1. Those are not implied by the automated smoke test or packaging.
Per-chat group selection and settings consolidation remain P9; P1 supplies metadata without silently changing
which essential tools a chat receives. No merge, push or PR is part of this local increment.
