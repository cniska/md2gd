# md2gd — Specification

> A command-line tool that converts a Markdown file into a professionally styled Google Docs document in the user's Google Drive, and prints a link to it.

This document specifies **what** the tool must do, not **how**. Implementation choices (libraries, whether to go through the Google Docs API directly, via an intermediate format, or via native Markdown import) are left to the building agent, provided the requirements and acceptance criteria below are met. The stack itself is fixed (see §8a).

---

## 1. Purpose & context

The user regularly writes long-form Markdown documents (reports, due-diligence write-ups, specs) and repeatedly needs to turn them into Google Docs that look professional and are easy to share and comment on. Doing this by hand — copy, paste, restyle — is slow and inconsistent.

`md2gd` replaces that manual step with a single command:

```
md2gd path/to/document.md
```

The result is a new, cleanly styled Google Doc in the user's Drive, with its URL printed to the terminal.

### Primary user

A single technical user (the author) running the tool from a macOS terminal against their own personal Google account and Drive. Multi-user, server, or shared-team deployment is **out of scope** for v1.

### Reference product

`https://md2doc.com/` is the conceptual reference for output quality. The goal is comparable or better styling, delivered as a scriptable local CLI rather than a web app, with documents never leaving the user's own Google account.

---

## 2. Functional requirements

### 2.1 Core behavior

