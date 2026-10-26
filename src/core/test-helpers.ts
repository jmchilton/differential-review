// Builders for synthetic git diffs and snapshots in core unit tests.
import { buildSnapshot, type CommitInput, type CommitPair } from "./snapshot";
import type { Phase, Snapshot } from "./types";

export interface HunkSpec {
  oldStart: number;
  newStart: number;
  /** Body lines with markers, e.g. [" ctx", "-old", "+new"]. */
  lines: string[];
}

export function fileDiff(path: string, hunks: HunkSpec[]): string {
  const out = [`diff --git a/${path} b/${path}`, `index 1111111..2222222 100644`, `--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    const oldCount = h.lines.filter((l) => l[0] !== "+").length;
    const newCount = h.lines.filter((l) => l[0] !== "-").length;
    out.push(`@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@`, ...h.lines);
  }
  return out.join("\n") + "\n";
}

const BASE = { name: "dev", source: "upstream_base_branch" as const, ref: "origin/dev", sha: "b".repeat(40), mergeBase: "b".repeat(40) };

export function commit(sha: string, patchId: string | null, subject: string, diff: string): CommitInput {
  return { sha: sha.padEnd(40, "0"), parents: [], patchId, subject, message: subject, author: "A <a@b>", authorDate: "2026-10-26T00:00:00Z", diff };
}

export function snap(
  opts: { at: string; phase: Phase; head: string; diff: string; commits?: CommitInput[]; previous?: Snapshot | null; rangeDiffPairs?: CommitPair[] | null },
): Snapshot {
  return buildSnapshot({
    createdAt: opts.at,
    phase: opts.phase,
    repo: "galaxy",
    branch: "feature",
    head: opts.head.padEnd(40, "0"),
    base: BASE,
    diff: opts.diff,
    commits: opts.commits ?? [],
    previous: opts.previous ?? null,
    rangeDiffPairs: opts.rangeDiffPairs ?? null,
  });
}
