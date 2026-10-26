// Diff-base selection: which ref a branch is measured against.
import type { BaseSource } from "../core/index.js";
import { remoteHead, remotes, revParse } from "./git.js";

export interface BaseChoice {
  /** Branch name without a remote, or whatever ref the user passed. */
  name: string;
  source: BaseSource;
  /** Try the local branch before remote-tracking refs, e.g. for a stacked branch's local parent. */
  localFirst?: boolean;
}

/** Candidate refs for a base name, most trusted first. */
export function baseCandidates(choice: BaseChoice, remoteNames: string[], preferredRemote?: string): string[] {
  const ordered = [...new Set([preferredRemote, "origin", "upstream", ...remoteNames].filter((r): r is string => !!r && remoteNames.includes(r)))];
  const remote = ordered.map((r) => `${r}/${choice.name}`);
  const local = `refs/heads/${choice.name}`;
  // Upstream bases move, so a remote-tracking ref is fresher than a stale local copy.
  // A name that is already a remote ref, tag or SHA falls through to itself.
  return [...new Set(choice.localFirst ? [local, ...remote] : [...remote, local, choice.name])];
}

export function resolveBaseRef(worktree: string, choice: BaseChoice, preferredRemote?: string): { ref: string; sha: string } {
  const candidates = baseCandidates(choice, remotes(worktree), preferredRemote);
  for (const ref of candidates) {
    const sha = revParse(worktree, ref);
    if (sha) return { ref: ref.replace(/^refs\/heads\//, ""), sha };
  }
  throw new Error(
    `could not resolve base ${choice.name} (${choice.source}); tried ${candidates.join(", ")}. ` +
      `Fetch it (the CLI never fetches) or pass --base <ref>`,
  );
}

/** `--base <ref>` when given, else the branch `<remote>/HEAD` points at (`git remote set-head <remote> --auto`). */
export function chooseBase(worktree: string, option: string | undefined, remote = "origin"): BaseChoice {
  if (option) return { name: option, source: "option" };
  const head = remoteHead(worktree, remote);
  if (!head) throw new Error(`no --base and ${remote}/HEAD is not set; pass --base <ref> or run \`git remote set-head ${remote} --auto\``);
  return { name: head.slice(remote.length + 1), source: "remote-head" };
}
