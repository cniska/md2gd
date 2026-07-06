# Project Rules

## Architecture

`md2gd` is a terminal-first CLI that converts a Markdown file into a professionally styled Google Doc. Read `SPEC.md` before working on anything — it is the source of requirements (what, not how).

The pipeline is a strict three-stage flow; never short-circuit it with string munging:

1. **Parse** — Markdown → mdast AST (`src/parse.ts`, remark + GFM + soft-break policy).
2. **Convert** — walk the AST → emit Google Docs `batchUpdate` request objects. Pure and offline; the Google boundary is not touched here.
3. **Send** — the Google API layer performs OAuth, folder creation, `documents.create`, and `batchUpdate`.

Keep the three stages separable (NF-6): styling changes must not touch parsing; the API layer must be mockable.

## Invariants

These must always hold.

1. Conversion logic is AST-based and pure — no regex/string parsing of Markdown, no network or auth in stages 1–2.
2. Every config value and external input is validated through Zod before entering the type system.
3. OAuth uses only the `drive.file` + Docs scopes (AU-3). Never request the broad `drive` scope. Tokens/secrets are never committed (AU-2, NF-7).
4. Google Docs offsets are UTF-16 code units — emoji are 2 units. All index arithmetic must account for this (see SPEC §10).
5. Automated tests are non-negotiable (SPEC §5.1). Every §2.5 edge case and §3.1 styling pain point has a test. `verify` must be green before every commit.
6. Run `bun run verify` before every commit.

## Workflow

1. Build in thin vertical slices: implement one behavior, verify, commit, repeat. Never accumulate uncommitted work across many files.
2. Drive conversion slices test-first (red-green-refactor).
3. When behavior and tests diverge: fix the implementation. Update expectations only if explicitly requested.
4. Commit only when explicitly requested.

## Commits

Format: `type(scope): description` — types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`. Single-line subject, no body needed, under 72 characters, ASCII only. No issue references and no spec IDs (e.g. `(FR-32)`) in the subject — describe the change; SPEC.md is the reference for why.

## Code

- No transitional architecture: land the canonical contract and single source of truth.
- No spec IDs (`FR-`/`ST-`/`NF-`/`AU-`) in code, comments, or test names — describe behavior in plain terms; SPEC.md is the reference for why.
- Define string unions / shared types as a Zod schema first, infer the TS type from it.
- Flat `src/`, colocated `*.test.ts`. No re-export layers, no banner/separator comments.
- Factory naming: `create*`. Prefer direct `export const` over alias + `export { ... }`.
- `switch` exhaustiveness: `default` branch with an `unreachable`/never check when applicable.

## Style

- Match the fixed stack in SPEC §8a: Bun + TypeScript ESM (strict), Biome (space indent, width 120, recommended preset).
- Do not hard-wrap lines in Markdown files — one line per paragraph, let the editor soft-wrap.

## Testing

- `bun test`. Unit tests are pure: mock boundary effects (filesystem, network, Google APIs) instead of exercising them.
- The AST → `batchUpdate` mapping is tested by asserting the requests produced, not just that code runs (NF-9).
- Tests are deterministic and offline (NF-12). Any real end-to-end check against Google is a separate, opt-in step.
