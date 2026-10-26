// Node fs storage for the CLI: read-only file access plus immutable snapshot writes.
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { annotationPath, parseReviewReply, type ReviewReply, snapshotPath, type ReadOnlyFileAdapter, type Snapshot } from "../core/index.js";

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
export function writeSnapshot(reviewDir: string, snapshot: Snapshot): string {
  const path = snapshotPath(reviewDir, snapshot.id);
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

/** Dedicated agent capability: append replies, with no access to thread or check-off writes. */
export function writeAgentReply(reviewDir: string, reply: ReviewReply): string {
  parseReviewReply(reply);
  if (reply.source !== "agent") throw new Error("the CLI can only write agent replies");
  const path = annotationPath(reviewDir, "replies", reply.id);
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(reply, null, 2) + "\n", { flag: "wx" });
  try { linkSync(tmp, path); } finally { unlinkSync(tmp); }
  return path;
}
