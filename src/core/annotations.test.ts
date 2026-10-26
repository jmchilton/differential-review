import { describe, expect, it } from "vitest";
import { captureReviewOrigin, createReviewThread, deriveThreads, parseReviewThread } from "./annotations.js";
import { buildReviewView } from "./view.js";
import { emptyReviewState, markFileReviewed } from "./review-state.js";
import { fileDiff, snap } from "./test-helpers.js";

const make = (head: string, start: number, lines: string[], previous?: ReturnType<typeof snap>) => snap({ at: `2026-10-26T0${previous ? 2 : 1}:00:00Z`, phase: "revision", head, diff: fileDiff("a.py", [{ oldStart: start, newStart: start, lines }]), previous });
const first = make("a", 10, [" before", "-old", "+new", " after"]);
const origin = () => captureReviewOrigin(first, { path: "a.py", hunkId: first.files[0].hunks[0].id, side: "new", range: [11, 12] });
const thread = () => createReviewThread({ id: "thread-1", origin: origin(), body: "Handle empty input", author: "John", createdAt: "2026-10-26T01:01:00Z" });

describe("review annotations", () => {
  it("captures source coordinates, selected text and context on either side", () => {
    expect(origin()).toMatchObject({ snapshotId: first.id, side: "new", range: [11, 12], quote: "new\nafter", contextBefore: ["before"], contextAfter: [] });
    expect(captureReviewOrigin(first, { path: "a.py", hunkId: first.files[0].hunks[0].id, side: "old", range: [11, 11] }).quote).toBe("old");
    expect(() => captureReviewOrigin(first, { path: "a.py", hunkId: first.files[0].hunks[0].id, side: "new", range: [9, 12] })).toThrow(/range/);
  });

  it("maps quoted lines across a rebase without changing the original anchor", () => {
    const t = thread();
    const moved = make("b", 30, [" before", "-old", "+new", " after"], first);
    const result = deriveThreads({ threads: [t], replies: [] }, moved, [first, moved]);
    expect(result[0].placement).toMatchObject({ state: "moved", path: "a.py", range: [31, 32] });
    expect(t.origin.range).toEqual([11, 12]);
    expect(result[0].thread.status).toBe("open");
  });

  it("retains changed and missing code without resolving the request", () => {
    const amended = make("b", 10, [" before", "-old", "+newer", " after"], first);
    expect(deriveThreads({ threads: [thread()], replies: [] }, amended, [first, amended])[0].placement.state).toBe("outdated");
    const gone = snap({ at: "2026-10-26T03:00:00Z", phase: "revision", head: "c", diff: "", previous: amended });
    expect(deriveThreads({ threads: [thread()], replies: [] }, gone, [first, gone])[0]).toMatchObject({ placement: { state: "unmapped" }, thread: { status: "open" } });
  });

  it("refuses ambiguous repeated text and can still locate a quote without its original snapshot", () => {
    const t = thread();
    expect(deriveThreads({ threads: [t], replies: [] }, first, [first])[0].placement.state).toBe("active");
    const repeated = make("b", 30, [" before", "-old", "+new", " after", " before", "+new", " after"], first);
    expect(deriveThreads({ threads: [t], replies: [] }, repeated, [first, repeated])[0].placement.state).toBe("outdated");
    const moved = make("c", 30, [" before", "-old", "+new", " after"]);
    expect(deriveThreads({ threads: [t], replies: [] }, moved, [moved])[0].placement.state).toBe("moved");
  });

  it("keeps an exact original selection among repeated lines when another phase has the identical diff", () => {
    const repeated = make("a", 10, [" before", "-old", "+new", " after", " before", "+new", " after"]);
    const o = captureReviewOrigin(repeated, { path: "a.py", hunkId: repeated.files[0].hunks[0].id, side: "new", range: [14, 15] });
    const t = createReviewThread({ ...thread(), origin: o });
    const same = snap({ at: "2026-10-26T03:00:00Z", phase: "hardening", head: "a", diff: repeated.diff, previous: repeated });
    expect(deriveThreads({ threads: [t], replies: [] }, same, [repeated, same])[0].placement).toMatchObject({ state: "moved", range: [14, 15] });
  });

  it("follows a rename but does not move a note into an unrelated file", () => {
    const renamedDiff = fileDiff("b.py", [{ oldStart: 10, newStart: 10, lines: [" before", "-old", "+new", " after"] }])
      .replace("a/b.py", "a/a.py").replace("--- a/b.py", "--- a/a.py")
      .replace("index 1111111", "similarity index 90%\nrename from a.py\nrename to b.py\nindex 1111111");
    const renamed = snap({ at: "2026-10-26T02:00:00Z", phase: "revision", head: "b", diff: renamedDiff, previous: first });
    expect(deriveThreads({ threads: [thread()], replies: [] }, renamed, [first, renamed])[0].placement).toMatchObject({ state: "moved", path: "b.py", range: [11, 12] });
    const unrelated = snap({ at: "2026-10-26T03:00:00Z", phase: "revision", head: "c", diff: fileDiff("other.py", [{ oldStart: 10, newStart: 10, lines: [" before", "-old", "+new", " after"] }]) });
    expect(deriveThreads({ threads: [thread()], replies: [] }, unrelated, [first, unrelated])[0].placement.state).toBe("unmapped");
  });

  it("keeps open threads visible through both baseline and reviewed filters without changing check-offs", () => {
    const moved = make("b", 30, [" before", "-old", "+new", " after"], first);
    const state = markFileReviewed(emptyReviewState(), first, "a.py", "now");
    const options = { baseline: { kind: "snapshot" as const, snapshotId: first.id }, hideReviewed: true };
    expect(buildReviewView([first, moved], state, options)!.files[0].visible).toBe(false);
    const view = buildReviewView([first, moved], state, { ...options, annotations: { threads: [thread()], replies: [] } })!;
    expect(view.files[0].visible).toBe(true);
    expect(view.files[0].hunks[0].state).toBe("reviewed");
    expect(view.counts.hunks.reviewed).toBe(1);
  });

  it("rejects invalid stored annotations and unsafe identifiers", () => {
    expect(parseReviewThread(JSON.parse(JSON.stringify(thread())))).toEqual(thread());
    expect(() => parseReviewThread({ ...thread(), schemaVersion: 99 })).toThrow(/schemaVersion/);
    expect(() => parseReviewThread({ ...thread(), id: "../state" })).toThrow(/id/);
    expect(() => parseReviewThread({ ...thread(), origin: { ...origin(), range: [0, 1] } })).toThrow(/range/);
  });
});