- **FR-1** — Accept a path to a single Markdown file as the primary argument.
- **FR-2** — Convert the file's content into a Google Docs document created in the user's Google Drive.
- **FR-3** — On success, print the created document's shareable URL to stdout.
- **FR-4** — The document title must default to the Markdown's top-level H1 if present, otherwise the input filename (without extension). The user must be able to override the title via an option.
- **FR-5** — Each run creates a **new** document (v1 default). The tool must not silently overwrite or mutate a pre-existing document.
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
- **FR-18** — Images. **URL-referenced images** (fetchable by Google's servers) are embedded inline at a reasonable width in v1. **Local-path images** are lower priority — the Docs API cannot embed a local file directly (it needs a Google-reachable URL), so v1 may warn-and-skip them per FR-21 rather than implement upload-and-temporary-link plumbing. (The reference document contains no images, so this is low-value for v1.) In all cases, an image that cannot be fetched/read must warn and continue, never abort the conversion.
- **FR-19** — Links must remain clickable in the output document.
- **FR-20** — Footnotes, rendered as Google Docs footnotes or an endnotes section if native footnotes are impractical.
- **FR-21** — Any Markdown construct not explicitly listed must degrade gracefully — rendered as readable text rather than raw markup or a crash.

### 2.4 Configuration & options (CLI)

- **FR-21a** — Provide an `md2gd init` command for one-time setup: it accepts the user's downloaded OAuth **Desktop client** secret (e.g. `md2gd init --client client_secret.json`), stores it, and runs the consent flow once (AU-1), caching the token. After `init`, all conversion is pure command-line. Rationale: Google does not permit plain API keys for Drive/Docs writes, so a per-user OAuth token is required; `init` makes acquiring it a single explicit step rather than a hidden first-run side effect.
- **FR-22** — Provide `--help` describing usage, arguments, and options.
- **FR-23** — Provide `--version`.
- **FR-24** — Allow overriding the document title (per FR-4).
- **FR-25** — Docs must land in a dedicated location rather than the Drive root. **Constraint (see AU-3):** v1 uses the narrow `drive.file` scope, which only grants access to files the tool itself creates — it cannot move docs into an arbitrary pre-existing folder. Therefore the tool must create and remember its **own** default folder (e.g. "md2gd") and place docs there. Targeting an arbitrary user-chosen existing folder is **descoped from v1** (would require the broad, verification-triggering `drive` scope); it may return later as an explicit opt-in.
- **FR-26** — Support a persistent config file for defaults (e.g. default title behavior) so the user need not repeat options every run. Config location must follow macOS conventions.
- **FR-27** — Provide a way to open the created doc in the browser on demand (e.g. `--open`), while the default remains print-link-only.

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
- **FR-34** — **Bold-only lines are captions, not headings.** Lines that are entirely bold (e.g. `**Customer journey**` preceding a table) are sub-labels. They must render as styled bold text and must **not** be promoted into the document heading outline.
- **FR-35** — **Adjacent tables with differing shapes.** The document places tables of different column counts near each other (3-col then 2-col) and two tables separated only by a bold caption. Each table's column widths must be sized independently, and consecutive tables must never merge into one.
- **FR-36** — **Wide/long table cells.** Description cells can hold paragraph-length text. Column widths must distribute so long-text columns get the space, cells wrap cleanly, and the table never overflows the page width (per ST-4).
- **FR-37** — **Bare domains in prose.** URLs written without a scheme or link syntax (e.g. `partybook-one.vercel.app`) appear as plain text. The tool must handle these consistently per the §9 auto-linking policy and never mangle them.

---

## 3. Styling requirements ("clean sensible default")

The chosen visual identity is a **neutral, clean, professional default** — no specific brand, logo, or corporate palette. The output must read as a polished, intentionally designed document, not a raw dump. The following define the desired **outcome**; the exact typographic values are the building agent's to tune toward this intent.

- **ST-1** — A coherent typographic hierarchy: body text in a highly readable serif or sans-serif at a comfortable reading size; headings clearly differentiated by size and weight, with H1 > H2 > H3 visibly distinct.
- **ST-2** — Sensible vertical rhythm: adequate space before/after headings, paragraphs, and lists so the document breathes and isn't cramped.
- **ST-3** — Comfortable line spacing for body text (not single-spaced dense).
- **ST-4** — Tables styled for readability: a visually distinct header row (e.g. bold and/or subtle background shade), light cell borders or row banding, and adequate cell padding. Tables must not overflow the page width.
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
- **AU-3** — Request the **minimum OAuth scopes** necessary. v1 uses only `drive.file` (access limited to files the tool creates) plus the Docs scope needed for `documents.create`/`batchUpdate`. Do **not** request the broad `drive` (all-files) scope — it is a sensitive scope that triggers Google verification and is unnecessary given the FR-25 own-folder model.
- **AU-4** — Tokens must refresh automatically when expired without forcing a full re-consent, until revoked.
- **AU-5** — Provide a documented way to reset/revoke local credentials (e.g. a `logout`/`reset-auth` command or deleting a documented file).
- **AU-6** — The tool must document the one-time Google Cloud project / OAuth client setup the user must perform, in clear step-by-step form (see §8). The docs **must** call out: (a) **publish the OAuth consent screen to "Production"** — leaving it in "Testing" causes Google to expire refresh tokens after 7 days, silently breaking AU-4; unverified-Production is fine for a personal tool, and (b) staying on `drive.file` keeps the app out of sensitive-scope verification entirely.
- **AU-7** — No document content or credentials may be sent to any third-party service other than Google's own APIs. All processing happens locally or within the user's Google account.
- **AU-8** — The loopback consent callback must be protected against authorization-code injection: a random `state` is verified on return and PKCE (S256) is used. Denied consent and a timeout must both terminate `init` cleanly rather than hang.

---

## 5. Non-functional requirements

- **NF-1** — Single-command install/run on macOS with minimal prerequisites; any required runtime or external dependency must be clearly documented.
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

---

## 6. Out of scope (v1)

- Reverse conversion (Google Docs → Markdown).
- Updating/syncing a previously created doc in place (may be a v2: "stable URL" mode). v1 always creates a new doc.
- Batch conversion of many files in one invocation (nice-to-have, not required).
- Multi-user / team / server deployment, or service-account automation.
- Syntax highlighting inside code blocks.
- Mermaid / diagram rendering, LaTeX math rendering.
- A GUI or web interface.
- Sharing/permission management of the created doc beyond it existing in the user's own Drive.

---

## 7. Acceptance criteria

The tool is considered done for v1 when all of the following hold:

- **AC-1** — Running `md2gd path/to/report.md` (the reference document) with valid auth produces a new Google Doc and prints its URL.
- **AC-2** — Opening that URL shows a document where: the title is correct; all headings appear in the Google Docs outline pane at the right levels; every table renders with a styled header row and no overflow; bold/italic/links/inline code/emoji render correctly; horizontal rules appear as dividers; bulleted lists render with correct nesting.
- **AC-3** — A test document exercising the full feature set in §2.3 (images, code blocks, blockquotes, task lists, nested numbered+bulleted lists, footnotes, strikethrough) renders each element correctly or degrades gracefully per FR-21, with no crash.
- **AC-4** — `md2gd init` completes auth via browser consent once; subsequent conversions reuse the cached token with no prompt and no browser.
- **AC-5** — The visual result is subjectively "professional" per §3 and at least matches `md2doc.com` output quality on the reference document.
- **AC-6** — `md2gd init` and all §2.4 CLI options (`--help`, `--version`, title override, `--open`) work as specified.
- **AC-7** — Error cases from NF-3 each produce a clear, non-crashing message and a non-zero exit code.
- **AC-8** — No credentials or document content are transmitted anywhere except Google's APIs; token/secret files are gitignored.

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
- **Auto-linking (FR-37):** do **not** invent hyperlinks from bare domains or fabricate link targets. Only explicit Markdown links (`[text](url)`) and explicit bare URLs with a scheme (`https://…`) become clickable links; a scheme-less domain like `partybook-one.vercel.app` renders as plain text, unchanged.

## 10. Recommended approach & first spike (advisory)

Not binding, but the reviewed recommendation the building agent should start from:

- **Conversion strategy: direct Google Docs API `batchUpdate`** — reject native Markdown import and the pandoc→docx→convert path. Both are black boxes that fail exactly on §3/§3.1 (no per-table column sizing, no cell-padding control, no deterministic spacing) and offer no fix, only workarounds. `batchUpdate` maps each hard requirement to a first-class field: `updateTableColumnProperties` (FIXED_WIDTH per table → FR-35/36), `updateTableCellStyle` (padding + header shading → ST-4/ST-13), `updateParagraphStyle` `spaceAbove`/`spaceBelow` from one central style table (ST-9/ST-11/ST-12/ST-14/NF-6).
- **Markdown parsing:** an AST-based parser (the `remark`/`mdast` ecosystem — `remark-parse` + `remark-gfm`, with a soft-break option for FR-32) runs fine under Bun. Rendering from a parsed AST makes FR-30 (literal chars in code spans), FR-33, and FR-34 fall out for free — cover them with tests, don't budget build effort for them.
- **Google API layer under Bun (per TS-7):** prefer the REST endpoints over `fetch` for the OAuth desktop flow and `batchUpdate`; only use an official SDK if it runs cleanly under Bun. This keeps the stack lean and Bun-native.
- **Known primary fragility:** Docs API offsets are **UTF-16 code units** — an emoji is 2 units, ZWJ sequences more — and a single miscount corrupts every later offset in a document full of em-dashes and emoji. Tables compound it (cells hold implicit paragraphs; filling them shifts indices). Standard mitigations: fill cells in reverse order, and/or run structure-creation and cell-population as separate `batchUpdate` rounds with a document GET between (extra round trips are well within NF-2).
- **First spike to de-risk before building the whole tool:** render the reference document's 16-row **Security findings table** end-to-end via `batchUpdate` — emoji-leading cells, bold lead-ins with em-dashes, inline code, one paragraph-length column, with fixed column widths, cell padding, and header shading. It exercises every risky mechanism at once (UTF-16 index math over emoji, cell-fill ordering, column-width computation, styled runs inside cells). If that table comes out clean and reproducible, the rest is well-trodden plumbing.
