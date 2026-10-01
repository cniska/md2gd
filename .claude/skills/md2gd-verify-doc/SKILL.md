---
name: md2gd-verify-doc
description: Render a Markdown file through the real md2gd CLI into a scratch Google Doc and inspect the result. Use after changing conversion, styling, or the executor, when unit tests alone can't show what the Doc looks like.
---

# Verify a rendered Google Doc

`bun run verify` proves the requests md2gd sends. It does not show what Google makes of them, so check a conversion change by running it for real and looking at the doc it produces. `bun run render` drives `src/cli.ts` end to end and saves evidence locally.

## Before you run

- **Credentials.** The harness reads `MD2GD_CLIENT_SECRET_JSON` and `MD2GD_TOKEN_JSON` (the contents of `client_secret.json` and `token.json`) if set, otherwise the stored config from `md2gd init`. If neither exists, stop and ask the user. `init` needs a browser, so an agent can't run it.
- **What the run owns.** It owns one new doc in the Drive folder `md2gd-verify` at the user's My Drive root, which the harness creates if needed. It also owns a temporary `HOME` holding a copy of the credentials, so the CLI's token refresh and file→doc mapping never touch the user's real config. It never touches the user's `md2gd` folder or any existing doc.
- **Input.** Write a small Markdown file that exercises the changed behavior (put it in your scratchpad, not the repo), or use `examples/sample.md` for a broad pass.

## Run

```
bun run render -- <file.md> [--rerender] [--keep] [--out <dir>] [--title <t>] [--links <map.json>]
```

- **Launch and readiness.** The CLI is a one-shot process: it is ready when it exits. A non-zero exit, or stdout that isn't a Docs URL, fails the run and is logged to `cli.log`.
- **Interaction.** The CLI is run as `md2gd <file> --folder <scratch>`. `--rerender` runs it a second time as `--update <id>` on the same doc, which exercises clear-and-rewrite. Use it when the change touches update or anything a previous render could leave behind.
- **Observation.** Read `<out>/outline.txt` first. It has one line per paragraph with its named style (`HEADING_2`, `NORMAL_TEXT`, …), bullet nesting, and text, plus each table's shape and cell contents. Then open the `page-*.png` files with the Read tool to see the visual result: spacing, fonts, table borders, quote accents. `document.json` is the full `documents.get` response, for checking specific paragraph or text styles.
- **Evidence.** Everything lands in `.verify/<timestamp>/` (gitignored) unless `--out` says otherwise: `cli.log`, `document.json`, `outline.txt`, `document.pdf`, and `page-N.png` (needs `pdftoppm`, from poppler-utils).
- **Cleanup.** Once the CLI has created the doc, it is moved to Drive trash when the run ends, even if a later step fails, and the temporary `HOME` is deleted. Pass `--keep` to leave the doc in place for the user to open. The printed URL is the link, and the doc must then be trashed by hand.

## Report

Name the input file, the CLI command or commands run, what `outline.txt` and the page images show for the changed behavior, and the evidence directory. If credentials were missing and nothing ran, say so: an unrun check is not a verification.
