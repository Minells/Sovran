# Development

## Prerequisites

- Node.js 20 or later (CI uses 22)
- VS Code 1.95 or later

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Bundle the host (esbuild → `dist/extension.js`) and the webview (Vite → `dist/webview`) |
| `npm run watch:host` / `npm run watch:webview` | Rebuild on change |
| `npm run dev:webview` | Webview dev server with a **mocked host** (`webview/src/dev/mockHost.ts`) |
| `npm run typecheck` | Strict TypeScript for host, core and webview |
| `npm run lint` | ESLint. Enforces that `src/core` never imports `vscode` |
| `npm test` | Vitest: core unit tests, provider integration tests, webview component tests |
| `npm run test:coverage` | The same tests with coverage (core target ≥ 85 % lines) |
| `npm run test:extension` | Smoke tests in a real VS Code instance (`@vscode/test-electron`; needs network to download VS Code) |
| `npm run check` | typecheck + lint + test (the CI gate) |
| `npm run package` | Build a VSIX with `vsce` |

Press **F5** in VS Code ("Run SOVRAN") to build and launch an Extension Development Host.

The real VS Code smoke tests poll observable state rather than sleeping through settings and file updates. Their
state timeout is 10 seconds locally and 30 seconds in CI, where macOS runner load and cross-process Settings/Secret
Storage calls can delay notifications. A synchronization timeout reports the disposable fixture's current Settings,
file content, and open-document state; it never reads the developer's real `~/.sovran/config.yaml`.

## UI development harness

`npm run dev:webview` serves the React app with a simulated host and VS Code theme variables. The harness lives in
`webview/src/dev/` and is only loaded when `import.meta.env.DEV` is true, so production builds never include it.

Query parameters:

| Parameter | Values |
|---|---|
| `scenario` | `conversation`, `bigdiff` (a proposal taller than the view), `long` (several long exchanges, to scroll), `done` (finished, no pending approval), `auto`, `empty`, `onboarding`, `providers`, `history` (with live chat status), `settings` |
| `surface` | `panel` (a chat in an editor tab: full width, editor background; default: the Activity Bar view) |
| `editor` | `none`, `selection`, `outside` (default: an open file) |
| `approval` | `ask`, `edits`, `auto` |
| `theme` | `dark`, `light` |
| `mode` | `plan`, `act` |
| `width` | Sidebar width in px |

The README screenshots are generated from this harness.

## Testing strategy

| Layer | Where | What is covered |
|---|---|---|
| Core unit | `tests/unit/*.test.ts` | Agent loop (multi-step, approvals, plan-mode enforcement, downgrade to prompted tools, loop guard, iteration cap, cancellation, grants), tools, edit engine, path confinement (POSIX and Windows), policy, command analysis, redaction, SSE parser, tagged-stream parser, context budgeting, session repair |
| Provider integration | `tests/integration/*.test.ts` | A real HTTP server replaying compatibility scenarios: split tool-call deltas, parallel calls, non-streaming JSON, `reasoning_content`, CRLF framing, tool rejection (400), HTTP error mapping, in-stream errors, cancellation, idle timeout, connection refused, custom auth headers, model listing variants |
| Webview | `webview/src/*.test.tsx` | Handshake, onboarding, composer keys, streaming deltas, the approval bar and its Enter/Escape shortcuts (arming delay, typed text, focused controls), rejection flows, diff parsing, live chat status, mode switching, Restricted Mode, stop and cancel, error rendering, markdown sanitization |
| Surfaces | `tests/unit/surfaces.test.ts` | The real controller with the view and editor tabs against a real HTTP model: per-surface chats and replies, parallel runs with approvals routed to their own chat, moving a chat to a tab, one place per chat, lists opened from a tab, approvals nobody sees, deleting a running chat |
| v0.2 features | `tests/unit/wave1.test.ts`, `tests/integration/ripgrep.test.ts` | Checkpoint recording and restore conflicts, compaction planning, auto-compaction and fallback, usage events, protected-path filtering of fast search, slash commands, fuzzy ranking, ripgrep against a real binary (skipped when `rg` is absent) |
| Documents | `tests/unit/documents.test.ts`, `tests/unit/hostAttachments.test.ts`, `tests/integration/documentWorker.test.ts` | Signature sniffing, UTF-16, the XML reader (no entity expansion, no prototype keys), ZIP limits including a size that lies, each converter on documents built in code (`tests/fixtures/documents.ts`), the budget, attaching and sending documents through the real controller (cache, fallback to text, protected files, files from the computer), and the worker bundled as it ships (timeout, cancellation, out of memory) |
| Images and read_file | `tests/unit/images.test.ts`, the *images* tests in `tests/unit/hostAttachments.test.ts` and `tests/unit/surfaces.test.ts` | Image signatures and sizes (`tests/fixtures/images.ts`), request content with and without vision, refusals and limits, what the agent learns and retries, the document cache, read_file on documents, UTF-16 and images (also through the checkpoint recorder), attaching and pasting images through the real controller, and the request a real HTTP server receives |
| Extension | `tests/extension/suite.cjs` | Activation, command registration, secure defaults, opening the view, chats in editor tabs (runs in CI) |

