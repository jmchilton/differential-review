// Node fs storage for the CLI: read-only file access plus immutable snapshot writes.
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { snapshotPath, type ReadOnlyFileAdapter, type Snapshot } from "../core";

/** No `write`: the CLI cannot build a ReviewStateStore from it. */
export const nodeReadAdapter: ReadOnlyFileAdapter = {
  async exists(path) {
    return existsSync(path);
  },
  async read(path) {
    return readFileSync(path, "utf8");
  },
  async listFiles(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  },
};

/** Write a new snapshot atomically; an existing file is an EEXIST error, never an overwrite. */
export function writeSnapshot(recordDir: string, snapshot: Snapshot): string {
  const path = snapshotPath(recordDir, snapshot.id);
  // Not `*.json`, so readers never list a partial write.
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n");
  try {
    linkSync(tmp, path);
  } finally {
    unlinkSync(tmp);
  }
  return path;
}
