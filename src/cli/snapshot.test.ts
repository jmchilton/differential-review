import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  commitFiles,
  deriveReview,
  emptyReviewState,
  markFileReviewed,
  readAllSnapshots,
  reviewStatePath,
  reviewStateStore,
  signOffCommit,
  snapshotFiles,
  snapshotReader,
  snapshotsDir,
  type ReviewState,
  type Snapshot,
} from "../core/index.js";
import { parseRangeDiff } from "./git.js";
import { nodeReadAdapter, writeSnapshot } from "./node-storage.js";
import { baseCandidates } from "./base.js";
import { run } from "./run.js";
import { isolateGit, numberedLines, pluginAdapter, TestRepo } from "./test-repo.js";

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

/** Snapshot against `main` unless `extra` passes its own --base. */
async function snapshot(repo: TestRepo, dir: string, phase: string, ...extra: string[]) {
  const base = extra.includes("--base") ? [] : ["--base", "main"];
  const r = await cli("snapshot", "--worktree", repo.dir, "--dir", dir, "--phase", phase, ...base, ...extra);
  expect(r.err.replace(/^warning: .*$/gm, "").trim()).toBe("");
  expect(r.code).toBe(0);
  return r;
}

async function snapshots(dir: string): Promise<Snapshot[]> {
  return readAllSnapshots(snapshotReader(nodeReadAdapter, dir));
}

/** What a plugin does: check off every file and sign off every commit of a snapshot. */
async function reviewEverything(dir: string, s: Snapshot): Promise<ReviewState> {
  let state = emptyReviewState();
  for (const f of s.files) state = markFileReviewed(state, s, f.path, "2026-10-26T00:00:00Z");
  for (const c of s.commits) state = signOffCommit(state, s, c.sha, "2026-10-26T00:00:00Z");
  await reviewStateStore(pluginAdapter, dir).writeReviewState(state);
  return state;
}

async function review(dir: string) {
  const all = await snapshots(dir);
  const state = (await reviewStateStore(pluginAdapter, dir).readReviewState())!;
  return deriveReview(all.at(-1)!, state, all);
}

/** main with a 60-line module; feature changes lines 10 and 40 in one commit. */
function setup() {
  const repo = new TestRepo();
  repo.write("lib/mod.py", numberedLines(60));
  repo.commit("base");
  repo.git("checkout", "-q", "-b", "feature");
  repo.edit("lib/mod.py", "x_10 = 10\n", "x_10 = 1000\n");
  repo.edit("lib/mod.py", "x_40 = 40\n", "x_40 = 4000\n");
  repo.commit("Change two values");
  return { repo, dir: repo.reviewDir };
}

