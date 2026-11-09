# P2a — Native Git inspection

Implemented on `codex/native-git-read`, **stacked on unmerged P1** at `1f39177`.
Remote `main` was fetched again before this increment and remained at `8495482`; P1 was not merged to main.
Review this increment relative to `codex/tool-availability-policy`. P4 remains independent.

## Implemented

- `git_status`, `git_diff`, `git_log`, `git_show`, `git_branches`: trusted Plan/Act reads using the existing registry,
  permission/approval pipeline, native disable/always-review controls and result masking.
- Explicit repository roots, named roots in multi-root workspaces, nested repositories and ordinary linked worktrees.
  No parent repository discovery. Working-tree arguments override `core.worktree` redirection; escaping marker/path
  symlinks are refused. Ordinary worktree `.git` files may reference their shared administrative directory.
- `ProcessPort.runFile`: literal argv without a shell, resolved host executables outside workspace roots, minimal
  environment, separate incrementally decoded stdout/stderr. Shared shell/argv output, timeout, abort and process-tree
  termination, including descendants holding pipes after their parent exits. No raw Git output is mirrored/streamed.
- Disable optional locks, lazy fetch, replacement refs, pagers, fsmonitor, submodule recursion, textconv, external diff,
  and effective clean/process filters. Filter names are read without their values and overridden before inspection.
  All Git calls use one bounded per-inspection deadline (maximum 15 seconds).
- Resolve limited commit-ish syntax to full commit IDs. Paths are separate literal arguments, not `REV:path`, option
  flags or pathspec magic. Historical file reads use tree/blob IDs, without working-tree conversion filters.
- Complete NUL-delimited metadata before parsing; bounded history/file paging and marked patch truncation. Historical
  blobs have a 2 MiB input cap and returned-line paging follows the actual result character budget.
- Bulk patches omit protected paths and detected rename sources even when the request selects only the public
  destination. Exact protected-file reads prepare the existing read approval without starting Git beforehand.

## Verification observed

Environment: macOS arm64, **Node 22.23.4** (project development runtime), **Git 2.50.1 (Apple Git-155)**.

- `npm run check`: typecheck, lint, **447 tests in 28 files passed** (P1 baseline: 417 tests in 25 files).
- `npm run build`: host/document worker/webview passed, also run by VSCE prepublish.
- `npm run test:extension`: real **VS Code 1.145.2** smoke suite passed (activation, secure settings, commands,
  configuration sync, views and editor chats). Version lookup had a local issuer-certificate error and the test runner
  used its existing cached installation; TLS verification was not disabled.
- `npm run package -- --pre-release --out /tmp/sovran-native-git-read.vsix`: passed, **24 files, 1,189,701 bytes**
  (reported 1.13 MB). Host bundle: 1,192,408 bytes. No production dependency added.
- `git diff --check`: passed.

The 30 added tests include core argument/metadata boundaries, actual disposable repositories and a real argv process
runner: status/index preservation, staged/unstaged/revision/root/merge diffs, line/file/history paging, binary blobs,
spaces/metacharacters, protected reads/renames, worktrees, two roots, nested repositories, outside-parent/path denial,
helper suppression, missing Git, timeout/cancellation, descendant termination, UTF-8 chunk decoding and metadata caps.
A promisor repository with a removed object and a configured SSH marker program fails without invoking that program.
The core agent-loop test exercises trusted Plan reads and rejects an explicit protected file before any Git process.

## Limits and remaining work

- Requires host Git with `--no-lazy-fetch` support (documented in Git 2.48); older Git fails closed with an update message.
- No manual layout/model smoke, Windows/Linux, Remote SSH/WSL/container, minimum VS Code runtime or fresh VSIX
  installation/upgrade was performed. Test coverage is not a claim that these matrices ran.
- Git output is path-protected, not a semantic secret classifier. Metadata may name protected files; moving/copying
  sensitive content into an unprotected path does not keep it protected by history. No OS sandbox is claimed.
- No stage/unstage/commit, network/history rewrite or repository checkpoint recovery is added. P2b implements the
  separately approved mutation increment. Existing custom MCP entries/policies are preserved.
- Website source is unchanged; its public feature claims can be updated with the release documentation increment.

Primary Git references checked during implementation:
[protective flags](https://git-scm.com/docs/git/2.48.0),
[external diff/textconv](https://git-scm.com/docs/git-diff),
[revision verification](https://git-scm.com/docs/git-rev-parse).
The concrete guarantees above are bounded by the code paths and tests actually exercised.
