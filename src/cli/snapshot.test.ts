import { existsSync, readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  deriveReview,
  emptyReviewState,
  markFileReviewed,
  readAllSnapshots,
  recordReviewStateStore,
  recordSnapshotReader,
  reviewStatePath,
  signOffCommit,
  snapshotsDir,
  type ReviewState,
  type Snapshot,
} from "../core";
import { parseRangeDiff } from "./git";
import { nodeAdapter, writeSnapshot } from "./node-storage";
import { baseCandidates } from "./record";
import { run } from "./run";
import { isolateGit, numberedLines, TestRepo } from "./test-repo";

beforeAll(isolateGit);

let clock = Date.parse("2026-10-26T00:00:00Z");

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  clock += 60_000;
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), now: new Date(clock) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function snapshot(repo: TestRepo, record: string, phase: string, ...extra: string[]) {
  const r = await cli("snapshot", "--worktree", repo.dir, "--record", record, "--phase", phase, ...extra);
  expect(r.err.replace(/^warning: .*$/gm, "").trim()).toBe("");
  expect(r.code).toBe(0);
  return r;
}

async function snapshots(record: string): Promise<Snapshot[]> {
  return readAllSnapshots(recordSnapshotReader(nodeAdapter, record));
}

/** What a plugin does: check off every file and sign off every commit of a snapshot. */
async function reviewEverything(record: string, s: Snapshot): Promise<ReviewState> {
  let state = emptyReviewState();
  for (const f of s.files) state = markFileReviewed(state, s, f.path, "2026-10-26T00:00:00Z");
  for (const c of s.commits) state = signOffCommit(state, s, c.sha, "2026-10-26T00:00:00Z");
  await recordReviewStateStore(nodeAdapter, record).writeReviewState(state);
  return state;
}

async function review(record: string) {
  const all = await snapshots(record);
  const state = (await recordReviewStateStore(nodeAdapter, record).readReviewState())!;
  return deriveReview(all.at(-1)!, state, all);
}

/** main with a 60-line module; feature changes lines 10 and 40 in one commit. */
function setup(frontmatter: Record<string, string> | null = { upstream_base_branch: "main" }) {
  const repo = new TestRepo();
  repo.write("lib/mod.py", numberedLines(60));
  repo.commit("base");
  repo.git("checkout", "-q", "-b", "feature");
  repo.edit("lib/mod.py", "x_10 = 10\n", "x_10 = 1000\n");
  repo.edit("lib/mod.py", "x_40 = 40\n", "x_40 = 4000\n");
  repo.commit("Change two values");
  return { repo, record: repo.record("feature", frontmatter) };
}

