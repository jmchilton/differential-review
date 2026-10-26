// Snapshot and review-state JSON schemas. Bump the schema versions on incompatible changes.

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const REVIEW_STATE_SCHEMA_VERSION = 1;
// Prefix on every fingerprint; review-state keeps fingerprints forever, so a new algorithm needs a new prefix.
export const FINGERPRINT_VERSION = "h1";

// Factory phases agents snapshot after (BRANCH_FACTORY.md: implement, harden, polish).
export const PHASES = ["implementation", "hardening", "polishing", "revision", "review"] as const;
export type Phase = (typeof PHASES)[number];

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

// `text` is a real @@ hunk; `meta` is a synthetic unit for changes without one (binary, rename, mode, empty file).
export type HunkKind = "text" | "meta";

export interface HunkIndex {
  /** Fingerprint: hash of path + contentHash + occurrence; the review-state key. */
  id: string;
  /** Hash of the normalized changed lines only. */
  contentHash: string;
  /** Index among hunks in the same file sharing this contentHash. */
  occurrence: number;
  kind: HunkKind;
  /** Raw `@@ ... @@ heading` line, or a short description for meta units. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  added: number;
  removed: number;
  /** Removed and added lines differ only in whitespace. */
  whitespaceOnly: boolean;
}

export interface FileIndex {
  /** Display path: new path, or old path for deletions. */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  binary: boolean;
  oldMode: string | null;
  newMode: string | null;
  hunks: HunkIndex[];
}

export type BaseSource = "parent_branch" | "upstream_base_branch" | "override";

export interface SnapshotBase {
  /** Branch name as recorded (no remote prefix), or the --base value. */
  name: string;
  source: BaseSource;
  /** Git ref actually used, e.g. `origin/dev`. */
  ref: string;
  sha: string;
  mergeBase: string;
}

export interface SnapshotCommit {
  sha: string;
  parents: string[];
  /** `git patch-id --verbatim`; null for merges and empty commits. */
  patchId: string | null;
  subject: string;
  message: string;
  author: string;
  authorDate: string;
  /** Unified diff against the first parent. */
  diff: string;
  files: FileIndex[];
}

export type HunkMatchKind = "exact" | "moved" | "fuzzy" | "new";

export interface HunkMatch {
  id: string;
  previousId: string | null;
  match: HunkMatchKind;
  /** 0..1 for fuzzy matches; 1 for exact and moved. */
  similarity: number;
}

// `sha`: the identical commit (e.g. merges, which have no patch-id and range-diff skips).
export type CommitMatchMethod = "sha" | "patch-id" | "range-diff" | "subject";

export interface CommitMapping {
  sha: string;
  previousSha: string | null;
  method: CommitMatchMethod | null;
  patchIdChanged: boolean;
  /** Per-commit hunk matches, present when patchIdChanged. */
  hunks?: HunkMatch[];
}

export interface SnapshotMapping {
  previousSnapshotId: string;
  previousHead: string;
  /** False when range-diff could not run (e.g. previous commits gone). */
  rangeDiff: boolean;
  commits: CommitMapping[];
  droppedCommits: string[];
  hunks: HunkMatch[];
  droppedHunks: string[];
}

export interface Snapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  kind: "differential-review-snapshot";
  fingerprintVersion: typeof FINGERPRINT_VERSION;
  /** File stem: `<UTC timestamp>-<phase>-<head12>`. */
  id: string;
  createdAt: string;
  phase: Phase;
  repo: string | null;
  branch: string;
  head: string;
  base: SnapshotBase;
  previousSnapshotId: string | null;
  /** Cumulative unified diff, merge-base..head. */
  diff: string;
  files: FileIndex[];
  commits: SnapshotCommit[];
  mapping: SnapshotMapping | null;
}

export interface HunkCheckoff {
  snapshotId: string;
  path: string;
  reviewedAt: string;
}

export interface CommitSignoff {
  sha: string;
  subject: string;
  snapshotId: string;
  signedOffAt: string;
  note?: string;
}

export interface ReviewState {
  schemaVersion: typeof REVIEW_STATE_SCHEMA_VERSION;
  kind: "differential-review-state";
  updatedAt: string | null;
  /** Keyed by hunk fingerprint (HunkIndex.id) from the cumulative branch diff. */
  hunks: Record<string, HunkCheckoff>;
  /** Keyed by commitKey(): patch-id, or `sha:<sha>` when there is none. */
  commits: Record<string, CommitSignoff>;
}

export type ReviewStatus = "reviewed" | "new" | "changed";
