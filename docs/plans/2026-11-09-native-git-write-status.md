# P2b — Controlled native Git writes

Implemented on `feature/native-git-write`, **stacked on unmerged P2a** at `319c315`, which itself depends on P1.
Review this increment relative to `feature/native-git-read`. No phase was merged or pushed to main.

## Implemented

- `git_stage` / `git_unstage`: explicit repository and 1–50 literal individual paths. No directory-wide selection,
  implicit stage-all or model-provided flags. Deleted directory prefixes cannot broaden a file selection.
- `git_commit`: a non-empty, NUL-free multi-line message and reviewed staged changes, with no automatic staging.
  Strict schemas reject amend/force/other unsupported arguments. No native remote, checkout or history rewrite tool.
- Always-confirmed execute-risk operations in trusted Act, independent of Auto, command allow-lists or chat edit grants.
  The dedicated Git card shows repository, branch, file list, bounded preview and full commit message. It has no Always
  allow or session-edit-grant control; hidden text-direction characters are revealed and filenames are quoted.
- Preparation performs bounded read-only Git/file work, without invoking write-time filters, hooks or signing.
  Fingerprints cover raw index bytes (including index path), canonical common administrative directory, HEAD,
  symbolic branch, configuration and selected saved-file content. Changes during preparation or approval refuse the action.
- Selected saved files must be at most 5 MiB; raw indexes at most 16 MiB. Known dirty buffers refuse staging. Dirty-file
  capability passes through the checkpoint decorator. Read-only previews keep filters disabled; stage/commit honors
  configured write-time programs after the user sees their warnings.
- One active Sovran write per real repository. Live permission, trust, workspace scope, dirty-buffer and abort checks
  run again after executable resolution, immediately before process creation. This closes the asynchronous gap after
  an approval or index/content recheck; reads use the same late authorization callback.
- Approved commits forward only the explicitly named host signing locations `SSH_AUTH_SOCK`, `GNUPGHOME`, `GPG_TTY`
  alongside the minimal environment. Model arguments cannot choose these names or inject Git redirection/preloads/tokens.
- Existing user Git MCP servers remain configurable with unchanged policies. Only the basic Git shortcut card is removed
  now that native reads and controlled stage/commit exist. Filesystem/Fetch and custom/import workflows are preserved.
- Git changes do not create fake file checkpoints. On failure/timeout/cancellation results require status/log inspection;
  a commit may already exist. Hook stdout is not streamed or returned on success; returned HEAD is best-effort metadata.

Unstage uses index-only restore against the reviewed HEAD. Before the first commit, it uses Git's path-only reset for
selected index entries; it does not move/create HEAD or alter working files. This internal implementation does not
expose a reset operation to the model.

## Verification observed

Environment: macOS arm64, **Node 22.23.4**, **Git 2.50.1 (Apple Git-155)**.

- `npm run check`: typecheck, lint and **480 tests in 29 files passed** (P2a: 447 in 28). The 33 added tests include
  core/runtime permission checks, actual disposable repositories, process environment and webview states.
- `npm run package -- --pre-release --out /tmp/sovran-native-git-write.vsix`: production host/document worker/webview
  builds and package passed, **24 files, 1,194,294 bytes** (reported 1.14 MB). Host bundle: **1,203,830 bytes**.
- `npm run test:extension`: real **VS Code 1.145.2** smoke suite passed: activation, secure defaults, registered
  commands, configuration diagnostics/sync, settings, views and editor chats. The runner used its cached installation
  after a local issuer-certificate failure during version lookup; TLS verification stayed enabled.
- `git diff --check`: passed. Root production dependencies and lockfile unchanged.

Meaningful regressions tested:

- Index bytes unchanged by preparing a preview; only selected saved files staged; protected files still ask in Auto;
  rejection/Plan/Restricted Mode start no mutation and never return protected preview text as a tool result.
- Unstage preserves working files/other entries, including an unborn branch; commit keeps a multi-line literal message,
  stages nothing automatically and passes shell metacharacters as data.
- Changed index/HEAD/branch/configuration/saved content refuses execution. Changing a worktree's common directory to
  matching metadata still invalidates the approval. Prototype-like filenames retain their content fingerprints.
- Dirty files and existing/deleted directory prefixes are refused. Disable/trust/workspace/dirty-state changes at the
  actual mutation spawn boundary cannot change the index. Concurrent Sovran writes cannot share an approval snapshot.
- A configured clean filter and a failing pre-commit hook run only after approval. A cancellation in post-commit leaves
  an observable new commit and reports uncertainty instead of claiming rollback. Git state has no checkpoint undo.
- Approval buttons/messages/files/warnings and absence of Always allow, plus saved Git MCP editing after shortcut removal.

## Limits and remaining work

This is not an OS sandbox, an immutable hook environment, or a transaction against every external Git process.
Ordinary Git locking still applies; an unrelated process can change state during command execution, and approved hooks
or filters can change the index/files or contact services. The displayed preview can be shortened and configured
programs can change what Git ultimately records. No automatic rollback or retry is safe to infer from a failed call.

Not exercised: manual Git-card visual/narrow-layout review, a real model invoking the tools inside VS Code, real
GPG/SSH signing with user keys, Windows/Linux, Remote SSH/WSL/container, minimum VS Code or fresh VSIX install/upgrade.
The smoke test is not evidence that these matrices ran. Stage sees saved bytes; dirty detection uses the host's known
editor paths rather than claiming a filesystem-wide alias/unsaved-buffer sandbox. Those compatibility checks remain P9.

Website source is unchanged while the increments remain unmerged. P3 diagnostics is the next independent feature;
P4's Web adoption gate remains closed and no Web runtime dependency is introduced here.

Primary Git references used alongside the actual fixtures:
[add](https://git-scm.com/docs/git-add), [index restore](https://git-scm.com/docs/git-restore),
[commit/hooks](https://git-scm.com/docs/git-commit), [path-only reset](https://git-scm.com/docs/git-reset).
