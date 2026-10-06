import { describe, expect, test } from "bun:test";
import { documentIdOf, type Ran, type World, withWorld } from "./support/world";

const DOC_MIME = "application/vnd.google-apps.document";

function expectReadableFailure(ran: Ran, cause: RegExp): void {
  expect(ran.exitCode).not.toBe(0);
  const message = ran.stderr.trim();
  expect(message.startsWith("md2gd:")).toBe(true);
  expect(message.split("\n")).toHaveLength(1);
  expect(message).not.toContain("    at ");
  expect(message).toMatch(cause);
}

const documents = (world: World): string[] =>
  world.google
    .driveFiles()
    .filter((file) => file.mimeType === DOC_MIME)
    .map((file) => file.id);

describe("--folder on a create", () => {
  test("AC-10 a folder id the user owns receives the new doc", async () => {
    await withWorld(async (world) => {
      await world.init();
      const folder = world.google.addFolder({ name: "Reports" });

      const id = documentIdOf(await world.run([world.write("note.md", "# Note\n"), "--folder", folder]));

      expect(world.google.file(id).parents).toEqual([folder]);
    });
  });

  test("AC-10 a folder URL the user owns receives the new doc", async () => {
    await withWorld(async (world) => {
      await world.init();
      const folder = world.google.addFolder({ name: "Reports" });

      const id = documentIdOf(
        await world.run([
          world.write("note.md", "# Note\n"),
          "--folder",
          `https://drive.google.com/drive/folders/${folder}?usp=sharing`,
        ]),
      );

      expect(world.google.file(id).parents).toEqual([folder]);
    });
  });

  test("AC-10 a folder shared with the user as writer receives the new doc", async () => {
    await withWorld(async (world) => {
      await world.init();
      const folder = world.google.addFolder({ name: "Team", role: "writer" });

      const id = documentIdOf(await world.run([world.write("note.md", "# Note\n"), "--folder", folder]));

      expect(world.google.file(id).parents).toEqual([folder]);
    });
  });

  test("AC-10 a folder in a shared drive receives the new doc", async () => {
    await withWorld(async (world) => {
      await world.init();
      const folder = world.google.addFolder({ name: "Shared", role: "writer", sharedDrive: true });

      const id = documentIdOf(await world.run([world.write("note.md", "# Note\n"), "--folder", folder]));

      expect(world.google.file(id).parents).toEqual([folder]);
      expect(world.google.file(id).sharedDrive).toBe(true);
    });
  });

  test("AC-10 a folder that does not exist fails with an actionable message and creates nothing", async () => {
    await withWorld(async (world) => {
      await world.init();

      const ran = await world.run([world.write("note.md", "# Note\n"), "--folder", "missingFolderId1234567890"]);

      expectReadableFailure(ran, /folder/);
      expect(documents(world)).toEqual([]);
    });
  });

  test("AC-10 a folder the user can only read fails with an actionable message and creates nothing", async () => {
    await withWorld(async (world) => {
      await world.init();
      const folder = world.google.addFolder({ name: "Read only", role: "reader" });

      const ran = await world.run([world.write("note.md", "# Note\n"), "--folder", folder]);

      expectReadableFailure(ran, /folder/);
      expect(documents(world)).toEqual([]);
    });
  });

  test("AC-10 a --folder naming a document fails with an actionable message and creates nothing", async () => {
    await withWorld(async (world) => {
      await world.init();
      const notAFolder = world.google.addDocument({ name: "Plan" });

      const ran = await world.run([world.write("note.md", "# Note\n"), "--folder", notAFolder]);

      expectReadableFailure(ran, /folder/);
      expect(documents(world)).toEqual([notAFolder]);
    });
  });
});

describe("--folder on an update", () => {
  test.todo("AC-10 --update --folder moves the target doc into the folder at the same URL", () => {});
  test.todo("AC-10 --update --folder into a shared-drive folder moves the target doc there", () => {});
  test.todo("AC-10 --update without --folder leaves the doc where it is", () => {});
  test.todo("AC-10 --update --folder on a folder the user cannot access fails and changes nothing", () => {});
  test.todo("AC-10 --update --folder naming a non-folder fails and changes nothing", () => {});
});
