import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { annotationPath, captureReviewOrigin, createReviewThread, reviewStatePath, snapshotPath } from "../core/index.js";
import { fileDiff, snap } from "../core/test-helpers.js";
import { createCli, type TargetFlags } from "./run.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "review-notes-")); dirs.push(dir);
  const s = snap({ at: "2026-10-26T01:00:00Z", phase: "revision", head: "a", diff: fileDiff("a.py", [{ oldStart: 1, newStart: 1, lines: ["-old", "+new"] }]) });
  const t = createReviewThread({ id: "t-1", origin: captureReviewOrigin(s, { path: "a.py", hunkId: s.files[0].hunks[0].id, side: "new", range: [1, 1] }), body: "Handle empty inputs", author: "John", createdAt: "2026-10-26T02:00:00Z" });
  for (const [path, value] of [[snapshotPath(dir, s.id), s], [annotationPath(dir, "threads", t.id), t], [reviewStatePath(dir), { untouched: true }]] as const) {
    mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(value));
  }
  const flags: TargetFlags = { options: {}, usage: "", help: "", baseHelp: "", worktreeHelp: "", resolve: () => ({ dir, branch: "feature", branchCheck: "off", base: () => { throw new Error("unused"); } }) };
  const run = createCli(flags);
  return { dir, s, t, async cli(...args: string[]) { const out: string[] = [], err: string[] = []; const code = await run(args, { out: (s) => out.push(s), err: (s) => err.push(s) }); return { code, out: out.join("\n"), err: err.join("\n") }; } };
}

describe("annotation CLI", () => {
  it("lists source context and replies across invocations while leaving human state untouched", async () => {
    const { dir, s, t, cli } = setup();
    const before = readFileSync(annotationPath(dir, "threads", t.id), "utf8");
    const first = await cli("threads", "--open", "--json");
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)[0]).toMatchObject({ thread: { body: "Handle empty inputs" }, placement: { state: "active" }, replies: [] });
    const body = join(dir, "response.md"); writeFileSync(body, "Fixed the boundary.\nAdded a regression test.\n");
    const response = await cli("reply", "--thread", t.id, "--body-file", body, "--snapshot", s.id, "--author", "Codex", "--json");
    expect(response.code).toBe(0);
    expect(JSON.parse(response.out)).toMatchObject({ threadId: t.id, source: "agent", snapshotId: s.id });
    expect(JSON.parse((await cli("threads", "--json")).out)[0].replies[0].body).toBe("Fixed the boundary.\nAdded a regression test.\n");
    expect(readFileSync(annotationPath(dir, "threads", t.id), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(reviewStatePath(dir), "utf8"))).toEqual({ untouched: true });
  });
  it("retains conversations when snapshots are unavailable", async () => {
    const { dir, s, cli } = setup();
    rmSync(snapshotPath(dir, s.id));
    const threads = JSON.parse((await cli("threads", "--json")).out);
    expect(threads[0]).toMatchObject({ thread: { body: "Handle empty inputs" }, placement: { state: "unmapped" } });
    expect((await cli("reply", "--thread", "t-1", "--body", "I need the current branch to verify this.")).code).toBe(0);
  });
  it("rejects missing threads, invalid snapshots and empty replies without writing", async () => {
    const { cli } = setup();
    expect((await cli("reply", "--thread", "missing", "--body", "done")).code).toBe(1);
    expect((await cli("reply", "--thread", "t-1", "--body", "done", "--snapshot", "missing")).code).toBe(1);
    expect((await cli("reply", "--thread", "t-1", "--body", " ")).code).toBe(2);
    expect(JSON.parse((await cli("threads", "--json")).out)[0].replies).toEqual([]);
  });
});
