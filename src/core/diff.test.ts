import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeChangedLines, parseDiff, toFileIndex } from "./diff";
import { sha256Hex } from "./sha256";
import { fileDiff } from "./test-helpers";

const MIXED = readFileSync(new URL("./fixtures/mixed.diff", import.meta.url), "utf8");

describe("sha256Hex", () => {
  // 55/56 and 63/64 bytes straddle the one- vs two-block padding boundary.
  const sizes = [55, 56, 63, 64, 119, 120].map((n) => "y".repeat(n));
  it.each(["", "abc", "ünïcødé ✓ 𝄞", "x".repeat(1000), ...sizes])("matches node:crypto for %j", (text) => {
    expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });
});

describe("parseDiff", () => {
  const files = parseDiff(MIXED);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

  it("reads statuses and paths from git extended headers", () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["a.txt", "modified"],
      ["bin.dat", "modified"],
      ["del.txt", "deleted"],
      ["empty.txt", "added"],
      ["mode.sh", "modified"],
      ["nonl.txt", "added"],
      ["renamed.txt", "renamed"],
    ]);
    expect(byPath["renamed.txt"]).toMatchObject({ oldPath: "ren.txt", newPath: "renamed.txt", basePath: "ren.txt" });
    expect(byPath["del.txt"]).toMatchObject({ oldPath: "del.txt", newPath: null });
    expect(byPath["empty.txt"]).toMatchObject({ oldPath: null, basePath: null });
  });

  it("keeps raw hunk headers and line ranges", () => {
    expect(byPath["a.txt"].hunks.map((h) => [h.header, h.oldStart, h.newStart, h.added, h.removed])).toEqual([
      ["@@ -2,7 +2,7 @@", 2, 2, 1, 1],
      ["@@ -12,7 +12,7 @@", 12, 12, 1, 1],
    ]);
    expect(byPath["del.txt"].hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, removed: 1 });
  });

  it("gives hunkless changes one synthetic meta unit", () => {
    for (const path of ["bin.dat", "empty.txt", "mode.sh", "renamed.txt"]) {
      expect(byPath[path].hunks.map((h) => h.kind)).toEqual(["meta"]);
    }
    expect(byPath["bin.dat"].hunks[0].changed).toContain(
      "# binary d5d0b8b4c4c9e936890870f6799cfbb5ba984470..4a270318359d8c2a960136495bceeae9eee22424",
    );
    expect(byPath["mode.sh"].hunks[0].header).toBe("mode 100644 → 100755");
    expect(byPath["renamed.txt"].hunks[0].header).toBe("renamed ren.txt → renamed.txt");
    expect(byPath["a.txt"].hunks.every((h) => h.kind === "text")).toBe(true);
  });

  it("keeps the no-newline marker in the fingerprinted lines", () => {
    expect(byPath["nonl.txt"].hunks[0].changed).toEqual(["+no newline", "\\ No newline at end of file"]);
  });

  it("serializes to an index without hunk lines", () => {
    const index = toFileIndex(byPath["a.txt"]);
    expect(Object.keys(index.hunks[0])).not.toContain("lines");
    expect(Object.keys(index.hunks[0])).not.toContain("changed");
    expect(JSON.parse(JSON.stringify(index))).toEqual(index);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });

  it("splits lines on \\n only, so form feeds and lone CRs stay inside a line", () => {
    const [file] = parseDiff(fileDiff("f.txt", [{ oldStart: 1, newStart: 1, lines: [" a\fb", "-mid\rcr", "+mid\rCR", " c\u0085"] }]));
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].changed).toEqual(["-mid\rcr", "+mid\rCR"]);
  });
});

describe("fingerprints", () => {
  const change = [" ctx1", " ctx2", "-old line", "+new line", " ctx3"];

  it("ignore line numbers and context", () => {
    const a = parseDiff(fileDiff("f.py", [{ oldStart: 10, newStart: 10, lines: change }]))[0].hunks[0];
    const shifted = [" other", " context", "-old line", "+new line", " here"];
    const b = parseDiff(fileDiff("f.py", [{ oldStart: 40, newStart: 52, lines: shifted }]))[0].hunks[0];
    expect(b.id).toBe(a.id);
    expect(b.contentHash).toBe(a.contentHash);
  });

  it("ignore trailing whitespace but not indentation", () => {
    const base = parseDiff(fileDiff("f.py", [{ oldStart: 1, newStart: 1, lines: ["-x = 1", "+x = 2"] }]))[0].hunks[0];
    const trailing = parseDiff(fileDiff("f.py", [{ oldStart: 1, newStart: 1, lines: ["-x = 1  ", "+x = 2\t\r"] }]))[0].hunks[0];
    const indented = parseDiff(fileDiff("f.py", [{ oldStart: 1, newStart: 1, lines: ["-x = 1", "+    x = 2"] }]))[0].hunks[0];
    expect(trailing.contentHash).toBe(base.contentHash);
    expect(indented.contentHash).not.toBe(base.contentHash);
  });

  it("do not collide for identical hunks in different files", () => {
    const diff = fileDiff("a.py", [{ oldStart: 1, newStart: 1, lines: ["+import os"] }]) +
      fileDiff("b.py", [{ oldStart: 1, newStart: 1, lines: ["+import os"] }]);
    const [a, b] = parseDiff(diff).map((f) => f.hunks[0]);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.id).not.toBe(b.id);
  });

  it("do not collide for identical hunks twice in one file", () => {
    const diff = fileDiff("a.py", [
      { oldStart: 1, newStart: 1, lines: [" a", "+pass", " b"] },
      { oldStart: 20, newStart: 21, lines: [" c", "+pass", " d"] },
    ]);
    const [h0, h1] = parseDiff(diff)[0].hunks;
    expect([h0.occurrence, h1.occurrence]).toEqual([0, 1]);
    expect(h0.id).not.toBe(h1.id);
  });

  it("flag whitespace-only hunks", () => {
    const ws = parseDiff(fileDiff("f.py", [{ oldStart: 1, newStart: 1, lines: ["-if x:", "+if  x :"] }]))[0].hunks[0];
    const real = parseDiff(fileDiff("f.py", [{ oldStart: 1, newStart: 1, lines: ["-if x:", "+if y:"] }]))[0].hunks[0];
    expect(ws.whitespaceOnly).toBe(true);
    expect(real.whitespaceOnly).toBe(false);
  });

  it("drop context and a context-only no-newline marker", () => {
    expect(normalizeChangedLines([" a", "\\ No newline at end of file", "+b  "])).toEqual(["+b"]);
  });
});
