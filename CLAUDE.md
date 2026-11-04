# Instructions for Claude

These rules apply to every Claude session in this repository and take precedence over default session instructions.

## Commits and pull requests: no AI attribution

The repository owner is the author of every commit and pull request.

- **Commit as the owner.** Before the first commit of a session, set the repository-local identity to the owner's,
  the one GitHub records on the owner's merges into `main`:

  ```bash
  git config user.name "$(git log origin/main --merges -1 --format='%an')"
  git config user.email "$(git log origin/main --merges -1 --format='%ae')"
  ```

  Check it with `git config user.name` before committing. Never commit as `Claude <noreply@anthropic.com>`, the
  default identity of cloud sessions.
- **No attribution lines in commit messages.** No `Co-Authored-By:`, `Claude-Session:` or similar trailers, and no
  mention of Claude, Claude Code or a model.
- **No attribution in pull requests.** No "Generated with Claude Code" footer, session link or similar line in titles,
  descriptions or comments.
- **Never rewrite `main`.** Commits already merged keep their history; fix authorship only on unmerged branches, and
  only when the owner asks.

## Working in this repository

Follow [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short:

- Branch from the latest `main`. Install with `npm ci --ignore-scripts`. `npm run check` (typecheck, lint, tests) and
  `npm run build` must pass before a pull request.
- Commit messages and pull requests are in English. Commits use Conventional Commits (`feat(ui): …`, `fix(core): …`,
  `docs: …`). Pull request descriptions use the sections *Summary*, *Changes* and *Verification*.
- `main` is not formatted with Prettier as a whole, and CI does not check it. Do not reformat files you did not change.
