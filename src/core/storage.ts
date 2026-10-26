// Storage layout and async interfaces; implemented over Obsidian's vault adapter, Node fs, or a native host.
import { parseReviewState } from "./review-state";
import { sortSnapshots } from "./snapshot";
import { FINGERPRINT_VERSION, SNAPSHOT_SCHEMA_VERSION, type ReviewState, type Snapshot } from "./types";

export const REVIEW_DIR = "differential-review";
export const SNAPSHOTS_DIR = "snapshots";
export const REVIEW_STATE_FILE = "review-state.json";

/** Minimal text-file access, relative to whatever root the host uses (vault root, filesystem). */
export interface TextFileAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  /** Creates missing parent dirs. */
  write(path: string, data: string): Promise<void>;
  /** File names (not paths) directly in `dir`; [] when it doesn't exist. */
  listFiles(dir: string): Promise<string[]>;
}

/** Read side of snapshots; plugins only ever read them. */
export interface SnapshotReader {
  listSnapshotIds(): Promise<string[]>;
  readSnapshot(id: string): Promise<Snapshot>;
}

/** Reviewer-owned state; implemented by plugins, never by the snapshot CLI. */
export interface ReviewStateStore {
  readReviewState(): Promise<ReviewState | null>;
  writeReviewState(state: ReviewState): Promise<void>;
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

export function reviewDir(recordDir: string): string {
  return join(recordDir, REVIEW_DIR);
}

export function snapshotsDir(recordDir: string): string {
  return join(recordDir, REVIEW_DIR, SNAPSHOTS_DIR);
}

export function snapshotPath(recordDir: string, id: string): string {
  return join(snapshotsDir(recordDir), `${id}.json`);
}

export function reviewStatePath(recordDir: string): string {
  return join(recordDir, REVIEW_DIR, REVIEW_STATE_FILE);
}

/** Validate parsed snapshot JSON; throws on unknown kinds or newer schema versions. */
export function parseSnapshot(json: unknown): Snapshot {
  const s = json as Partial<Snapshot> | null;
  if (!s || s.kind !== "differential-review-snapshot") throw new Error("not a differential-review snapshot");
  if (s.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) throw new Error(`unsupported snapshot schemaVersion ${s.schemaVersion}`);
  if (s.fingerprintVersion !== FINGERPRINT_VERSION) throw new Error(`unsupported fingerprintVersion ${s.fingerprintVersion}`);
  return s as Snapshot;
}

/** Read-only file access: enough for snapshots and `readReviewState`, never for writing. */
export type ReadOnlyFileAdapter = Pick<TextFileAdapter, "exists" | "read" | "listFiles">;

export function recordSnapshotReader(adapter: Pick<TextFileAdapter, "read" | "listFiles">, recordDir: string): SnapshotReader {
  return {
    async listSnapshotIds() {
      const names = await adapter.listFiles(snapshotsDir(recordDir));
      return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
    },
    async readSnapshot(id) {
      const path = snapshotPath(recordDir, id);
      try {
        return parseSnapshot(JSON.parse(await adapter.read(path)));
      } catch (e) {
        throw new Error(`unreadable snapshot ${path}: ${(e as Error).message}`);
      }
    },
  };
}

/** Read-only access for tools that must never write review state (the CLI). */
export async function readReviewState(adapter: Pick<TextFileAdapter, "exists" | "read">, recordDir: string): Promise<ReviewState | null> {
  const path = reviewStatePath(recordDir);
  if (!(await adapter.exists(path))) return null;
  return parseReviewState(JSON.parse(await adapter.read(path)));
}

export function recordReviewStateStore(adapter: TextFileAdapter, recordDir: string): ReviewStateStore {
  return {
    readReviewState: () => readReviewState(adapter, recordDir),
    async writeReviewState(state) {
      await adapter.write(reviewStatePath(recordDir), JSON.stringify(state, null, 2) + "\n");
    },
  };
}

/** All snapshots of a record, oldest first. */
export async function readAllSnapshots(reader: SnapshotReader): Promise<Snapshot[]> {
  const ids = await reader.listSnapshotIds();
  return sortSnapshots(await Promise.all(ids.map((id) => reader.readSnapshot(id))));
}
