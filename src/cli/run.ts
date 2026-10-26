// differential-review CLI commands: `snapshot` (after each phase), `list` and `status` (read-only).
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  PHASES,
  deriveReview,
  emptyReviewState,
  isPhase,
  readAllSnapshots,
  readReviewState,
  snapshotReader,
  summarizeSnapshot,
} from "../core/index.js";
import { chooseBase, type BaseChoice } from "./base.js";
import { formatList, formatSnapshotResult, formatStatus, hunkCount } from "./format.js";
import { currentBranch, gitCommonDir, worktreeRoot } from "./git.js";
import { nodeReadAdapter } from "./node-storage.js";
import { createSnapshot, type SnapshotOptions } from "./snapshot.js";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  now?: Date;
  cwd?: string;
}

export type Options = NonNullable<ParseArgsConfig["options"]>;
export type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

/** Where a command's review dir is and what `snapshot` records about the branch. */
export interface Target {
  dir: string;
  branch: string;
  repo?: string | null;
  /** Resolves the diff base; `option` is the --base value. Only `snapshot` calls it. */
  base(option: string | undefined, worktree: string, remote: string | undefined): BaseChoice;
  branchCheck: NonNullable<SnapshotOptions["branchCheck"]>;
  branchLabel?: string;
}

/** The flags that pick a target, so an integration can swap `--dir` for its own (e.g. `--record`). */
export interface TargetFlags {
  options: Options;
  /** Usage fragment, e.g. `[--dir <dir>] [--branch <name>]`. */
  usage: string;
  /** Help lines for `options`. */
  help: string;
  /** Help for `snapshot --worktree` and `--base`. */
  worktreeHelp: string;
  baseHelp: string;
  resolve(values: Values, worktree: string, worktreeDefaulted: boolean): Target;
}

export class UsageError extends Error {}

export function str(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === "string" ? v : undefined;
}

export function required(values: Values, name: string): string {
  const v = str(values, name);
  if (!v) throw new UsageError(`--${name} is required`);
  return v;
}

/** `--dir`, else `<git common dir>/differential-review/<branch>`, with `--branch` defaulting to the worktree's. */
export const DIR_TARGET: TargetFlags = {
  options: { dir: { type: "string" }, branch: { type: "string" }, worktree: { type: "string" } },
  usage: "[--dir <dir>] [--branch <name>] [--worktree <dir>]",
  help: `  --dir <dir>       review dir (default: <git common dir>/differential-review/<branch>)
  --branch <name>   branch the review is for (default: the worktree's current branch)`,
  worktreeHelp: "the branch's worktree (default: current dir)",
  baseHelp: "diff base (default: the branch origin/HEAD points at, or --remote's)",
  resolve(values, worktree) {
    let branch = str(values, "branch");
    const dir = str(values, "dir");
    if (!branch) {
      branch = currentBranch(worktreeRoot(worktree)) ?? undefined;
      if (!branch) throw new UsageError(`HEAD is detached in ${worktree}; pass --branch <name>`);
    }
    return {
      dir: dir ? resolve(dir) : join(gitCommonDir(worktreeRoot(worktree)), "differential-review", branch),
      branch,
      base: (option, wt, remote) => chooseBase(wt, option, remote),
      branchCheck: "warn",
    };
  },
};

interface Command {
  summary: string;
  usage: string;
  help: string;
  options: Options;
  run(values: Values, io: Io, target: Target): Promise<void>;
}

const JSON_FLAG = "  --json            machine-readable output";

