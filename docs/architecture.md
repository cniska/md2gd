# Architecture

How md2gd turns Markdown into a styled Google Doc, and the non-obvious hazards it works around. This document is non-normative: `SPEC.md` defines *what* the tool must do; this describes *how* the current implementation does it. Read it before touching the conversion or executor layers.

## Pipeline

Conversion is a one-way pipeline, each stage a separate module so styling, parsing, and the Google boundary stay independent (SPEC NF-6):

```
Markdown ─▶ parse ─▶ plan ─▶ convert / table ─▶ executor ─▶ Google REST
           mdast    segments   Docs requests    batchUpdate   Docs + Drive
```

- **`parse.ts`** — Markdown to an mdast tree via `unified`: `remark-parse` + `remark-gfm` (tables, strikethrough, task lists, footnotes, autolinks) + `remark-breaks`. `remark-breaks` is the soft-break policy (SPEC FR-32): a single newline inside a paragraph becomes a hard line break, reproducing stacked-line intent instead of collapsing to a space.
- **`plan.ts`** — splits the tree into an ordered list of segments. A run of non-table blocks is one `linear` segment; each table is its own `table` segment. This split exists because table cell indices do not exist until the table is inserted (see below), so tables cannot be converted deterministically the way linear content can.
- **`convert.ts` / `inline.ts`** — turn linear nodes into Docs requests at a known cursor, resolving inline formatting (bold, italic, code, links, strikethrough) into styled text runs.
- **`table.ts`** — builds a `TablePlan` (rows, columns, per-column fixed widths, per-cell text and styled runs) from a table node.
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

After the fills, the table's size has changed, so the executor re-reads the document's end index to know where the next segment begins.

### Pre-table spacer

The API injects an empty paragraph immediately before every inserted table. Left alone it renders inconsistently and breaks caption grouping. The executor pins that paragraph to a thin, deterministic spacer. This is what makes create mode and update mode render tables identically, and lets a bold caption sit tight against the table it introduces (SPEC FR-34, FR-35).

### Clear-and-rewrite update

`--update` re-renders into an existing document so its URL and Drive location persist (SPEC §2.6). The executor:

1. **Reads before it destroys.** It GETs the target first. A 403/404 means the id is wrong, the doc was trashed, or the user lacks access; that is translated into an actionable message rather than a raw API error (SPEC FR-39, FR-43). Only the read is guarded, so an auth or permission failure leaves the target untouched.
2. **Clears the body** down to the single undeletable trailing newline, then resets the surviving paragraph to normal style with list markers removed, so the previous render's trailing heading or list style cannot bleed into the new content (SPEC FR-40). An already-empty body skips the delete.
3. **Refills** using the same segment pipeline as create.
4. **Renames** the Drive file if the derived title changed (SPEC FR-41).

The update is not atomic and comments anchored to cleared ranges orphan. Both are accepted limitations for the single-user regenerate loop, documented rather than engineered around (SPEC FR-43).

## Drive and Docs identity

A document is created directly inside its parent folder via Drive, not via the Docs API's create-then-move. A Drive file's id *is* the Docs document id, so creating the file with the folder as parent avoids the add-parent-to-a-rooted-file move, which fails under Drive's single-parent model. The parent is `--folder` if given, else md2gd's own default folder (SPEC FR-25, FR-27b). The same identity lets the title be renamed with a Drive `PATCH`.

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
| `plan.ts` | Tree to linear/table segments |
| `convert.ts`, `inline.ts` | Linear nodes to styled Docs requests |
| `table.ts` | Table node to a `TablePlan` with column widths |
| `style.ts` | Central typographic style table |
| `executor.ts` | Create/clear/fill orchestration, two-phase tables |
| `google.ts` | Live Docs + Drive REST client (`DocsClient`) |
| `oauth.ts`, `tokens.ts`, `init.ts` | OAuth flow, token cache, one-time setup |
| `config.ts`, `mapping.ts` | Config paths and the file→doc mapping |
| `pipeline.ts` | Read file, derive title, resolve update target |
