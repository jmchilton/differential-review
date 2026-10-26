// Snapshot construction from git-derived inputs, and the mapping to the previous snapshot.
import { parseDiff, toFileIndex, type ParsedFile } from "./diff";
import { hunkRefs, matchHunks, toHunkMatches } from "./match";
import {
  FINGERPRINT_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  type CommitMapping,
  type FileIndex,
  type Phase,
  type Snapshot,
  type SnapshotBase,
  type SnapshotCommit,
  type SnapshotMapping,
} from "./types";

export type CommitInput = Omit<SnapshotCommit, "files">;

export interface CommitPair {
  previousSha: string;
  sha: string;
}

export interface SnapshotInput {
  createdAt: string;
  phase: Phase;
  repo: string | null;
  branch: string;
  head: string;
  base: SnapshotBase;
  diff: string;
  commits: CommitInput[];
  previous: Snapshot | null;
  /** Commit pairs reported by `git range-diff`; null when it could not run. */
  rangeDiffPairs: CommitPair[] | null;
}

/** `20261026T031500Z-hardening-3bf56e17e9b1`: sortable, colon-free (Obsidian sync, mobile). */
export function snapshotId(createdAt: string, phase: Phase, head: string): string {
  const stamp = createdAt.replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  return `${stamp}-${phase}-${head.slice(0, 12)}`;
}

const parsedCache = new WeakMap<object, ParsedFile[]>();

/** Throws when re-parsed fingerprints differ from the stored index (parser drift). */
export function verifyFingerprints(stored: FileIndex[], parsed: ParsedFile[]): void {
  const ids = (files: { hunks: { id: string }[] }[]) => files.flatMap((f) => f.hunks.map((h) => h.id)).join(",");
  if (ids(stored) !== ids(parsed)) {
    throw new Error(`stored fingerprints don't match this parser (${FINGERPRINT_VERSION}); rebuild or bump the fingerprint version`);
  }
}

function cachedParse(owner: { diff: string; files?: FileIndex[] }): ParsedFile[] {
  let files = parsedCache.get(owner);
  if (!files) {
    files = parseDiff(owner.diff);
    if (owner.files) verifyFingerprints(owner.files, files);
    parsedCache.set(owner, files);
  }
  return files;
}

/** Parsed cumulative diff of a snapshot, with hunk lines; memoized per object and checked against `files`. */
export function snapshotFiles(snapshot: Pick<Snapshot, "diff"> & Partial<Pick<Snapshot, "files">>): ParsedFile[] {
  return cachedParse(snapshot);
}

/** Parsed diff of one commit; memoized per object. */
export function commitFiles(commit: Pick<SnapshotCommit, "diff"> & Partial<Pick<SnapshotCommit, "files">>): ParsedFile[] {
  return cachedParse(commit);
}

/** Sign-off key: patch-id, or the sha for merges/empty commits. */
export function commitKey(commit: Pick<SnapshotCommit, "sha" | "patchId">): string {
  return commit.patchId ?? `sha:${commit.sha}`;
}

export function buildMapping(
  previous: Snapshot,
  next: Pick<Snapshot, "diff" | "commits">,
  rangeDiffPairs: CommitPair[] | null,
): SnapshotMapping {
  const oldRefs = hunkRefs(snapshotFiles(previous));
  const newRefs = hunkRefs(snapshotFiles(next));
  const hunkResult = matchHunks(oldRefs, newRefs);

  const usedPrev = new Set<string>();
  const mapped = new Map<string, CommitMapping>();
  const pair = (sha: string, previousSha: string, method: CommitMapping["method"]) => {
    usedPrev.add(previousSha);
    const prevCommit = previous.commits.find((c) => c.sha === previousSha)!;
    const commit = next.commits.find((c) => c.sha === sha)!;
    const changed = sha !== previousSha && (prevCommit.patchId === null || prevCommit.patchId !== commit.patchId);
    const entry: CommitMapping = { sha, previousSha, method, patchIdChanged: changed };
    if (changed) {
      const o = hunkRefs(commitFiles(prevCommit));
      const n = hunkRefs(commitFiles(commit));
      entry.hunks = toHunkMatches(n, matchHunks(o, n));
    }
    mapped.set(sha, entry);
  };

  for (const commit of next.commits) {
    if (previous.commits.some((p) => p.sha === commit.sha)) pair(commit.sha, commit.sha, "sha");
  }
  for (const commit of next.commits) {
    if (commit.patchId === null || mapped.has(commit.sha)) continue;
    const prev = previous.commits.find((p) => !usedPrev.has(p.sha) && p.patchId === commit.patchId);
    if (prev) pair(commit.sha, prev.sha, "patch-id");
  }
  if (rangeDiffPairs) {
    for (const { previousSha, sha } of rangeDiffPairs) {
      if (mapped.has(sha) || usedPrev.has(previousSha)) continue;
      if (!previous.commits.some((c) => c.sha === previousSha) || !next.commits.some((c) => c.sha === sha)) continue;
      pair(sha, previousSha, "range-diff");
    }
  } else {
    for (const commit of next.commits) {
      if (mapped.has(commit.sha)) continue;
      const prev = previous.commits.find((p) => !usedPrev.has(p.sha) && p.subject === commit.subject);
      if (prev) pair(commit.sha, prev.sha, "subject");
    }
  }

  return {
    previousSnapshotId: previous.id,
    previousHead: previous.head,
    rangeDiff: rangeDiffPairs !== null,
    commits: next.commits.map(
      (c) => mapped.get(c.sha) ?? { sha: c.sha, previousSha: null, method: null, patchIdChanged: false },
    ),
    droppedCommits: previous.commits.filter((c) => !usedPrev.has(c.sha)).map((c) => c.sha),
    hunks: toHunkMatches(newRefs, hunkResult),
    droppedHunks: hunkResult.removed,
  };
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const commits: SnapshotCommit[] = input.commits.map((c) => ({
    ...c,
    files: parseDiff(c.diff).map(toFileIndex),
  }));
  const partial = { diff: input.diff, commits };
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    kind: "differential-review-snapshot",
    fingerprintVersion: FINGERPRINT_VERSION,
    id: snapshotId(input.createdAt, input.phase, input.head),
    createdAt: input.createdAt,
    phase: input.phase,
    repo: input.repo,
    branch: input.branch,
    head: input.head,
    base: input.base,
    previousSnapshotId: input.previous?.id ?? null,
    diff: input.diff,
    files: parseDiff(input.diff).map(toFileIndex),
    commits,
    mapping: input.previous ? buildMapping(input.previous, partial, input.rangeDiffPairs) : null,
  };
}

/** Snapshots oldest first. */
export function sortSnapshots<T extends Pick<Snapshot, "createdAt" | "id">>(snapshots: T[]): T[] {
  return [...snapshots].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
