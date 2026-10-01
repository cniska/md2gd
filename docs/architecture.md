# Architecture

How md2gd turns Markdown into a styled Google Doc, and the non-obvious hazards it works around. This document is non-normative: `SPEC.md` defines *what* the tool must do; this describes *how* the current implementation does it. Read it before touching the conversion or executor layers.

## Pipeline

Conversion is a one-way pipeline, each stage a separate module so styling, parsing, and the Google boundary stay independent (SPEC NF-6):

```
Markdown ─▶ parse ─▶ plan ─▶ convert / table ─▶ executor ─▶ Google REST
           mdast    segments   Docs requests    batchUpdate   Docs + Drive
```

- **`parse.ts`** — Markdown to an mdast tree via `unified`: `remark-parse` + `remark-gfm` (tables, strikethrough, task lists, footnotes, autolinks) + `remark-breaks`. `remark-breaks` is the soft-break policy (SPEC FR-32): a single newline inside a paragraph becomes a hard line break, reproducing stacked-line intent instead of collapsing to a space.
- **`plan.ts`** — walks the tree into an ordered tree of segments. A list item exists in Docs only as bullets and indents on its paragraphs, so each block becomes a leaf carrying its list placement (outermost list, nesting depth, preset, whether it starts the item). A run of leaves is one `linear` segment; each table, wherever it sits, is its own `table` segment; each blockquote is a `quote` segment holding its own segments. Tables and quotes are split out because their cell indices do not exist until they are inserted (see below), so they cannot be converted deterministically the way linear content can.
- **`convert.ts` / `inline.ts`** — turn leaves into Docs requests at a known cursor, resolving inline formatting (bold, italic, code, links, strikethrough) into styled text runs. A leaf's paragraph style is its own spec from `style.ts`, chosen by what the block is; where it sits changes only its spacing (container edges, after a table, the end of a list, a tight list's text) and, for a bulleted item's later blocks, its indent.
- **`table.ts`** — builds a `TablePlan` (rows, columns, each cell's inline content) from a table node, and sizes its columns to the container width it lands in. A cell is a container holding one paragraph, filled through the same converter as every other block.
- **`style.ts`** — the single source of truth for every typographic value: fonts, paragraph spacing, cell padding, header shading, caption spacing. Change the look here without touching conversion logic (SPEC ST-9, NF-6).
- **`executor.ts`** — drives the document: creates or clears it, then walks the segments emitting `batchUpdate` rounds.
- **`google.ts`** — the live REST client for Docs and Drive. Implements the `DocsClient` interface the executor depends on.

## The testing seam

`executor.ts` depends on a `DocsClient` interface (`createDocument`, `batchUpdate`, `getDocument`, `renameDocument`), not on `google.ts` directly. Unit tests inject a mock and assert the exact `batchUpdate` requests produced, with no network or auth (SPEC NF-9, NF-13). This is the boundary "mock at boundaries" refers to: everything above `DocsClient` is tested offline; only `google.ts` talks to Google.

## Hazards

These are the mechanisms that break naive converters. They are the reason the executor looks more complicated than "render nodes to requests."

### UTF-16 offsets

The Docs API addresses content by **UTF-16 code unit**, not by character or byte. An emoji is 2 units; a ZWJ sequence is more. A single miscount corrupts every later offset in the document, and the reference documents are full of emoji and em-dashes. The executor never computes an offset by counting characters; it advances the cursor by the length of text it actually inserted and, for tables, reads real indices back from the document (next section).

### Two-phase table insertion

A table's cell indices only exist after the table is in the document. So each table is done in two phases:

1. Insert the empty table structure at the cursor.
2. GET the document, locate the inserted table, and read each cell's real content index.
3. Style the table and fill the cells using those indices.

Cell fills run **last cell first** (descending index order). Inserting text into a cell shifts the indices of everything after it, so filling in reverse means each insertion only moves cells that are already filled. Styling requests do not change indices, so they can be batched freely.

After the fills, the table's size has changed, so the executor re-reads the table's own end index to know where the next segment begins. Column widths come from the same read: a document keeps the paper size of the account that created it, so the content width is the page width less its margins, never a fixed size. Docs clips a table wider than its container instead of shrinking it, so the widths must sum to that width exactly.

### Quotes are one-cell tables

Docs has no quote style, and a paragraph border joins the next paragraph's only when both have "the same border and indent properties" ([ParagraphStyle reference](https://developers.google.com/docs/api/reference/rest/v1/documents#ParagraphStyle)), which a bulleted item and a plain paragraph never do. A table cell is the only Docs container that holds any block, so a quote is a one-cell table with only a left accent, and its cell is filled through the same path as the body, recursively.

- **Placement.** Content is only ever appended at the end of the innermost open container, so nothing before the cursor moves except the nesting tabs bulleting strips, which `convertLeaves` subtracts from the index it returns. A newly inserted table is the first table at any depth starting at or after the cursor; after its fill, the cursor continues from that table's own end index.
- **Geometry.** Docs draws a cell border centered on the cell's edge without taking width, so a quote's column is its container's full width and its contents sit in by the cell's left padding alone. Every block's right edge therefore meets the page's content edge, inside a quote or not.
- **The cell's own paragraph.** A cell always keeps one paragraph, so the quote's last block is written into it rather than adding a line. When the last block is a table or another quote, the paragraph after it cannot go, and is pinned to the same thin spacer style as the paragraph before a table (SPEC FR-45).
- **Cost.** Every table and quote costs two reads, one to locate it and one for its end, however deeply it is nested.

### Pre-table spacer

The API injects an empty paragraph immediately before every inserted table. Left alone it renders inconsistently and breaks caption grouping. The executor pins that paragraph to a thin ~6pt spacer, styled only on its single newline index so no real caption or heading text is shrunk. This keeps create and update rendering identical and lets a bold caption sit close to the table it introduces (SPEC FR-34, FR-35).

**Why not just delete it?** Removing the paragraph seems cleaner, but the Docs API rejects it: `deleteContentRange` over the newline immediately before a table returns `400 Invalid deletion range. Cannot delete the requested range.` (The Docs editor lets you backspace it; the API does not.) The spacer is a required workaround, not a stylistic choice — do not reintroduce a delete here; tuning its size is the only safe lever.

### Lists with blocks after an item's first

`createParagraphBullets` decides each paragraph's level by counting leading tabs, then strips them, which shifts every later index. Bullet requests therefore run last, in reverse document order, and the linear end index subtracts the stripped tabs.

The request cannot name an existing list; per the [`CreateParagraphBulletsRequest` reference](https://developers.google.com/docs/api/reference/rest/v1/documents/request#createparagraphbulletsrequest), "if the paragraph immediately before paragraphs being updated is in a list with a matching preset, the paragraphs being updated are added to that preceding list." So each list's blocks, an item's later blocks included, are bulleted as one range, which Docs counts as one list. The later blocks then have their bullets removed, in post-strip indices; a removed bullet leaves the paragraph in the list's count but drops it to the margin, so md2gd indents it under the item's text, 36pt per level (`listLaterBlockIndent` in `style.ts`).

A table cannot be indented, so a table or quote inside a list item sits at its container's edge, and the list after it is bulleted afresh and restarts its count (SPEC FR-45). A task list has no bullets, so its blocks keep their leading tabs.

### Clear-and-rewrite update

`--update` re-renders into an existing document so its URL and Drive location persist (SPEC §2.6). The executor:

1. **Reads before it destroys.** It GETs the target first. A 403/404 means the id is wrong, the doc was trashed, or the user lacks access; that is translated into an actionable message rather than a raw API error (SPEC FR-39, FR-43). Only the read is guarded, so an auth or permission failure leaves the target untouched.
2. **Clears the body** down to the single undeletable trailing newline, then resets the surviving paragraph to normal style with list markers removed, so the previous render's trailing heading or list style cannot bleed into the new content (SPEC FR-40). An already-empty body skips the delete.
3. **Refills** using the same segment pipeline as create.
4. **Renames** the Drive file if the derived title changed (SPEC FR-41).

The update is not atomic and comments anchored to cleared ranges orphan. Both are accepted limitations for the single-user regenerate loop, documented rather than engineered around (SPEC FR-43).

## Drive and Docs identity

A document is created directly inside its parent folder via Drive, not via the Docs API's create-then-move. A Drive file's id *is* the Docs document id, so creating the file with the folder as parent avoids the add-parent-to-a-rooted-file move, which fails under Drive's single-parent model. The parent is `--folder` if given, else md2gd's own default folder (SPEC FR-25, FR-27b). The same identity lets the title be renamed with a Drive `PATCH`.

Every Drive call acting on a caller-supplied id goes through `driveUrl`, which carries `supportsAllDrives=true`. Drive treats a client that omits it as My Drive-only and reports a shared-drive folder or document as a missing file, so the flag lives in the URL builder rather than at each call site (SPEC NF-14a). The default-folder lookup deliberately stays outside it: that folder is always in md2gd's own Drive, and widening the search to all drives would let it latch onto a same-named folder in a shared drive.

## Auth

`md2gd init` runs the OAuth installed-application flow once (`oauth.ts`, `init.ts`, `tokens.ts`):

- A loopback server binds `127.0.0.1` on an ephemeral port and becomes the redirect target.
- The consent URL carries a random `state` and a PKCE S256 challenge; the callback verifies `state` before accepting the code (SPEC AU-8).
- Denied consent and a 5-minute timeout both settle the flow cleanly instead of hanging.
- The resulting token (including its refresh token) is cached under `~/.md2gd/` with owner-only permissions and refreshed automatically on expiry (SPEC AU-2, AU-4).

The scope is `drive` (which also authorises the Docs API's create/batchUpdate, so no separate Docs scope is requested). It's a sensitive scope, chosen deliberately: the narrower `drive.file` can't reach folders the user made or docs md2gd didn't create, both of which the workflow needs (SPEC AU-3).

## Module map

| Module | Responsibility |
|--------|----------------|
| `cli.ts` | Command dispatch, stdout/stderr, exit codes |
| `args.ts` | Argument parsing into a pure `Command` (unit-tested without I/O) |
| `parse.ts` | Markdown to mdast, GFM + soft-break policy |
| `plan.ts` | Tree to a tree of leaf runs, tables and quotes, at any nesting depth |
| `convert.ts`, `inline.ts` | Leaves to styled Docs requests |
| `table.ts` | Table node to a `TablePlan` with column widths |
| `style.ts` | Central typographic style table |
| `executor.ts` | Create/clear/fill orchestration, two-phase tables |
| `google.ts` | Live Docs + Drive REST client (`DocsClient`) |
| `oauth.ts`, `tokens.ts`, `init.ts` | OAuth flow, token cache, one-time setup |
| `config.ts`, `mapping.ts` | Config paths and the file→doc mapping |
| `pipeline.ts` | Read file, derive title, resolve update target |
