# md2gd — Specification

> A command-line tool that converts a Markdown file into a professionally styled Google Docs document in the user's Google Drive, and prints a link to it.

This document specifies **what** the tool must do, not **how**. Implementation choices are left to the building agent, provided the requirements and acceptance criteria below are met. The stack itself is fixed (see §8a); decisions deliberately left open are called out in §9. The how — offset math, table-fill ordering, batch structuring — lives in `docs/architecture.md`, not here.

---

## 1. Purpose & context

The user regularly writes long-form Markdown documents (reports, due-diligence write-ups, specs) and repeatedly needs to turn them into Google Docs that look professional and are easy to share and comment on. Doing this by hand — copy, paste, restyle — is slow and inconsistent.

`md2gd` replaces that manual step with a single command:

```
md2gd path/to/document.md
```

The result is a new, cleanly styled Google Doc in the user's Drive, with its URL printed to the terminal.

### Primary user

A single technical user (the author) running the tool from a macOS or Linux terminal against their own personal Google account and Drive. Multi-user, server, or shared-team deployment is **out of scope** for v1.

### Reference product

`https://md2doc.com/` is the conceptual reference for output quality. The goal is comparable or better styling, delivered as a scriptable local CLI rather than a web app, with documents never leaving the user's own Google account.

---

## 2. Functional requirements

### 2.1 Core behavior

- **FR-1** — Accept a path to a single Markdown file as the primary argument.
- **FR-2** — Convert the file's content into a Google Docs document created in the user's Google Drive.
- **FR-3** — On success, print the created document's shareable URL to stdout.
- **FR-4** — The document title must default to the Markdown's top-level H1 if present. Otherwise it defaults to a human-readable form of the input filename: the extension dropped and the stem word-separated (on `-`, `_`, spaces) with each word's first letter capitalised (e.g. `service-readiness-review.md` → "Service Readiness Review"). The user must be able to override the title via an option.
- **FR-5** — Each run creates a **new** document by default. The tool must never *silently* overwrite or mutate a pre-existing document; in-place update happens only when the user explicitly opts in via `--update` (see §2.6).
- **FR-6** — Exit with a zero status on success and a non-zero status on any failure, so the tool composes in scripts.

### 2.2 Input handling

