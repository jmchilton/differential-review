import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  commitFiles,
  deriveReview,
  emptyReviewState,
  markFileReviewed,
  readAllSnapshots,
  recordReviewStateStore,
  recordSnapshotReader,
  reviewStatePath,
  signOffCommit,
  snapshotFiles,
  snapshotsDir,
  type ReviewState,
  type Snapshot,
} from "../core";
import { parseRangeDiff } from "./git";
import { nodeReadAdapter, writeSnapshot } from "./node-storage";
import { baseCandidates } from "./record";
import { run } from "./run";
import { isolateGit, numberedLines, pluginAdapter, TestRepo } from "./test-repo";

beforeAll(isolateGit);

let clock = Date.parse("2026-10-26T00:00:00Z");

async function cliIn(cwd: string | undefined, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  clock += 60_000;
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), now: new Date(clock), cwd });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const cli = (...argv: string[]) => cliIn(undefined, argv);
const firstLine = (text: string) => text.split("\n")[0];

async function snapshot(repo: TestRepo, record: string, phase: string, ...extra: string[]) {
  const r = await cli("snapshot", "--worktree", repo.dir, "--record", record, "--phase", phase, ...extra);
  expect(r.err.replace(/^warning: .*$/gm, "").trim()).toBe("");
  expect(r.code).toBe(0);
  return r;
}

async function snapshots(record: string): Promise<Snapshot[]> {
  return readAllSnapshots(recordSnapshotReader(nodeReadAdapter, record));
}

/** What a plugin does: check off every file and sign off every commit of a snapshot. */
async function reviewEverything(record: string, s: Snapshot): Promise<ReviewState> {
  let state = emptyReviewState();
  for (const f of s.files) state = markFileReviewed(state, s, f.path, "2026-10-26T00:00:00Z");
  for (const c of s.commits) state = signOffCommit(state, s, c.sha, "2026-10-26T00:00:00Z");
  await recordReviewStateStore(pluginAdapter, record).writeReviewState(state);
  return state;
}