describe("snapshot CLI", () => {
  it("writes an immutable snapshot of the branch against the record's base", async () => {
    const { repo, record } = setup();
    const r = await snapshot(repo, record, "implementation");
    expect(r.out).toMatch(/^created .*\/differential-review\/snapshots\/\d{8}T\d{6}Z-implementation-[0-9a-f]{12}\.json$/);
    const [s] = await snapshots(record);
    expect(s).toMatchObject({ phase: "implementation", repo: "demo", branch: "feature", head: repo.head(), previousSnapshotId: null, mapping: null });
    expect(s.base).toMatchObject({ name: "main", source: "upstream_base_branch", ref: "main" });
    expect(s.files.map((f) => [f.path, f.hunks.length])).toEqual([["lib/mod.py", 2]]);
    expect(s.commits).toHaveLength(1);
    expect(s.commits[0].patchId).toMatch(/^[0-9a-f]{40}$/);
    expect(s.commits[0].subject).toBe("Change two values");
  });

  it("is a no-op when re-run on the same head and phase, and never overwrites", async () => {
    const { repo, record } = setup();
    const first = await snapshot(repo, record, "implementation");
    const path = first.out.replace(/^created /, "");
    const bytes = readFileSync(path, "utf8");
    const again = await snapshot(repo, record, "implementation");
    expect(again.out).toBe(`exists ${path}`);
    expect(readdirSync(snapshotsDir(record))).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    const [s] = await snapshots(record);
    expect(() => writeSnapshot(record, s)).toThrow(/EEXIST/);

    await snapshot(repo, record, "hardening");
    expect(readdirSync(snapshotsDir(record))).toHaveLength(2);
  });

  it("never creates or modifies review-state.json", async () => {
    const { repo, record } = setup();
    await snapshot(repo, record, "implementation");
    await cli("status", "--record", record);
    await cli("list", "--record", record);
    expect(existsSync(reviewStatePath(record))).toBe(false);

    const [s] = await snapshots(record);
    await reviewEverything(record, s);
    const before = readFileSync(reviewStatePath(record), "utf8");
    repo.edit("lib/mod.py", "x_40 = 4000\n", "x_40 = 4001\n");
    repo.commit("Change two values", "--amend");
    await snapshot(repo, record, "hardening");
    await cli("status", "--record", record);
    expect(readFileSync(reviewStatePath(record), "utf8")).toBe(before);
  });

  it("requires --base when the record has no frontmatter", async () => {
    const { repo, record } = setup(null);
    const r = await cli("snapshot", "--worktree", repo.dir, "--record", record, "--phase", "implementation");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--base/);
    await snapshot(repo, record, "implementation", "--base", "main");
    expect((await snapshots(record))[0].base).toMatchObject({ source: "override", ref: "main" });
  });

  it("rejects unknown phases", async () => {
    const { repo, record } = setup();
    const r = await cli("snapshot", "--worktree", repo.dir, "--record", record, "--phase", "rebase");
    expect(r.code).toBe(2);
  });

  it("prefers origin/<base> for upstream bases and the local branch for parents", async () => {
    const { repo, record } = setup();
    repo.git("remote", "add", "origin", repo.dir);
    repo.git("fetch", "-q", "origin");
    await snapshot(repo, record, "implementation");
    expect((await snapshots(record))[0].base.ref).toBe("origin/main");
    expect(baseCandidates({ name: "dev", source: "parent_branch" }, ["jmchilton", "origin"])).toEqual([
      "refs/heads/dev",
      "origin/dev",
      "jmchilton/dev",
    ]);
    expect(baseCandidates({ name: "dev", source: "override" }, ["origin"])).toEqual(["origin/dev", "dev"]);
  });
});

