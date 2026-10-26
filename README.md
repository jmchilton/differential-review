# differential-review

Review a branch once, then only what changed.

Branches keep moving after the first read. Fixups get squashed, commits get amended, the branch is rebased onto a newer base and force-pushed. Most review tools then show a wall of "changed" lines whose content you already read. `differential-review` snapshots a branch after each round of work and matches every hunk and commit against what the reviewer already checked off:

- a rebase that only moves code leaves nothing to re-read;
- an amended commit shows only the hunks that differ from the version you signed off;
- a changed hunk comes with an interdiff against the version you reviewed.

It is local and offline: no server and no GitHub integration. Git runs only in the snapshot CLI; the review logic is a pure TypeScript library with no Node imports, so a browser or mobile UI can use it.

> [!NOTE]
> **Status: 0.x.** The snapshot CLI and the library are used daily by an agent-driven development setup. The only review UI that writes check-offs today is the Obsidian plugin in [galaxy-brain](https://github.com/jmchilton/galaxy-brain), which is built on this package. On its own, this package gives you snapshots, change summaries and `status` reports, and the library to build a UI.

## Install

Requires Node 22 or later and git 2.31 or later.

```sh
npm install -g differential-review   # or: npx differential-review --help
```

## Quick start

From a branch's worktree, after each round of work:

```sh
differential-review snapshot --phase implementation --base main
# ... rebase, amend, add commits ...
differential-review snapshot --phase hardening --base main
```

```
created /repo/.git/differential-review/feature/snapshots/20261026T052513Z-hardening-a9569d8fee3b.json
  hardening @ a9569d8fee3b vs main (merge-base 43c4d0f06a4a)
  since 20261026T052424Z-implementation-c48aa1d4ca6b:
    commits: 0 same, 4 rebased, 1 changed, 0 new, 0 dropped
    hunks:   34 carried, 1 changed, 0 new, 0 dropped
    changed 7629850da068 Summarize workflow upgrade changes in the editor (1 differing hunk)
```

Four commits were rebased with unchanged patches, so their sign-offs hold. One commit changed, and only one of its hunks differs. `differential-review status` lists what still needs review against the reviewer's `review-state.json`.

## CLI

```sh
differential-review snapshot --phase <phase> [--dir <dir>] [--branch <name>] [--worktree <dir>]
                             [--head <rev>] [--base <ref>] [--remote <name>] [--json]
differential-review list     [--dir <dir>] [--branch <name>] [--worktree <dir>] [--json]
differential-review status   [--dir <dir>] [--branch <name>] [--worktree <dir>] [--snapshot <id>] [--json]
differential-review [<command>] --help
```

- **Review dir.** Each branch's review lives in one directory: `snapshots/` and `review-state.json`. It defaults to `<git common dir>/differential-review/<branch>`, which every worktree of the repository shares and which git never commits. Pass `--dir` to keep it somewhere else, such as next to your own notes.
- **Phases.** `implementation`, `hardening`, `polishing`, `revision` (rebases, requested changes, review responses) and `review` (a round of reviewing someone else's PR). The phase is a tag on the snapshot; reviews can narrow to "only what changed since the implementation snapshot".
- **`snapshot`** records the committed HEAD of `--worktree` (default: the current directory) against its merge-base with the base. A rerun on the same head, base and phase is a no-op that prints `exists`. It never fetches and never writes `review-state.json`.
  - `--head <rev>` snapshots another commit without touching the worktree, e.g. `git fetch origin pull/42/head` then `--head FETCH_HEAD --branch pr-42`.
  - Warnings go to stderr: a dirty worktree (only committed HEAD is snapshotted), a worktree on another branch than `--branch`, a detached HEAD, an empty branch.
  - `--json` prints `{status, id, path, summary, warnings}`.
- **`list`** prints one line per snapshot, oldest first.
- **`status`** derives reviewed, changed and new for every hunk, file and commit of the latest snapshot (or `--snapshot <id>`) and lists what is left. `--json` prints the whole derived review.

**Base resolution.** `--base <ref>`, else the branch `<remote>/HEAD` points at (`git remote set-head origin --auto` sets it). A branch name is tried as `origin/<name>`, then `upstream/<name>`, then other remotes, then the local branch, because a local `main` is often stale. `--remote` puts a remote first. A ref that is already a remote ref, tag or SHA is used as is.

**Exit codes.** 0 ok, 1 error (git failure, unresolvable base, unreadable snapshot), 2 usage error. Every error names the fix.

## Review conversations

A review UI can store comments on old or new source-line ranges with the original snapshot and quoted code. Threads survive closing the UI. An agent reads them and appends replies without changing reviewer check-offs or resolving requests:

```sh
differential-review threads --open --json
differential-review reply --thread THREAD_ID --body-file response.md \
  --snapshot SNAPSHOT_ID --author "Agent"
```

`threads` includes the original comment, source excerpt, replies and placement against the latest snapshot. `--snapshot <id>` selects an earlier target and `--open` selects unresolved threads. Without snapshots, it still returns the saved conversations with unmapped placements. `reply` accepts exactly one of `--body <text>` or `--body-file <path>`. Its optional `--snapshot` must name an existing snapshot. Both commands accept the usual target flags and `--json`.

The review dir also holds `annotations/threads/<id>.json` and `annotations/replies/<id>.json`. Keep these files with your review notes when using `--dir`. A reviewer UI creates and resolves threads. Each reply is a separate immutable file, so an agent response does not overwrite a simultaneous reviewer action.

The [galaxy-brain Obsidian view](https://github.com/jmchilton/galaxy-brain) provides line selection, inline conversations, replies and resolve/reopen controls. The core exports `captureReviewOrigin`, `createReviewThread`, `deriveThreads`, `setThreadResolved` and `annotationStore` for other UIs. `buildReviewView` accepts `annotations` and keeps hunks with open threads visible under its reviewed and baseline filters.

## Library

```ts
// Pure core: parsing, fingerprints, matching, review state, view model. No Node imports.
import { deriveReview, emptyReviewState, markFileReviewed, readAllSnapshots, reviewStateStore, snapshotReader, updateReviewState } from "differential-review";
// Node: snapshotting, and the CLI.
import { createCli, createSnapshot } from "differential-review/node";
```

A UI supplies a `TextFileAdapter` (`exists`, `read`, `write`, `listFiles`) over whatever storage it has, then:

```ts
const snapshots = await readAllSnapshots(snapshotReader(adapter, reviewDir));
const store = reviewStateStore(adapter, reviewDir);
const review = deriveReview(snapshots.at(-1)!, (await store.readReviewState()) ?? emptyReviewState(), snapshots);
// The reviewer ticks a file: re-read, apply the pure mutation, write.
await updateReviewState(store, (s) => markFileReviewed(s, snapshots.at(-1)!, "src/app.ts", new Date().toISOString()));
```

`buildReviewView` turns a derived review into what to render (states, visibility, baselines such as "since the implementation snapshot", interdiffs). `summarizeSnapshot`, `changesBetween` and `changesSincePhase` answer "what changed since X" without any review state.

**Your own storage layout.** `createCli(flags)` builds the same CLI with your own flags for finding the review dir and base. For example, [galaxy-brain](https://github.com/jmchilton/galaxy-brain) replaces `--dir` with `--record <dir>` and reads the base branch from the record's frontmatter. See `TargetFlags` in [`src/cli/run.ts`](src/cli/run.ts).

## How it works

- **Hunk fingerprints** hash a hunk's changed lines, not its line numbers or context, so a hunk that moved still matches. Matching is one-to-one: exact, then the same content moved within the same file, then fuzzy (character-level similarity of at least 0.6, reported as `changed`). Everything else is `new`.
- **Commits** are matched by SHA, then `git patch-id`, then `git range-diff`, then subject. Commit sign-offs are keyed by patch-id, so a clean rebase keeps them. A changed commit lists only the hunks that differ from the signed-off version.
- **Files** are reviewed when all their hunks are. Binary files, renames and mode changes get a synthetic "meta" unit, so they can't pass vacuously.
- **Deterministic diffs.** Every git call pins its diff options, so fingerprints and patch-ids don't depend on anyone's `diff.*` config.
- **When unsure, show more.** Nothing ambiguous is ever silently treated as reviewed.

[docs/design.md](docs/design.md) has the full algorithm, storage guarantees, JSON schemas and known limitations.

## Development

```sh
npm ci
npm test            # vitest: core unit tests and CLI tests on real temp git repos
npm run typecheck   # whole package, plus src/core with no Node types
npm run build       # dist/ via tsc
```

## License

[MIT](LICENSE)
