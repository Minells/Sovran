# Picomatch alert review and workspace glob hardening

Branch: `fix/picomatch-glob-hardening`, from `origin/main` (`e0f8edc`).

## Findings and application impact

- User-reported [Dependabot alert #1](https://github.com/Minells/Sovran/security/dependabot/1) references [GHSA-fc5q-39xc-vjpf / CVE-2026-112366](https://github.com/advisories/GHSA-fc5q-39xc-vjpf). GitHub withdrew the advisory on 2026-11-18 because it is not classified as a security issue. The original high-severity metadata remains visible; it must not be described as an active, patched vulnerability.
- As checked on 2026-11-20, npm's latest published picomatch is **4.0.7**, matching the lockfile. No patched release is listed. `npm audit` reports zero vulnerabilities. No version override, fabricated upgrade, vendored upstream PR or audit suppression is appropriate.
- Picomatch is a production dependency, bundled into the extension host, and also used transitively by Vite/Vitest/vsce tooling. Application-controlled changes do not patch those development-tool internals.
- Two application call sites accept lower-trust patterns: a model-supplied include filter in `RipgrepSearch`, and workspace-scoped `files.exclude` in the attachment directory browser. Both previously enabled the full Picomatch grammar, including repeated Bash extglobs and regex groups.
- Protected-path checks in `policy.ts` and `commands.ts` use user-only security settings. The host ignores workspace overrides for these settings. Preserve their existing grammar and approval behavior instead of silently weakening protection patterns.
- Isolated probes of the original matcher for `+(*a)` and `+(*)b` on crafted non-matches exceeded a 600 ms child-process deadline. This confirms a relevant availability concern for lower-trust patterns despite the withdrawn classification; it does not establish credential disclosure or permission bypass.
- The maintainer [closed the proposed upstream fix](https://github.com/micromatch/picomatch/pull/235#issuecomment-6315749381) and recommends avoiding unsafe patterns/untrusted regex input. Do not treat the unmerged patch as a supported release.
- The available GitHub connector has no Dependabot-alert operation. CLI reads of the private alert and advisory API returned **403 Forbidden**. Public advisory status is independently verified; the private alert's current state cannot be asserted or changed through these available API permissions.

## Implementation and compatibility

1. Add one workspace-glob compiler for model/workspace-controlled filters. Disable Bash extglobs, regex quantifier mode and leading-negation semantics; escape parentheses/pipes while preserving existing backslash escapes. Keep ordinary stars, globstars, question marks, character classes, brace alternatives and dotfile matching.
2. Use it only at the two lower-trust runtime call sites. Parenthesized route directories such as `app/(auth)/**` match literally. Replace `@(a|b)` with `{a,b}` when expressing alternatives. Leading `!` is literal, as in ordinary VS Code file globs.
3. Keep user-only protected-path matching and all approval decisions unchanged. Dependency versions, lockfile, third-party notices and build-tool behavior stay unchanged.
4. Verify actual behavior in a killable subprocess with advisory-shaped patterns; cover ordinary/literal globs, trusted protection rules, real ripgrep and the attachment browser. Run the full application checks and production packaging.
5. Push, open a PR to main, inspect the exact commit's complete CI matrix and packaging jobs, fix failures if any, and merge only after success.

This is targeted input hardening. It does not claim that every arbitrarily complex glob or explicit regular expression has a bounded execution time, nor that a dependency-version alert will automatically close after this change. If alert #1 is still open, its withdrawn-advisory classification can be recorded by a maintainer with Dependabot permissions; do not label it fixed by a nonexistent release.

## Validation

- `npm run check` passed: 888 tests passed, 4 pre-existing optional browser/released-service checks skipped. Typecheck, lint and MCP license freshness checks passed.
- Regression coverage includes advisory-shaped patterns in a time-limited child process, ordinary/escaped/literal glob semantics, real ripgrep route-directory searches and controller workspace exclusions. The subprocess uses a Node 20-compatible production-style CJS bundle; no native TypeScript runtime is required.
- Production host/webview build, VSIX packaging and verification passed (30 files). Both complete and production npm audits report zero vulnerabilities.
- CI and real VS Code smoke results will be recorded in the pull request before merge.