- **FR-7** — Support UTF-8 input, including emoji and non-ASCII characters (the user's docs contain both, e.g. Finnish text and status emoji in tables).
- **FR-8** — Reject or clearly error on: missing file, unreadable file, empty file, and non-Markdown input, with an actionable message.
- **FR-9** — Resolve `~` and relative paths correctly.

### 2.3 Markdown feature coverage

The tool must faithfully render the following, mapping each to the closest native Google Docs construct. This is a **superset** of what the user's current documents use; the tool must not fail or degrade badly on any of them.

- **FR-10** — Headings, levels 1–6, mapped to Google Docs heading styles so the document's outline/navigation pane is populated correctly.
- **FR-11** — Paragraphs with inline formatting: **bold**, *italic*, ***bold+italic***, `inline code`, ~~strikethrough~~, and hyperlinks (`[text](url)`).
- **FR-12** — Bulleted and numbered lists, including nested lists (at least 3 levels deep) with correct indentation and marker style per level.
- **FR-13** — Task lists (`- [ ]` / `- [x]`) rendered legibly (checkbox glyphs or Google Docs checklist).
- **FR-14** — Tables, including header rows, with clean styling (see §3). Tables are the highest-frequency rich element in the user's docs and must render cleanly, preserving cell content including inline formatting and emoji.
- **FR-15** — Fenced and indented code blocks, in a monospace font with visual distinction from body text (e.g. shaded background or bordered block). Language hints need not produce syntax highlighting in v1.
- **FR-16** — Blockquotes, visually distinct from body text.
- **FR-17** — Horizontal rules (`---`) are **ignored** (produce no output). A bordered rule renders poorly in Google Docs, and heading spacing already separates sections, so thematic breaks are dropped rather than drawn.
- **FR-18** — Images degrade to their alt text (readable text, per FR-21); the tool never crashes on an image. Actual embedding is **out of scope for v1**: the reference documents contain no images, so it is low-value, and inline embedding via the Docs API is a self-contained slice (URL-reachable images via `insertInlineImage`; local images need upload plumbing) that can return later.
- **FR-19** — Links whose target a reader of the document can follow must remain clickable in the output. Links to targets that do not resolve outside the source tree — relative paths, bare filenames, in-page anchors, `file:` URLs — must render as plain text rather than dead links (see §9 auto-linking policy).
- **FR-20** — Footnotes degrade to readable text (per FR-21) without crashing. Native Google Docs footnotes are **out of scope for v1**: footnotes are a niche Markdown extension (not CommonMark) absent from the reference documents, and the Docs API's separate footnote segments do not fit the tool's index model — low value against real friction.
- **FR-21** — Any Markdown construct not explicitly listed must degrade gracefully — rendered as readable text rather than raw markup or a crash.

### 2.4 Configuration & options (CLI)

The complete command surface, enumerated once (each line's behavior is specified by the requirements below):

```
md2gd init [--client <client_secret.json>]                  One-time setup (browser consent)
md2gd <file.md> [--title <t>] [--folder <url|id>] [--open]  Convert into a new doc, print its URL
md2gd <file.md> --update [<url|id>] [--title <t>]           Re-render into an existing doc
md2gd --help | -h | help                                   Usage
md2gd --version | -V | version                             Version
```

- **FR-21a** — Provide an `md2gd init` command for one-time setup: it accepts the user's downloaded OAuth **Desktop client** secret (e.g. `md2gd init --client client_secret.json`), stores it, and runs the consent flow once (AU-1), caching the token. After `init`, all conversion is pure command-line. Rationale: Google does not permit plain API keys for Drive/Docs writes, so a per-user OAuth token is required; `init` makes acquiring it a single explicit step rather than a hidden first-run side effect.
- **FR-22** — Provide `--help` describing usage, arguments, and options.
- **FR-23** — Provide `--version`.
- **FR-24** — Allow overriding the document title (per FR-4).
- **FR-25** — Docs must land in a dedicated location rather than the Drive root. By default the tool creates and remembers its **own** folder (e.g. "md2gd") and places docs there. The user may override the destination per run with `--folder` (FR-27b), including a folder they did not create (e.g. a shared folder); this relies on the `drive` scope (AU-3). A `--folder` target the user cannot access, or that is not a folder, must fail with an actionable message and create nothing.
- **FR-26** — Persist tool state across runs in a user-scoped config file so invocations coordinate (v1 stores the file→doc mapping of FR-42). The file lives in a user-scoped location with restrictive permissions (AU-2), is forward-compatible (unknown keys are preserved rather than clobbered so later versions can add settings), and a corrupt file must never abort a conversion. The concrete on-disk layout is enumerated in §2.7.
- **FR-27** — Provide a way to open the created doc in the browser on demand (e.g. `--open`), while the default remains print-link-only.
- **FR-27a** — Provide an `--update [<url-or-id>]` option that re-renders into an existing document rather than creating a new one (see §2.6). With no argument, it targets the doc previously created from the same input file; with an argument, it targets that specific doc.
- **FR-27b** — Provide a `--folder <url-or-id>` option that places a newly created doc in the given Drive folder instead of the default folder (FR-25). It accepts either a full Drive folder URL or a bare folder id. It applies only when creating; with `--update` the target doc keeps its existing location and `--folder` has no effect.

### 2.5 Content edge cases requiring special handling

These are derived from analyzing the reference due-diligence report and are the constructs that naive converters most often get wrong. Each is a **requirement**, not a nice-to-have.

- **FR-28** — **Rich content inside table cells.** Cells routinely contain **bold** lead-ins, `inline code`, quoted strings, and em-dashes in the same cell. Inline formatting inside cells must be preserved — cells must not be flattened to plain text. (The report's severity tables lead each cell with a bold phrase followed by an em-dash and prose, plus inline code like `` `WebhookSecret` ``.)
- **FR-29** — **Emoji as status markers.** Color emoji (✅ ❌ 🕐 🟠 🟡 🔴 and others) appear as the first token in table cells (e.g. "🟠 High", "✅ Working") and inline in text. They must render as color emoji — not stripped, not converted to monochrome tofu — and stay on the same line as the text that follows them.
- **FR-30** — **Markdown-significant characters inside inline code must be literal.** Code spans contain `_`, `*`, `/`, `;`, and spaces (e.g. `` `sk_test_` ``, `` `HttpOnly; SameSite=Strict` ``, `` `POST /api/auth/resend-confirmation` ``, `` `*` ``). These must never be interpreted as emphasis, links, or list markers.
- **FR-31** — **Unicode typography must survive intact.** Em-dashes (—, ~88 in the reference doc), en-dashes (–), arrows (→), and curly quotes (" " ' ') must pass through unchanged and never be corrupted to mojibake or ASCII-fied.
- **FR-32** — **Soft line breaks.** When single (non-blank-separated) lines are clearly meant as stacked lines — e.g. the document's metadata block:
  ```
  **Date:** July 5, 2026
  **Subject:** …
  **Classification:** Confidential
  ```
  they must render as separate lines, not collapsed into one run-on paragraph. (Strict CommonMark collapses soft breaks to spaces; that is the wrong outcome here.) See §9 for the chosen policy.
- **FR-33** — **Tightly-grouped metadata blocks.** A run of consecutive single-line `**Key:** value` paragraphs (the header block) should read as a grouped block with tight spacing, not with full inter-paragraph gaps between each line — while normal body paragraphs still get the spacing of ST-11.
- **FR-34** — **Bold-only lines are captions, not headings.** Lines that are entirely bold (e.g. `**Customer journey**` preceding a table) are sub-labels. They must render as styled bold text with caption spacing — space above to separate them from preceding content and tight space below so they group with the element they introduce (typically a table) — and must **not** be promoted into the document heading outline.
- **FR-35** — **Adjacent tables with differing shapes.** The document places tables of different column counts near each other (3-col then 2-col) and two tables separated only by a bold caption. Each table's column widths must be sized independently, and consecutive tables must never merge into one.
- **FR-36** — **Wide/long table cells.** Description cells can hold paragraph-length text. Column widths must distribute so long-text columns get the space, cells wrap cleanly, and the table never overflows the page width (per ST-4). Conversely, a short-content column (e.g. a one-word status/severity column) must be wide enough to hold its widest cell on a single line rather than pinned so narrow that short values wrap.
- **FR-37** — **Bare domains in prose.** URLs written without a scheme or link syntax (e.g. `partybook-one.vercel.app`) appear as plain text. The tool must handle these consistently per the §9 auto-linking policy and never mangle them.

### 2.6 Updating an existing document ("stable URL" mode)

The user's core loop is *edit the Markdown, regenerate the Doc*. Creating a fresh doc every time breaks shared links and scatters near-duplicates across Drive. `--update` re-renders into the **same** document so its URL, Drive location, and shares stay put. This was deferred in the original §6; it is now in scope.

**Scope (inherits AU-3):** because the tool uses the `drive` scope, `--update` may target **any document the user can edit** — one md2gd created, or one made by hand or shared into a folder. The tool never *silently* updates: a plain run always creates (FR-5), and an update requires either the explicit `--update <url|id>` or a remembered mapping for the file (FR-42).

- **FR-38** — **Clear-and-rewrite semantics.** `--update` targets an existing doc, clears its body, and re-runs the normal conversion into it. Content diffing / in-place patching is explicitly **not** attempted: a cleared doc must render identically to a freshly created one from the same Markdown.
- **FR-39** — **Read before destroy.** The tool must GET the target document *before* issuing any destructive call, so an auth failure, 404, or permission error leaves the target intact and the run exits non-zero with a clear message (per NF-3).
- **FR-40** — **No style bleed.** After clearing, the surviving paragraph must be reset to default body style with list markers removed, so the previous render's trailing heading/list style does not leak into the new content. An already-empty body must be handled without error.
- **FR-41** — **Title stays in sync.** If the derived/overridden title differs from the target doc's current name, the tool must rename the Drive file to match, so the doc's title does not go stale after an update.
- **FR-42** — **File→doc mapping (hybrid UX).**
  - On a successful *create*, record `realpath(input) → documentId` in the config location (§2.4, FR-26).
  - `md2gd file.md --update` with **no argument** updates the doc previously created from that file (looked up in the mapping). `--update <url-or-id>` overrides with an explicit target and accepts either a full Docs URL or a bare document id.
  - A plain run (no `--update`) when a mapping already exists still **creates a new doc**, but prints a hint — e.g. `previously created <url> — pass --update to overwrite` — so the destructive path is never taken implicitly.
  - A stale mapping (target trashed or not found) must produce a clear error, not silently diverge into a new doc.
- **FR-43** — **Honest limitations documented, not engineered around.** Google Docs comments anchored to cleared ranges will orphan, and a multi-round update is not atomic (a mid-run failure can leave the doc partially rewritten). These are acceptable for the single-user regenerate loop; they must be documented (README) rather than solved in v1. An `--update` target the user cannot access or edit (wrong id, no permission, trashed) must fail at the read-before-destroy step (FR-39) with an actionable message, leaving nothing changed — never a raw API error.

### 2.7 Config & credential storage

All persisted state lives under a single user-scoped directory, created with owner-only permissions (AU-2). The location follows platform convention: `~/.md2gd/` on macOS, and `$XDG_CONFIG_HOME/md2gd` (default `~/.config/md2gd`) on Linux. It holds:

- **`client_secret.json`** — the OAuth Desktop client secret supplied to `md2gd init` (FR-21a). Owner-only.
- **`token.json`** — the cached OAuth token, including the refresh token (AU-4). Owner-only.
- **`config.json`** — tool state (FR-26). A JSON object whose `docs` key maps each input file's canonical absolute path to the id of the document last created from it (FR-42): `{ "docs": { "/abs/path/report.md": "<documentId>" } }`. Unknown top-level keys are preserved on write.

Deleting this directory resets the tool to its unconfigured state (AU-5). The layout and location must be documented (D-2).

---

## 3. Styling requirements ("clean sensible default")

The chosen visual identity is a **neutral, clean, professional default** — no specific brand, logo, or corporate palette. The output must read as a polished, intentionally designed document, not a raw dump. The following define the desired **outcome**; the exact typographic values are the building agent's to tune toward this intent.

- **ST-1** — A coherent typographic hierarchy: body text in a highly readable serif or sans-serif at a comfortable reading size; headings clearly differentiated by size and weight, with H1 > H2 > H3 visibly distinct.
- **ST-2** — Sensible vertical rhythm: adequate space before/after headings, paragraphs, and lists so the document breathes and isn't cramped.
- **ST-3** — Comfortable line spacing for body text (not single-spaced dense).
- **ST-4** — Tables styled for readability: a visually distinct header row (e.g. bold and/or subtle background shade), light cell borders or row banding, and adequate cell padding. Tables must not overflow the page width, and a row must not split across a page break — a row that doesn't fit moves whole to the next page.
- **ST-5** — Code and inline code in a monospace font, visually set apart from prose.
- **ST-6** — Blockquotes visually indented and/or accented.
- **ST-7** — Consistent, professional page margins.
- **ST-8** — Links styled in a conventional link appearance (e.g. colored, underlined) while remaining clickable.
- **ST-9** — The styling must be **consistent and reproducible**: the same input produces the same look every time, and the look is uniform across all documents the tool generates.
- **ST-10** — The result should be at least on par with `md2doc.com` in perceived polish.

### 3.1 Known pain points (must be handled, not left to fix by hand)

These are concrete defects the user has repeatedly had to correct by hand when converting via naive/plain-HTML output. Getting them right is a **hard requirement**, since fixing them manually in Google Docs is precisely the toil this tool exists to eliminate.

- **ST-11** — **Paragraph spacing:** there must be clear space *between* paragraphs (via space-after on paragraphs, not blank lines). Body text must not run together as one dense block.
- **ST-12** — **Space after block elements:** there must be adequate space *after* tables, code blocks, blockquotes, and lists before the following content — these must not butt directly against the next paragraph.
- **ST-13** — **Table cell padding:** table cells must have visible internal padding on all sides. Text must not touch cell borders.
- **ST-14** — **Space before headings:** headings must have more space above them than below, so sections are visually grouped with their content.

Styling should be centralized/configurable enough that the default look can be adjusted in one place later (e.g. to introduce brand fonts/colors) without rewriting the conversion logic — but exposing that configuration to the end user is not required in v1.

---

## 4. Authentication & authorization requirements

- **AU-1** — Authenticate to Google as the **user's personal Google account** using an OAuth "installed application" (desktop) flow, initiated by `md2gd init` (FR-21a). It opens the system browser for consent once (a loopback redirect captures the code); subsequent runs reuse a locally cached token. Plain API keys are **not** an option — Google rejects them for Drive/Docs writes — and service accounts are unsuitable (no personal Drive storage, wrong ownership), so a cached user OAuth token is the mechanism.
- **AU-2** — Cached credentials/tokens must be stored securely in a user-scoped location with appropriately restrictive file permissions, and must never be committed to the repository.
- **AU-3** — Request only the scope the tool's capabilities require, and no more. Because the tool must place docs in folders the user did not create (FR-27b) and update docs it did not itself create (§2.6), it uses the `drive` scope, which also covers the Docs edits (`documents.create`/`batchUpdate`), so no separate Docs scope is requested. This is a deliberate tradeoff: `drive` is a sensitive scope, but the narrower `drive.file` cannot reach user-created folders or foreign docs, which are core to the workflow. The tool must never request more than `drive`.
- **AU-4** — Tokens must refresh automatically when expired without forcing a full re-consent, until revoked.
- **AU-5** — Resetting local credentials must be possible and documented. v1 does this by deleting the config directory (§2.7), which removes the cached token and stored client secret; the next `init` re-consents from scratch.
- **AU-6** — The tool must document the one-time Google Cloud project / OAuth client setup the user must perform, in clear step-by-step form (see §8). The docs **must** call out: (a) **publish the OAuth consent screen to "Production"** — leaving it in "Testing" causes Google to expire refresh tokens after 7 days, silently breaking AU-4; and (b) that `drive` is a **sensitive scope**, so consent shows an "unverified app" warning the user clicks through — fine for a personal tool run against one's own account; distributing it to others would require Google verification.
- **AU-7** — No document content or credentials may be sent to any third-party service other than Google's own APIs. All processing happens locally or within the user's Google account.
- **AU-8** — The loopback consent callback must be protected against authorization-code injection: a random `state` is verified on return and PKCE (S256) is used. Denied consent and a timeout must both terminate `init` cleanly rather than hang.

---

## 5. Non-functional requirements

- **NF-1** — Single-command install/run on macOS or Linux with minimal prerequisites; any required runtime or external dependency must be clearly documented.
- **NF-2** — Convert a typical document (~400 lines, multiple tables, like the reference due-diligence report) in a few seconds, network round-trips aside.
- **NF-3** — Clear, human-readable error messages for the common failure modes: no network, auth failure/expired consent, invalid file, Drive permission denied, API rate limiting. Errors must not dump raw stack traces as the primary output.
- **NF-4** — Idempotent auth: running repeatedly does not create duplicate credentials or re-prompt unnecessarily.
- **NF-5** — Handle Google API rate limits / transient errors with sensible retry behavior rather than immediate hard failure.
- **NF-6** — The codebase must be structured so conversion logic, styling, and the Google API integration are separable (styling can change without touching parsing; API layer can be tested/mocked independently).
- **NF-7** — Sensitive files (tokens, client secrets, credentials) must be listed in `.gitignore` from the start.

### 5.1 Automated testing (non-negotiable)

Automated tests are a **hard requirement**, not optional. The tool must not be considered complete without them, and they must be present and passing throughout development — not bolted on at the end.

- **NF-8** — An automated test suite (`bun test`) must ship with the tool and be wired into the `verify` script (TS-6). `verify` must pass before any release.
- **NF-9** — The conversion layer must be **unit-tested against the Google API boundary mocked** (per NF-6), so the markdown-AST → `batchUpdate`-request mapping is verified without live network or auth. Tests assert the *requests produced*, not just that code runs.
- **NF-10** — Every §2.5 edge case (FR-28 through FR-37) must have a dedicated test proving correct output: rich content in cells, emoji preservation, literal chars in code spans, Unicode typography survival, soft-break handling, caption-not-heading, per-table column sizing, no-overflow, bare-domain handling. These are the constructs that regress silently, so they are tested explicitly.
- **NF-11** — The §3.1 styling pain points (ST-11 through ST-14) must be covered by tests asserting the corresponding paragraph/table style fields are emitted (paragraph space-after, space-after-blocks, cell padding, space-before-headings).
- **NF-12** — Tests must be deterministic and runnable offline (no dependency on live Google APIs or cached credentials). Any real end-to-end check against Google is a separate, opt-in step, not part of the default suite.
- **NF-13** — The update path (§2.6) must be unit-tested against the mocked Google boundary: the body-clear requests (including the style reset and the already-empty-body case), the GET-before-destroy ordering, the rename-on-title-change, and the mapping lookup / override / stale-mapping behavior. As with NF-9, tests assert the *requests produced*, not just that code runs.
- **NF-14** — The `--folder` option (FR-27b) must be unit-tested: extracting a folder id from a Drive folder URL and from a bare id, that a create places the doc under the given folder rather than the default (FR-25), and that `--update` ignores it. The title-cased filename fallback (FR-4) must likewise have dedicated tests.

---

## 6. Out of scope (v1)

- Reverse conversion (Google Docs → Markdown).
- ~~Updating/syncing a previously created doc in place.~~ **Now in scope** as "stable URL" mode — see §2.6 (FR-38–FR-43), for any doc the user can edit.
- Headers / footers, and page numbers. The Docs API has no page-number field request, and a footer is a single block shared across all pages, so a live page number is not achievable via `batchUpdate` at all. A static title header is possible but low-value (the doc already opens with its H1) and is deferred; it can be added later as an isolated slice.
- Batch conversion of many files in one invocation (nice-to-have, not required).
- Multi-user / team / server deployment, or service-account automation.
- Syntax highlighting inside code blocks.
- Image embedding (images degrade to alt text — FR-18) and native footnotes (footnotes degrade to text — FR-20).
- Mermaid / diagram rendering, LaTeX math rendering.
- A GUI or web interface.
- Sharing/permission management of the created doc beyond it existing in the user's own Drive.

---

## 7. Acceptance criteria

The tool is considered done for v1 when all of the following hold:

- **AC-1** — Running `md2gd path/to/report.md` (the reference document) with valid auth produces a new Google Doc and prints its URL.
- **AC-2** — Opening that URL shows a document where: the title is correct; all headings appear in the Google Docs outline pane at the right levels; every table renders with a styled header row and no overflow; bold/italic/links/inline code/emoji render correctly; horizontal rules produce no output (per FR-17); bulleted lists render with correct nesting.
- **AC-3** — A test document exercising the full feature set in §2.3 (images, code blocks, blockquotes, task lists, nested numbered+bulleted lists, footnotes, strikethrough) renders each element correctly or degrades gracefully per FR-21, with no crash.
- **AC-4** — `md2gd init` completes auth via browser consent once; subsequent conversions reuse the cached token with no prompt and no browser.
- **AC-5** — The visual result is subjectively "professional" per §3 and at least matches `md2doc.com` output quality on the reference document.
- **AC-6** — `md2gd init` and all §2.4 CLI options (`--help`, `--version`, title override, `--open`) work as specified.
- **AC-7** — Error cases from NF-3 each produce a clear, non-crashing message and a non-zero exit code.
- **AC-8** — No credentials or document content are transmitted anywhere except Google's APIs; token/secret files are gitignored.
- **AC-9** — Re-running with `--update` on an editable doc (whether md2gd created it or not) re-renders it at the **same** URL: the body reflects the edited Markdown, no prior-render style bleeds in, the title tracks the H1, and a failed GET leaves the doc untouched. An `--update` target the user cannot access fails with a clear message (FR-43), not a raw API error.
- **AC-10** — Running `md2gd file.md --folder <url|id>` on a folder the user can write (including a shared folder they did not create) places the new doc in that folder; a plain run still lands in the default md2gd folder (FR-25, FR-27b).

---

## 8. Deliverables

- **D-1** — The working CLI tool, invokable as `md2gd`.
- **D-2** — A `README.md` covering: install, the one-time Google Cloud / OAuth client setup (AU-6), first-run auth, usage examples, all options, config file format and location, and how to reset credentials.
- **D-3** — A sample/test Markdown file exercising the full §2.3 feature set, used for AC-3.
- **D-4** — `.gitignore` covering tokens, client secrets, and any local build artifacts, present from the first commit.
- **D-5** — The automated test suite required by §5.1, passing via `verify`.

---

## 8a. Tech stack & engineering conventions (fixed)

The stack is decided and mirrors the user's `acolyte` project — match its conventions rather than introducing new ones:

- **TS-1** — **Runtime:** Bun. Language: TypeScript, ESM (`"type": "module"`), strict mode. Prefer Bun-native APIs (`Bun.serve`, native `fetch`, `Bun.file`) and avoid Node-only dependencies where a leaner path exists.
- **TS-2** — **CLI entry:** a `bin` mapping `md2gd` → `src/cli.ts`, runnable directly under Bun.
- **TS-3** — **Lint/format:** Biome (`^2.5`), matching acolyte's `biome.json` (space indent, line width 120, recommended preset). `format` = `biome format --write .`; `lint` = `biome check --error-on-warnings .`.
- **TS-4** — **tsconfig:** align with acolyte — target ES2022, ESNext modules, Bundler resolution, `strict`, `verbatimModuleSyntax`, `types: ["bun"]` (+`node` only if needed).
- **TS-5** — **Validation:** use `zod` for config-file and external-input validation.
- **TS-6** — **Testing:** `bun test`. Provide a `verify` script chaining lint → typecheck (`tsc --noEmit`) → test → `bun audit`, matching acolyte.
- **TS-7** — Dependencies stay minimal and Bun-compatible. The Google API layer may hit the REST endpoints directly with `fetch` (leaner) or use an official SDK **only if** it runs cleanly under Bun; do not pull in a heavy Node-only SDK if the REST path is straightforward.
- **TS-8** — `.gitignore` from the first commit (per NF-7), plus a Biome config and `tsconfig.json` committed up front.

## 9. Open decisions left to the building agent

These are explicitly **not** constrained by this spec; choose what best satisfies the requirements:

- How styling is expressed and centralized (§3, NF-6).
- Exact typographic values (fonts, sizes, spacing, colors) toward the §3 intent.
- Config file format and CLI option syntax.

### Policies referenced above (chosen, not open)

- **Soft line breaks (FR-32):** render a single newline within a paragraph as a line break (i.e. treat source line breaks as intended). The reference document is not hard-wrapped at a column width, so this reproduces author intent without side effects. If a future document turns out to be hard-wrapped, revisit.
- **Auto-linking (FR-37):** do **not** invent hyperlinks from bare domains or fabricate link targets. A link becomes clickable only when its target resolves outside the source document — an absolute URL with a followable scheme (`http`, `https`, `mailto`, `tel`). Explicit Markdown links to a local target (a relative path, bare filename, or in-page anchor like `#section`) and unsafe schemes (`javascript:`, `data:`, `file:`) render as plain styled text: they would be dead links in a Google Doc (FR-19). A scheme-less bare domain like `partybook-one.vercel.app` likewise stays plain text, unchanged.

The implementation approach, the UTF-16 offset hazard, and the two-phase table flow are non-normative and documented in `docs/architecture.md`.