function commands(flags: TargetFlags): Record<string, Command> {
  const common = { ...flags.options, json: { type: "boolean" } } as Options;
  return {
    snapshot: {
      summary: "snapshot the branch after a phase",
      usage: `snapshot ${flags.usage} --phase <${PHASES.join("|")}> [--head <rev>] [--base <ref>] [--remote <name>] [--json]`,
      help: `Writes an immutable snapshot of the worktree's committed HEAD to <dir>/snapshots/ and summarizes
what changed since the previous snapshot. A rerun on the same head and phase is a no-op ("exists").
Never writes review-state.json, never fetches.

${flags.help}
  --phase <phase>   ${PHASES.join(", ")}
  --worktree <dir>  ${flags.worktreeHelp}
  --head <rev>      commit to snapshot instead of HEAD, e.g. FETCH_HEAD after fetching a PR
  --base <ref>      ${flags.baseHelp}
  --remote <name>   remote to try first when resolving the base
${JSON_FLAG}: {status, id, path, summary, warnings}`,
      options: { worktree: { type: "string" }, ...common, phase: { type: "string" }, head: { type: "string" }, base: { type: "string" }, remote: { type: "string" } },
      async run(values, io, target) {
        const phase = required(values, "phase");
        if (!isPhase(phase)) throw new UsageError(`--phase must be one of ${PHASES.join(", ")}, got ${phase}`);
        const worktree = str(values, "worktree") ?? io.cwd ?? process.cwd();
        const remote = str(values, "remote");
        const result = await createSnapshot({
          worktree,
          dir: target.dir,
          phase,
          branch: target.branch,
          repo: target.repo,
          base: (root) => target.base(str(values, "base"), root, remote),
          remote,
          head: str(values, "head"),
          branchCheck: target.branchCheck,
          branchLabel: target.branchLabel,
          now: io.now,
        });
        const summary = summarizeSnapshot(result.snapshot);
        for (const w of result.warnings) io.err(`warning: ${w}`);
        if (values.json) {
          const { status, path, warnings } = result;
          io.out(JSON.stringify({ status, id: result.snapshot.id, path, summary, warnings }));
        } else {
          for (const line of formatSnapshotResult(result, summary)) io.out(line);
        }
      },
    },
    list: {
      summary: "list a branch's snapshots, oldest first",
      usage: `list ${flags.usage} [--json]`,
      help: `${flags.help}\n${JSON_FLAG}`,
      options: common,
      async run(values, io, target) {
        const snapshots = await readAllSnapshots(snapshotReader(nodeReadAdapter, target.dir));
        if (!values.json) {
          for (const line of formatList(snapshots)) io.out(line);
          return;
        }
        const rows = snapshots.map((s) => ({
          id: s.id,
          phase: s.phase,
          head: s.head,
          base: s.base.ref,
          commits: s.commits.length,
          files: s.files.length,
          hunks: hunkCount(s),
        }));
        io.out(JSON.stringify(rows));
      },
    },
    status: {
      summary: "reviewed / changed / new counts against review-state.json (read-only)",
      usage: `status ${flags.usage} [--snapshot <id>] [--json]`,
      help: `Derives each hunk, file and commit's state from review-state.json (written by a review UI) and lists
what still needs review. Read-only.

${flags.help}
  --snapshot <id>   snapshot to report on (default: latest)
${JSON_FLAG}: the full derived review`,
      options: { ...common, snapshot: { type: "string" } },
      async run(values, io, target) {
        const snapshots = await readAllSnapshots(snapshotReader(nodeReadAdapter, target.dir));
        const id = str(values, "snapshot");
        const current = id ? snapshots.find((s) => s.id === id) : snapshots.at(-1);
        if (!current) throw new Error(id ? `no snapshot ${id}; see \`list\`` : "no snapshots yet; run `snapshot` first");
        const state = await readReviewState(nodeReadAdapter, target.dir);
        const review = deriveReview(current, state ?? emptyReviewState(), snapshots);
        if (values.json) io.out(JSON.stringify(review));
        else for (const line of formatStatus(current, review, state !== null)) io.out(line);
      },
    },
  };
}

/** A CLI whose commands find their review dir through `flags`. */
export function createCli(flags: TargetFlags): (argv: string[], io: Io) => Promise<number> {
  const table = commands(flags);
  const usage = `usage: differential-review <command> [options]

${Object.entries(table).map(([name, c]) => `  ${name.padEnd(9)} ${c.summary}`).join("\n")}

Run \`differential-review <command> --help\` for options.
Exit codes: 0 ok, 1 error, 2 usage error.`;
  const commandHelp = (command: Command) => `usage: differential-review ${command.usage}\n\n${command.help}`;

  return async (argv, io) => {
    const [name, ...rest] = argv;
    if (!name || name === "-h" || name === "--help" || name === "help") {
      io.out(usage);
      return name ? 0 : 2;
    }
    const command = table[name];
    if (!command) {
      io.err(`usage error: unknown command ${name}\n${usage}`);
      return 2;
    }
    try {
      let values: Values;
      try {
        const options = { ...command.options, help: { type: "boolean", short: "h" } } as Options;
        ({ values } = parseArgs({ args: rest, options, strict: true, allowPositionals: false }));
      } catch (e) {
        throw new UsageError((e as Error).message);
      }
      if (values.help) {
        io.out(commandHelp(command));
        return 0;
      }
      const worktree = str(values, "worktree");
      const target = flags.resolve(values, worktree ?? io.cwd ?? process.cwd(), worktree === undefined);
      await command.run(values, io, target);
      return 0;
    } catch (e) {
      if (e instanceof UsageError) {
        io.err(`usage error: ${e.message}\n${commandHelp(command)}`);
        return 2;
      }
      io.err(`error: ${(e as Error).message}`);
      return 1;
    }
  };
}

export const run = createCli(DIR_TARGET);
