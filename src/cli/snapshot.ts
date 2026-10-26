// The post-phase step: snapshot a worktree's branch into a review dir.
import { resolve } from "node:path";
import {
  buildSnapshot,
  readAllSnapshots,
  snapshotPath,
  snapshotReader,
  type CommitPair,
  type Phase,
  type Snapshot,
} from "../core/index.js";
import { resolveBaseRef, type BaseChoice } from "./base.js";
import { branchCommits, commitExists, currentBranch, diff, git, isDirty, mergeBase, rangeDiff, revParse, worktreeRoot } from "./git.js";
import { nodeReadAdapter, writeSnapshot } from "./node-storage.js";

export interface SnapshotOptions {
  worktree: string;
  /** Review dir: `snapshots/` is written here. */
  dir: string;
  phase: Phase;
  /** Branch the review is for; stored in the snapshot and checked against the worktree. */
  branch: string;
  repo?: string | null;
  /** A function is called with the worktree root, after it is validated. */
  base: BaseChoice | ((worktree: string) => BaseChoice);
  remote?: string;
  /** Commit to snapshot instead of the worktree's HEAD; skips the branch check. */
  head?: string;
  /** When HEAD isn't on `branch`: fail, warn (the default), or say nothing (e.g. a PR head on a scratch branch). */
  branchCheck?: "require" | "warn" | "off";
  /** What `branch` names in messages, e.g. "record" for an integration's own records. */
  branchLabel?: string;
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

/** A snapshot of this head, base and phase since the head last changed; reruns reuse it. */
function rerunOf(existing: Snapshot[], head: string, mergeBase: string, phase: Phase): Snapshot | undefined {
  for (let i = existing.length - 1; i >= 0 && existing[i].head === head; i--) {
    if (existing[i].phase === phase && existing[i].base.mergeBase === mergeBase) return existing[i];
  }
  return undefined;
}

function branchProblem(branchName: string | null, head: string, branch: string, label: string): string | null {
  if (!branchName) return `HEAD is detached at ${head.slice(0, 12)}; snapshotting it for ${label} ${branch}`;
  return branchName === branch ? null : `worktree is on ${branchName}, ${label} is ${branch}`;
}

function nextCreatedAt(previous: Snapshot | null, now: Date): string {
  // Keep snapshots strictly ordered even if the clock runs behind the latest one.
  if (previous && now.toISOString() <= previous.createdAt) return new Date(Date.parse(previous.createdAt) + 1000).toISOString();
  return now.toISOString();
}

export async function createSnapshot(opts: SnapshotOptions): Promise<SnapshotResult> {
  const dir = resolve(opts.dir);
  const worktree = worktreeRoot(resolve(opts.worktree));
  const worktreeHead = git(worktree, ["rev-parse", "HEAD"]).trim();
  const head = opts.head ? revParse(worktree, opts.head) : worktreeHead;
  if (!head) throw new Error(`--head ${opts.head} is not a commit in ${worktree}; fetch it first`);

  const check = opts.head ? "off" : (opts.branchCheck ?? "warn");
  const problem = check === "off" ? null : branchProblem(currentBranch(worktree), head, opts.branch, opts.branchLabel ?? "branch");
  if (problem && check === "require") throw new Error(`${problem} (in ${worktree}); pass --worktree <the branch's worktree>`);

  const choice = typeof opts.base === "function" ? opts.base(worktree) : opts.base;
  const { ref, sha } = resolveBaseRef(worktree, choice, opts.remote);
  const base = mergeBase(worktree, sha, head);
  const existing = await readAllSnapshots(snapshotReader(nodeReadAdapter, dir));
  const same = rerunOf(existing, head, base, opts.phase);
  if (same) return { status: "exists", snapshot: same, path: snapshotPath(dir, same.id), warnings: [] };

  const warnings = problem ? [problem] : [];
  if (head === worktreeHead && isDirty(worktree)) warnings.push("worktree has uncommitted changes; snapshot covers committed HEAD only");
  const commits = branchCommits(worktree, base, head);
  if (!commits.length) warnings.push(`no commits between ${ref} and HEAD; snapshot is empty`);

  const previous = existing.at(-1) ?? null;
  const snapshot = buildSnapshot({
    createdAt: nextCreatedAt(previous, opts.now ?? new Date()),
    phase: opts.phase,
    repo: opts.repo ?? null,
    branch: opts.branch,
    head,
    base: { name: choice.name, source: choice.source, ref, sha, mergeBase: base },
    diff: diff(worktree, base, head),
    commits,
    previous,
    rangeDiffPairs: previous ? previousRangeDiff(worktree, previous, `${base}..${head}`) : null,
  });
  if (previous && !snapshot.mapping?.rangeDiff) warnings.push("range-diff unavailable (previous commits gone?); matched commits by patch-id and subject");
  return { status: "created", snapshot, path: writeSnapshot(dir, snapshot), warnings };
}
