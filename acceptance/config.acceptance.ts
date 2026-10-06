import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { documentIdOf, withWorld } from "./support/world";

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

  test("AC-23 a corrupt config.json does not stop a conversion", async () => {
    await withWorld(async (world) => {
      await world.init();
      writeFileSync(join(world.configDir, "config.json"), "{ not json");

      const ran = await world.run([world.write("note.md", "# Note\n")]);

      documentIdOf(ran);
    });
  });
});
