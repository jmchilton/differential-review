// Human-readable CLI output; concise enough to paste into an agent debrief.
import type { Snapshot, SnapshotReview, SnapshotSummary } from "../core";
import type { SnapshotResult } from "./snapshot";

const short = (sha: string) => sha.slice(0, 12);
// A --base given as a full SHA reads better abbreviated.
const baseRef = (ref: string) => (/^[0-9a-f]{40}$/.test(ref) ? short(ref) : ref);

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function hunkCount(snapshot: Snapshot): number {
  return snapshot.files.reduce((n, f) => n + f.hunks.length, 0);
}

export function formatSnapshotResult(result: SnapshotResult, summary: SnapshotSummary): string[] {
  const s = result.snapshot;
  const lines = [
    `${result.status} ${result.path}`,
    `  ${s.phase} @ ${short(s.head)} vs ${baseRef(s.base.ref)} (merge-base ${short(s.base.mergeBase)})`,
  ];
  if (!summary.previousSnapshotId) {
    lines.push(`  first snapshot: ${plural(s.commits.length, "commit")}, ${plural(s.files.length, "file")}, ${plural(hunkCount(s), "hunk")}`);
    return lines;
  }
  const c = summary.commits;
  const h = summary.hunks;
  lines.push(
    `  since ${summary.previousSnapshotId}:`,
    `    commits: ${c.same} same, ${c.rebased} rebased, ${c.changed} changed, ${c.new} new, ${c.dropped} dropped`,
    `    hunks:   ${h.carried} carried, ${h.changed} changed, ${h.new} new, ${h.dropped} dropped`,
  );
  for (const f of summary.flaggedCommits) {
    const detail = f.differingHunks === null ? "" : ` (${plural(f.differingHunks, "differing hunk")})`;
    lines.push(`    ${f.change.padEnd(7)} ${short(f.sha)} ${f.subject}${detail}`);
  }
  return lines;
}

export function formatList(snapshots: Snapshot[]): string[] {
  if (!snapshots.length) return ["no snapshots yet"];
  return snapshots.map(
    (s) => `${s.id}  ${plural(s.commits.length, "commit")}, ${plural(s.files.length, "file")}, ${plural(hunkCount(s), "hunk")} vs ${baseRef(s.base.ref)}`,
  );
}

export function formatStatus(current: Snapshot, review: SnapshotReview, hasState: boolean): string[] {
  const lines = [`${current.id} (${current.phase} @ ${short(current.head)})`];
  if (!hasState) return [...lines, "  no review-state.json yet; everything is new"];
  for (const level of ["hunks", "files", "commits"] as const) {
    const c = review.counts[level];
    lines.push(`  ${`${level}:`.padEnd(9)}${c.reviewed} reviewed, ${c.changed} changed, ${c.new} new`);
  }
  const files = review.files.filter((f) => f.state !== "reviewed");
  const commits = review.commits.filter((c) => c.state !== "reviewed");
  if (!files.length && !commits.length) return lines;
  lines.push("  to review:");
  for (const f of files) lines.push(`    ${f.state.padEnd(7)} ${f.path} (${f.counts.changed} changed, ${f.counts.new} new)`);
  for (const c of commits) {
    const detail = c.differingHunks ? ` (${plural(c.differingHunks.length, "differing hunk")})` : "";
    lines.push(`    ${c.state.padEnd(7)} commit ${short(c.sha)} ${c.subject}${detail}`);
  }
  return lines;
}
