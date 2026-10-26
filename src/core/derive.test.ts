import { describe, expect, it } from "vitest";
import { deriveReview } from "./derive";
import { changesSincePhase, latestSnapshot } from "./queries";
import {
  emptyReviewState,
  markFileReviewed,
  markHunksReviewed,
  parseReviewState,
  revokeCommitSignoff,
  signOffCommit,
  unmarkHunks,
} from "./review-state";
import { commit, fileDiff, snap } from "./test-helpers";

const NOW = "2026-10-26T01:00:00Z";
const hunkA = (arg: string) => fileDiff("lib/tool.py", [
  { oldStart: 10, newStart: 10, lines: [" def run(self):", "-    return self.execute(job)", `+    return self.execute(job, cache=${arg})`] },
]);
const hunkB = (start: number) => fileDiff("lib/tool.py", [
  { oldStart: start, newStart: start, lines: [" # helpers", "+def helper():", "+    return 42"] },
]);
const toolDiff = (arg: string, bStart: number) => fileDiff("lib/tool.py", [
  { oldStart: 10, newStart: 10, lines: [" def run(self):", "-    return self.execute(job)", `+    return self.execute(job, cache=${arg})`] },
  { oldStart: bStart, newStart: bStart, lines: [" # helpers", "+def helper():", "+    return 42"] },
]);
const extra = fileDiff("lib/new.py", [{ oldStart: 0, newStart: 1, lines: ["+print('hi')"] }]);

const s1 = snap({
  at: "2026-10-26T00:00:00.000Z",
  phase: "implementation",
  head: "aaa1",
  diff: toolDiff("True", 80),
  commits: [commit("c1", "p1", "Cache jobs", hunkA("True")), commit("c2", "p2", "Add helper", hunkB(80))],
});
const s2 = snap({
  at: "2026-10-26T02:00:00.000Z",
  phase: "hardening",
  head: "bbb2",
  diff: toolDiff("False", 95) + extra,
  commits: [
    commit("d1", "p1-amended", "Cache jobs", hunkA("False")),
    commit("d2", "p2", "Add helper", hunkB(95)),
    commit("d3", "p3", "New module", extra),
  ],
  previous: s1,
  rangeDiffPairs: [{ previousSha: "c1".padEnd(40, "0"), sha: "d1".padEnd(40, "0") }],
});

function reviewedEverythingIn(snapshot: typeof s1) {
  let state = emptyReviewState();
  for (const f of snapshot.files) state = markFileReviewed(state, snapshot, f.path, NOW);
  for (const c of snapshot.commits) state = signOffCommit(state, snapshot, c.sha, NOW);
  return state;
}

describe("snapshot mapping", () => {
  it("maps commits by patch-id then range-diff and flags patch-id changes", () => {
    expect(s2.mapping!.commits.map((c) => [c.sha.slice(0, 2), c.previousSha?.slice(0, 2) ?? null, c.method, c.patchIdChanged])).toEqual([
      ["d1", "c1", "range-diff", true],
      ["d2", "c2", "patch-id", false],
      ["d3", null, null, false],
    ]);
    expect(s2.mapping!.commits[0].hunks!.map((h) => h.match)).toEqual(["fuzzy"]);
    expect(s2.mapping!.droppedCommits).toEqual([]);
    expect(s2.mapping!.hunks.map((h) => h.match)).toEqual(["fuzzy", "exact", "new"]);
  });

  it("keeps identical commits without a patch-id (merges) paired and signed off", () => {
    const merge = commit("m1", null, "Merge dev", "");
    const a = snap({ at: "2026-10-26T03:00:00.000Z", phase: "implementation", head: "m1", diff: s1.diff, commits: [merge] });
    const b = snap({ at: "2026-10-26T04:00:00.000Z", phase: "hardening", head: "m1", diff: s1.diff, commits: [merge], previous: a, rangeDiffPairs: [] });
    expect(b.mapping!.commits[0]).toMatchObject({ method: "sha", patchIdChanged: false });
    const state = signOffCommit(emptyReviewState(), a, merge.sha, NOW);
    expect(deriveReview(b, state, [a, b]).commits[0].state).toBe("reviewed");
    expect(changesSincePhase([a, b], "implementation")!.commits[0].change).toBe("unchanged");
  });

  it("falls back to subject matching without range-diff", () => {
    const s = snap({ at: "2026-10-26T03:00:00.000Z", phase: "polishing", head: "ccc3", diff: s2.diff, commits: [commit("e1", "zz", "Cache jobs", hunkA("False"))], previous: s1 });
    expect(s.mapping!.rangeDiff).toBe(false);
    expect(s.mapping!.commits[0]).toMatchObject({ method: "subject", patchIdChanged: true });
    expect(s.mapping!.droppedCommits).toEqual(["c2".padEnd(40, "0")]);
  });
});

