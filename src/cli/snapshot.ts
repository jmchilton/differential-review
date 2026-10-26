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
import { branchCommits, commitExists, currentBranch, diff, git, isDirty, mergeBase, rangeDiff } from "./git";
import { nodeAdapter, writeSnapshot } from "./node-storage";
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

export async function createSnapshot(opts: SnapshotOptions): Promise<SnapshotResult> {
  const worktree = resolve(opts.worktree);
  const recordDir = resolve(opts.record);
  const warnings: string[] = [];
  const record = readRecord(recordDir);
  const head = git(worktree, ["rev-parse", "HEAD"]).trim();

  const existing = await readAllSnapshots(recordSnapshotReader(nodeAdapter, recordDir));
  const same = existing.find((s) => s.head === head && s.phase === opts.phase);
  if (same) {
    return { status: "exists", snapshot: same, path: snapshotPath(recordDir, same.id), warnings };
  }

  const choice = chooseBase(record, opts.base);
  const { ref, sha } = resolveBaseRef(worktree, choice, opts.remote);
  const base = mergeBase(worktree, sha, head);
  const branchName = currentBranch(worktree);
  if (branchName && branchName !== record.branch) warnings.push(`worktree is on ${branchName}, record is ${record.branch}`);
  if (isDirty(worktree)) warnings.push("worktree has uncommitted changes; snapshot covers committed HEAD only");

  const previous = existing.at(-1) ?? null;
  const now = opts.now ?? new Date();
  const createdAt = previous && now.toISOString() <= previous.createdAt
    ? new Date(Date.parse(previous.createdAt) + 1000).toISOString()
    : now.toISOString();
  const snapshot = buildSnapshot({
    createdAt,
    phase: opts.phase,
    repo: record.repo,
    branch: record.branch,
    head,
    base: { name: choice.name, source: choice.source, ref, sha, mergeBase: base },
    diff: diff(worktree, base, head),
    commits: branchCommits(worktree, base, head),
    previous,
    rangeDiffPairs: previous ? previousRangeDiff(worktree, previous, `${base}..${head}`) : null,
  });
  if (previous && !snapshot.mapping?.rangeDiff) warnings.push("range-diff unavailable; matched commits by patch-id and subject");
  return { status: "created", snapshot, path: writeSnapshot(recordDir, snapshot), warnings };
}
