import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDiff, toFileIndex } from "./diff";
import { emptyReviewState } from "./review-state";
import { commitFiles, snapshotFiles } from "./snapshot";
import {
  readAllSnapshots,
  recordReviewStateStore,
  recordSnapshotReader,
  reviewStatePath,
  parseSnapshot,
  snapshotPath,
  type TextFileAdapter,
} from "./storage";
import { commit, fileDiff, snap } from "./test-helpers";

function memoryAdapter(files: Record<string, string> = {}): TextFileAdapter & { files: Record<string, string> } {
  return {
    files,
    async exists(path) {
      return path in files;
    },
    async read(path) {
      if (!(path in files)) throw new Error(`missing ${path}`);
      return files[path];
    },
    async write(path, data) {
      files[path] = data;
    },
    async listFiles(dir) {
      const prefix = dir.replace(/\/$/, "") + "/";
      return Object.keys(files).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).map((p) => p.slice(prefix.length));
    },
  };
}

const RECORD = "repositories/galaxy/branches/active/feature";

describe("record storage", () => {
  it("lays files out under <record>/differential-review/", () => {
    expect(snapshotPath(RECORD, "x")).toBe(`${RECORD}/differential-review/snapshots/x.json`);
    expect(reviewStatePath(RECORD + "/")).toBe(`${RECORD}/differential-review/review-state.json`);
  });

  it("lists and reads snapshots oldest first", async () => {
    const a = snap({ at: "2026-10-26T00:00:00.000Z", phase: "implementation", head: "a1", diff: fileDiff("f", [{ oldStart: 1, newStart: 1, lines: ["+x"] }]) });
    const b = snap({ at: "2026-10-26T01:00:00.000Z", phase: "hardening", head: "b1", diff: a.diff, previous: a });
    const adapter = memoryAdapter({
      [snapshotPath(RECORD, b.id)]: JSON.stringify(b),
      [snapshotPath(RECORD, a.id)]: JSON.stringify(a),
      [`${RECORD}/differential-review/snapshots/notes.txt`]: "ignored",
    });
    const reader = recordSnapshotReader(adapter, RECORD);
    expect(await reader.listSnapshotIds()).toEqual([a.id, b.id]);
    expect((await readAllSnapshots(reader)).map((s) => s.phase)).toEqual(["implementation", "hardening"]);
  });

  it("reads null before the first write, then round-trips review state", async () => {
    const adapter = memoryAdapter();
    const store = recordReviewStateStore(adapter, RECORD);
    expect(await store.readReviewState()).toBeNull();
    await store.writeReviewState(emptyReviewState());
    expect(await store.readReviewState()).toEqual(emptyReviewState());
  });

  it("rejects files that are not snapshots", async () => {
    const adapter = memoryAdapter({ [snapshotPath(RECORD, "bad")]: JSON.stringify({ kind: "nope" }) });
    await expect(recordSnapshotReader(adapter, RECORD).readSnapshot("bad")).rejects.toThrow();
  });
});

describe("fingerprint integrity", () => {
  const MIXED = readFileSync(new URL("./fixtures/mixed.diff", import.meta.url), "utf8");
  const s = snap({ at: "2026-10-26T00:00:00.000Z", phase: "implementation", head: "a1", diff: MIXED, commits: [commit("c1", "p1", "All", MIXED)] });

  it("stores exactly the fingerprints a re-parse produces", () => {
    const reparsed = parseDiff(MIXED).map(toFileIndex);
    expect(s.files).toEqual(reparsed);
    expect(s.commits[0].files).toEqual(reparsed);
    const fromDisk = JSON.parse(JSON.stringify(s));
    expect(() => snapshotFiles(fromDisk)).not.toThrow();
    expect(() => commitFiles(fromDisk.commits[0])).not.toThrow();
  });

  it("fails loudly when stored fingerprints drift from the parser", () => {
    const tampered = JSON.parse(JSON.stringify(s));
    tampered.files[0].hunks[0].id = "h1:0000000000000000";
    expect(() => snapshotFiles(tampered)).toThrow(/fingerprints don't match/);
    tampered.commits[0].files[1].hunks[0].id = "h1:0000000000000000";
    expect(() => commitFiles(tampered.commits[0])).toThrow(/fingerprints don't match/);
  });

  it("rejects snapshots with another fingerprint version", () => {
    expect(() => parseSnapshot({ ...JSON.parse(JSON.stringify(s)), fingerprintVersion: "h2" })).toThrow(/fingerprintVersion/);
  });
});
