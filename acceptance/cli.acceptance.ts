import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { viewOf } from "./support/doc-view";
import { documentIdOf, expectFailure, type World, withWorld } from "./support/world";

const REPO = join(import.meta.dir, "..");
const VERSION = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
const SAMPLE = readFileSync(join(REPO, "examples", "sample.md"), "utf8");

const docUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;
const titleOf = (world: World, id: string) => viewOf(world.google.document(id)).title;
const documents = (world: World) =>
  world.google.driveFiles().filter((file) => file.mimeType === "application/vnd.google-apps.document");

describe("the command line", () => {
  for (const flag of ["--help", "-h", "help"])
    test(`AC-6 ${flag} prints usage and exits zero`, async () => {
      await withWorld(async (world) => {
        const ran = await world.run([flag]);

        expect(ran.exitCode).toBe(0);
        expect(ran.stdout).toContain("Usage:");
        expect(ran.stdout).toContain("--title");
      });
    });

  test("AC-6 an unknown option prints a usage error and exits 2", async () => {
    await withWorld(async (world) => {
      const ran = await world.run(["note.md", "--nope"]);

      expect(ran.exitCode).toBe(2);
      expect(ran.stdout).toBe("");
      expect(ran.stderr).toBe("md2gd: unknown option: --nope [usage]\nresolve: md2gd --help\n");
    });
  });

  test("AC-6 an unknown init option prints a usage error and exits 2", async () => {
    await withWorld(async (world) => {
      const ran = await world.run(["init", "--nope"]);

      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toBe("md2gd: unknown option: --nope [usage]\nresolve: md2gd --help\n");
    });
  });

  test("AC-6 a flag missing its value prints a usage error and exits 2", async () => {
    await withWorld(async (world) => {
      const ran = await world.run(["note.md", "--title"]);

      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toBe("md2gd: --title needs a value [usage]\nresolve: md2gd --help\n");
    });
  });

  test("AC-6 a run naming no file prints a usage error and exits 2", async () => {
    await withWorld(async (world) => {
      const ran = await world.run(["--open"]);

      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toBe("md2gd: expected a markdown file path [usage]\nresolve: md2gd --help\n");
    });
  });

  for (const flag of ["--version", "-V", "version"])
    test(`AC-6 ${flag} prints the version`, async () => {
      await withWorld(async (world) => {
        const ran = await world.run([flag]);

        expect(ran.exitCode).toBe(0);
        expect(ran.stdout.trim()).toBe(`md2gd v${VERSION}`);
      });
    });

  test("AC-6 --title overrides the title the H1 would give", async () => {
    await withWorld(async (world) => {
      await world.init();
      const id = documentIdOf(
        await world.run([world.write("report.md", "# From Heading\n\nBody.\n"), "--title", "Chosen Title"]),
      );

      expect(titleOf(world, id)).toBe("Chosen Title");
    });
  });

  test("AC-6 a file without an H1 takes its title from the filename", async () => {
    await withWorld(async (world) => {
      await world.init();
      const id = documentIdOf(await world.run([world.write("service-readiness-review.md", "Just a paragraph.\n")]));

      expect(titleOf(world, id)).toBe("Service Readiness Review");
    });
  });

  test("AC-6 --open opens the created doc's URL in the browser", async () => {
    await withWorld(async (world) => {
      await world.init();
      const before = world.opened().length;
      const id = documentIdOf(await world.run([world.write("notes.md", "# Notes\n"), "--open"]));

      expect(world.opened().slice(before)).toEqual([docUrl(id)]);
    });
  });

  test("AC-6 --open opens the updated doc's URL in the browser", async () => {
    await withWorld(async (world) => {
      await world.init();
      const input = world.write("notes.md", "# Notes\n");
      const id = documentIdOf(await world.run([input]));
      const before = world.opened().length;
      const updated = documentIdOf(await world.run([input, "--update", "--open"]));

      expect(updated).toBe(id);
      expect(world.opened().slice(before)).toEqual([docUrl(id)]);
    });
  });

  test("AC-6 --open with no browser to launch prints the doc URL, remembers the doc, then refuses naming it", async () => {
    await withWorld(async (world) => {
      await world.init();
      const input = world.write("notes.md", "# Notes\n");
      const ran = await world.run([input, "--open"], { PATH: "/nonexistent" });

      const id = documents(world)[0]?.id ?? "no document";
      expect(ran.stdout).toBe(`${docUrl(id)}\n`);
      expectFailure(
        ran,
        `md2gd: cannot open a browser for ${docUrl(id)}: no such file or directory [browser_unopenable]\nresolve: open the URL printed above yourself\n`,
      );
      expect(documentIdOf(await world.run([input, "--update"]))).toBe(id);
    });
  });

  test("AC-6 a run without --open opens nothing", async () => {
    await withWorld(async (world) => {
      await world.init();
      const before = world.opened().length;
      documentIdOf(await world.run([world.write("notes.md", "# Notes\n")]));

      expect(world.opened().slice(before)).toEqual([]);
    });
  });
});

