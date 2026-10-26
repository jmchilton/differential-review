// Phase-aware "what changed since snapshot X" queries.
import { hunkRefs, matchHunks, toHunkMatches } from "./match";
import { snapshotFiles, sortSnapshots } from "./snapshot";
import type { CommitMapping, HunkMatch, HunkMatchKind, Phase, Snapshot, SnapshotCommit } from "./types";

export interface LineageStep {
  snapshot: Snapshot;
  commit: SnapshotCommit;
}

/** Earlier versions of a commit, newest first, following each snapshot's commit mapping. */
export function commitLineage(snapshots: Snapshot[], from: Snapshot, sha: string): LineageStep[] {
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  const steps: LineageStep[] = [];
  let snapshot = from;
  let current = sha;
  while (snapshot.mapping) {
    const entry = snapshot.mapping.commits.find((c) => c.sha === current);
    const prev = byId.get(snapshot.mapping.previousSnapshotId);
    if (!entry?.previousSha || !prev) break;
    const commit = prev.commits.find((c) => c.sha === entry.previousSha);
    if (!commit) break;
    steps.push({ snapshot: prev, commit });
    snapshot = prev;
    current = commit.sha;
  }
  return steps;
}

/** Latest snapshot, optionally of one phase and strictly before `before`. */
export function latestSnapshot(snapshots: Snapshot[], options: { phase?: Phase; before?: Snapshot } = {}): Snapshot | null {
  const ordered = sortSnapshots(snapshots);
  const end = options.before ? ordered.findIndex((s) => s.id === options.before!.id) : ordered.length;
  const candidates = ordered.slice(0, end < 0 ? ordered.length : end);
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (!options.phase || candidates[i].phase === options.phase) return candidates[i];
  }
  return null;
}

export type CommitChangeKind = "unchanged" | "modified" | "added";

export interface CommitChange {
  sha: string;
  change: CommitChangeKind;
  previousSha: string | null;
}

export interface SnapshotChanges {
  from: string;
  to: string;
  hunks: HunkMatch[];
  droppedHunks: string[];
  commits: CommitChange[];
  droppedCommits: string[];
}

/** Compare any two snapshots of a branch: hunks directly, commits by patch-id then lineage. */
export function changesBetween(snapshots: Snapshot[], from: Snapshot, to: Snapshot): SnapshotChanges {
  const oldRefs = hunkRefs(snapshotFiles(from));
  const newRefs = hunkRefs(snapshotFiles(to));
  const result = matchHunks(oldRefs, newRefs);

  const used = new Set<string>();
  const commits = to.commits.map((c): CommitChange => {
    const same =
      from.commits.find((p) => !used.has(p.sha) && p.sha === c.sha) ??
      (c.patchId !== null && from.commits.find((p) => !used.has(p.sha) && p.patchId === c.patchId));
    if (same) {
      used.add(same.sha);
      return { sha: c.sha, change: "unchanged", previousSha: same.sha };
    }
    const ancestor = commitLineage(snapshots, to, c.sha).find((step) => step.snapshot.id === from.id);
    if (ancestor && !used.has(ancestor.commit.sha)) {
      used.add(ancestor.commit.sha);
      return { sha: c.sha, change: "modified", previousSha: ancestor.commit.sha };
    }
    return { sha: c.sha, change: "added", previousSha: null };
  });

  return {
    from: from.id,
    to: to.id,
    hunks: toHunkMatches(newRefs, result),
    droppedHunks: result.removed,
    commits,
    droppedCommits: from.commits.filter((c) => !used.has(c.sha)).map((c) => c.sha),
  };
}

/** "What did later phases change since the latest `phase` snapshot", e.g. hardening since implementation. */
export function changesSincePhase(snapshots: Snapshot[], phase: Phase, to?: Snapshot): SnapshotChanges | null {
  const target = to ?? latestSnapshot(snapshots);
  if (!target) return null;
  const from = latestSnapshot(snapshots, { phase, before: target });
  return from ? changesBetween(snapshots, from, target) : null;
}

export type CommitDelta = "same" | "rebased" | "changed" | "new";

export type HunkDelta = "carried" | "changed" | "new";

const HUNK_DELTA: Record<HunkMatchKind, HunkDelta> = { exact: "carried", moved: "carried", fuzzy: "changed", new: "new" };

export interface SnapshotSummary {
  previousSnapshotId: string | null;
  commits: Record<CommitDelta | "dropped", number>;
  hunks: Record<HunkDelta | "dropped", number>;
  /** Changed and new commits in branch order; `differingHunks` counts a changed commit's hunks not carried. */
  flaggedCommits: { sha: string; subject: string; change: "changed" | "new"; differingHunks: number | null }[];
}

function commitDelta(entry: CommitMapping | undefined): CommitDelta {
  if (!entry?.method) return "new";
  if (entry.patchIdChanged) return "changed";
  return entry.method === "sha" ? "same" : "rebased";
}

/** What a snapshot changed relative to its previous one, from its stored mapping; all new for a first snapshot. */
export function summarizeSnapshot(snapshot: Snapshot): SnapshotSummary {
  const mapping = snapshot.mapping;
  const commits = { same: 0, rebased: 0, changed: 0, new: 0, dropped: mapping?.droppedCommits.length ?? 0 };
  const flaggedCommits: SnapshotSummary["flaggedCommits"] = [];
  for (const commit of snapshot.commits) {
    const entry = mapping?.commits.find((c) => c.sha === commit.sha);
    const delta = commitDelta(entry);
    commits[delta]++;
    if (delta === "changed" || delta === "new") {
      const differing = entry?.hunks?.filter((h) => HUNK_DELTA[h.match] !== "carried").length ?? null;
      flaggedCommits.push({ sha: commit.sha, subject: commit.subject, change: delta, differingHunks: differing });
    }
  }
  const hunks = { carried: 0, changed: 0, new: 0, dropped: mapping?.droppedHunks.length ?? 0 };
  if (mapping) {
    for (const h of mapping.hunks) hunks[HUNK_DELTA[h.match]]++;
  } else {
    hunks.new = snapshot.files.reduce((n, f) => n + f.hunks.length, 0);
  }
  return { previousSnapshotId: mapping?.previousSnapshotId ?? null, commits, hunks, flaggedCommits };
}
