import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff";
import { FUZZY_THRESHOLD, hunkRefs, matchHunks, similarity } from "./match";
import { fileDiff } from "./test-helpers";

function refs(diff: string) {
  return hunkRefs(parseDiff(diff));
}

const ONE = fileDiff("lib/tool.py", [
  { oldStart: 10, newStart: 10, lines: [" def run(self):", "-    return self.execute(job)", "+    return self.execute(job, cache=True)"] },
  { oldStart: 80, newStart: 80, lines: [" # helpers", "+def helper():", "+    return 42"] },
]);

describe("matchHunks", () => {
  it("matches identical diffs exactly", () => {
    const r = matchHunks(refs(ONE), refs(ONE));
    expect(r.pairs.map((p) => p.match)).toEqual(["exact", "exact"]);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("treats a one-line amend as a fuzzy (changed) match", () => {
    const amended = ONE.replace("cache=True)", "cache=False)");
    const r = matchHunks(refs(ONE), refs(amended));
    expect(r.pairs.map((p) => p.match).sort()).toEqual(["exact", "fuzzy"]);
    const fuzzy = r.pairs.find((p) => p.match === "fuzzy")!;
    expect(fuzzy.similarity).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
    expect(fuzzy.similarity).toBeLessThan(1);
  });

  it("leaves an unrelated hunk in the same file unmatched", () => {
    const other = fileDiff("lib/tool.py", [{ oldStart: 10, newStart: 10, lines: ["+import collections.abc as abc_mod"] }]);
    const r = matchHunks(refs(ONE), refs(other));
    expect(r.pairs).toEqual([]);
    expect(r.added).toHaveLength(1);
    expect(r.removed).toHaveLength(2);
  });

  it("never fuzzy-matches across unrelated files", () => {
    const moved = ONE.replaceAll("lib/tool.py", "lib/other.py");
    const r = matchHunks(refs(ONE), refs(moved));
    expect(r.pairs).toEqual([]);
  });

  it("follows a rename by base path", () => {
    const before = refs(ONE);
    const after = refs(ONE).map((r) => ({ ...r, id: r.id + "x", path: "lib/renamed.py", basePath: "lib/tool.py" }));
    const r = matchHunks(before, after);
    expect(r.pairs.map((p) => p.match)).toEqual(["moved", "moved"]);
  });

  it("pairs one-to-one when content repeats", () => {
    const one = fileDiff("a.py", [{ oldStart: 1, newStart: 1, lines: [" a", "+pass", " b"] }]);
    const two = fileDiff("a.py", [
      { oldStart: 1, newStart: 1, lines: [" a", "+pass", " b"] },
      { oldStart: 9, newStart: 10, lines: [" c", "+pass", " d"] },
    ]);
    const r = matchHunks(refs(one), refs(two));
    expect(r.pairs).toHaveLength(1);
    expect(r.added).toHaveLength(1);
  });

  it("matches a changed binary file's meta unit as fuzzy", () => {
    const bin = (blob: string) =>
      `diff --git a/x.png b/x.png\nindex 1111111..${blob} 100644\nBinary files a/x.png and b/x.png differ\n`;
    const r = matchHunks(refs(bin("2222222")), refs(bin("3333333")));
    expect(r.pairs.map((p) => p.match)).toEqual(["fuzzy"]);
    expect(r.pairs[0].similarity).toBeGreaterThan(0.9);
    expect(r.pairs[0].similarity).toBeLessThan(1);
  });
});

describe("similarity", () => {
  it("falls back to lines for huge hunks", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `+line number ${i}`);
    const edited = big.map((l, i) => (i === 5 ? "+changed" : l));
    expect(similarity(big, edited)).toBeGreaterThan(0.99);
  });
});
