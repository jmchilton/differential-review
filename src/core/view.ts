// UI-agnostic review view model: what to show, in which state, under a baseline. Shared by plugin UIs.
import { structuredPatch } from "diff";
import { deriveReview, type CommitReview, type HunkReview, type SnapshotReview } from "./derive";
import type { ParsedFile, ParsedHunk } from "./diff";
import { changesBetween, summarizeSnapshot, type CommitChangeKind, type HunkDelta, type SnapshotSummary } from "./queries";
import { emptyReviewState } from "./review-state";
import { commitFiles, snapshotFiles, sortSnapshots } from "./snapshot";
import type { FileStatus, ReviewState, ReviewStatus, Snapshot, SnapshotCommit } from "./types";

/** "Since my last review" (review state only), or only what changed since an earlier snapshot. */
export type Baseline = { kind: "review" } | { kind: "snapshot"; snapshotId: string };

export interface ViewOptions {
  baseline?: Baseline;
  hideReviewed?: boolean;
}

export interface HunkView extends HunkReview {
  header: string;
  added: number;
  removed: number;
  whitespaceOnly: boolean;
  /** Versus the baseline snapshot; null under the review baseline. */
  sinceBaseline: HunkDelta | null;
  /** The baseline snapshot's hunk this one fuzzy-matched, for an interdiff. */
  baselineHunkId: string | null;
  visible: boolean;
}

export interface FileView {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  state: ReviewStatus;
  counts: Record<ReviewStatus, number>;
  hunks: HunkView[];
  visible: boolean;
}

export interface CommitView extends CommitReview {
  message: string;
  author: string;
  authorDate: string;
  /** Versus the baseline snapshot; null under the review baseline. */
  sinceBaseline: CommitChangeKind | null;
  /** Changed since sign-off, but every hunk carried: only the holistic re-look is needed. */
  contextOnly: boolean;
  visible: boolean;
}

export interface BaselineOption {
  id: string;
  label: string;
}

export interface ReviewView {
  /** The latest snapshot; check-offs are always recorded against it. */
  snapshot: Snapshot;
  snapshots: Snapshot[];
  summary: SnapshotSummary;
  /** Effective baseline: falls back to the review baseline when the requested snapshot is gone. */
  baseline: Baseline;
  baselineSnapshot: Snapshot | null;
  /** Earlier snapshots, newest first. */
  baselineOptions: BaselineOption[];
  files: FileView[];
  commits: CommitView[];
  counts: SnapshotReview["counts"];
  /** Some commit changed since its sign-off; otherwise rebases stay out of sight. */
  needsRelook: boolean;
  hidden: { files: number; hunks: number; commits: number };
}

export function snapshotLabel(s: Pick<Snapshot, "phase" | "head" | "createdAt">): string {
  return `${s.phase} @ ${s.head.slice(0, 8)} (${s.createdAt.slice(0, 16).replace("T", " ")}Z)`;
}

const HUNK_DELTA = { exact: "carried", moved: "carried", fuzzy: "changed", new: "new" } as const;

