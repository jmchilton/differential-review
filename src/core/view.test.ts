import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyReviewState, markFileReviewed, signOffCommit } from "./review-state";
import { snapshotFiles } from "./snapshot";
import { parseSnapshot } from "./storage";
import { commit, fileDiff, snap } from "./test-helpers";
import type { ReviewState, Snapshot } from "./types";
import { buildReviewView, commitHunks, findHunk, hunkPatch, interdiffPatch, previousHunk } from "./view";

// make-view-fixtures.sh: implementation; rebase + amend + new commit (hardening); pure rebase (polishing).
const DIR = new URL("./fixtures/view-fixtures/", import.meta.url);
const [impl, hard, polish] = readdirSync(DIR)
  .sort()
  .map((name) => parseSnapshot(JSON.parse(readFileSync(new URL(name, DIR), "utf8"))));

function reviewAll(s: Snapshot, state: ReviewState = emptyReviewState()): ReviewState {
  for (const f of s.files) state = markFileReviewed(state, s, f.path, "t");
  for (const c of s.commits) state = signOffCommit(state, s, c.sha, "t");
  return state;
}

const subjects = (commits: { subject: string; visible: boolean }[]) => commits.filter((c) => c.visible).map((c) => c.subject);

describe("buildReviewView", () => {
  it("is null without snapshots", () => {
    expect(buildReviewView([], null)).toBeNull();
  });

  it("shows everything as new before any review", () => {
    const view = buildReviewView([impl], null)!;
    expect(view.snapshot.id).toBe(impl.id);
    expect(view.counts.hunks).toEqual({ reviewed: 0, new: 5, changed: 0 });
    expect(view.files.map((f) => [f.path, f.state])).toEqual([
      ["README.md", "new"],
      ["app.py", "new"],
      ["settings.yml", "new"],
      ["util.py", "new"],
    ]);
    expect(view.files.find((f) => f.path === "settings.yml")).toMatchObject({ status: "renamed", oldPath: "config.yml" });
    expect(view.commits.every((c) => c.state === "new" && c.visible)).toBe(true);
    expect(view.needsRelook).toBe(false);
    expect(view.baselineOptions).toEqual([]);
    expect(view.summary.previousSnapshotId).toBeNull();
  });

  it("after a rebase + amend, shows only the changed hunks and flags the amended commit", () => {
    const view = buildReviewView([impl, hard], reviewAll(impl), { hideReviewed: true })!;
    expect(view.snapshot.id).toBe(hard.id);
    expect(view.counts.hunks).toEqual({ reviewed: 3, new: 0, changed: 2 });
    expect(view.files.filter((f) => f.visible).map((f) => f.path)).toEqual(["app.py", "util.py"]);
    const app = view.files.find((f) => f.path === "app.py")!;
    expect(app.hunks.map((h) => [h.state, h.visible])).toEqual([
      ["reviewed", false],
      ["changed", true],
    ]);
    expect(view.hidden).toEqual({ files: 2, hunks: 3, commits: 2 });

    expect(view.commits.map((c) => [c.subject, c.state])).toEqual([
      ["Add greeting helper", "changed"],
      ["Document greeting usage", "reviewed"],
      ["Rename config to settings", "reviewed"],
      ["Validate greeting name", "new"],
    ]);
    const amended = view.commits[0];
    expect(amended.differingHunks).toHaveLength(1);
    expect(amended.contextOnly).toBe(false);
    expect(view.needsRelook).toBe(true);
    expect(subjects(view.commits)).toEqual(["Add greeting helper", "Validate greeting name"]);
  });

  it("interdiffs a changed hunk against the version that was reviewed", () => {
    const view = buildReviewView([impl, hard], reviewAll(impl))!;
    const changed = view.files.find((f) => f.path === "app.py")!.hunks[1];
    const before = previousHunk(view, changed, "reviewed")!;
    expect(before.hunk.lines).toContain("+line 30 print(greeting)");
    const after = findHunk(snapshotFiles(view.snapshot), changed.id)!;
    const patch = interdiffPatch("app.py", before.hunk, after.hunk);
    expect(patch).toContain("\n-+line 30 print(greeting)\n");
    expect(patch).toContain("\n++line 30 print(greeting.upper())\n");
    expect(previousHunk(view, view.files[0].hunks[0], "reviewed")).toBeNull();
  });

  it("keeps a pure rebase out of sight once the previous phase was reviewed", () => {
    const view = buildReviewView([impl, hard, polish], reviewAll(hard), { hideReviewed: true })!;
    expect(view.snapshot.id).toBe(polish.id);
    expect(view.counts.hunks).toEqual({ reviewed: 5, new: 0, changed: 0 });
    expect(view.counts.commits).toEqual({ reviewed: 4, new: 0, changed: 0 });
    expect(view.needsRelook).toBe(false);
    expect(view.files.some((f) => f.visible) || view.commits.some((c) => c.visible)).toBe(false);
    expect(view.summary.commits).toMatchObject({ rebased: 4, changed: 0, new: 0 });
  });

  it("with a phase baseline, shows only what changed since that snapshot", () => {
    const view = buildReviewView([impl, hard, polish], null, { baseline: { kind: "snapshot", snapshotId: impl.id } })!;
    expect(view.baseline).toEqual({ kind: "snapshot", snapshotId: impl.id });
    expect(view.baselineOptions.map((o) => o.id)).toEqual([hard.id, impl.id]);
    expect(view.baselineOptions[1].label).toMatch(/^implementation @ [0-9a-f]{8} \(/);
    const visible = view.files.flatMap((f) => f.hunks.filter((h) => h.visible).map((h) => [f.path, h.sinceBaseline, h.state]));
    expect(visible).toEqual([
      ["app.py", "changed", "new"],
      ["util.py", "changed", "new"],
    ]);
    expect(view.commits.map((c) => [c.subject, c.sinceBaseline])).toEqual([
      ["Add greeting helper", "modified"],
      ["Document greeting usage", "unchanged"],
      ["Rename config to settings", "unchanged"],
      ["Validate greeting name", "added"],
    ]);
    expect(subjects(view.commits)).toEqual(["Add greeting helper", "Validate greeting name"]);

    const util = view.files.find((f) => f.path === "util.py")!.hunks[0];
    expect(previousHunk(view, util, "baseline")!.hunk.lines).not.toContain('+        raise ValueError("name required")');
    expect(previousHunk(view, util, "reviewed")).toBeNull();
  });

  it("combines a phase baseline with review state: unreviewed changes since implementation", () => {
    const state = markFileReviewed(reviewAll(impl), hard, "util.py", "t2");
    const view = buildReviewView([impl, hard, polish], state, { baseline: { kind: "snapshot", snapshotId: impl.id }, hideReviewed: true })!;
    const visible = view.files.flatMap((f) => f.hunks.filter((h) => h.visible).map((h) => f.path));
    expect(visible).toEqual(["app.py"]);
  });

  it("falls back to the review baseline for an unknown or current snapshot", () => {
    for (const snapshotId of ["nope", polish.id]) {
      const view = buildReviewView([impl, hard, polish], null, { baseline: { kind: "snapshot", snapshotId } })!;
      expect(view.baseline).toEqual({ kind: "review" });
      expect(view.baselineSnapshot).toBeNull();
    }
  });

  it("marks a commit whose patch-id changed with no differing hunks as context-only", () => {
    const diff = fileDiff("f.py", [{ oldStart: 1, newStart: 1, lines: [" a", "+b"] }]);
    const a = snap({ at: "2026-10-26T00:00:00.000Z", phase: "implementation", head: "a1", diff, commits: [commit("c1", "p1", "One", diff)] });
    const b = snap({
      at: "2026-10-26T01:00:00.000Z",
      phase: "polishing",
      head: "b1",
      diff,
      commits: [commit("c2", "p2", "One", diff)],
      previous: a,
      rangeDiffPairs: [{ previousSha: a.commits[0].sha, sha: "c2".padEnd(40, "0") }],
    });
    const view = buildReviewView([a, b], reviewAll(a))!;
    expect(view.commits[0]).toMatchObject({ state: "changed", differingHunks: [], contextOnly: true });
    expect(view.needsRelook).toBe(true);
  });
});

describe("render helpers", () => {
  it("builds a single-hunk patch with the file header, and none for meta units", () => {
    const files = snapshotFiles(hard);
    const app = files.find((f) => f.path === "app.py")!;
    const patch = hunkPatch({ file: app, hunk: app.hunks[1] })!;
    expect(patch.startsWith("diff --git a/app.py b/app.py\nindex ")).toBe(true);
    expect(patch).toContain("+++ b/app.py\n@@ ");
    expect(patch.match(/^@@ /gm)).toHaveLength(1);
    const renamed = files.find((f) => f.path === "settings.yml")!;
    expect(hunkPatch({ file: renamed, hunk: renamed.hunks[0] })).toBeNull();
  });

  it("filters a commit's files to the given hunks", () => {
    const view = buildReviewView([impl, hard], reviewAll(impl))!;
    const amended = view.commits[0];
    const files = commitHunks(hard.commits[0], amended.differingHunks);
    expect(files.map((f) => [f.path, f.hunks.length])).toEqual([["app.py", 1]]);
    expect(commitHunks(hard.commits[0], null).length).toBe(2);
  });
});