describe("deriveReview", () => {
  const state = reviewedEverythingIn(s1);

  it("everything is reviewed in the snapshot it was checked off in", () => {
    const r = deriveReview(s1, state, [s1]);
    expect(r.counts.hunks).toEqual({ reviewed: 2, new: 0, changed: 0 });
    expect(r.commits.map((c) => c.state)).toEqual(["reviewed", "reviewed"]);
  });

  it("carries check-offs across a rebase and flags only what changed", () => {
    const r = deriveReview(s2, state, [s1, s2]);
    const tool = r.files.find((f) => f.path === "lib/tool.py")!;
    expect(tool.hunks.map((h) => h.state)).toEqual(["changed", "reviewed"]);
    expect(tool.state).toBe("changed");
    expect(r.files.find((f) => f.path === "lib/new.py")!.state).toBe("new");
    expect(tool.hunks[0].reviewedAs).toMatchObject({ snapshotId: s1.id });
  });

  it("holds commit sign-off on unchanged patch-id and flags changed ones with differing hunks", () => {
    const r = deriveReview(s2, state, [s1, s2]);
    expect(r.commits.map((c) => [c.subject, c.state])).toEqual([
      ["Cache jobs", "changed"],
      ["Add helper", "reviewed"],
      ["New module", "new"],
    ]);
    expect(r.commits[0].signoff!.key).toBe("p1");
    expect(r.commits[0].differingHunks).toEqual(s2.commits[0].files[0].hunks.map((h) => h.id));
  });

  it("re-reviewing a changed hunk makes it reviewed; unmarking restores new", () => {
    const changed = deriveReview(s2, state, [s1, s2]).files[0].hunks[0];
    const next = markHunksReviewed(state, s2, [changed.id], NOW);
    expect(deriveReview(s2, next, [s1, s2]).files[0].hunks[0].state).toBe("reviewed");
    const cleared = unmarkHunks(next, [changed.id, changed.reviewedAs!.hunkId], NOW);
    expect(deriveReview(s2, cleared, [s1, s2]).files[0].hunks[0].state).toBe("new");
  });

  it("revoking a sign-off returns the commit to new", () => {
    const r = deriveReview(s1, revokeCommitSignoff(state, "p1", NOW), [s1]);
    expect(r.commits[0].state).toBe("new");
  });

  it("still matches exactly when the reviewed snapshot is missing", () => {
    const r = deriveReview(s2, state, [s2]);
    expect(r.files[0].hunks.map((h) => h.state)).toEqual(["new", "reviewed"]);
  });
});

describe("review state", () => {
  it("round-trips through JSON and rejects other kinds or versions", () => {
    const state = reviewedEverythingIn(s1);
    expect(parseReviewState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(() => parseReviewState({ kind: "other" })).toThrow();
    expect(() => parseReviewState({ ...state, schemaVersion: 99 })).toThrow(/schemaVersion/);
  });

  it("rejects hunks that are not in the snapshot", () => {
    expect(() => markHunksReviewed(emptyReviewState(), s1, ["h1:nope"], NOW)).toThrow();
  });
});

describe("phase queries", () => {
  it("shows what hardening changed since implementation", () => {
    const c = changesSincePhase([s1, s2], "implementation")!;
    expect(c.from).toBe(s1.id);
    expect(c.to).toBe(s2.id);
    expect(c.hunks.map((h) => h.match)).toEqual(["fuzzy", "exact", "new"]);
    expect(c.commits.map((x) => x.change)).toEqual(["modified", "unchanged", "added"]);
  });

  it("finds the latest snapshot of a phase", () => {
    expect(latestSnapshot([s2, s1], { phase: "implementation" })!.id).toBe(s1.id);
    expect(latestSnapshot([s2, s1])!.id).toBe(s2.id);
    expect(changesSincePhase([s1, s2], "polishing")).toBeNull();
  });
});
