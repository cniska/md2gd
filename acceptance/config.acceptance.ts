import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_MIME } from "./support/google-fake";
import { documentIdOf, expectFailure, type World, withWorld } from "./support/world";

const BATCH_UPDATE = /:batchUpdate$/;
const documents = (world: World): string[] =>
  world.google
    .driveFiles()
    .filter((file) => file.mimeType === DOC_MIME)
    .map((file) => file.id);
const unparsed = (config: string): string =>
  `md2gd: config.json is not JSON: ${config} [config_unparsed]\nresolve: fix the JSON in ${config}, or move the file aside to start with no remembered docs\n`;

describe("config.json", () => {
  test("AC-23 a conversion preserves unknown top-level keys in config.json", async () => {
    await withWorld(async (world) => {
      await world.init();
      const config = join(world.configDir, "config.json");
      writeFileSync(config, JSON.stringify({ docs: {}, theme: { accent: "teal" }, futureFlag: true }));
      const file = world.write("note.md", "# Note\n");

      const id = documentIdOf(await world.run([file]));

      expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
        docs: { [realpathSync(file)]: id },
        theme: { accent: "teal" },
        futureFlag: true,
      });
    });
  });

  test("AC-23 a corrupt config.json refuses a conversion and creates nothing", async () => {
    await withWorld(async (world) => {
      await world.init();
      const config = join(world.configDir, "config.json");
      writeFileSync(config, "{ not json");

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      expectFailure(ran, unparsed(config));
      expect(ran.stdout).toBe("");
      expect(documents(world)).toEqual([]);
      expect(readFileSync(config, "utf8")).toBe("{ not json");
    });
  });

  test("AC-23 a corrupt config.json refuses an --update <id> and leaves the doc unchanged", async () => {
    await withWorld(async (world) => {
      await world.init();
      const id = world.google.addDocument({ name: "Plan" });
      const before = JSON.stringify(world.google.document(id));
      const config = join(world.configDir, "config.json");
      writeFileSync(config, "{ not json");

      const ran = await world.run([world.write("note.md", "# Note\n"), "--update", id]);

      expectFailure(ran, unparsed(config));
      expect(JSON.stringify(world.google.document(id))).toBe(before);
      expect(world.google.requests.some((request) => BATCH_UPDATE.test(request.path))).toBe(false);
    });
  });

  test("AC-23 a corrupt config.json refuses a bare --update before any Google request", async () => {
    await withWorld(async (world) => {
      await world.init();
      const config = join(world.configDir, "config.json");
      writeFileSync(config, "{ not json");
      const before = world.google.requests.length;

      const ran = await world.run([world.write("note.md", "# Note\n"), "--update"]);

      expectFailure(ran, unparsed(config));
      expect(world.google.requests.slice(before)).toEqual([]);
    });
  });

  test("AC-23 a config.json that cannot be written fails after printing the updated doc's URL", async () => {
    await withWorld(async (world) => {
      await world.init();
      const id = world.google.addDocument({ name: "Plan" });
      const config = join(world.configDir, "config.json");
      writeFileSync(config, JSON.stringify({ docs: {} }));
      chmodSync(config, 0o400);

      const ran = await world.run([world.write("note.md", "# Note\n"), "--update", id]);

      expect(ran.stdout).toBe(`https://docs.google.com/document/d/${id}/edit\n`);
      expectFailure(
        ran,
        `md2gd: cannot write config.json ${config}: permission denied [config_unwritable]\nresolve: make ${config} and ${world.configDir} writable, then run the command again\n`,
      );
    });
  });

  test("AC-23 a config.json that cannot be written outranks a browser that cannot be launched", async () => {
    await withWorld(async (world) => {
      await world.init();
      const config = join(world.configDir, "config.json");
      writeFileSync(config, JSON.stringify({ docs: {} }));
      chmodSync(config, 0o400);

      const ran = await world.run([world.write("note.md", "# Note\n"), "--open"], { PATH: "/nonexistent" });

      expectFailure(
        ran,
        `md2gd: cannot write config.json ${config}: permission denied [config_unwritable]\nresolve: make ${config} and ${world.configDir} writable, then run the command again\n`,
      );
    });
  });

  test("AC-23 a config.json that cannot be written fails after printing the new doc's URL", async () => {
    await withWorld(async (world) => {
      await world.init();
      const config = join(world.configDir, "config.json");
      writeFileSync(config, JSON.stringify({ docs: {} }));
      chmodSync(config, 0o400);

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      const id = documents(world)[0] ?? "no document";
      expect(ran.stdout).toBe(`https://docs.google.com/document/d/${id}/edit\n`);
      expectFailure(
        ran,
        `md2gd: cannot write config.json ${config}: permission denied [config_unwritable]\nresolve: make ${config} and ${world.configDir} writable, then run the command again\n`,
      );
    });
  });
});
