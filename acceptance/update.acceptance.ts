import { describe, expect, test } from "bun:test";
import { documentIdOf, expectFailure, withWorld } from "./support/world";

describe("re-rendering into an existing doc", () => {
  test.todo("AC-9 --update on a doc md2gd created re-renders it at the same URL to match a fresh create", () => {});
  test.todo("AC-9 --update on a doc md2gd did not create re-renders it at the same URL", () => {});
  test.todo("AC-9 no style from the previous render remains after --update", () => {});
  test.todo("AC-9 --update on a doc with an already-empty body succeeds", () => {});
  test.todo("AC-9 --update with a changed H1 renames the doc", () => {});
});

describe("cross-document links", () => {
  test.todo("AC-11 a relative link to a mapped document becomes a live link to its Doc URL with its text unchanged", () => {});
  test.todo("AC-11 a #fragment on a mapped link is dropped", () => {});
  test.todo("AC-11 the link target resolves against the source file and the keys against the map file", () => {});
  test.todo("AC-11 a bare document id or an edit URL is accepted as a map value", () => {});
  test.todo("AC-11 an unmapped relative link, an in-page anchor, and a reference-style link stay plain text", () => {});
  test.todo("AC-11 stderr carries a one-line summary of the link counts", () => {});
  test.todo("AC-11 a missing map fails with an actionable message before any document is written", () => {});
  test.todo("AC-11 a malformed map fails with an actionable message before any document is written", () => {});
});

describe("unreadable update targets", () => {
  test("AC-12 --update on a wrong id exits non-zero with an actionable message and changes nothing", async () => {
    await withWorld(async (world) => {
      await world.init();
      const input = world.write("note.md", "# Note\n");

      const refused = await world.run([input, "--update", "missingDocId1234567890"]);

      expect(refused.stdout).toBe("");
      expectFailure(
        refused,
        "md2gd: cannot open document missingDocId1234567890 (404 NOT_FOUND) [document_inaccessible]\nresolve: check the doc URL or id and that you can edit it\n",
      );
      expectFailure(
        await world.run([input, "--update"]),
        `md2gd: no document remembered for ${input} [no_document_remembered]\nresolve: md2gd ${input} --update <url|id>\n`,
      );
    });
  });
  test.todo("AC-12 --update on a doc without permission exits non-zero with an actionable message and changes nothing", () => {});
  test.todo("AC-12 --update on a trashed doc exits non-zero with an actionable message and changes nothing", () => {});
});

describe("file to doc mapping", () => {
  test.todo("AC-13 after a create, --update with no argument updates that doc", () => {});
  test("AC-13 --update <url|id> on a doc md2gd did not create adopts it for a later no-argument --update", async () => {
    await withWorld(async (world) => {
      await world.init();
      const id = world.google.addDocument({ name: "Hand made" });
      const input = world.write("note.md", "# Note\n");
      const url = `https://docs.google.com/document/d/${id}/edit`;

      expect(documentIdOf(await world.run([input, "--update", url]))).toBe(id);
      expect(documentIdOf(await world.run([input, "--update"]))).toBe(id);
    });
  });
  test.todo("AC-13 a plain run with a mapping creates a new doc and prints a hint naming the earlier one", () => {});
  test.todo("AC-13 a mapping whose doc is gone fails with a clear error and creates nothing", () => {});
});
