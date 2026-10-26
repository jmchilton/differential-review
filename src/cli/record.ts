// Branch record metadata (index.md frontmatter) and diff-base resolution.
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BaseSource } from "../core";
import { remotes, revParse } from "./git";

export interface RecordInfo {
  repo: string | null;
  branch: string;
  upstreamBaseBranch: string | null;
  parentBranch: string | null;
}

export function readFrontmatter(markdown: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!m) return {};
  const data = parseYaml(m[1]);
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

/** Repo and branch come from `repositories/<repo>/branches/<status>/<branch>`; the branch from the dir name. */
export function readRecord(recordDir: string): RecordInfo {
  const abs = resolve(recordDir);
  const parts = abs.split(sep);
  const i = parts.lastIndexOf("repositories");
  const repo = i >= 0 && parts[i + 2] === "branches" && parts.length === i + 5 ? parts[i + 1] : null;
  const indexPath = join(abs, "index.md");
  const fm = existsSync(indexPath) ? readFrontmatter(readFileSync(indexPath, "utf8")) : {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    repo,
    branch: basename(abs),
    upstreamBaseBranch: str(fm.upstream_base_branch),
    parentBranch: str(fm.parent_branch),
  };
}

export interface BaseChoice {
  name: string;
  source: BaseSource;
}

/** `parent_branch` first, else `upstream_base_branch`; `--base` overrides both. */
export function chooseBase(record: RecordInfo, override: string | undefined): BaseChoice {
  if (override) return { name: override, source: "override" };
  if (record.parentBranch) return { name: record.parentBranch, source: "parent_branch" };
  if (record.upstreamBaseBranch) return { name: record.upstreamBaseBranch, source: "upstream_base_branch" };
  throw new Error(
    `record ${record.branch} has no parent_branch or upstream_base_branch frontmatter in index.md; pass --base <ref>`,
  );
}

/** Candidate refs for a base name, most trusted first. Records store names without a remote. */
export function baseCandidates(choice: BaseChoice, remoteNames: string[], preferredRemote?: string): string[] {
  const ordered = [...new Set([preferredRemote, "origin", "upstream", ...remoteNames].filter((r): r is string => !!r && remoteNames.includes(r)))];
  const remote = ordered.map((r) => `${r}/${choice.name}`);
  const local = `refs/heads/${choice.name}`;
  switch (choice.source) {
    case "parent_branch":
      // Parent branches are local factory branches; the local ref is canonical.
      return [local, ...remote];
    case "upstream_base_branch":
    case "override":
      // Upstream bases move; a remote-tracking ref is fresher than a stale local copy.
      // An override that is already a remote ref or SHA falls through to itself.
      return [...remote, choice.source === "override" ? choice.name : local];
  }
}

export function resolveBaseRef(worktree: string, choice: BaseChoice, preferredRemote?: string): { ref: string; sha: string } {
  const candidates = baseCandidates(choice, remotes(worktree), preferredRemote);
  for (const ref of candidates) {
    const sha = revParse(worktree, ref);
    if (sha) return { ref: ref.replace(/^refs\/heads\//, ""), sha };
  }
  throw new Error(`could not resolve base ${choice.name} (${choice.source}); tried ${candidates.join(", ")}`);
}
