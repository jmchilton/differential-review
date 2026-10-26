// differential-review CLI commands: `snapshot` (agents, post-phase), `list` and `status` (read-only).
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  PHASES,
  deriveReview,
  emptyReviewState,
  isPhase,
  readAllSnapshots,
  recordReviewStateStore,
  recordSnapshotReader,
} from "../core";
import { nodeAdapter } from "./node-storage";
import { createSnapshot } from "./snapshot";

const USAGE = `usage:
  differential-review snapshot --worktree <dir> --record <dir> --phase <${PHASES.join("|")}> [--base <ref>] [--remote <name>] [--json]
  differential-review list --record <dir> [--json]
  differential-review status --record <dir> [--snapshot <id>] [--json]`;

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  now?: Date;
}

const OPTIONS = {
  worktree: { type: "string" },
  record: { type: "string" },
  phase: { type: "string" },
  base: { type: "string" },
  remote: { type: "string" },
  snapshot: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

class UsageError extends Error {}

function required(value: string | undefined, name: string): string {
  if (!value) throw new UsageError(`--${name} is required`);
  return value;
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    const [command] = positionals;
    if (values.help || !command) {
      io.out(USAGE);
      return command || values.help ? 0 : 2;
    }
    const record = resolve(required(values.record, "record"));

    if (command === "snapshot") {
      const phase = required(values.phase, "phase");
      if (!isPhase(phase)) throw new UsageError(`--phase must be one of ${PHASES.join(", ")}`);
      const result = await createSnapshot({
        worktree: required(values.worktree, "worktree"),
        record,
        phase,
        base: values.base,
        remote: values.remote,
        now: io.now,
      });
      for (const w of result.warnings) io.err(`warning: ${w}`);
      if (values.json) io.out(JSON.stringify({ status: result.status, id: result.snapshot.id, path: result.path }));
      else io.out(`${result.status} ${result.path}`);
      return 0;
    }

    const snapshots = await readAllSnapshots(recordSnapshotReader(nodeAdapter, record));
    if (command === "list") {
      const rows = snapshots.map((s) => ({
        id: s.id,
        phase: s.phase,
        head: s.head,
        base: s.base.ref,
        commits: s.commits.length,
        files: s.files.length,
        hunks: s.files.reduce((n, f) => n + f.hunks.length, 0),
      }));
      if (values.json) io.out(JSON.stringify(rows));
      else for (const r of rows) io.out(`${r.id}  ${r.commits} commits, ${r.files} files, ${r.hunks} hunks vs ${r.base}`);
      return 0;
    }

    if (command === "status") {
      const current = values.snapshot ? snapshots.find((s) => s.id === values.snapshot) : snapshots.at(-1);
      if (!current) throw new UsageError(values.snapshot ? `no snapshot ${values.snapshot}` : "no snapshots yet");
      const state = (await recordReviewStateStore(nodeAdapter, record).readReviewState()) ?? emptyReviewState();
      const review = deriveReview(current, state, snapshots);
      if (values.json) io.out(JSON.stringify(review));
      else {
        io.out(`${current.id}`);
        for (const level of ["hunks", "files", "commits"] as const) {
          const c = review.counts[level];
          io.out(`  ${level}: ${c.reviewed} reviewed, ${c.changed} changed, ${c.new} new`);
        }
      }
      return 0;
    }

    throw new UsageError(`unknown command ${command}`);
  } catch (e) {
    io.err(`${e instanceof UsageError ? "usage error" : "error"}: ${(e as Error).message}`);
    if (e instanceof UsageError) io.err(USAGE);
    return e instanceof UsageError ? 2 : 1;
  }
}
