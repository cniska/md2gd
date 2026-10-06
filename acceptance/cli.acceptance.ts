import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { viewOf } from "./support/doc-view";
import { documentIdOf, type World, withWorld } from "./support/world";

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
  async function expectRejected(world: World, args: readonly string[], mentions: RegExp): Promise<void> {
    const ran = await world.run(args);

    expect(ran.exitCode).not.toBe(0);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toMatch(mentions);
    expect(documents(world)).toEqual([]);
  }

  test("AC-14 a missing input file fails with a message naming it and creates no document", async () => {
    await withWorld(async (world) => {
      await world.init();
      await expectRejected(world, ["absent.md"], /not found.*absent\.md/);
    });
  });

  test("AC-14 an empty input file fails with a message naming it and creates no document", async () => {
    await withWorld(async (world) => {
      await world.init();
      await expectRejected(world, [world.write("blank.md", "")], /empty.*blank\.md/);
    });
  });

  test("AC-14 an unreadable input file fails with an actionable message and creates no document", async () => {
    await withWorld(async (world) => {
      await world.init();
      const input = world.write("locked.md", "# Locked\n");
      chmodSync(input, 0o000);
      await expectRejected(world, [input], /^md2gd: .*locked\.md/);
    });
  });

  test.failing("AC-14 a non-Markdown input file fails with an actionable message and creates no document", async () => {
    await withWorld(async (world) => {
      await world.init();
      const input = join(world.work, "photo.png");
      writeFileSync(input, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48]));
      await expectRejected(world, [input], /photo\.png/);
    });
  });

  test.failing("AC-14 an input path given with ~ resolves against the home directory", async () => {
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
