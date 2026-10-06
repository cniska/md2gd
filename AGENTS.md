# Project Rules

Read [SPEC.md](SPEC.md) before working on anything — it is the source of truth for requirements (what, not how), and any change to behavior or scope lands in it in the same commit; the spec never lags the code. `docs/architecture.md` describes how the current implementation does it (non-normative); read it before touching conversion or the executor.

`md2gd` is a terminal-first CLI that converts a Markdown file into a styled Google Doc through a strict one-way pipeline — parse (Markdown → mdast) → plan → convert/table (→ Docs `batchUpdate` requests, pure and offline) → executor/google (OAuth + REST). Never short-circuit it with string munging.

## Invariants

1. Conversion is AST-based and pure — no regex/string parsing of Markdown, no network or auth in the parse/plan/convert stages. The three stages stay separable: styling changes never touch parsing, and the Google API layer is always mockable.
2. Every config value and external input is validated through Zod before entering the type system.
3. OAuth requests only the `drive` scope — the workflow places docs in and updates docs the user did not create, which `drive.file` cannot reach, and `drive` also covers the Docs edits — never a broader or extra scope (AU-3). Tokens and secrets are never committed.
4. Google Docs offsets are UTF-16 code units (emoji are 2 units); all index arithmetic must account for this (`docs/architecture.md`).
5. Every SPEC §2.5 edge case and §3.1 styling pain point has a unit test, and every §7 criterion has an acceptance test or a todo; the citation check in `bun test` ties the criteria to the requirements and the tests. `bun run verify` must be green before every commit.

## Workflow

- Run locally: `bun run start -- <file.md>`.
- Compile a standalone binary: `bun build --compile src/cli.ts --outfile md2gd`.
- Verify (lint → typecheck → test → audit): `bun run verify`.
- Prove the spec's criteria against a scripted Google: `bun run test:acceptance` (compiles the binary first).
- See a change in a real Google Doc: `bun run render -- <file.md>`; the recipe (credentials, evidence, cleanup) is `.claude/skills/md2gd-verify-doc/SKILL.md`. Run it after conversion, styling, or executor changes.
- Cut a release: bump `version` in `package.json`, commit `chore: release vX.Y.Z`, and push a matching `vX.Y.Z` tag — `.github/workflows/release.yml` builds the binaries, writes their checksums, and publishes the GitHub release. There is no local release script.

## Code

- No transitional architecture: land the canonical contract and single source of truth.
- No spec IDs (`FR-`/`ST-`/`NF-`/`AU-`) in code, comments, or test names — describe behavior in plain terms; SPEC.md is the reference for why. `bun run lint` enforces it.
- Define string unions / shared types as a Zod schema first, infer the TS type from it.
- Flat `src/`, colocated `*.test.ts`. No re-export layers.
- Factory naming: `create*`. Prefer direct `export const` over alias + `export { ... }`.
- `switch` exhaustiveness: a `default` branch with an `unreachable`/never check when applicable.
- Comments explain only the *why* a name, type, or test can't encode — never the *what*; no banner or separator comments.

## Style

- Biome is the formatter and linter of record; `tsconfig.json` and `biome.json` own their settings — don't restate them here.
- Never hard-wrap Markdown — one line per paragraph, let it soft-wrap.
- Credentials, tokens, build output, and render evidence stay out of git (`.gitignore`); project config files are committed.

## Testing

- `bun test`. Unit tests are pure and offline: mock boundary effects (filesystem, network, Google APIs), never exercise them. The live Google check (`bun run render`) stays out of `verify`.
- The AST → `batchUpdate` mapping is tested by asserting the requests produced, not just that code runs.
- Acceptance tests (`acceptance/*.acceptance.ts`) run the compiled binary against the scripted Google in `acceptance/support/`, each in its own temporary home. A test's name starts with the criteria it proves; a case exposing a known bug is `test.failing`, one the suite cannot reach is `test.todo`.
- Drive conversion changes test-first (red-green-refactor).

## Commits

- `type(scope): description` — types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`. Single-line subject, no body, under 72 characters, ASCII only. No issue references or spec IDs in the subject.

## Process

- Commit only when explicitly requested, and push directly to `main`; no feature branches or pull requests.
- Clean up after yourself once work lands: delete the branches, clones, and scratch files you created.

## Docs

- `docs/architecture.md` is the non-normative how; update it when conversion, executor, or Google client behavior changes.