## Architecture rules

- `src/core` is portable. New capabilities reach it through ports in `src/core/ports.ts`.
- The host is authoritative. The webview sends intents and renders `AppState`, and never holds secrets.
- Every webview → host message has a zod schema in `src/shared/protocol.ts`.
- Security-relevant settings must be `application`-scoped and read with `userSetting()` in `src/extension/config.ts`.
- New tools declare a `risk` (`read`/`write`/`execute`). Write and execute tools must implement `prepare()` so the user sees exactly what will happen before approving.

## Dependency install scripts

npm 12 blocks the install scripts of dependencies unless `allowScripts` in `package.json` approves them. Sovran needs
none, so they are denied explicitly (which also silences npm's warning), and CI installs with `npm ci --ignore-scripts`
so it checks the same setup:

| Package | Script | Why it is not needed |
|---|---|---|
| `esbuild` | checks and optimizes the platform binary | the binary comes from esbuild's optional platform package |
| `@vscode/vsce-sign` | copies the signing binary | used only to sign packages (`--sign-tool`), which the release does not do |
| `ttf2woff2` (via fantasticon) | builds a native module with node-gyp | falls back to its WASM build; `npm run build:icons` gives a byte-identical font |
| `es5-ext` (via fantasticon) | prints a message for Russian time zones | no function |

When a new dependency brings an install script, npm lists it after `npm install`. Read the script, check whether the
project works without it (`npm ci --ignore-scripts`, then `npm run check`, `npm run build`, `npx vsce package`), and
record the decision with `npm install-scripts deny <pkg>` or `npm install-scripts approve <pkg>`.

## Dependency overrides

`package.json` pins two transitive **development** dependencies with `overrides` (nothing here ships in the VSIX;
`npm audit --omit=dev` is clean without them):

| Override | Why | Used by | Remove when |
|---|---|---|---|
| `minimatch` → `^11.0.4` | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249): denial of service through glob pattern amplification, fixed only in 11.0.1+ | ESLint, typescript-eslint, `@vscode/vsce`, `glob` | ESLint, typescript-eslint and vsce accept `^11` |
| `glob` → `^14.0.3` | [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4): traversal continues after an `AbortSignal` cancels it, fixed only in 14.0.2+. Also removes the `glob@10`/`glob@11` deprecation warnings | fantasticon, svgicons2svgfont, cacache (node-gyp for `ttf2woff2`) | fantasticon and its dependencies accept `^14` |

Both are major versions above what those packages declare, so a change to an override is checked against the tools'
real behaviour, not only `npm audit`: `npx vsce ls` lists the same files, ESLint lints the same files with the same
results, `npm run build:icons` produces a byte-identical `media/brand/sovran-icons.woff`, and `npm run check` passes.
Never use `npm audit fix --force` here: it "fixes" these by downgrading ESLint, typescript-eslint and fantasticon by
several majors.

## Manual compatibility matrix (M5)

Record the results in `docs/IMPLEMENTATION_STATUS.md`:

| Server | Native tools | Prompted tools | Streaming | /models | Cancel |
|---|---|---|---|---|---|
| Ollama | | | | | |
| LM Studio | | | | | |
| vLLM | | | | | |
| LiteLLM | | | | | |
| Enterprise gateway | | | | | |
