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
- **FR-15** — A table column's alignment (`:--` left, `:-:` center, `--:` right) applies to every cell in that column, header included; a column without one is left-aligned.
- **FR-16** — Fenced and indented code blocks, in a monospace font with visual distinction from body text (e.g. shaded background or bordered block). Language hints need not produce syntax highlighting in v1.
- **FR-17** — Blockquotes, visually distinct from body text.
- **FR-18** — Horizontal rules (`---`) are **ignored** (produce no output).
- **FR-19** — Images degrade to their alt text (readable text, per FR-22); the tool never crashes on an image. Embedding images is out of scope (§6).
- **FR-20** — Links whose target a reader of the document can follow must remain clickable in the output. Links to targets that do not resolve outside the source tree — relative paths, bare filenames, in-page anchors, `file:` URLs — must render as plain text rather than dead links (see §9 auto-linking policy) — except a relative link whose target is present in a supplied link map (FR-32), which is upgraded to a live link to that document's Google Doc URL.
- **FR-21** — Footnotes degrade to readable text (per FR-22) without crashing. Native Google Docs footnotes are out of scope (§6).
- **FR-22** — Any Markdown construct not explicitly listed must degrade gracefully — rendered as readable text rather than raw markup or a crash.

### 2.4 Configuration & options (CLI)