describe("differential review across agent iterations", () => {
  it("keeps hunk check-offs and commit sign-off through a rebase that only shifts line numbers", async () => {
    const { repo, record } = setup();
    await snapshot(repo, record, "implementation");
    await reviewEverything(record, (await snapshots(record))[0]);

    repo.git("checkout", "-q", "main");
    repo.write("lib/mod.py", "# header\n# more\n" + repo.read("lib/mod.py"));
    repo.commit("Upstream adds a header");
    repo.git("checkout", "-q", "feature");
    repo.git("rebase", "-q", "main");
    await snapshot(repo, record, "hardening");

    const [s1, s2] = await snapshots(record);
    expect(s2.files[0].hunks.map((h) => h.newStart)).not.toEqual(s1.files[0].hunks.map((h) => h.newStart));
    expect(s2.commits[0].sha).not.toBe(s1.commits[0].sha);
    expect(s2.mapping!.commits[0]).toMatchObject({ method: "patch-id", patchIdChanged: false });
    const r = await review(record);
    expect(r.files[0].hunks.map((h) => h.state)).toEqual(["reviewed", "reviewed"]);
    expect(r.commits.map((c) => c.state)).toEqual(["reviewed"]);
  });

  it("keeps hunk check-offs when a rebase changes context, but flags the commit with no differing hunks", async () => {
    const { repo, record } = setup();
    await snapshot(repo, record, "implementation");
    await reviewEverything(record, (await snapshots(record))[0]);

    repo.git("checkout", "-q", "main");
    repo.edit("lib/mod.py", "x_38 = 38\n", "x_38 = 38  # upstream tweak\n");
    repo.commit("Upstream touches nearby context");
    repo.git("checkout", "-q", "feature");
    repo.git("rebase", "-q", "main");
    await snapshot(repo, record, "hardening");

    const r = await review(record);
    expect(r.files[0].hunks.map((h) => h.state)).toEqual(["reviewed", "reviewed"]);
    expect(r.commits[0]).toMatchObject({ state: "changed", differingHunks: [] });
  });

  it("shows only the amended hunk as changed and flags the commit with just that hunk", async () => {
    const { repo, record } = setup();
    await snapshot(repo, record, "implementation");
    await reviewEverything(record, (await snapshots(record))[0]);

    repo.edit("lib/mod.py", "x_40 = 4000\n", "x_40 = 4001\n");
    repo.commit("Change two values", "--amend");
    await snapshot(repo, record, "hardening");

    const [, s2] = await snapshots(record);
    expect(s2.mapping!.commits[0]).toMatchObject({ method: "range-diff", patchIdChanged: true });
    expect(s2.mapping!.hunks.map((h) => h.match)).toEqual(["exact", "fuzzy"]);
    const r = await review(record);
    expect(r.files[0].hunks.map((h) => h.state)).toEqual(["reviewed", "changed"]);
    expect(r.files[0].state).toBe("changed");
    expect(r.commits[0].state).toBe("changed");
    expect(r.commits[0].differingHunks).toEqual([s2.commits[0].files[0].hunks[1].id]);
  });

  it("treats an indentation-only amend as a commit change", async () => {
    const { repo, record } = setup();
    await snapshot(repo, record, "implementation");
    await reviewEverything(record, (await snapshots(record))[0]);

    repo.edit("lib/mod.py", "x_40 = 4000\n", "    x_40 = 4000\n");
    repo.commit("Change two values", "--amend");
    await snapshot(repo, record, "hardening");

    const r = await review(record);
    expect(r.commits[0].state).toBe("changed");
    expect(r.files[0].hunks.map((h) => h.state)).toEqual(["reviewed", "changed"]);
  });

  it("does not let a check-off in one file cover an identical hunk in another", async () => {
    const repo = new TestRepo();
    repo.write("a.py", numberedLines(5, "a"));
    repo.write("b.py", numberedLines(5, "b"));
    repo.commit("base");
    repo.git("checkout", "-q", "-b", "feature");
    repo.write("a.py", "import os\n" + repo.read("a.py"));
    repo.write("b.py", "import os\n" + repo.read("b.py"));
    repo.commit("Import os twice");
    const record = repo.record("feature", { upstream_base_branch: "main" });
    await snapshot(repo, record, "implementation");

    const [s] = await snapshots(record);
    const [a, b] = s.files.map((f) => f.hunks[0]);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.id).not.toBe(b.id);
    const state = markFileReviewed(emptyReviewState(), s, "a.py", "2026-10-26T00:00:00Z");
    await recordReviewStateStore(nodeAdapter, record).writeReviewState(state);
    const r = await review(record);
    expect(r.files.map((f) => [f.path, f.state])).toEqual([["a.py", "reviewed"], ["b.py", "new"]]);
  });

  it("reports what hardening added since implementation via status", async () => {
    const { repo, record } = setup();
    await snapshot(repo, record, "implementation");
    await reviewEverything(record, (await snapshots(record))[0]);
    repo.write("lib/extra.py", "def extra():\n    return 1\n");
    repo.commit("Add extra");
    await snapshot(repo, record, "hardening");

    const r = await cli("status", "--record", record);
    expect(r.out).toContain("hunks: 2 reviewed, 0 changed, 1 new");
    expect(r.out).toContain("commits: 1 reviewed, 0 changed, 1 new");
  });
});

describe("parseRangeDiff", () => {
  it("pairs = and ! lines and ignores additions and removals", () => {
    const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40), d = "d".repeat(40);
    const out = [
      `1:  ${a} = 1:  ${b} Same`,
      `2:  ${c} ! 2:  ${d} Changed`,
      `    @@ interdiff`,
      `3:  ${"e".repeat(40)} < -:  ${"-".repeat(40)} Dropped`,
      `-:  ${"-".repeat(40)} > 3:  ${"f".repeat(40)} Added`,
    ].join("\n");
    expect(parseRangeDiff(out)).toEqual([{ previousSha: a, sha: b }, { previousSha: c, sha: d }]);
  });
});
