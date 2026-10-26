// The agent post-phase step: snapshot a worktree's branch into its vault record.
import { resolve } from "node:path";
import {
  buildSnapshot,
  readAllSnapshots,
  recordSnapshotReader,
  snapshotPath,
  type CommitPair,
  type Phase,
  type Snapshot,
} from "../core";
import { branchCommits, commitExists, currentBranch, diff, git, isDirty, mergeBase, rangeDiff, worktreeRoot } from "./git";
import { nodeReadAdapter, writeSnapshot } from "./node-storage";
import { chooseBase, readRecord, resolveBaseRef } from "./record";

export interface SnapshotOptions {
  worktree: string;
  record: string;
  phase: Phase;
  base?: string;
  remote?: string;
  now?: Date;
}

export interface SnapshotResult {
  status: "created" | "exists";
  snapshot: Snapshot;
  path: string;
  warnings: string[];
}

function previousRangeDiff(worktree: string, previous: Snapshot, newRange: string): CommitPair[] | null {
  if (!commitExists(worktree, previous.head) || !commitExists(worktree, previous.base.mergeBase)) return null;
  try {
    return rangeDiff(worktree, `${previous.base.mergeBase}..${previous.head}`, newRange);
  } catch {
    return null;
  }
}

/** A snapshot of this head and phase since the head last changed; reruns reuse it. */
function rerunOf(existing: Snapshot[], head: string, phase: Phase): Snapshot | undefined {
  for (let i = existing.length - 1; i >= 0 && existing[i].head === head; i--) {
    if (existing[i].phase === phase) return existing[i];
  }
  return undefined;
}

function nextCreatedAt(previous: Snapshot | null, now: Date): string {
  // Keep snapshots strictly ordered even if the clock runs behind the latest one.
  if (previous && now.toISOString() <= previous.createdAt) return new Date(Date.parse(previous.createdAt) + 1000).toISOString();
  return now.toISOString();
}

export async function createSnapshot(opts: SnapshotOptions): Promise<SnapshotResult> {
  const recordDir = resolve(opts.record);
  const record = readRecord(recordDir);
  const worktree = worktreeRoot(resolve(opts.worktree));
  const head = git(worktree, ["rev-parse", "HEAD"]).trim();

  const existing = await readAllSnapshots(recordSnapshotReader(nodeReadAdapter, recordDir));
  const same = rerunOf(existing, head, opts.phase);
  if (same) return { status: "exists", snapshot: same, path: snapshotPath(recordDir, same.id), warnings: [] };

  const warnings: string[] = [];
  const branchName = currentBranch(worktree);
  if (!branchName) warnings.push(`HEAD is detached at ${head.slice(0, 12)}; snapshotting it for record ${record.branch}`);
  else if (branchName !== record.branch) warnings.push(`worktree is on ${branchName}, record is ${record.branch}`);
  if (isDirty(worktree)) warnings.push("worktree has uncommitted changes; snapshot covers committed HEAD only");

  const choice = chooseBase(record, opts.base);
  const { ref, sha } = resolveBaseRef(worktree, choice, opts.remote);
  const base = mergeBase(worktree, sha, head);
  const commits = branchCommits(worktree, base, head);
  if (!commits.length) warnings.push(`no commits between ${ref} and HEAD; snapshot is empty`);

  const previous = existing.at(-1) ?? null;
  const snapshot = buildSnapshot({
    createdAt: nextCreatedAt(previous, opts.now ?? new Date()),
    phase: opts.phase,
    repo: record.repo,
    branch: record.branch,
    head,
    base: { name: choice.name, source: choice.source, ref, sha, mergeBase: base },
    diff: diff(worktree, base, head),
    commits,
    previous,
    rangeDiffPairs: previous ? previousRangeDiff(worktree, previous, `${base}..${head}`) : null,
  });
  if (previous && !snapshot.mapping?.rangeDiff) warnings.push("range-diff unavailable (previous commits gone?); matched commits by patch-id and subject");
  return { status: "created", snapshot, path: writeSnapshot(recordDir, snapshot), warnings };
}
