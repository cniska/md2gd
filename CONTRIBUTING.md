# Contributing

Thanks for your interest in md2gd.

## Setup

- [mise](https://mise.jdx.dev), then `mise install` for the Bun version pinned in `mise.toml`
- `bun install`

## Workflow

- Read `SPEC.md` first — it is the source of requirements (what, not how) — and `AGENTS.md` for conventions.
- Build in thin vertical slices; drive conversion changes test-first.
- Run `bun run check` (lint → typecheck → tests → audit) before every commit. It must be green.

## Tests

- `bun test`. Unit tests are pure and offline — mock the Google API boundary, never hit the network.
- The AST → `batchUpdate` mapping is tested by asserting the requests produced, not just that code runs.
- `bun run test:acceptance` proves `SPEC.md`'s acceptance criteria by running the compiled binary against a scripted Google.

## Commits

- Conventional commits: `type(scope): description`, single-line, at most 50 characters.

## Pull requests

- Keep `verify` green and cover the change with tests. Describe what changed and why.
