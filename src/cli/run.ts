// differential-review CLI commands: `snapshot` (agents, post-phase), `list` and `status` (read-only).
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  PHASES,
  deriveReview,
  emptyReviewState,
  isPhase,
  readAllSnapshots,
  readReviewState,
  recordSnapshotReader,
  summarizeSnapshot,
} from "../core";
import { formatList, formatSnapshotResult, formatStatus, hunkCount } from "./format";
import { nodeReadAdapter } from "./node-storage";
import { readRecord } from "./record";
import { createSnapshot } from "./snapshot";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  now?: Date;
  cwd?: string;
}

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

interface Command {
  summary: string;
  usage: string;
  help: string;
  options: Options;
  run(values: Values, io: Io): Promise<void>;
}

class UsageError extends Error {}

const RECORD_OPTION = { record: { type: "string" }, json: { type: "boolean" } } as const;
const RECORD_FLAG = "  --record <dir>    branch record dir: vault/repositories/<repo>/branches/<status>/<branch>";
const JSON_FLAG = "  --json            machine-readable output";

function str(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === "string" ? v : undefined;
}

function required(values: Values, name: string): string {
  const v = str(values, name);
  if (!v) throw new UsageError(`--${name} is required`);
  return v;
}

async function loadSnapshots(values: Values) {
  const record = resolve(required(values, "record"));
  readRecord(record);
  return { record, snapshots: await readAllSnapshots(recordSnapshotReader(nodeReadAdapter, record)) };
}

const COMMANDS: Record<string, Command> = {
  snapshot: {
    summary: "snapshot the branch after a phase (agents run this)",
    usage: `snapshot --record <dir> --phase <${PHASES.join("|")}> [--worktree <dir>] [--base <ref>] [--remote <name>] [--json]`,
    help: `Writes an immutable snapshot of the worktree's committed HEAD to <record>/differential-review/snapshots/
and summarizes what changed since the previous snapshot. A rerun on the same head and phase is a no-op
("exists"). Never writes review-state.json, never fetches.

${RECORD_FLAG}
  --phase <phase>   ${PHASES.join(", ")}
  --worktree <dir>  the branch's worktree (default: current dir)
  --base <ref>      diff base, overriding the record's parent_branch / upstream_base_branch
  --remote <name>   remote to try first when resolving the base
${JSON_FLAG}: {status, id, path, summary, warnings}`,
    options: { ...RECORD_OPTION, phase: { type: "string" }, worktree: { type: "string" }, base: { type: "string" }, remote: { type: "string" } },
    async run(values, io) {
      const phase = required(values, "phase");
      if (!isPhase(phase)) throw new UsageError(`--phase must be one of ${PHASES.join(", ")}, got ${phase}`);
      const result = await createSnapshot({
        worktree: str(values, "worktree") ?? io.cwd ?? process.cwd(),
        record: required(values, "record"),
        phase,
        base: str(values, "base"),
        remote: str(values, "remote"),
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
    summary: "list a record's snapshots, oldest first",
    usage: "list --record <dir> [--json]",
    help: `${RECORD_FLAG}\n${JSON_FLAG}`,
    options: RECORD_OPTION,
    async run(values, io) {
      const { snapshots } = await loadSnapshots(values);
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
    usage: "status --record <dir> [--snapshot <id>] [--json]",
    help: `Derives each hunk, file and commit's state from review-state.json (written by the plugins) and lists
what still needs review. Read-only.

${RECORD_FLAG}
  --snapshot <id>   snapshot to report on (default: latest)
${JSON_FLAG}: the full derived review`,
    options: { ...RECORD_OPTION, snapshot: { type: "string" } },
    async run(values, io) {
      const { record, snapshots } = await loadSnapshots(values);
      const id = str(values, "snapshot");
      const current = id ? snapshots.find((s) => s.id === id) : snapshots.at(-1);
      if (!current) throw new Error(id ? `no snapshot ${id}; see \`list\`` : "no snapshots yet; run `snapshot` first");
      const state = await readReviewState(nodeReadAdapter, record);
      const review = deriveReview(current, state ?? emptyReviewState(), snapshots);
      if (values.json) io.out(JSON.stringify(review));
      else for (const line of formatStatus(current, review, state !== null)) io.out(line);
    },
  },
};

const USAGE = `usage: differential-review <command> [options]

${Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(9)} ${c.summary}`).join("\n")}

Run \`differential-review <command> --help\` for options.
Exit codes: 0 ok, 1 error, 2 usage error.`;

function commandHelp(name: string, command: Command): string {
  return `usage: differential-review ${command.usage}\n\n${command.help}`;
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "-h" || name === "--help" || name === "help") {
    io.out(USAGE);
    return name ? 0 : 2;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.err(`usage error: unknown command ${name}\n${USAGE}`);
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
      io.out(commandHelp(name, command));
      return 0;
    }
    await command.run(values, io);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`usage error: ${e.message}\n${commandHelp(name, command)}`);
      return 2;
    }
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}
