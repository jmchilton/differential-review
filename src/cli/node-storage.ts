// Node fs implementations of the core storage interfaces.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { snapshotPath, type Snapshot, type TextFileAdapter } from "../core";

export const nodeAdapter: TextFileAdapter = {
  async exists(path) {
    return existsSync(path);
  },
  async read(path) {
    return readFileSync(path, "utf8");
  },
  async write(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  },
  async listFiles(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  },
};

/** Write a new snapshot file; `wx` makes an existing file an error, never an overwrite. */
export function writeSnapshot(recordDir: string, snapshot: Snapshot): string {
  const path = snapshotPath(recordDir, snapshot.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx" });
  return path;
}
