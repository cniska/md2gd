# Contributing

Thanks for your interest in md2gd.

## Setup

- [Bun](https://bun.sh) 1.3+
- `bun install`

## Workflow

- Read `SPEC.md` first — it is the source of requirements (what, not how) — and `AGENTS.md` for conventions.
- Build in thin vertical slices; drive conversion changes test-first.
- Run `bun run verify` (lint → typecheck → tests → audit) before every commit. It must be green.

## Tests

- `bun test`. Unit tests are pure and offline — mock the Google API boundary, never hit the network.
- The AST → `batchUpdate` mapping is tested by asserting the requests produced, not just that code runs.

## Commits

- Conventional commits: `type(scope): description`, single-line, under 72 characters.

## Pull requests

- Keep `verify` green and cover the change with tests. Describe what changed and why.