async function review(record: string) {
  const all = await snapshots(record);
  const state = (await recordReviewStateStore(pluginAdapter, record).readReviewState())!;
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
    expect(firstLine(r.out)).toMatch(/^created .*\/differential-review\/snapshots\/\d{8}T\d{6}Z-implementation-[0-9a-f]{12}\.json$/);
    expect(r.out).toContain("first snapshot: 1 commit, 1 file, 2 hunks");
    const [s] = await snapshots(record);
    expect(s).toMatchObject({ phase: "implementation", repo: "demo", branch: "feature", head: repo.head(), previousSnapshotId: null, mapping: null });
    expect(s.base).toMatchObject({ name: "main", source: "upstream_base_branch", ref: "main" });
    expect(s.files.map((f) => [f.path, f.hunks.length])).toEqual([["lib/mod.py", 2]]);
    expect(s.commits).toHaveLength(1);
    expect(s.commits[0].patchId).toMatch(/^[0-9a-f]{40}$/);
    expect(s.commits[0].subject).toBe("Change two values");
    expect(() => snapshotFiles(s)).not.toThrow();
    expect(() => commitFiles(s.commits[0])).not.toThrow();
  });

  it("is a no-op when re-run on the same head and phase, and never overwrites", async () => {
    const { repo, record } = setup();
    const first = await snapshot(repo, record, "implementation");
    const path = firstLine(first.out).replace(/^created /, "");
    const bytes = readFileSync(path, "utf8");
    const again = await snapshot(repo, record, "implementation");
    expect(firstLine(again.out)).toBe(`exists ${path}`);
    expect(readdirSync(snapshotsDir(record))).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    const [s] = await snapshots(record);
    expect(() => writeSnapshot(record, s)).toThrow(/EEXIST/);
    expect(readdirSync(snapshotsDir(record))).toEqual([`${s.id}.json`]);

    await snapshot(repo, record, "hardening");
    expect(readdirSync(snapshotsDir(record))).toHaveLength(2);
  });

  it("snapshots again when HEAD returns to an earlier head, but not on a same-head rerun", async () => {
    const { repo, record } = setup();
    const first = repo.head();
    await snapshot(repo, record, "implementation");
    await snapshot(repo, record, "hardening");
    expect(firstLine((await snapshot(repo, record, "implementation")).out)).toMatch(/^exists /);

    repo.write("lib/extra.py", "x = 1\n");
    repo.commit("Extra");
    await snapshot(repo, record, "hardening");
    repo.git("reset", "-q", "--hard", first);
    const back = await snapshot(repo, record, "hardening");
    expect(firstLine(back.out)).toMatch(/^created /);
    expect((await snapshots(record)).map((s) => [s.phase, s.head === first])).toEqual([
      ["implementation", true],
      ["hardening", true],
      ["hardening", false],
      ["hardening", true],
    ]);
  });

  it("names an unreadable snapshot file instead of failing opaquely", async () => {
    const { repo, record } = setup();
    await snapshot(repo, record, "implementation");
    writeFileSync(`${snapshotsDir(record)}/20261026T999999Z-hardening-truncated.json`, '{"schemaVersion": 1, "ki');
    const r = await cli("list", "--record", record);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unreadable snapshot .*truncated\.json/);
  });

  it("never creates or modifies review-state.json", async () => {
    const { repo, record } = setup();
    await snapshot(repo, record, "implementation");
    expect((await cli("status", "--record", record)).code).toBe(0);
    expect((await cli("list", "--record", record)).code).toBe(0);
    expect(existsSync(reviewStatePath(record))).toBe(false);

    const [s] = await snapshots(record);
    await reviewEverything(record, s);
    const before = readFileSync(reviewStatePath(record), "utf8");
    repo.edit("lib/mod.py", "x_40 = 4000\n", "x_40 = 4001\n");
    repo.commit("Change two values", "--amend");
    await snapshot(repo, record, "hardening");
    expect((await cli("status", "--record", record)).code).toBe(0);
    expect((await cli("status", "--record", record, "--json")).code).toBe(0);
    expect(readFileSync(reviewStatePath(record), "utf8")).toBe(before);
  });

  it("summarizes the change since the previous snapshot, as text and stable JSON", async () => {
    const { repo, record } = setup();
    await snapshot(repo, record, "implementation");
    repo.edit("lib/mod.py", "x_40 = 4000\n", "x_40 = 4001\n");
    repo.commit("Change two values", "--amend");
    repo.write("lib/extra.py", "x = 1\n");
    repo.commit("Add extra");

    const r = await cli("snapshot", "--worktree", repo.dir, "--record", record, "--phase", "hardening", "--json");
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(Object.keys(json)).toEqual(["status", "id", "path", "summary", "warnings"]);
    expect(json.summary).toMatchObject({
      commits: { same: 0, rebased: 0, changed: 1, new: 1, dropped: 0 },
      hunks: { carried: 1, changed: 1, new: 1, dropped: 0 },
    });
    expect(json.summary.flaggedCommits.map((c: { change: string; differingHunks: number | null }) => [c.change, c.differingHunks])).toEqual([
      ["changed", 1],
      ["new", null],
    ]);

    const text = (await snapshot(repo, record, "hardening")).out.split("\n");
    expect(text[0]).toBe(`exists ${json.path}`);
    expect(text.slice(2)).toEqual([
      `  since ${(await snapshots(record))[0].id}:`,
      "    commits: 0 same, 0 rebased, 1 changed, 1 new, 0 dropped",
      "    hunks:   1 carried, 1 changed, 1 new, 0 dropped",
      expect.stringMatching(/^    changed [0-9a-f]{12} Change two values \(1 differing hunk\)$/),
      expect.stringMatching(/^    new     [0-9a-f]{12} Add extra$/),
    ]);
  });

  it("produces identical diffs and patch-ids regardless of the user's diff config", async () => {
    const { repo, record } = setup();
    repo.write("lib/blank.py", "a = 1\n\nb = 2\n\nc = 3\n");
    repo.commit("Blank lines");
    repo.edit("lib/blank.py", "b = 2\n", "b = 20\n");
    repo.commit("Edit between blank lines");
    await snapshot(repo, record, "implementation");
    const hostile = {
      "diff.noprefix": "true",
      "diff.mnemonicPrefix": "true",
      "diff.context": "10",
      "diff.interHunkContext": "20",
      "diff.algorithm": "histogram",
      "diff.renames": "false",
      "diff.suppressBlankEmpty": "true",
      "diff.relative": "true",
      "diff.orderFile": "/dev/null",
      "diff.submodule": "log",
      "color.ui": "always",
      "core.quotePath": "true",
    };
    for (const [k, v] of Object.entries(hostile)) repo.git("config", k, v);
    // From a subdir, where diff.relative would otherwise narrow the diff.
    expect((await cli("snapshot", "--worktree", `${repo.dir}/lib`, "--record", record, "--phase", "hardening")).code).toBe(0);

    const [clean, configured] = await snapshots(record);
    expect(configured.diff).toBe(clean.diff);
    expect(configured.commits.map((c) => [c.patchId, c.diff])).toEqual(clean.commits.map((c) => [c.patchId, c.diff]));
    expect(configured.mapping!.commits.map((c) => c.method)).toEqual(["sha", "sha", "sha"]);
  });

  it("gives different patch-ids to different binary edits", async () => {
    const repo = new TestRepo();
    repo.write("img.bin", "\x00\x01\x02");
    repo.commit("base");
    repo.git("checkout", "-q", "-b", "feature");
    repo.write("img.bin", "\x00\x09\x02");
    repo.commit("Binary edit");
    const record = repo.record("feature", { upstream_base_branch: "main" });
    await snapshot(repo, record, "implementation");
    repo.write("img.bin", "\x00\x09\x03");
    repo.commit("Binary edit", "--amend");
    await snapshot(repo, record, "hardening");

    const [a, b] = await snapshots(record);
    expect(a.commits[0].patchId).toMatch(/^[0-9a-f]{40}$/);
    expect(b.commits[0].patchId).not.toBe(a.commits[0].patchId);
    expect(b.mapping!.commits[0]).toMatchObject({ patchIdChanged: true });
  });

  it("requires --base when the record has no frontmatter", async () => {
    const { repo, record } = setup(null);
    const r = await cli("snapshot", "--worktree", repo.dir, "--record", record, "--phase", "implementation");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/upstream_base_branch.*--base/);
    expect(existsSync(snapshotsDir(record))).toBe(false);
    await snapshot(repo, record, "implementation", "--base", "main");
    expect((await snapshots(record))[0].base).toMatchObject({ source: "override", ref: "main" });
  });

  it("rejects unknown phases", async () => {
    const { repo, record } = setup();
    const r = await cli("snapshot", "--worktree", repo.dir, "--record", record, "--phase", "rebase");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--phase must be one of implementation, hardening, polishing/);
    expect(existsSync(snapshotsDir(record))).toBe(false);
  });

  it("refuses a record dir without index.md instead of creating it", async () => {
    const { repo, record } = setup();
    const typo = `${record}_typo`;
    for (const argv of [
      ["snapshot", "--worktree", repo.dir, "--record", typo, "--phase", "implementation", "--base", "main"],
      ["list", "--record", typo],
      ["status", "--record", typo],
    ]) {
      const r = await cli(...argv);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/no branch record at .*_typo \(no index\.md\)/);
    }
    expect(existsSync(typo)).toBe(false);
  });

  it("explains a worktree that is not a git repo, and an unresolvable base", async () => {
    const { repo, record } = setup();
    const notGit = await cli("snapshot", "--worktree", repo.vault, "--record", record, "--phase", "implementation");
    expect(notGit.code).toBe(1);
    expect(notGit.err).toMatch(/is not inside a git worktree; pass --worktree/);

    const badBase = await cli("snapshot", "--worktree", repo.dir, "--record", record, "--phase", "implementation", "--base", "nope");
    expect(badBase.code).toBe(1);
    expect(badBase.err).toMatch(/could not resolve base nope .*tried nope\. Fetch it/);
  });

  it("defaults --worktree to the current dir and warns on a detached HEAD", async () => {
    const { repo, record } = setup();
    repo.git("checkout", "-q", "--detach");
    const r = await cliIn(repo.dir, ["snapshot", "--record", record, "--phase", "implementation"]);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/^warning: HEAD is detached at [0-9a-f]{12}; snapshotting it for record feature$/);
    expect((await snapshots(record))[0].head).toBe(repo.head());
  });

  it("treats bad flags and commands as usage errors with per-command help", async () => {
    const { record } = setup();
    for (const argv of [["status", "--record", record, "--bogus"], ["list", "--record", record, "--phase", "x"], ["frobnicate"], ["list", "extra"]]) {
      const r = await cli(...argv);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/^usage error: /);
    }
    const help = await cli("snapshot", "--help");
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/^usage: differential-review snapshot --record <dir> --phase/);
    expect(help.out).toContain("--worktree <dir>  the branch's worktree (default: current dir)");
    const top = await cli("--help");
    expect(top.code).toBe(0);
    expect(top.out).toMatch(/snapshot .*\n.*list .*\n.*status /);
    expect((await cli()).code).toBe(2);
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
    await recordReviewStateStore(pluginAdapter, record).writeReviewState(state);
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
    const [, s2] = await snapshots(record);
    expect(r.out.split("\n")).toEqual([
      `${s2.id} (hardening @ ${s2.head.slice(0, 12)})`,
      "  hunks:   2 reviewed, 0 changed, 1 new",
      "  files:   1 reviewed, 0 changed, 1 new",
      "  commits: 1 reviewed, 0 changed, 1 new",
      "  to review:",
      "    new     lib/extra.py (0 changed, 1 new)",
      `    new     commit ${s2.head.slice(0, 12)} Add extra`,
    ]);
  });

  it("carries text-hunk check-offs through a rename and shows the rename itself as new", async () => {
    const { repo, record } = setup();
    await snapshot(repo, record, "implementation");
    await reviewEverything(record, (await snapshots(record))[0]);
    repo.git("mv", "lib/mod.py", "lib/renamed.py");
    repo.commit("Rename module");
    await snapshot(repo, record, "hardening");

    const r = await review(record);
    expect(r.files.map((f) => [f.path, f.hunks.map((h) => [h.kind, h.state])])).toEqual([
      ["lib/renamed.py", [["meta", "new"], ["text", "reviewed"], ["text", "reviewed"]]],
    ]);
    expect(r.files[0].state).toBe("changed");
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
