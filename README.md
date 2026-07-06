# md2gd

Convert a Markdown file into a professionally styled Google Doc from the command line.

```
md2gd ~/notes/report.md
# → https://docs.google.com/document/d/…/edit
```

One command turns a Markdown file into a cleanly styled Google Doc in your Drive — proper heading hierarchy, readable spacing, styled tables with padded cells and a shaded header row, monospace code, and working links. The document never leaves your own Google account.

## Requirements

- macOS
- [Bun](https://bun.sh) 1.3+
- A Google account

## Install

```
bun install
bun link        # exposes `md2gd` on your PATH
```

You can also run it without linking via `bun run src/cli.ts <file.md>`.

## One-time Google setup

Creating a Doc in your Drive is a per-user write, so Google requires an OAuth login — there is no API-key shortcut. This is a one-time, ~5-minute setup.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. Enable two APIs for the project: **Google Docs API** and **Google Drive API** (APIs & Services → Library).
3. Configure the **OAuth consent screen**: user type **External**, fill in the required fields, and **publish it to Production**. Leaving it in "Testing" makes Google expire your login after 7 days.
4. Under **Credentials → Create credentials → OAuth client ID**, choose application type **Desktop app**. Download the resulting `client_secret.json`.

md2gd requests only the `drive.file` and `documents` scopes — it can see and touch only the files it creates, never the rest of your Drive.

## Authenticate

Run once, pointing at the file you downloaded:

```
md2gd init --client ~/Downloads/client_secret.json
```

Your browser opens for consent. Approve it, and the token is cached locally. After this, conversion is pure command-line — the access token refreshes silently.

## Usage

```
md2gd <file.md> [--title <title>] [--open]
```

- `--title <title>` — override the document title (defaults to the file's top `# H1`, else its filename).
- `--open` — open the created doc in your browser after converting.
- `md2gd --help` / `md2gd --version`.

Generated docs are placed in an `md2gd` folder in your Drive. Each run creates a new document and prints its URL.

## What it renders

Headings, **bold**/*italic*/~~strikethrough~~, `inline code` and fenced code blocks, links, ordered/unordered/nested and task lists, blockquotes, horizontal rules, and tables (with sized columns, padded cells, and a shaded header row). Emoji and non-ASCII text are preserved.

Not yet supported (they degrade to readable text): embedded local images, footnotes, and per-level markers for mixed-type nested lists.

## Configuration and credentials

md2gd stores everything under `~/.md2gd/` with owner-only permissions:

- `client_secret.json` — your OAuth client (copied in by `init`)
- `token.json` — the cached access/refresh token

Nothing here is ever transmitted anywhere except Google's own APIs.

## Reset

To sign out, delete the cached token and re-run `init`:

```
rm ~/.md2gd/token.json      # re-authenticate on next `md2gd init`
rm -rf ~/.md2gd             # full reset, including the stored client secret
```
