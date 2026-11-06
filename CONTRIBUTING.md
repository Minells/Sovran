# Contributing to SOVRAN

Thanks for helping. SOVRAN favors a few well-made features over many unreliable ones. Please read this before
opening a pull request.

## Ground rules

- **Open an issue first** for anything beyond a small fix, so the design can be agreed before you write code.
- **Security issues** go through private vulnerability reporting, never public issues (see SECURITY.md).
- **No copied code or assets** from other AI coding extensions. SOVRAN is an original codebase.

## Development workflow

1. Use Node.js 22 (the current CI version), then run `npm ci --ignore-scripts` and `npm run build`.
2. Make your change with tests. New behavior in `src/core` needs unit tests; new UI states need component tests.
3. Run `npm run check`. It must pass, as CI enforces it on Linux, Windows and macOS.
4. If you added a dependency, run `node scripts/third-party-notices.mjs` and explain why the dependency is needed.
5. For host or command changes, run `npm run test:extension` in a real VS Code instance. Run `npm run package` to
   verify the distributable. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the complete testing guide.

For bug reports, include reproduction steps, the operating system, VS Code version, model/server type, and sanitized
logs when relevant. Never include keys, proprietary source, private endpoint URLs, or confidential conversations.
The issue templates help collect these details. Compatibility reports from real model servers are welcome.

Follow the [code of conduct](CODE_OF_CONDUCT.md). The official website lives in the independent
[Sovran-Website repository](https://github.com/Minells/Sovran-Website); do not add website dependencies to this project.

## Architecture constraints

These are enforced in review; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md):

- `src/core` must not import `vscode` or UI code. Add a port instead.
- The extension host owns state, credentials and I/O. The webview renders state and sends validated intents.
- Every write or execute tool shows the user exactly what will happen (`prepare()`) before it runs.
- Never log, persist or send secrets to the webview.

## Style

- TypeScript in strict mode, formatted with Prettier (`npm run format`).
- UI text is plain and specific. Name things by what users recognize, use active voice, and make errors say what
  happened and how to fix it.
- Use VS Code theme tokens for every color (`--vscode-*` via the `--sv-*` aliases in `webview/src/styles/app.css`).

## Commit messages

Use the Conventional Commits style: `feat(core): …`, `fix(ui): …`, `docs: …`.
