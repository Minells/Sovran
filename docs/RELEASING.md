# Releasing Sovran

## Release flow

Pushing a tag `vX.Y.Z` runs [`release.yml`](../.github/workflows/release.yml) in three jobs:

| Job | Permissions | What it does |
|---|---|---|
| **Build and verify VSIX** | read | Checks that the tag matches `package.json`, runs `npm run check`, packages `sovran-X.Y.Z.vsix` (with `--pre-release` for an odd minor), runs `verify:vsix`, installs the VSIX in a fresh VS Code profile, writes its SHA-256 and the release notes |
| **GitHub Release** | `contents: write` | Publishes the release with the VSIX and `sovran-X.Y.Z.vsix.sha256`, marked as a pre-release for an odd minor. The notes come from `scripts/release-notes.mjs`, followed by GitHub's list of merged pull requests |
| **VS Code Marketplace** | `id-token: write` | Runs only when the repository variable `MARKETPLACE_PUBLISH` is `true`, after the reviewers of the `marketplace` environment approve. Publishes the same VSIX with `vsce publish --oidc` |

The GitHub Release never depends on the Marketplace: until the one-time setup below is done, leave
`MARKETPLACE_PUBLISH` unset and the third job is skipped.

**Release notes.** `scripts/release-notes.mjs` uses the curated announcement `docs/releases/vX.Y.Z.md` when it exists,
otherwise the `## [X.Y.Z]` section of `CHANGELOG.md`, and fails when neither exists. It appends installation steps and
the VSIX checksum. Preview the notes locally with:

```bash
npm run package
node scripts/release-notes.mjs 0.1.0 sovran-0.1.0.vsix
```

## Publishing a GitHub release

1. Merge the release changes into `main` and wait for CI to pass.
2. Check that `package.json`, the `CHANGELOG.md` section (with its date) and, optionally, `docs/releases/vX.Y.Z.md`
   name the same version.
3. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag -a v0.1.0 -m "Sovran 0.1.0"
   git push origin v0.1.0
   ```

4. Follow the run under **Actions → Release**. When it finishes, the release appears under **Releases** with the VSIX.
5. Download the VSIX from the release page, check it with `sha256sum -c`, install it and open the Sovran view once.

If a job fails before the release is created, fix the cause on `main`, delete the tag (`git push --delete origin
vX.Y.Z` and `git tag -d vX.Y.Z`) and tag again. Once a version has been published, never reuse its tag: release a
new patch version instead.

## Publishing to the VS Code Marketplace

> Requirements were checked against the official VS Code docs on 2026-11-03 ("Publishing Extensions",
> from the microsoft/vscode-docs repository). Re-check before each release: publishing auth is changing.

### Key facts (verified)

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

### One-time setup (owner action — not automated)

1. Decide the publisher ID and display name (decision D2).
2. Create the publisher on the Marketplace management page.
3. Configure Marketplace **Trusted Publishing** for `Minells/sovran`, workflow `release.yml`.
4. In GitHub, create the environment **`marketplace`** with required reviewers.
5. Complete the name/trademark check (decision D1). The license is settled: MIT (D3).
6. Under **Settings → Secrets and variables → Actions → Variables**, add the repository variable
   `MARKETPLACE_PUBLISH` with the value `true`. From the next tag on, the release also publishes to the Marketplace.

## Release checklist

- [ ] `npm run check` passes and CI is green on Linux, Windows and macOS (including extension smoke tests).
- [ ] The manual compatibility matrix (docs/DEVELOPMENT.md) has been updated for this version.
- [ ] `CHANGELOG.md` has a dated `## [X.Y.Z]` section, and its link references at the bottom are updated.
- [ ] `node scripts/third-party-notices.mjs` has been re-run if dependencies changed.
- [ ] `npm audit --omit=dev` shows no high or critical issues.
- [ ] `npx vsce ls --no-dependencies` lists only `dist/`, `media/brand/`, `media/sovran.css`, the managed MCP
      manifests under `resources/mcp/` and the top-level documents (README, CHANGELOG, LICENSE, SECURITY, notices).
      `npm run verify:vsix` enforces the essentials.
- [ ] The version in `package.json` follows the odd/even channel rule.
- [ ] Tag with `git tag -a vX.Y.Z -m "Sovran X.Y.Z" && git push origin vX.Y.Z` (see
      [Publishing a GitHub release](#publishing-a-github-release)).

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
