// Derive reviewed / new / changed-since-reviewed at hunk, file and commit level.
import { hunkRefs, matchHunks, type HunkRef } from "./match";
import { commitLineage } from "./queries";
import { commitFiles, commitKey, snapshotFiles } from "./snapshot";
import type { CommitSignoff, HunkKind, ReviewState, ReviewStatus, Snapshot } from "./types";

export interface HunkReview {
  id: string;
  path: string;
  kind: HunkKind;
  state: ReviewStatus;
  /** The check-off this state comes from; its hunkId is the review-state key. */
  reviewedAs: { hunkId: string; snapshotId: string; similarity: number } | null;
}

export interface FileReview {
  path: string;
  state: ReviewStatus;
  hunks: HunkReview[];
  counts: Record<ReviewStatus, number>;
}

export interface CommitReview {
  sha: string;
  subject: string;
  key: string;
  state: ReviewStatus;
  /** The sign-off this state comes from (this commit's, or an earlier version's when changed). */
  signoff: (CommitSignoff & { key: string }) | null;
  /** For changed commits: this commit's hunk ids that differ from the signed-off version. */
  differingHunks: string[] | null;
}

export interface SnapshotReview {
  snapshotId: string;
  files: FileReview[];
  commits: CommitReview[];
  counts: { hunks: Record<ReviewStatus, number>; files: Record<ReviewStatus, number>; commits: Record<ReviewStatus, number> };
}

function zero(): Record<ReviewStatus, number> {
  return { reviewed: 0, new: 0, changed: 0 };
}

function reviewedRefs(state: ReviewState, byId: Map<string, Snapshot>): HunkRef[] {
  return Object.entries(state.hunks).map(([id, rec]) => {
    const snap = byId.get(rec.snapshotId);
    for (const file of snap ? snapshotFiles(snap) : []) {
      const hunk = file.hunks.find((h) => h.id === id);
      if (hunk) {
        return { id, contentHash: hunk.contentHash, kind: hunk.kind, path: file.path, basePath: file.basePath, changed: hunk.changed };
      }
    }
    // Snapshot missing (e.g. not synced): only an exact fingerprint match is possible.
    return { id, contentHash: "", kind: "text", path: rec.path, basePath: null, changed: null };
  });
}

function fileState(counts: Record<ReviewStatus, number>, total: number): ReviewStatus {
  if (counts.reviewed === total) return "reviewed";
  if (counts.new === total) return "new";
  return "changed";
}

/** Review status of `current` given the reviewer's state and the branch's other snapshots. */
export function deriveReview(current: Snapshot, state: ReviewState, snapshots: Snapshot[]): SnapshotReview {
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  byId.set(current.id, current);
  const all = [...byId.values()];
  const counts = { hunks: zero(), files: zero(), commits: zero() };

  const parsed = snapshotFiles(current);
  const refs = hunkRefs(parsed);
  const old = reviewedRefs(state, byId);
  const result = matchHunks(old, refs);
  const pairByNew = new Map(result.pairs.map((p) => [p.newId, p]));

  const files = parsed.map((file): FileReview => {
    const fileCounts = zero();
    const hunks = file.hunks.map((h): HunkReview => {
      const pair = pairByNew.get(h.id);
      const hunkState: ReviewStatus = !pair ? "new" : pair.match === "fuzzy" ? "changed" : "reviewed";
      fileCounts[hunkState]++;
      counts.hunks[hunkState]++;
      const reviewedAs = pair
        ? { hunkId: pair.oldId, snapshotId: state.hunks[pair.oldId].snapshotId, similarity: pair.similarity }
        : null;
      return { id: h.id, path: file.path, kind: h.kind, state: hunkState, reviewedAs };
    });
    const fs = fileState(fileCounts, hunks.length);
    counts.files[fs]++;
    return { path: file.path, state: fs, hunks, counts: fileCounts };
  });

  const commits = current.commits.map((commit): CommitReview => {
    const key = commitKey(commit);
    let review: CommitReview = { sha: commit.sha, subject: commit.subject, key, state: "new", signoff: null, differingHunks: null };
    if (state.commits[key]) {
      review = { ...review, state: "reviewed", signoff: { ...state.commits[key], key } };
    } else {
      const signed = commitLineage(all, current, commit.sha).find((step) => state.commits[commitKey(step.commit)]);
      if (signed) {
        const signedKey = commitKey(signed.commit);
        const n = hunkRefs(commitFiles(commit));
        const m = matchHunks(hunkRefs(commitFiles(signed.commit)), n);
        const same = new Set(m.pairs.filter((p) => p.match !== "fuzzy").map((p) => p.newId));
        review = {
          ...review,
          state: "changed",
          signoff: { ...state.commits[signedKey], key: signedKey },
          differingHunks: n.map((r) => r.id).filter((id) => !same.has(id)),
        };
      }
    }
    counts.commits[review.state]++;
    return review;
  });

  return { snapshotId: current.id, files, commits, counts };
}
