// Git plumbing for snapshots. Diff options are pinned so fingerprints don't depend on user config.
import { execFileSync } from "node:child_process";
import type { CommitInput, CommitPair } from "../core";

// -U3 / myers / indent heuristic are git's defaults, pinned against diff.* config.
const DIFF_FLAGS = [
  "--no-ext-diff",
  "--no-color",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "-M",
  "--full-index",
  "-U3",
  "--inter-hunk-context=0",
  "--diff-algorithm=myers",
  "--indent-heuristic",
  "--ignore-submodules=none",
];
const CONFIG = ["-c", "core.quotePath=false", "-c", "color.ui=never"];
const FIELD = "\x1f";
const RECORD = "\x1e";

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", [...CONFIG, ...args], {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function revParse(cwd: string, rev: string): string | null {
  return tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])?.trim() || null;
}

export function commitExists(cwd: string, sha: string): boolean {
  return tryGit(cwd, ["cat-file", "-e", `${sha}^{commit}`]) !== null;
}

export function remotes(cwd: string): string[] {
  return git(cwd, ["remote"]).split("\n").filter(Boolean);
}

export function currentBranch(cwd: string): string | null {
  return tryGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim() || null;
}

export function isDirty(cwd: string): boolean {
  return git(cwd, ["status", "--porcelain", "--untracked-files=no"]).trim() !== "";
}

export function mergeBase(cwd: string, a: string, b: string): string {
  return git(cwd, ["merge-base", a, b]).trim();
}

export function diff(cwd: string, from: string, to: string): string {
  return git(cwd, ["diff", ...DIFF_FLAGS, from, to]);
}

/** `--verbatim` keeps whitespace, so indentation-only changes (Python) change the patch-id. */
export function patchId(cwd: string, diffText: string): string | null {
  if (!diffText.trim()) return null;
  return git(cwd, ["patch-id", "--verbatim"], diffText).split(/\s+/)[0] || null;
}

function emptyTree(cwd: string): string {
  return git(cwd, ["hash-object", "-t", "tree", "/dev/null"]).trim();
}

/** Commits in base..head, oldest first, with diffs against their first parent. */
export function branchCommits(cwd: string, base: string, head: string): CommitInput[] {
  const shas = git(cwd, ["rev-list", "--reverse", "--topo-order", `${base}..${head}`]).split("\n").filter(Boolean);
  return shas.map((sha) => {
    const format = ["%H", "%P", "%an <%ae>", "%aI", "%s", "%B"].join(FIELD) + RECORD;
    const [, parents, author, authorDate, subject, body] = git(cwd, ["show", "-s", `--format=${format}`, sha])
      .split(RECORD)[0]
      .split(FIELD);
    const parentList = parents.split(" ").filter(Boolean);
    const commitDiff = diff(cwd, parentList[0] ?? emptyTree(cwd), sha);
    return {
      sha,
      parents: parentList,
      patchId: parentList.length > 1 ? null : patchId(cwd, commitDiff),
      subject,
      message: body.replace(/\n+$/, ""),
      author,
      authorDate,
      diff: commitDiff,
    };
  });
}

const RANGE_DIFF_LINE = /^\s*(?:\d+|-):\s+([0-9a-f]{40}|-+)\s+([=!<>])\s+(?:\d+|-):\s+([0-9a-f]{40}|-+)\s/;

/** Pairs (`=` and `!`) from `git range-diff --abbrev=40` output. */
export function parseRangeDiff(output: string): CommitPair[] {
  const pairs: CommitPair[] = [];
  for (const line of output.split("\n")) {
    const m = RANGE_DIFF_LINE.exec(line);
    if (m && (m[2] === "=" || m[2] === "!")) pairs.push({ previousSha: m[1], sha: m[3] });
  }
  return pairs;
}

export function rangeDiff(cwd: string, oldRange: string, newRange: string): CommitPair[] {
  return parseRangeDiff(git(cwd, ["range-diff", "--no-color", "--abbrev=40", "--no-patch", oldRange, newRange]));
}