describe("input files", () => {
  async function expectRejected(world: World, args: readonly string[], stderr: string): Promise<void> {
    const ran = await world.run(args);

    expectFailure(ran, stderr);
    expect(ran.stdout).toBe("");
    expect(documents(world)).toEqual([]);
  }

  test("AC-14 a missing input file fails with a message naming it and creates no document", async () => {
    await withWorld(async (world) => {
      await world.init();
      await expectRejected(
        world,
        ["absent.md"],
        "md2gd: file not found: absent.md [file_not_found]\nresolve: check the path, then run the command again\n",
      );
    });
  });

  test("AC-14 an empty input file fails with a message naming it and creates no document", async () => {
    await withWorld(async (world) => {
      await world.init();
      const input = world.write("blank.md", "");
      await expectRejected(
        world,
        [input],
        `md2gd: file is empty: ${input} [file_empty]\nresolve: add content to ${input}, then run the command again\n`,
      );
    });
  });

  test("AC-14 an unreadable input file fails with an actionable message and creates no document", async () => {
    await withWorld(async (world) => {
      await world.init();
      const input = world.write("locked.md", "# Locked\n");
      chmodSync(input, 0o000);
      await expectRejected(
        world,
        [input],
        `md2gd: cannot read ${input}: permission denied [file_unreadable]\nresolve: make ${input} readable, then run the command again\n`,
      );
    });
  });

  test("AC-14 a non-Markdown input file fails with an actionable message and creates no document", async () => {
    await withWorld(async (world) => {
      await world.init();
      const input = join(world.work, "photo.png");
      writeFileSync(input, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48]));
      await expectRejected(
        world,
        [input],
        `md2gd: not a Markdown file (binary content or not UTF-8): ${input} [file_not_markdown]\nresolve: save ${input} as UTF-8 text, then run the command again\n`,
      );
    });
  });

  test("AC-14 an input path given with ~ resolves against the home directory", async () => {
    await withWorld(async (world) => {
      await world.init();
      writeFileSync(join(world.home, "home-notes.md"), "# From Home\n");
      const id = documentIdOf(await world.run(["~/home-notes.md"]));

      expect(titleOf(world, id)).toBe("From Home");
    });
  });

  test("AC-14 an input path relative to the working directory resolves", async () => {
    await withWorld(async (world) => {
      await world.init();
      world.write("drafts/relative.md", "# From Drafts\n");
      const id = documentIdOf(await world.run(["drafts/relative.md"]));

      expect(titleOf(world, id)).toBe("From Drafts");
    });
  });
});

describe("the released executable", () => {
  test("AC-24 the executable prints its version with no Bun on PATH", async () => {
    await withWorld(async (world) => {
      const path = world.env().PATH ?? "";

      expect(path.split(":").filter((dir) => existsSync(join(dir, "bun")))).toEqual([]);
      const ran = await world.run(["--version"]);
      expect(ran.exitCode).toBe(0);
      expect(ran.stdout.trim()).toBe(`md2gd v${VERSION}`);
    });
  });

  test("AC-25 converting a document of about 400 lines with several tables finishes within 5 seconds", async () => {
    await withWorld(async (world) => {
      await world.init();
      let markdown = SAMPLE;
      while (markdown.split("\n").length < 400) markdown += `\n${SAMPLE}`;
      const input = world.write("long.md", markdown);

      const started = performance.now();
      const ran = await world.run([input]);
      const elapsed = performance.now() - started;

      expect(viewOf(world.google.document(documentIdOf(ran))).tables.length).toBeGreaterThanOrEqual(10);
      expect(elapsed).toBeLessThan(5000);
    });
  }, 30_000);
});
