import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";

const HOME = "/home/u";

describe("parseArgs", () => {
  test("no args and help flags map to help", () => {
    for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
      expect(parseArgs(argv, HOME).kind).toBe("help");
    }
  });

  test("version flags map to version", () => {
    for (const argv of [["version"], ["--version"], ["-V"]]) {
      expect(parseArgs(argv, HOME).kind).toBe("version");
    }
  });

  test("init parses an optional client path", () => {
    expect(parseArgs(["init"], HOME)).toEqual({ kind: "init" });
    expect(parseArgs(["init", "--client", "cs.json"], HOME)).toEqual({ kind: "init", clientPath: "cs.json" });
  });

  test("a file path with options parses to a convert command", () => {
    expect(parseArgs(["doc.md"], HOME)).toEqual({
      kind: "convert",
      file: "doc.md",
      title: undefined,
      open: false,
      update: false,
    });
    expect(parseArgs(["doc.md", "--open", "--title", "Report"], HOME)).toEqual({
      kind: "convert",
      file: "doc.md",
      title: "Report",
      open: true,
      update: false,
    });
  });

  test("--update with no argument flags an update against the file's remembered doc", () => {
    expect(parseArgs(["doc.md", "--update"], HOME)).toEqual({
      kind: "convert",
      file: "doc.md",
      title: undefined,
      open: false,
      update: true,
      updateTarget: undefined,
    });
  });

  test("--folder captures the destination folder", () => {
    expect(parseArgs(["doc.md", "--folder", "https://drive.google.com/drive/folders/F1"], HOME)).toMatchObject({
      kind: "convert",
      folder: "https://drive.google.com/drive/folders/F1",
    });
  });

  test("--folder with no value errors", () => {
    expect(parseArgs(["doc.md", "--folder"], HOME).kind).toBe("error");
  });

  test("--links captures the map path", () => {
    expect(parseArgs(["doc.md", "--links", "docs-map.json"], HOME)).toMatchObject({
      kind: "convert",
      links: "docs-map.json",
    });
  });

  test("a leading ~ in the file and --links paths resolves against home", () => {
    expect(parseArgs(["~/a.md", "--links", "~/m.json"], HOME)).toMatchObject({
      file: "/home/u/a.md",
      links: "/home/u/m.json",
    });
    expect(parseArgs(["~"], HOME)).toMatchObject({ file: "/home/u" });
  });

  test("a ~ naming another user, or with no or an empty home, stays as written", () => {
    expect(parseArgs(["~bob/a.md"], HOME)).toMatchObject({ file: "~bob/a.md" });
    expect(parseArgs(["~/a.md", "--links", "~/m.json"], undefined)).toMatchObject({
      file: "~/a.md",
      links: "~/m.json",
    });
    expect(parseArgs(["~/a.md"], "")).toMatchObject({ file: "~/a.md" });
  });

  test("--links with no value errors", () => {
    expect(parseArgs(["doc.md", "--links"], HOME).kind).toBe("error");
  });

  test("--update with an argument captures the explicit target", () => {
    const cmd = parseArgs(["doc.md", "--update", "https://docs.google.com/document/d/abc/edit"], HOME);
    expect(cmd).toMatchObject({
      kind: "convert",
      update: true,
      updateTarget: "https://docs.google.com/document/d/abc/edit",
    });
  });

  test("--update before another flag stays a no-arg update", () => {
    expect(parseArgs(["doc.md", "--update", "--open"], HOME)).toMatchObject({
      update: true,
      updateTarget: undefined,
      open: true,
    });
  });

  test("a flag needing a value errors when the value is missing", () => {
    expect(parseArgs(["doc.md", "--title"], HOME).kind).toBe("error");
    expect(parseArgs(["init", "--client"], HOME).kind).toBe("error");
  });

  test("an unknown option errors", () => {
    expect(parseArgs(["doc.md", "--nope"], HOME).kind).toBe("error");
  });
});
