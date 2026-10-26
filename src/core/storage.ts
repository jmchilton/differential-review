// Storage layout and async interfaces, implemented over whatever file access the host has (Node fs, an app's vault).
import { emptyReviewState, parseReviewState } from "./review-state.js";
import { sortSnapshots } from "./snapshot.js";
import { FINGERPRINT_VERSION, SNAPSHOT_SCHEMA_VERSION, type ReviewState, type Snapshot } from "./types.js";

// A review dir holds one branch's review: `snapshots/<id>.json` and `review-state.json`.
export const SNAPSHOTS_DIR = "snapshots";
export const REVIEW_STATE_FILE = "review-state.json";

/** Minimal text-file access, relative to whatever root the host uses. */
export interface TextFileAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  /** Creates missing parent dirs. */
  write(path: string, data: string): Promise<void>;
  /** File names (not paths) directly in `dir`; [] when it doesn't exist. */
  listFiles(dir: string): Promise<string[]>;
}

/** Read side of snapshots; review UIs only ever read them. */
export interface SnapshotReader {
  listSnapshotIds(): Promise<string[]>;
  readSnapshot(id: string): Promise<Snapshot>;
}

/** Reviewer-owned state; implemented by review UIs, never by the snapshot CLI. */
export interface ReviewStateStore {
  readReviewState(): Promise<ReviewState | null>;
  writeReviewState(state: ReviewState): Promise<void>;
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

export function snapshotsDir(reviewDir: string): string {
  return join(reviewDir, SNAPSHOTS_DIR);
}

export function snapshotPath(reviewDir: string, id: string): string {
  return join(snapshotsDir(reviewDir), `${id}.json`);
}

export function reviewStatePath(reviewDir: string): string {
  return join(reviewDir, REVIEW_STATE_FILE);
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

export function snapshotReader(adapter: Pick<TextFileAdapter, "read" | "listFiles">, reviewDir: string): SnapshotReader {
  return {
    async listSnapshotIds() {
      const names = await adapter.listFiles(snapshotsDir(reviewDir));
      return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
    },
    async readSnapshot(id) {
      const path = snapshotPath(reviewDir, id);
      try {
        return parseSnapshot(JSON.parse(await adapter.read(path)));
      } catch (e) {
        throw new Error(`unreadable snapshot ${path}: ${(e as Error).message}`);
      }
    },
  };
}

/** Read-only access for tools that must never write review state (the CLI). */
export async function readReviewState(adapter: Pick<TextFileAdapter, "exists" | "read">, reviewDir: string): Promise<ReviewState | null> {
  const path = reviewStatePath(reviewDir);
  if (!(await adapter.exists(path))) return null;
  return parseReviewState(JSON.parse(await adapter.read(path)));
}

export function reviewStateStore(adapter: TextFileAdapter, reviewDir: string): ReviewStateStore {
  return {
    readReviewState: () => readReviewState(adapter, reviewDir),
    async writeReviewState(state) {
      await adapter.write(reviewStatePath(reviewDir), JSON.stringify(state, null, 2) + "\n");
    },
  };
}

/** Read-modify-write: apply `mutate` to the state as it is on disk now, so other writers' check-offs survive. */
export async function updateReviewState(store: ReviewStateStore, mutate: (state: ReviewState) => ReviewState): Promise<ReviewState> {
  const next = mutate((await store.readReviewState()) ?? emptyReviewState());
  await store.writeReviewState(next);
  return next;
}

/** All snapshots in a review dir, oldest first. */
export async function readAllSnapshots(reader: SnapshotReader): Promise<Snapshot[]> {
  const ids = await reader.listSnapshotIds();
  return sortSnapshots(await Promise.all(ids.map((id) => reader.readSnapshot(id))));
}