describe("snapshot CLI", () => {
  it("writes an immutable snapshot of the branch against its base", async () => {
    const { repo, dir } = setup();
    const r = await snapshot(repo, dir, "implementation");
    expect(firstLine(r.out)).toMatch(/^created .*\/review\/snapshots\/\d{8}T\d{6}Z-implementation-[0-9a-f]{12}\.json$/);
    expect(r.out).toContain("first snapshot: 1 commit, 1 file, 2 hunks");
    const [s] = await snapshots(dir);
    expect(s).toMatchObject({ phase: "implementation", repo: null, branch: "feature", head: repo.head(), previousSnapshotId: null, mapping: null });
    expect(s.base).toMatchObject({ name: "main", source: "option", ref: "main" });
    expect(s.files.map((f) => [f.path, f.hunks.length])).toEqual([["lib/mod.py", 2]]);
    expect(s.commits).toHaveLength(1);
    expect(s.commits[0].patchId).toMatch(/^[0-9a-f]{40}$/);
    expect(s.commits[0].subject).toBe("Change two values");
    expect(() => snapshotFiles(s)).not.toThrow();
    expect(() => commitFiles(s.commits[0])).not.toThrow();
  });

  it("is a no-op when re-run on the same head and phase, and never overwrites", async () => {
    const { repo, dir } = setup();
    const first = await snapshot(repo, dir, "implementation");
    const path = firstLine(first.out).replace(/^created /, "");
    const bytes = readFileSync(path, "utf8");
    const again = await snapshot(repo, dir, "implementation");
    expect(firstLine(again.out)).toBe(`exists ${path}`);
    expect(readdirSync(snapshotsDir(dir))).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    const [s] = await snapshots(dir);
    expect(() => writeSnapshot(dir, s)).toThrow(/EEXIST/);
    expect(readdirSync(snapshotsDir(dir))).toEqual([`${s.id}.json`]);

    await snapshot(repo, dir, "hardening");
    expect(readdirSync(snapshotsDir(dir))).toHaveLength(2);
  });

  it("snapshots again when HEAD returns to an earlier head, but not on a same-head rerun", async () => {
    const { repo, dir } = setup();
    const first = repo.head();
    await snapshot(repo, dir, "implementation");
    await snapshot(repo, dir, "hardening");
    expect(firstLine((await snapshot(repo, dir, "implementation")).out)).toMatch(/^exists /);

    repo.write("lib/extra.py", "x = 1\n");
    repo.commit("Extra");
    await snapshot(repo, dir, "hardening");
    repo.git("reset", "-q", "--hard", first);
    const back = await snapshot(repo, dir, "hardening");
    expect(firstLine(back.out)).toMatch(/^created /);
    expect((await snapshots(dir)).map((s) => [s.phase, s.head === first])).toEqual([
      ["implementation", true],
      ["hardening", true],
      ["hardening", false],
      ["hardening", true],
    ]);
  });

  it("names an unreadable snapshot file instead of failing opaquely", async () => {
    const { repo, dir } = setup();
    await snapshot(repo, dir, "implementation");
    writeFileSync(`${snapshotsDir(dir)}/20261026T999999Z-hardening-truncated.json`, '{"schemaVersion": 1, "ki');
    const r = await cli("list", "--dir", dir);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unreadable snapshot .*truncated\.json/);
  });

  it("never creates or modifies review-state.json", async () => {
    const { repo, dir } = setup();
    await snapshot(repo, dir, "implementation");
    expect((await cli("status", "--dir", dir)).code).toBe(0);
    expect((await cli("list", "--dir", dir)).code).toBe(0);
    expect(existsSync(reviewStatePath(dir))).toBe(false);

    const [s] = await snapshots(dir);
    await reviewEverything(dir, s);
    const before = readFileSync(reviewStatePath(dir), "utf8");
    repo.edit("lib/mod.py", "x_40 = 4000\n", "x_40 = 4001\n");
    repo.commit("Change two values", "--amend");
    await snapshot(repo, dir, "hardening");
    expect((await cli("status", "--dir", dir)).code).toBe(0);
    expect((await cli("status", "--dir", dir, "--json")).code).toBe(0);
    expect(readFileSync(reviewStatePath(dir), "utf8")).toBe(before);
  });

  it("summarizes the change since the previous snapshot, as text and stable JSON", async () => {
    const { repo, dir } = setup();
    await snapshot(repo, dir, "implementation");
    repo.edit("lib/mod.py", "x_40 = 4000\n", "x_40 = 4001\n");
    repo.commit("Change two values", "--amend");
    repo.write("lib/extra.py", "x = 1\n");
    repo.commit("Add extra");

    const r = await cli("snapshot", "--worktree", repo.dir, "--dir", dir, "--phase", "hardening", "--base", "main", "--json");
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

    const text = (await snapshot(repo, dir, "hardening")).out.split("\n");
    expect(text[0]).toBe(`exists ${json.path}`);
    expect(text.slice(2)).toEqual([
      `  since ${(await snapshots(dir))[0].id}:`,
      "    commits: 0 same, 0 rebased, 1 changed, 1 new, 0 dropped",
      "    hunks:   1 carried, 1 changed, 1 new, 0 dropped",
      expect.stringMatching(/^    changed [0-9a-f]{12} Change two values \(1 differing hunk\)$/),
      expect.stringMatching(/^    new     [0-9a-f]{12} Add extra$/),
    ]);
  });

  it("produces identical diffs and patch-ids regardless of the user's diff config", async () => {
    const { repo, dir } = setup();
    repo.write("lib/blank.py", "a = 1\n\nb = 2\n\nc = 3\n");
    repo.commit("Blank lines");
    repo.edit("lib/blank.py", "b = 2\n", "b = 20\n");
    repo.commit("Edit between blank lines");
    await snapshot(repo, dir, "implementation");
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
    expect((await cli("snapshot", "--worktree", `${repo.dir}/lib`, "--dir", dir, "--phase", "hardening", "--base", "main")).code).toBe(0);

    const [clean, configured] = await snapshots(dir);
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
    const dir = repo.reviewDir;
    await snapshot(repo, dir, "implementation");
    repo.write("img.bin", "\x00\x09\x03");
    repo.commit("Binary edit", "--amend");
    await snapshot(repo, dir, "hardening");

    const [a, b] = await snapshots(dir);
    expect(a.commits[0].patchId).toMatch(/^[0-9a-f]{40}$/);
    expect(b.commits[0].patchId).not.toBe(a.commits[0].patchId);
    expect(b.mapping!.commits[0]).toMatchObject({ patchIdChanged: true });
  });

  it("rejects unknown phases", async () => {
    const { repo, dir } = setup();
    const r = await cli("snapshot", "--worktree", repo.dir, "--dir", dir, "--phase", "rebase");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--phase must be one of implementation, hardening, polishing, revision, review,/);
    expect(existsSync(snapshotsDir(dir))).toBe(false);
  });

  it("snapshots again on a same-head rerun against a different base", async () => {
    const { repo, dir } = setup();
    const older = repo.git("rev-parse", "main").trim();
    repo.git("checkout", "-q", "main");
    repo.write("lib/upstream.py", "u = 1\n");
    repo.commit("Upstream");
    repo.git("checkout", "-q", "feature");
    repo.git("merge", "-q", "--no-edit", "main");
    await snapshot(repo, dir, "implementation", "--base", older);
    const rerun = await snapshot(repo, dir, "implementation", "--base", "main");
    expect(firstLine(rerun.out)).toMatch(/^created /);
    expect((await snapshots(dir)).map((s) => s.files.length)).toEqual([2, 1]);
  });


  it("defaults the branch to the worktree's and the review dir to the git common dir", async () => {
    const { repo } = setup();
    const r = await cliIn(`${repo.dir}/lib`, ["snapshot", "--phase", "implementation", "--base", "main"]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(firstLine(r.out)).toMatch(new RegExp(`^created ${repo.git("rev-parse", "--path-format=absolute", "--git-common-dir").trim()}/differential-review/feature/snapshots/`));
    expect((await cliIn(repo.dir, ["list"])).out).toMatch(/-implementation-[0-9a-f]{12}  1 commit, 1 file, 2 hunks vs main$/);

    const other = await cliIn(repo.dir, ["snapshot", "--phase", "hardening", "--base", "main", "--branch", "other"]);
    expect(other.code).toBe(0);
    expect(other.err).toBe("warning: worktree is on feature, branch is other");
    expect(firstLine(other.out)).toMatch(/\/differential-review\/other\/snapshots\//);
  });

  it("needs --branch on a detached HEAD unless --dir and --branch are given", async () => {
    const { repo, dir } = setup();
    repo.git("checkout", "-q", "--detach");
    const r = await cliIn(repo.dir, ["snapshot", "--phase", "implementation", "--base", "main"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^usage error: HEAD is detached in .*; pass --branch <name>/);
    const ok = await cli("snapshot", "--worktree", repo.dir, "--dir", dir, "--branch", "feature", "--phase", "implementation", "--base", "main");
    expect(ok.code).toBe(0);
    expect(ok.err).toMatch(/^warning: HEAD is detached at [0-9a-f]{12}; snapshotting it for branch feature$/);
  });

  it("defaults the base to the branch origin/HEAD points at", async () => {
    const { repo, dir } = setup();
    const unset = await cli("snapshot", "--worktree", repo.dir, "--dir", dir, "--phase", "implementation");
    expect(unset.code).toBe(1);
    expect(unset.err).toMatch(/no --base and origin\/HEAD is not set; pass --base <ref> or run `git remote set-head origin --auto`/);
    expect(existsSync(snapshotsDir(dir))).toBe(false);

    repo.git("remote", "add", "origin", repo.dir);
    repo.git("fetch", "-q", "origin");
    repo.git("remote", "set-head", "origin", "main");
    expect((await cli("snapshot", "--worktree", repo.dir, "--dir", dir, "--phase", "implementation")).code).toBe(0);
    expect((await snapshots(dir))[0].base).toMatchObject({ name: "main", source: "remote-head", ref: "origin/main" });
  });

  it("snapshots another head without the branch check or touching the worktree", async () => {
    const { repo, dir } = setup();
    const prHead = repo.head();
    repo.git("checkout", "-q", "-b", "pr_42_review_0");
    repo.write("lib/fix.py", "fix = 1\n");
    const reviewHead = repo.commit("Review fix");

    const r = await cliIn(repo.dir, ["snapshot", "--dir", dir, "--branch", "pr-42", "--phase", "review", "--base", "main", "--head", "feature"]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    const [s] = await snapshots(dir);
    expect(s).toMatchObject({ head: prHead, phase: "review", branch: "pr-42" });
    expect(s.files.map((f) => f.path)).toEqual(["lib/mod.py"]);
    expect(repo.head()).toBe(reviewHead);
    expect(repo.git("symbolic-ref", "--short", "HEAD").trim()).toBe("pr_42_review_0");

    const missing = await cliIn(repo.dir, ["snapshot", "--dir", dir, "--branch", "pr-42", "--phase", "review", "--base", "main", "--head", "nope"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/^error: --head nope is not a commit in .*; fetch it first/);
  });

  it("explains a worktree that is not a git repo, and an unresolvable base", async () => {
    const { repo, dir } = setup();
    const notGit = await cli("snapshot", "--worktree", repo.root, "--phase", "implementation", "--base", "main");
    expect(notGit.code).toBe(1);
    expect(notGit.err).toMatch(/is not inside a git worktree; pass --worktree/);

    const badBase = await cli("snapshot", "--worktree", repo.dir, "--dir", dir, "--phase", "implementation", "--base", "nope");
    expect(badBase.code).toBe(1);
    expect(badBase.err).toMatch(/could not resolve base nope .*tried refs\/heads\/nope, nope\. Fetch it/);
  });

  it("treats bad flags and commands as usage errors with per-command help", async () => {
    const { dir } = setup();
    for (const argv of [["status", "--dir", dir, "--bogus"], ["list", "--dir", dir, "--phase", "x"], ["frobnicate"], ["list", "extra"]]) {
      const r = await cli(...argv);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/^usage error: /);
    }
    const help = await cli("snapshot", "--help");
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/^usage: differential-review snapshot \[--dir <dir>\] \[--branch <name>\] \[--worktree <dir>\] --phase/);
    expect(help.out).toContain("--dir <dir>       review dir (default: <git common dir>/differential-review/<branch>)");
    expect(help.out).toContain("--head <rev>");
    const top = await cli("--help");
    expect(top.code).toBe(0);
    expect(top.out).toMatch(/snapshot .*\n.*list .*\n.*status /);
    expect((await cli()).code).toBe(2);
  });

  it("orders base candidates remote-first, or local-first when asked", () => {
    expect(baseCandidates({ name: "dev", source: "option" }, ["jmchilton", "origin"])).toEqual(["origin/dev", "jmchilton/dev", "refs/heads/dev", "dev"]);
    expect(baseCandidates({ name: "dev", source: "parent", localFirst: true }, ["jmchilton", "origin"], "jmchilton")).toEqual([
      "refs/heads/dev",
      "jmchilton/dev",
      "origin/dev",
    ]);
  });
});

describe("differential review across iterations", () => {
  it("keeps hunk check-offs and commit sign-off through a rebase that only shifts line numbers", async () => {
    const { repo, dir } = setup();
    await snapshot(repo, dir, "implementation");
    await reviewEverything(dir, (await snapshots(dir))[0]);

    repo.git("checkout", "-q", "main");
    repo.write("lib/mod.py", "# header\n# more\n" + repo.read("lib/mod.py"));
    repo.commit("Upstream adds a header");
    repo.git("checkout", "-q", "feature");
    repo.git("rebase", "-q", "main");
    await snapshot(repo, dir, "hardening");

    const [s1, s2] = await snapshots(dir);
    expect(s2.files[0].hunks.map((h) => h.newStart)).not.toEqual(s1.files[0].hunks.map((h) => h.newStart));
    expect(s2.commits[0].sha).not.toBe(s1.commits[0].sha);
    expect(s2.mapping!.commits[0]).toMatchObject({ method: "patch-id", patchIdChanged: false });
    const r = await review(dir);
    expect(r.files[0].hunks.map((h) => h.state)).toEqual(["reviewed", "reviewed"]);
    expect(r.commits.map((c) => c.state)).toEqual(["reviewed"]);
  });

  it("keeps hunk check-offs when a rebase changes context, but flags the commit with no differing hunks", async () => {
    const { repo, dir } = setup();
    await snapshot(repo, dir, "implementation");
    await reviewEverything(dir, (await snapshots(dir))[0]);

    repo.git("checkout", "-q", "main");
    repo.edit("lib/mod.py", "x_38 = 38\n", "x_38 = 38  # upstream tweak\n");
    repo.commit("Upstream touches nearby context");
    repo.git("checkout", "-q", "feature");
    repo.git("rebase", "-q", "main");
    await snapshot(repo, dir, "hardening");

    const r = await review(dir);
    expect(r.files[0].hunks.map((h) => h.state)).toEqual(["reviewed", "reviewed"]);
    expect(r.commits[0]).toMatchObject({ state: "changed", differingHunks: [] });
  });

  it("shows only the amended hunk as changed and flags the commit with just that hunk", async () => {
    const { repo, dir } = setup();
    await snapshot(repo, dir, "implementation");
    await reviewEverything(dir, (await snapshots(dir))[0]);

    repo.edit("lib/mod.py", "x_40 = 4000\n", "x_40 = 4001\n");
    repo.commit("Change two values", "--amend");
    await snapshot(repo, dir, "hardening");

    const [, s2] = await snapshots(dir);
    expect(s2.mapping!.commits[0]).toMatchObject({ method: "range-diff", patchIdChanged: true });
    expect(s2.mapping!.hunks.map((h) => h.match)).toEqual(["exact", "fuzzy"]);
    const r = await review(dir);
    expect(r.files[0].hunks.map((h) => h.state)).toEqual(["reviewed", "changed"]);
    expect(r.files[0].state).toBe("changed");
    expect(r.commits[0].state).toBe("changed");
    expect(r.commits[0].differingHunks).toEqual([s2.commits[0].files[0].hunks[1].id]);
  });

  it("treats an indentation-only amend as a commit change", async () => {
    const { repo, dir } = setup();
    await snapshot(repo, dir, "implementation");
    await reviewEverything(dir, (await snapshots(dir))[0]);

    repo.edit("lib/mod.py", "x_40 = 4000\n", "    x_40 = 4000\n");
    repo.commit("Change two values", "--amend");
    await snapshot(repo, dir, "hardening");

    const r = await review(dir);
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
    const dir = repo.reviewDir;
    await snapshot(repo, dir, "implementation");

    const [s] = await snapshots(dir);
    const [a, b] = s.files.map((f) => f.hunks[0]);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.id).not.toBe(b.id);
    const state = markFileReviewed(emptyReviewState(), s, "a.py", "2026-10-26T00:00:00Z");
    await reviewStateStore(pluginAdapter, dir).writeReviewState(state);
    const r = await review(dir);
    expect(r.files.map((f) => [f.path, f.state])).toEqual([["a.py", "reviewed"], ["b.py", "new"]]);
  });

  it("reports what hardening added since implementation via status", async () => {
    const { repo, dir } = setup();
    await snapshot(repo, dir, "implementation");
    await reviewEverything(dir, (await snapshots(dir))[0]);
    repo.write("lib/extra.py", "def extra():\n    return 1\n");
    repo.commit("Add extra");
    await snapshot(repo, dir, "hardening");

    const r = await cli("status", "--dir", dir);
    const [, s2] = await snapshots(dir);
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
    const { repo, dir } = setup();
    await snapshot(repo, dir, "implementation");
    await reviewEverything(dir, (await snapshots(dir))[0]);
    repo.git("mv", "lib/mod.py", "lib/renamed.py");
    repo.commit("Rename module");
    await snapshot(repo, dir, "hardening");

    const r = await review(dir);
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