/** View model for the latest snapshot of a branch; null when there are no snapshots. */
export function buildReviewView(snapshots: Snapshot[], state: ReviewState | null, options: ViewOptions = {}): ReviewView | null {
  const ordered = sortSnapshots(snapshots);
  const current = ordered[ordered.length - 1];
  if (!current) return null;
  const hideReviewed = options.hideReviewed ?? false;
  const requested = options.baseline?.kind === "snapshot" ? options.baseline.snapshotId : null;
  const baselineSnapshot = (requested && ordered.find((s) => s.id === requested && s !== current)) || null;
  const baseline: Baseline = baselineSnapshot ? { kind: "snapshot", snapshotId: baselineSnapshot.id } : { kind: "review" };

  const review = deriveReview(current, state ?? emptyReviewState(), ordered);
  const changes = baselineSnapshot ? changesBetween(ordered, baselineSnapshot, current) : null;
  const hunkChange = new Map(changes?.hunks.map((h) => [h.id, h]));
  const commitChange = new Map(changes?.commits.map((c) => [c.sha, c.change]));
  const hidden = { files: 0, hunks: 0, commits: 0 };

  const parsed = new Map(snapshotFiles(current).map((f) => [f.path, f]));
  const files = review.files.map((file): FileView => {
    const source = parsed.get(file.path)!;
    const hunks = file.hunks.map((h, i): HunkView => {
      const index = source.hunks[i];
      const match = hunkChange.get(h.id);
      const sinceBaseline = match ? HUNK_DELTA[match.match] : null;
      const visible = !(hideReviewed && h.state === "reviewed") && sinceBaseline !== "carried";
      if (!visible) hidden.hunks++;
      return {
        ...h,
        header: index.header,
        added: index.added,
        removed: index.removed,
        whitespaceOnly: index.whitespaceOnly,
        sinceBaseline,
        baselineHunkId: match?.match === "fuzzy" ? match.previousId : null,
        visible,
      };
    });
    const visible = hunks.some((h) => h.visible);
    if (!visible) hidden.files++;
    const { path, oldPath, status, binary } = source;
    return { path, oldPath, status, binary, state: file.state, counts: file.counts, hunks, visible };
  });

  const bySha = new Map(current.commits.map((c) => [c.sha, c]));
  const commits = review.commits.map((c): CommitView => {
    const commit = bySha.get(c.sha)!;
    const sinceBaseline = commitChange.get(c.sha) ?? null;
    const visible = !(hideReviewed && c.state === "reviewed") && sinceBaseline !== "unchanged";
    if (!visible) hidden.commits++;
    return {
      ...c,
      message: commit.message,
      author: commit.author,
      authorDate: commit.authorDate,
      sinceBaseline,
      contextOnly: c.state === "changed" && c.differingHunks?.length === 0,
      visible,
    };
  });

  return {
    snapshot: current,
    snapshots: ordered,
    summary: summarizeSnapshot(current),
    baseline,
    baselineSnapshot,
    baselineOptions: ordered
      .filter((s) => s !== current)
      .reverse()
      .map((s) => ({ id: s.id, label: snapshotLabel(s) })),
    files,
    commits,
    counts: review.counts,
    needsRelook: commits.some((c) => c.state === "changed"),
    hidden,
  };
}

export interface HunkSource {
  file: ParsedFile;
  hunk: ParsedHunk;
}

export function findHunk(files: ParsedFile[], id: string): HunkSource | null {
  for (const file of files) {
    const hunk = file.hunks.find((h) => h.id === id);
    if (hunk) return { file, hunk };
  }
  return null;
}

/** A file's diff header lines (`diff --git` through `+++`), without hunks. */
export function fileHeader(file: ParsedFile): string {
  const lines = file.text.split("\n");
  const end = lines.findIndex((l) => l.startsWith("@@"));
  return lines.slice(0, end < 0 ? lines.length : end).join("\n").replace(/\n+$/, "");
}

/** A renderable single-hunk patch; null for meta units, which have no `@@` body. */
export function hunkPatch({ file, hunk }: HunkSource): string | null {
  if (hunk.kind === "meta") return null;
  return `${fileHeader(file)}\n${hunk.header}\n${hunk.lines.join("\n")}\n`;
}

/** An earlier version of a hunk, for "what changed since": the reviewed version or the baseline's. */
export function previousHunk(view: ReviewView, hunk: HunkView, against: "reviewed" | "baseline"): HunkSource | null {
  const ref =
    against === "reviewed"
      ? hunk.state === "changed" && hunk.reviewedAs && { snapshotId: hunk.reviewedAs.snapshotId, id: hunk.reviewedAs.hunkId }
      : view.baselineSnapshot && hunk.baselineHunkId && { snapshotId: view.baselineSnapshot.id, id: hunk.baselineHunkId };
  const snapshot = ref && view.snapshots.find((s) => s.id === ref.snapshotId);
  return snapshot && ref ? findHunk(snapshotFiles(snapshot), ref.id) : null;
}

/** Diff of two versions of a hunk's changed (`+`/`-`) lines, as a renderable patch. */
export function interdiffPatch(path: string, before: ParsedHunk, after: ParsedHunk): string {
  const text = (h: ParsedHunk) => h.lines.filter((l) => l[0] === "+" || l[0] === "-").join("\n") + "\n";
  const patch = structuredPatch(path, path, text(before), text(after), "", "", { context: 3 });
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const h of patch.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines);
  }
  return out.join("\n") + "\n";
}

/** A commit's own parsed files, optionally only the given hunks (e.g. a changed commit's differing hunks). */
export function commitHunks(commit: SnapshotCommit, ids: string[] | null): ParsedFile[] {
  const files = commitFiles(commit);
  if (!ids) return files;
  const keep = new Set(ids);
  return files.map((f) => ({ ...f, hunks: f.hunks.filter((h) => keep.has(h.id)) })).filter((f) => f.hunks.length > 0);
}
