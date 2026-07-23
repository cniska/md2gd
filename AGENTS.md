# Project Rules

Read [SPEC.md](SPEC.md) before working on anything — it is the source of truth for requirements (what, not how), and any change to behavior or scope lands in it in the same commit; the spec never lags the code. `docs/architecture.md` describes how the current implementation does it (non-normative); read it before touching conversion or the executor.

`md2gd` is a terminal-first CLI that converts a Markdown file into a styled Google Doc through a strict one-way pipeline — parse (Markdown → mdast) → plan → convert/table (→ Docs `batchUpdate` requests, pure and offline) → executor/google (OAuth + REST). Never short-circuit it with string munging.

## Invariants

1. Conversion is AST-based and pure — no regex/string parsing of Markdown, no network or auth in the parse/plan/convert stages. The three stages stay separable: styling changes never touch parsing, and the Google API layer is always mockable.
2. Every config value and external input is validated through Zod before entering the type system.
3. OAuth requests only the `drive` scope — the workflow places docs in and updates docs the user did not create, which `drive.file` cannot reach, and `drive` also covers the Docs edits — never a broader or extra scope (AU-3). Tokens and secrets are never committed.
4. Google Docs offsets are UTF-16 code units (emoji are 2 units); all index arithmetic must account for this (`docs/architecture.md`).
5. Every SPEC §2.5 edge case and §3.1 styling pain point has an automated test. `bun run verify` must be green before every commit.

## Workflow

- Run locally: `bun run start -- <file.md>`.
- Compile a standalone binary: `bun build --compile src/cli.ts --outfile md2gd`.
- Verify (lint → typecheck → test → audit): `bun run verify`.
- Cut a release: bump `version` in `package.json`, commit `chore: release vX.Y.Z`, and push a matching `vX.Y.Z` tag — `.github/workflows/release.yml` builds the binaries, writes their checksums, and publishes the GitHub release. There is no local release script.

## Code

- No transitional architecture: land the canonical contract and single source of truth.
- No spec IDs (`FR-`/`ST-`/`NF-`/`AU-`) in code, comments, or test names — describe behavior in plain terms; SPEC.md is the reference for why.
- Define string unions / shared types as a Zod schema first, infer the TS type from it.
- Flat `src/`, colocated `*.test.ts`. No re-export layers.
- Factory naming: `create*`. Prefer direct `export const` over alias + `export { ... }`.
- `switch` exhaustiveness: a `default` branch with an `unreachable`/never check when applicable.
- Comments explain only the *why* a name, type, or test can't encode — never the *what*; no banner or separator comments.

## Style

- Stack: Bun + TypeScript ESM, strict; Zod at boundaries (SPEC §8a). `tsconfig.json` and `biome.json` are the source of truth for their settings — don't restate the values here.
- Biome is the formatter and linter of record: space indent, width 120, recommended preset.
- Never hard-wrap Markdown — one line per paragraph, let it soft-wrap.
- `.gitignore` covers credentials, tokens, and the built `/md2gd` binary; project config files are committed.

## Testing

- `bun test`. Unit tests are pure and offline: mock boundary effects (filesystem, network, Google APIs), never exercise them. Any real end-to-end check against Google is a separate, opt-in step.
- The AST → `batchUpdate` mapping is tested by asserting the requests produced, not just that code runs.
- Drive conversion changes test-first (red-green-refactor).

## Commits

- `type(scope): description` — types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`. Single-line subject, no body, under 72 characters, ASCII only. No issue references or spec IDs in the subject.
- Commit only when explicitly requested.

## Pull requests

- Merge gate: `bun run verify` green and the change covered by tests. Describe what changed and why.

## Docs

- `docs/architecture.md` is the non-normative how; update it when conversion or executor behavior changes.