The complete command surface, enumerated once (each line's behavior is specified by the requirements below):

```
md2gd init [--client <client_secret.json>]                                                      One-time setup (browser consent)
md2gd <file.md> [--title <t>] [--folder <url|id>] [--links <map>] [--open]                      Convert into a new doc, print its URL
md2gd <file.md> --update [<url|id>] [--title <t>] [--folder <url|id>] [--links <map>] [--open]  Re-render into an existing doc
md2gd --help | -h | help                                                                        Usage
md2gd --version | -V | version                                                                  Version
```

- **FR-23** — Provide an `md2gd init` command for one-time setup: it accepts the user's downloaded OAuth **Desktop client** secret (e.g. `md2gd init --client client_secret.json`), stores it, and runs the consent flow once (AU-1), caching the token. After `init`, all conversion is pure command-line.
- **FR-24** — Provide `--help` describing usage, arguments, and options.
- **FR-25** — Provide `--version`.
- **FR-26** — Allow overriding the document title (per FR-4).
- **FR-27** — Docs must land in a dedicated location rather than the Drive root. By default the tool places docs in its **own** folder (e.g. "md2gd"), created on first use and reused on every later run. The user may override the destination per run with `--folder` (FR-31), including a folder they did not create — one shared with them, or one inside a shared drive; this relies on the `drive` scope (AU-3). A `--folder` target the user cannot access, or that is not a folder, must fail with an actionable message and create nothing.
- **FR-28** — Persist tool state across runs in a user-scoped config file so invocations coordinate (v1 stores the file→doc mapping of FR-50). The file lives in a user-scoped location with restrictive permissions (AU-2), is forward-compatible (unknown keys are preserved rather than clobbered so later versions can add settings), and a corrupt file must never abort a conversion. The concrete on-disk layout is enumerated in §2.7.
- **FR-29** — Provide a way to open the resulting doc, created or updated, in the browser on demand (e.g. `--open`), while the default remains print-link-only.
- **FR-30** — Provide an `--update [<url-or-id>]` option that re-renders into an existing document rather than creating a new one (see §2.6). With no argument, it targets the doc previously created from the same input file; with an argument, it targets that specific doc.
- **FR-31** — Provide a `--folder <url-or-id>` option naming a destination Drive folder, accepting either a full Drive folder URL or a bare folder id. The folder may sit in the user's own Drive or in a shared drive, and a shared-drive destination behaves identically. On a create, the new doc is placed in that folder instead of the default folder (FR-27). On an `--update`, the target doc is moved into that folder (its URL is unchanged); with no `--folder`, an update leaves the doc where it is. A folder the user cannot access, or that is not a folder, must fail with an actionable message before any destructive change.
- **FR-32** — Provide a `--links <path>` option naming a JSON file that maps document paths to their published Google Doc URLs (typically the same map a sync workflow already keeps to track each doc's URL). When supplied, a relative Markdown link whose target resolves to a path in the map renders as a live hyperlink to that document's Doc URL, instead of the plain text it would otherwise be (FR-20). This makes cross-references within a set of related documents clickable in the generated Docs. The link **text** is never altered — only the destination changes. Resolution: a link's target is resolved relative to the source Markdown file's own location (matching how Markdown renderers resolve relative links); map keys are resolved relative to the map file's location, so a repo-root map works regardless of the working directory; a target given as a bare document id or a full edit URL is accepted and normalised to a followable Doc URL. Any `#fragment` on a matched link is dropped — a Doc URL cannot address a Markdown heading. Links with a followable scheme, in-page anchors, and targets absent from the map are left exactly as FR-20 specifies. Only inline links (`[text](path)`) are considered; a reference-style link renders as plain text as it would without a map. A missing or malformed map file must fail with an actionable message before any document is written. The tool reports a one-line summary — to stderr, so it never pollutes the printed doc URL (FR-3) — of how many links were rewritten, how many anchors were dropped, and how many relative links went unmatched.
- **FR-33** — When the `MD2GD_GOOGLE_ORIGIN` environment variable is set, every request to a Google API — OAuth consent and token, Docs, and Drive — goes to that origin instead, with its path unchanged. Nothing else changes: the printed document URL is still the Google Docs URL.

### 2.5 Content edge cases requiring special handling

These are derived from analyzing the reference due-diligence report and are the constructs that naive converters most often get wrong. Each is a **requirement**, not a nice-to-have.

- **FR-34** — **Rich content inside table cells.** Cells routinely contain **bold** lead-ins, `inline code`, quoted strings, and em-dashes in the same cell. Inline formatting inside cells must be preserved — cells must not be flattened to plain text. (The report's severity tables lead each cell with a bold phrase followed by an em-dash and prose, plus inline code like `` `WebhookSecret` ``.)
- **FR-35** — **Emoji as status markers.** Color emoji (✅ ❌ 🕐 🟠 🟡 🔴 and others) appear as the first token in table cells (e.g. "🟠 High", "✅ Working") and inline in text. They must render as color emoji — not stripped, not converted to monochrome tofu — and stay on the same line as the text that follows them.
- **FR-36** — **Markdown-significant characters inside inline code must be literal.** Code spans contain `_`, `*`, `/`, `;`, and spaces (e.g. `` `sk_test_` ``, `` `HttpOnly; SameSite=Strict` ``, `` `POST /api/auth/resend-confirmation` ``, `` `*` ``). These must never be interpreted as emphasis, links, or list markers.
- **FR-37** — **Unicode typography must survive intact.** Em-dashes (—, ~88 in the reference doc), en-dashes (–), arrows (→), and curly quotes (" " ' ') must pass through unchanged and never be corrupted to mojibake or ASCII-fied.
- **FR-38** — **Soft line breaks.** When single (non-blank-separated) lines are clearly meant as stacked lines — e.g. the document's metadata block:
  ```
  **Date:** July 5, 2026
  **Subject:** …
  **Classification:** Confidential
  ```
  they must render as separate lines, not collapsed into one run-on paragraph. (Strict CommonMark collapses soft breaks to spaces; that is the wrong outcome here.) See §9 for the chosen policy.
- **FR-39** — **Tightly-grouped metadata blocks.** A run of consecutive single-line `**Key:** value` paragraphs (the header block) should read as a grouped block with tight spacing, not with full inter-paragraph gaps between each line — while normal body paragraphs still get the spacing of ST-11.
- **FR-40** — **Bold-only lines are captions, not headings.** Lines that are entirely bold (e.g. `**Customer journey**` preceding a table) are sub-labels. They must render as styled bold text with caption spacing — space above to separate them from preceding content and tight space below so they group with the element they introduce (typically a table) — and must **not** be promoted into the document heading outline.
- **FR-41** — **Adjacent tables with differing shapes.** The document places tables of different column counts near each other (3-col then 2-col) and two tables separated only by a bold caption. Each table's column widths must be sized independently, and consecutive tables must never merge into one.
- **FR-42** — **Wide/long table cells.** Description cells can hold paragraph-length text. Column widths must distribute so long-text columns get the space, cells wrap cleanly, and the table never overflows the page width (per ST-4). Conversely, a short-content column (e.g. a one-word status/severity column) must be wide enough to hold its widest cell on a single line rather than pinned so narrow that short values wrap. A column whose body cells are all blank is a fill-in column — a form's answer column — and must be sized for what will be written into it rather than for its header, so the label column beside it cannot take the page; a table whose body is blank throughout shares the page equally between its columns.
- **FR-43** — **Bare domains in prose.** URLs written without a scheme or link syntax (e.g. `partybook-one.vercel.app`) appear as plain text. The tool must handle these consistently per the §9 auto-linking policy and never mangle them.
- **FR-44** — **Blocks nested in quotes and list items.** Any block §2.3 lists may sit inside a blockquote or a list item, at any depth, and renders there as it does anywhere else. A blockquote is one container with a single continuous left accent around everything inside it, a nested quote drawing its own; quotes at the same depth sit at the same horizontal position whatever they hold or follow, and every block's right edge meets its container's. A list item's marker sits on its first block and its later blocks align under the item's text, with an ordered list counting on through them. A nested table renders as a real table at its position, sized to its container.
- **FR-45** — **Nesting Google Docs cannot represent degrades, and only this.** A quote or table inside a list item sits at its container's edge rather than under the item's text, and an ordered list restarts its numbering after it; an item that opens with a quote, table or list carries its marker on an empty line above it; a task item's later blocks sit at its checkbox rather than under its text; a quote that starts or ends with a table or another quote keeps a thin blank line at that edge; a nested list takes the outer list's marker style.

### 2.6 Updating an existing document ("stable URL" mode)

The user's core loop is *edit the Markdown, regenerate the Doc*. Creating a fresh doc every time breaks shared links and scatters near-duplicates across Drive. `--update` re-renders into the **same** document so its URL, Drive location, and shares stay put.

**Scope (inherits AU-3):** because the tool uses the `drive` scope, `--update` may target **any document the user can edit** — one md2gd created, one made by hand or shared into a folder, or one living in a shared drive. The tool never *silently* updates: a plain run always creates (FR-5), and an update requires either the explicit `--update <url|id>` or a remembered mapping for the file (FR-50).

- **FR-46** — **Clear-and-rewrite semantics.** `--update` targets an existing doc, clears its body, and re-runs the normal conversion into it. Content diffing / in-place patching is explicitly **not** attempted: a cleared doc must render identically to a freshly created one from the same Markdown.
- **FR-47** — **Read before destroy.** The tool must GET the target document *before* issuing any destructive call, so an auth failure, 404, or permission error leaves the target intact and the run exits non-zero with a clear message (per NF-3).
- **FR-48** — **No style bleed.** After clearing, the surviving paragraph must be reset to default body style with list markers removed, so the previous render's trailing heading/list style does not leak into the new content. An already-empty body must be handled without error.
- **FR-49** — **Title stays in sync.** If the derived/overridden title differs from the target doc's current name, the tool must rename the Drive file to match, so the doc's title does not go stale after an update.
- **FR-50** — **File→doc mapping (hybrid UX).**
  - On a successful *create* **or `--update`**, record `realpath(input) → documentId` in the config location (§2.4, FR-28). Recording on update means a doc first targeted explicitly (`--update <url|id>`, including one md2gd did not create) is **adopted** into the mapping, so subsequent no-argument `--update` runs find it without re-passing the URL.
  - `md2gd file.md --update` with **no argument** updates the doc previously created from that file (looked up in the mapping). `--update <url-or-id>` overrides with an explicit target and accepts either a full Docs URL or a bare document id.
  - A plain run (no `--update`) when a mapping already exists still **creates a new doc**, but prints a hint — e.g. `previously created <url> — pass --update to overwrite` — so the destructive path is never taken implicitly.
  - A stale mapping (target trashed or not found) must produce a clear error, not silently diverge into a new doc.
- **FR-51** — **Inaccessible targets.** An `--update` target the user cannot access or edit (wrong id, no permission, trashed) fails with an actionable message and leaves nothing changed — never a raw API error.

### 2.7 Config & credential storage

All persisted state lives under a single user-scoped directory, created with owner-only permissions (AU-2). The location follows platform convention: `~/.md2gd/` on macOS, and `$XDG_CONFIG_HOME/md2gd` (default `~/.config/md2gd`) on Linux. It holds:

- **`client_secret.json`** — the OAuth Desktop client secret supplied to `md2gd init` (FR-23). Owner-only.
- **`token.json`** — the cached OAuth token, including the refresh token (AU-4). Owner-only.
- **`config.json`** — tool state (FR-28). A JSON object whose `docs` key maps each input file's canonical absolute path to the id of the document last created from or updated for it (FR-50): `{ "docs": { "/abs/path/report.md": "<documentId>" } }`. Unknown top-level keys are preserved on write.

Deleting this directory resets the tool to its unconfigured state (AU-5). The layout and location must be documented (D-2).

---

## 3. Styling requirements ("clean sensible default")

The chosen visual identity is a **neutral, clean, professional default** — no specific brand, logo, or corporate palette. The output must read as a polished, intentionally designed document, not a raw dump. The following define the desired **outcome**; the exact typographic values are the building agent's to tune toward this intent.

- **ST-1** — A coherent typographic hierarchy: body text in a highly readable serif or sans-serif at a comfortable reading size; headings larger than body text, with H1 > H2 > H3 by size.
- **ST-2** — Sensible vertical rhythm: adequate space before/after headings, paragraphs, and lists so the document breathes and isn't cramped.
- **ST-3** — Comfortable line spacing for body text (not single-spaced dense).
- **ST-4** — Tables styled for readability: a header row set apart by bold text and a subtle background shade, light cell borders or row banding, and adequate cell padding. Tables must not overflow the page width, and a row must not split across a page break — a row that doesn't fit moves whole to the next page.
- **ST-5** — Code and inline code in a monospace font, visually set apart from prose.
- **ST-6** — Blockquotes visually indented and/or accented.
- **ST-7** — Consistent, professional page margins.
- **ST-8** — Links styled in a conventional link appearance (e.g. colored, underlined) while remaining clickable.
- **ST-9** — The styling must be **consistent and reproducible**: the same input produces the same look every time, and the look is uniform across all documents the tool generates.
- **ST-10** — One typeface sets all text — body, headings, captions, and table cells — except code, which is monospace (ST-5).

### 3.1 Known pain points (must be handled, not left to fix by hand)

These are concrete defects the user has repeatedly had to correct by hand when converting via naive/plain-HTML output. Getting them right is a **hard requirement**, since fixing them manually in Google Docs is precisely the toil this tool exists to eliminate.

- **ST-11** — **Paragraph spacing:** there must be clear space *between* paragraphs (via space-after on paragraphs, not blank lines). Body text must not run together as one dense block.
- **ST-12** — **Space after block elements:** there must be adequate space *after* tables, code blocks, blockquotes, and lists before the following content — these must not butt directly against the next paragraph.
- **ST-13** — **Table cell padding:** table cells must have visible internal padding on all sides. Text must not touch cell borders.
- **ST-14** — **Space before headings:** headings must have more space above them than below, so sections are visually grouped with their content.
- **ST-15** — **Loose and tight lists:** a list with blank lines between its items spaces them like paragraphs; a list without keeps them close, as rendered Markdown does.
- **ST-16** — **Flush container edges:** the first block inside a quote sits against its top and the last against its bottom, with no paragraph spacing of their own there (a table or quote at that edge excepted, per FR-45).
- **ST-17** — **Captions stay with their element:** a page break never falls between a caption (FR-40) and the element it introduces.

---

## 4. Authentication & authorization requirements

- **AU-1** — Authenticate to Google as the **user's personal Google account** using an OAuth "installed application" (desktop) flow, initiated by `md2gd init` (FR-23). It opens the system browser for consent once (a loopback redirect captures the code); subsequent runs reuse a locally cached token.
- **AU-2** — Cached credentials/tokens must be stored securely in a user-scoped location with appropriately restrictive file permissions, and must never be committed to the repository.
- **AU-3** — Request only the scope the tool's capabilities require, and no more. Because the tool must place docs in folders the user did not create (FR-31) and update docs it did not itself create (§2.6), it uses the `drive` scope, which also covers the Docs edits (`documents.create`/`batchUpdate`), so no separate Docs scope is requested. This is a deliberate tradeoff: `drive` is a sensitive scope, but the narrower `drive.file` cannot reach user-created folders or foreign docs, which are core to the workflow. The tool must never request more than `drive`.
- **AU-4** — Tokens must refresh automatically when expired without forcing a full re-consent, until revoked.
- **AU-5** — Resetting local credentials must be possible and documented. v1 does this by deleting the config directory (§2.7), which removes the cached token and stored client secret; the next `init` re-consents from scratch.
- **AU-6** — No document content or credentials may be sent to any third-party service other than Google's own APIs. All processing happens locally or within the user's Google account.
- **AU-7** — The loopback consent callback must be protected against authorization-code injection: a random `state` is verified on return and PKCE (S256) is used. Denied consent and a timeout must both terminate `init` cleanly rather than hang.

---

## 5. Non-functional requirements

- **NF-1** — The tool runs on macOS or Linux as a single standalone executable, with no runtime to install.
- **NF-2** — Against a Google that answers instantly, converting a document of about 400 lines with several tables finishes within 5 seconds.
- **NF-3** — Clear, human-readable error messages for the common failure modes: no network, auth failure/expired consent, invalid file, Drive permission denied, API rate limiting. Errors must not dump raw stack traces as the primary output.
- **NF-4** — Idempotent auth: running repeatedly does not create duplicate credentials or re-prompt unnecessarily.
- **NF-5** — A rate-limited response, a server error, or a dropped connection on a read is retried, and the run carries on once a retry succeeds; lasting rate limiting or a lasting network failure ends in its NF-3 message.
- **NF-6** — A write that may already have applied is never resent, and a client error is never retried.

---

## 6. Out of scope (v1)

- Reverse conversion (Google Docs → Markdown).
- Headers, footers, and page numbers.
- Batch conversion of many files in one invocation (nice-to-have, not required).
- Multi-user / team / server deployment, or service-account automation.
- Syntax highlighting inside code blocks.
- Image embedding (images degrade to alt text — FR-19) and native footnotes (footnotes degrade to text — FR-21).
- Mermaid / diagram rendering, LaTeX math rendering.
- A GUI or web interface.
- Sharing/permission management of the created doc beyond it existing in the user's own Drive.

---

## 7. Acceptance criteria

The tool is considered done for v1 when all of the following hold:

- **AC-1** — Running `md2gd <file.md>` on the sample file (D-3) with valid auth creates a new Google Doc in md2gd's own folder, prints its URL to stdout, and exits zero; a second run reuses that folder. (FR-1, FR-2, FR-3, FR-6, FR-27)
- **AC-2** — In the document AC-1 creates, the title is the Markdown's H1; each heading carries the heading style of its level; bold, italic, bold+italic, inline code, strikethrough, and links carry their formatting; bulleted and numbered lists nested three levels deep carry each level's indentation and marker; every table has its header row; a horizontal rule produces no output. (FR-4, FR-10, FR-11, FR-12, FR-14, FR-18)
- **AC-3** — Converting the sample file (D-3) renders task lists as checkboxes, fenced and indented code blocks in monospace set apart from prose, and blockquotes set apart from body text; an image becomes its alt text, a footnote becomes readable text, and a construct §2.3 does not list becomes readable text without raw markup; the run exits zero. (FR-13, FR-16, FR-17, FR-19, FR-21, FR-22)
- **AC-4** — `md2gd init --client <secret>` opens the consent page once, stores the client secret, and caches the token; a following conversion completes without opening a browser or prompting, and running `init` again leaves one set of credentials. (FR-23, AU-1, NF-4)
- **AC-5** — The document AC-1 creates is styled as §3 specifies: body text at one reading size with comfortable line spacing, H1 > H2 > H3 > body text by size, space around headings, paragraphs and lists, a table header row in bold on a shaded background with cell borders and padding and rows that do not split across pages, code in monospace, quotes accented, the default page margins, links colored and underlined, and one typeface for all non-code text; converting the same input twice produces the same styling. (ST-1, ST-2, ST-3, ST-4, ST-5, ST-6, ST-7, ST-8, ST-9, ST-10)
- **AC-6** — `--help`, `-h`, and `help` print usage and exit zero; `--version`, `-V`, and `version` print the version; `--title` overrides the title; a file without an H1 takes its title from the filename (`service-readiness-review.md` → "Service Readiness Review"); `--open` opens the resulting doc's URL in the browser, created or updated, while a run without it opens nothing. (FR-4, FR-24, FR-25, FR-26, FR-29)
- **AC-7** — Each of no network, expired or revoked consent, Drive permission denied, and lasting rate limiting ends the run with a human-readable message and no stack trace, and a non-zero exit. (FR-6, NF-3, NF-5)
- **AC-8** — With `MD2GD_GOOGLE_ORIGIN` set, every request md2gd makes during `init`, a create, and an update goes to that origin, and the printed URL is still the Google Docs URL. (FR-33, AU-6)
- **AC-9** — Running `--update` on an editable doc, whether md2gd created it or not, re-renders it at the same URL: the body matches a fresh create from the edited Markdown, no style from the previous render remains, an already-empty body updates without error, and a changed H1 renames the doc. (FR-30, FR-46, FR-48, FR-49)
- **AC-10** — `--folder <url|id>` on a folder the user can write — their own, one shared with them, or one in a shared drive — places a new doc in that folder; `--update --folder` moves the target doc there at the same URL, and `--update` without it leaves the doc where it is; a folder the user cannot access, or a non-folder, fails with an actionable message and changes nothing. (FR-27, FR-31)
- **AC-11** — `--links <map>` renders a relative link to a mapped document as a live link to its Doc URL with any `#fragment` dropped and its text unchanged, resolving the target against the source file and the keys against the map file, and accepting a bare document id or an edit URL as a map value; an unmapped relative link, an in-page anchor, and a reference-style link stay plain text; stderr carries a one-line summary of the counts; a missing or malformed map fails with an actionable message before any document is written. (FR-20, FR-32)
- **AC-12** — An `--update` whose target cannot be read — a wrong id, no permission, or a trashed doc — exits non-zero with an actionable message and leaves the target unchanged. (FR-47, FR-51)
- **AC-13** — After a create, `md2gd file.md --update` with no argument updates that doc; `--update <url|id>` on a doc md2gd did not create adopts it, so a later no-argument `--update` targets it; a plain run with a mapping creates a new doc and prints a hint naming the earlier one; a mapping whose doc is gone fails with a clear error and creates nothing. (FR-5, FR-50)
- **AC-14** — A missing, unreadable, empty, or non-Markdown input file fails with an actionable message, a non-zero exit, and no document; an input path given with `~` or relative to the working directory resolves. (FR-8, FR-9)
- **AC-15** — Finnish text, color emoji, em- and en-dashes, arrows, and curly quotes reach the document unchanged, emoji stay on the line of the text that follows them, and formatting around an emoji covers exactly its text. (FR-7, FR-35, FR-37)
- **AC-16** — In tables: a cell's bold lead-in, em-dash, and inline code keep their formatting; a column's alignment applies to every cell in it, header included; adjacent tables of different shapes stay separate and are sized independently; a long-text column takes the width while a one-word column holds its widest cell on one line; a blank answer column is sized for what will be written into it; no table exceeds the page width. (FR-15, FR-34, FR-41, FR-42)
- **AC-17** — `_`, `*`, `/`, and `;` inside inline code stay literal; single-line breaks inside a paragraph render as separate lines; a run of `**Key:** value` lines renders as one tightly spaced block; a bold-only line renders as a caption outside the heading outline; a bare domain stays plain text, unchanged. (FR-36, FR-38, FR-39, FR-40, FR-43)
- **AC-18** — Every §2.3 block nested in a blockquote or list item, at any depth, renders as it does at the top level, with each quote's single left accent and each item's later blocks aligned under its text; the nestings Google Docs cannot represent degrade exactly as FR-45 lists. (FR-44, FR-45)
- **AC-19** — Paragraphs are separated by space after them, not blank lines; tables, code blocks, blockquotes, and lists have space after them; table cells have padding on all sides; headings have more space above than below; a loose list spaces its items like paragraphs and a tight list keeps them close; the first and last blocks in a quote sit flush with its edges; a caption is kept on the same page as the element it introduces. (ST-11, ST-12, ST-13, ST-14, ST-15, ST-16, ST-17)
- **AC-20** — A rate-limited response, a server error on a read, and a dropped connection on a read are each retried and the run succeeds; a write that fails after it may have applied is not resent; a client error is not retried. (NF-5, NF-6)
- **AC-21** — `init` creates the config directory and its credential files readable by the owner only; the consent request asks for exactly the `drive` scope; an expired token refreshes without opening a browser; after the config directory is deleted, a conversion fails asking for `init`, and `init` consents afresh. (AU-2, AU-3, AU-4, AU-5)
- **AC-22** — `init` rejects a consent callback whose `state` does not match, presents a PKCE S256 verifier matching its challenge, and exits non-zero without a token when consent is denied or times out. (AU-7)
- **AC-23** — A conversion preserves unknown top-level keys in `config.json`, and a corrupt `config.json` does not stop a conversion. (FR-28)
- **AC-24** — The released executable runs `md2gd --version` on a machine with no Bun installed. (NF-1)
- **AC-25** — Against a Google that answers instantly, converting a document of about 400 lines with several tables finishes within 5 seconds. (NF-2)

---

## 8. Deliverables

- **D-1** — The working CLI tool, invokable as `md2gd`.
- **D-2** — A `README.md` covering: install and its prerequisites, the one-time Google Cloud / OAuth client setup in step-by-step form, first-run auth, usage examples, all options, config file format and location, how to reset credentials, and the update path's limitations. The setup steps call out that the OAuth consent screen must be published to "Production" — in "Testing", Google expires refresh tokens after 7 days — and that `drive` is a sensitive scope, so consent shows an "unverified app" warning the user clicks through. The limitations are that comments anchored to replaced text orphan, and that an update is not atomic: a failure mid-run can leave the doc partly rewritten.
- **D-3** — A sample Markdown file exercising the full §2.3 feature set and the §2.5 edge cases, used by AC-1 and AC-3.
- **D-4** — `.gitignore` covering tokens, client secrets, and any local build artifacts, present from the first commit.
- **D-5** — An automated test suite, part of the project's verification, which passes before any release.

---

## 8a. Tech stack (fixed)

Constraints here are limited to decisions that change what the deliverable *is* — reversing one would force a rewrite. Mechanically re-appliable choices (formatter, tsconfig, lint/verify commands, dependency preferences, gitignore) are conventions, not spec constraints; they live in `AGENTS.md`.

- **TS-1** — Runtime is Bun; language is TypeScript, ESM, strict mode.
- **TS-2** — Runtime-boundary values (config, external input) are validated with Zod before entering typed code.

## 9. Open decisions left to the building agent

These are explicitly **not** constrained by this spec; choose what best satisfies the requirements:

- How styling is expressed and centralized (§3).
- Exact typographic values (fonts, sizes, spacing, colors) toward the §3 intent.
- Config file format and CLI option syntax.

### Policies referenced above (chosen, not open)

- **Soft line breaks (FR-38):** render a single newline within a paragraph as a line break (i.e. treat source line breaks as intended). The reference document is not hard-wrapped at a column width, so this reproduces author intent without side effects. If a future document turns out to be hard-wrapped, revisit.
- **Auto-linking (FR-43):** do **not** invent hyperlinks from bare domains or fabricate link targets. A link becomes clickable only when its target resolves outside the source document — an absolute URL with a followable scheme (`http`, `https`, `mailto`, `tel`). Explicit Markdown links to a local target (a relative path, bare filename, or in-page anchor like `#section`) and unsafe schemes (`javascript:`, `data:`, `file:`) render as plain styled text: they would be dead links in a Google Doc (FR-20). A scheme-less bare domain like `partybook-one.vercel.app` likewise stays plain text, unchanged.
- **Cross-document links (FR-32):** with no `--links` map the rule above is complete — relative links stay plain text. A supplied map adds exactly one rule: a relative link whose target, resolved against the source file's directory with any fragment stripped, matches a map entry becomes a live link to that entry's Doc URL. Resolution is lexical — no filesystem canonicalisation, so a symlinked doc path is a documented non-match — and matching is case-sensitive. Nothing else changes: unmatched relative links, in-page anchors, and unsafe schemes remain plain text, and link text is never rewritten.

The implementation approach, the UTF-16 offset hazard, and the two-phase table flow are non-normative and documented in `docs/architecture.md`.
