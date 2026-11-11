# P3 — Cached workspace diagnostics

Implemented on `feature/workspace-diagnostics`, created directly from `feature/native-git-write` at
`12aa10f045cc0badeaba705b0310b1986b1710c5`, as requested by the owner. The branch contains unmerged P1/P2a/P2b.
Review this increment relative to `feature/native-git-write`; integrate the preceding increments first.
No branch was merged or pushed.

## Implemented

- Native read-only `get_diagnostics`, registered in the existing `context` group and available in Plan and Act,
  including Restricted Mode. Existing native disable/force-Ask controls and live dispatch rechecks apply.
- `scope`: `workspace` (default, all roots) or `active` (current file editor); optional literal `path` selects a
  workspace file or directory in workspace scope. Named-root and absolute in-workspace selectors are supported.
  Conflicting active/path arguments and external selectors fail clearly. No active file produces an explicit result.
- `severity`: `all` (default), `error`, `warning`, `info` or `hint`. `max_results`: 1–500, default 100.
  Results include workspace-relative paths (with root labels in multi-root workspaces), 1-based lines, severity,
  message and optional source. Paths/messages/sources are quoted to keep embedded newlines on one output line.
- Optional `WorkspacePort.diagnostics(absPath?)` capability and receiver-bound checkpoint passthrough. Unsupported
  hosts report the missing capability rather than claiming there are no problems. Reading creates no checkpoint.
- `VscodeWorkspace` reads `vscode.languages.getDiagnostics()` or its exact-file overload. Non-file URI schemes are
  discarded. Nothing opens a document, invokes a language provider, starts a process, runs checks or contacts a service.
  Unopened files appear when a provider has already reported their diagnostics; dirty-buffer diagnostics remain cached
  editor state. There is no active-document-only fallback that would silently lose workspace diagnostics.
- Core filtering verifies each diagnostic path against workspace boundaries and real paths. Protected paths are
  omitted even for explicit file requests, since messages may contain file contents. Both displayed/root-local paths
  and canonical targets are checked, including in-workspace aliases to protected paths. External, broken and
  unverifiable entries are omitted without returning their filenames/messages. New unsaved paths are verified through
  their nearest existing ancestor. Cancellation and live tool authorization are checked around asynchronous work.
- Count and configured result-size limits stop output with a narrowing hint. Individual diagnostics that do not fit
  are omitted rather than returned partially. Empty output states that no matching **cached** diagnostics were
  returned; it does not claim that analysis completed or that the workspace has no errors.

The protected-path filter is evaluated using the runtime settings supplied at dispatch, including changes made while
force-Ask approval was pending. Diagnostic messages are provider-supplied text, not a guarantee about the actual file
contents or a complete project analysis. Existing active-editor context behavior is outside this increment.

## Verification observed

Environment: macOS arm64, **Node 22.23.4**, **VS Code 1.145.2**.

- `npm run check`: typecheck, lint and **506 tests in 30 files passed** (P2b: 480 in 29).
  The initial sandboxed attempt could not listen on `127.0.0.1` (`EPERM`); rerunning with local-server access passed.
- **26 new core/runtime tests** cover active/workspace/unopened files, all severities, literal file/directory and
  multi-root selection, protected root-local patterns, aliases/external/broken paths, missing unsaved files,
  output/count limits, invalid arguments, empty/unsupported hosts, cancellation, checkpoint capability binding,
  Plan/Act and Restricted Mode. Disable, approval rejection, disable/cancel during approval and a newly protected path
  all prevent diagnostic content disclosure before dispatch.
- `npm run test:extension`: real VS Code regression smoke suite passed, including a new production-adapter/core probe
  built only in a temporary directory. An actual DiagnosticCollection provides dirty-active and unopened files,
  protected/external/virtual entries, warning/hint filtering, literal directory/file selectors, limits and cache
  clearing. The unopened document stays unopened. The runner reused cached VS Code after a local issuer-certificate
  error during version lookup; TLS verification stayed enabled.
- `npm run package -- --pre-release --out /tmp/sovran-workspace-diagnostics.vsix`: production host, document worker,
  webview builds and VSIX verification passed. The package contains 24 files (reported 1.14 MB); no test probe ships.
- `git diff --check`: passed. No dependency, lockfile, Web runtime, MCP configuration or website changes.

## Remaining gates

Not exercised: manual calls through a real model, Windows/Linux, Remote SSH/WSL/container, minimum VS Code,
fresh VSIX installation or upgrade. These remain P9 compatibility/release checks. No new UI needs a layout review.
Document symbols and language-server invocation are deferred by the approved plan.

P3's scoped automated acceptance gate is satisfied. P8a and further P4 feasibility work can follow; P5 remains gated
on the Web transport/adoption proof. The original P1 → P2a → P2b review/integration order is preserved.
