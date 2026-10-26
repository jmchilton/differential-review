// Reviewer-owned check-off state. Only plugins write it; the snapshot CLI never does.
import { commitKey } from "./snapshot";
import { REVIEW_STATE_SCHEMA_VERSION, type ReviewState, type Snapshot } from "./types";

export function emptyReviewState(): ReviewState {
  return { schemaVersion: REVIEW_STATE_SCHEMA_VERSION, kind: "differential-review-state", updatedAt: null, hunks: {}, commits: {} };
}

/** Validate parsed JSON; throws on unknown kinds or newer schema versions. */
export function parseReviewState(json: unknown): ReviewState {
  const s = json as Partial<ReviewState> | null;
  if (!s || s.kind !== "differential-review-state") throw new Error("not a differential-review state file");
  if (s.schemaVersion !== REVIEW_STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported review-state schemaVersion ${s.schemaVersion}`);
  }
  return { ...emptyReviewState(), ...s, hunks: { ...s.hunks }, commits: { ...s.commits } } as ReviewState;
}

function findHunkPath(snapshot: Snapshot, id: string): string {
  for (const f of snapshot.files) if (f.hunks.some((h) => h.id === id)) return f.path;
  throw new Error(`hunk ${id} not in snapshot ${snapshot.id}`);
}

/** Check off cumulative-diff hunks of `snapshot`. */
export function markHunksReviewed(state: ReviewState, snapshot: Snapshot, ids: string[], now: string): ReviewState {
  const hunks = { ...state.hunks };
  for (const id of ids) hunks[id] = { snapshotId: snapshot.id, path: findHunkPath(snapshot, id), reviewedAt: now };
  return { ...state, updatedAt: now, hunks };
}

/** Remove check-offs by record id (HunkReview.reviewedAs.hunkId for carried-over check-offs). */
export function unmarkHunks(state: ReviewState, ids: string[], now: string): ReviewState {
  const hunks = { ...state.hunks };
  for (const id of ids) delete hunks[id];
  return { ...state, updatedAt: now, hunks };
}

/** Check off every hunk of one file; files have no record of their own. */
export function markFileReviewed(state: ReviewState, snapshot: Snapshot, path: string, now: string): ReviewState {
  const file = snapshot.files.find((f) => f.path === path);
  if (!file) throw new Error(`file ${path} not in snapshot ${snapshot.id}`);
  return markHunksReviewed(state, snapshot, file.hunks.map((h) => h.id), now);
}

export function signOffCommit(state: ReviewState, snapshot: Snapshot, sha: string, now: string, note?: string): ReviewState {
  const commit = snapshot.commits.find((c) => c.sha === sha);
  if (!commit) throw new Error(`commit ${sha} not in snapshot ${snapshot.id}`);
  const record = { sha, subject: commit.subject, snapshotId: snapshot.id, signedOffAt: now, ...(note ? { note } : {}) };
  return { ...state, updatedAt: now, commits: { ...state.commits, [commitKey(commit)]: record } };
}

export function revokeCommitSignoff(state: ReviewState, key: string, now: string): ReviewState {
  const commits = { ...state.commits };
  delete commits[key];
  return { ...state, updatedAt: now, commits };
}
