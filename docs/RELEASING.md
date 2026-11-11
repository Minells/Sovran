# Releasing to the VS Code Marketplace

> Requirements were checked against the official VS Code docs on 2026-11-03 ("Publishing Extensions",
> from the microsoft/vscode-docs repository). Re-check before each release: publishing auth is changing.

## Key facts (verified)

- **Publisher.** Every extension needs a `publisher`. The publisher **ID is permanent**. Create it on the Marketplace
  publisher management page with a Microsoft account. The `publisher` field in `package.json` (currently
  `minells`) must match it.
- **Authentication.** For GitHub Actions, **Marketplace Trusted Publishing (OIDC)** is recommended:
  `vsce publish --oidc`. The credential lasts 15 minutes, and each OIDC token can be exchanged once.
  **Azure DevOps global PATs are retired on December 1, 2026**, so do not build the pipeline on PATs.
- **Content restrictions.**
  - The icon must be a PNG of at least 128 px and not an SVG (`media/icon.png` is 256 px).
  - User-provided SVGs are not allowed in the package or in README images.
  - README and CHANGELOG images must resolve to `https` URLs. vsce rewrites relative links using `repository`.
  - Use at most 30 keywords.
- **Versions.** Only `major.minor.patch` is allowed. Pre-release and stable versions must differ.
  - Convention: **odd minor = pre-release** (`0.1.x`), **even minor = stable** (`0.2.x`).
  - Pre-release needs `engines.vscode` ≥ 1.63.
- **Verified publisher badge.** It requires an extension on the Marketplace for at least 6 months and a domain that is at
  least 6 months old. The domain cannot be a subdomain such as `github.io`, must use HTTPS, and needs a DNS TXT record. Review
  takes up to 5 business days.

## One-time setup (owner action — not automated)

1. Decide the publisher ID and display name (decision D2).
2. Create the publisher on the Marketplace management page.
3. Configure Marketplace **Trusted Publishing** for `Minells/sovran`, workflow `release.yml`.
4. In GitHub, create the environment **`marketplace`** with required reviewers.
5. Complete the name/trademark check (decision D1). The license is settled: MIT (D3).

## Release checklist

- [ ] `npm run check` passes and CI is green on Linux, Windows and macOS (including extension smoke tests).
- [ ] The manual compatibility matrix (docs/DEVELOPMENT.md) has been updated for this version.
- [ ] `CHANGELOG.md` has a section for the version.
- [ ] `node scripts/third-party-notices.mjs` has been re-run if dependencies changed.
- [ ] `npm audit --omit=dev` shows no high or critical issues.
- [ ] `npx vsce ls --no-dependencies` lists only `dist/`, `media/icon.png`, `media/activity-bar.svg` and the docs.
- [ ] The version in `package.json` follows the odd/even channel rule.
- [ ] Tag with `git tag vX.Y.Z && git push origin vX.Y.Z`. The `release.yml` workflow packages, publishes (after
      environment approval) and attaches the VSIX to a GitHub Release.

## Manual packaging

```bash
npm run build
npx vsce package --no-dependencies --pre-release
```

The command produces `sovran-<version>.vsix`. Install it with:

```bash
code --install-extension sovran-<version>.vsix
```

## Post-publication

- Watch issues and Marketplace Q&A. Triage security reports through private advisories (SECURITY.md).
- Keep pre-release ahead of stable: publish the next pre-release before promoting a stable version.
- Run `npm audit` monthly and update dependencies.
- Re-check `engines.vscode` against the API surface used. `@types/vscode` must not be newer than `engines`.

## Native tools release gates

Before integrating the stacked native-tools branches, consult
[the P9 verification record](plans/2026-11-10-native-tools-release-hardening-status.md). Code complete does not mean
all platform/account gates passed. CI now covers source smoke on stable and minimum VS Code on three operating
systems, verifies VSIX assets and tests a fresh installed artifact on Linux. Release packaging repeats asset validation
and installed-artifact smoke before publishing. Those workflow definitions are not evidence that CI already ran.

Record Windows/Linux/macOS and SSH/WSL/container results separately; test native/prompted model behavior, signing/hooks,
Restricted Mode, cancellation and narrow/high-contrast UI. Use opted-in test accounts for Playwright extension session
consent and GitHub token permissions. Test a genuine versioned upgrade as well as the development VSIX replacement;
check saved secrets/chats manually. No general Web search, crawler/index, browser binary or automatic browser-port
forwarding belongs to the current scope. This work does not publish or merge any branch.
