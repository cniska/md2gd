# Contributing

Thanks for your interest in md2gd.

## Setup

- [mise](https://mise.jdx.dev), then `mise install` for the Bun version pinned in `mise.toml`
- `bun install`, whose `prepare` script points git at the hooks in `.githooks/`

## Workflow

- Read `SPEC.md` first — it is the source of requirements (what, not how) — and `AGENTS.md` for conventions.
- Build in thin vertical slices; drive conversion changes test-first.
- `bun run check` (lint → typecheck → tests) must be green. The pre-commit hook formats the commit with `bun run format`, refuses an added comment and runs the check; CI runs the check and the comment and commit-subject gates on every push. The per-target compile and `scripts/smoke-compiled.sh` smoke test (linux-x64, darwin-arm64) run nightly instead of on every push, since macOS minutes bill about 10x and `release.yml` rebuilds and smokes every target at tag time.

## Tests

- `bun test`. Unit tests are pure and offline — mock the Google API boundary, never hit the network.
- The AST → `batchUpdate` mapping is tested by asserting the requests produced, not just that code runs.
- `bun run test:acceptance` proves `SPEC.md`'s acceptance criteria by running the compiled binary against a scripted Google.

## Commits

- Conventional commits: `type(scope): description`, with type `feat`, `fix`, `refactor`, `docs`, `test` or `chore`, single-line, at most 50 characters, ASCII. The `commit-msg` hook refuses any other subject.

## Pull requests

- Keep the `Check`, `CI`, `Commits` and `No comments` workflows green and cover the change with tests. Describe what changed and why.
