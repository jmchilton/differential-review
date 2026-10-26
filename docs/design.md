# Design

How snapshots are built, how check-offs are matched to later versions of a branch, and what is stored. The TypeScript types in [`src/core/types.ts`](../src/core/types.ts) are the source of truth for the JSON formats.

## Model

- **Granularity.** A reviewer checks off hunks, files or commits.
  - Hunk check-offs are the base layer. A file counts as reviewed when all its hunks are.
  - Commit sign-off is a separate, holistic record keyed by `git patch-id`. If the patch-id is unchanged after a rebase, the sign-off holds. If it changes, the commit is flagged with only its differing hunks.
- **States.** Every hunk, file and commit is `reviewed`, `new`, or `changed` (changed since it was reviewed).
- **Two writers, never the same file.** The snapshot CLI writes immutable snapshots. A review UI writes `review-state.json`. The CLI's file adapter has no `write` method, so it can't build a review-state store. Its separate reply writer only appends agent responses.

## Layout

```
src/core/      pure: no fs, child_process, path or process (runs in browsers and mobile apps)
  types.ts         JSON schemas as types, PHASES, schema and fingerprint versions
  diff.ts          git diff parsing (jsdiff parsePatch) and fingerprints
  match.ts         exact / moved / fuzzy hunk matching
  snapshot.ts      buildSnapshot, mapping to the previous snapshot, commitKey, snapshotId
  queries.ts       commit lineage, latestSnapshot, changesBetween, changesSincePhase, summarizeSnapshot
  review-state.ts  review-state model and immutable mutations
  derive.ts        reviewed / new / changed at hunk, file and commit level
  storage.ts       review dir layout, TextFileAdapter, SnapshotReader, ReviewStateStore, updateReviewState
  annotations.ts   source anchors, threads, replies and placement across snapshots
  annotation-storage.ts reviewer thread store and independent reply files
  view.ts          UI view model: buildReviewView (states, baseline, visibility), interdiffPatch
  sha256.ts        synchronous SHA-256 (no node:crypto, no async WebCrypto)
src/cli/       Node only
  git.ts           git invocations with pinned diff flags; range-diff parser
  base.ts          base selection and ref resolution
  snapshot.ts      createSnapshot
  node-storage.ts  read-only fs adapter, atomic no-clobber writeSnapshot
  format.ts        human output for snapshot / list / status
  run.ts           command table, createCli and the default --dir target
```

`tsconfig.core.json` typechecks `src/core` with `types: []`, so a Node import there is a compile error.

## Fingerprints (`h1`)

For each hunk:

1. **Changed lines.** Take the `+` and `-` lines, plus the `\ No newline at end of file` marker when it follows a change. Context lines and line numbers are dropped.
2. **Normalize.** Strip trailing whitespace, including `\r`. Keep leading indentation, which matters in Python, and keep the `+`/`-` marker.
3. `contentHash = "h1:" + sha256(changedLines.join("\n"))[0:16]`
4. `id = "h1:" + sha256(path + "\0" + contentHash + "\0" + occurrence)[0:16]`
   - `path` is the new path, or the old path for deletions.
   - `occurrence` counts earlier hunks in the same file with the same `contentHash`, so `+import os` in two files, or `+pass` twice in one file, get distinct IDs.
5. **Meta units.** A file change that no `@@` hunk covers gets one synthetic `kind: "meta"` unit: binary files (old and new blob IDs), renames and copies, mode changes, and empty added or deleted files. Without it, "file reviewed = all hunks reviewed" would pass these files vacuously.
6. `whitespaceOnly` is a flag, set when removed and added text are equal once all whitespace is removed. It doesn't change identity.

The `h1:` prefix is versioned because review state keeps fingerprints forever; a new algorithm gets a new prefix. Snapshots store the diff text once plus a fingerprint index. Readers re-parse the text and `verifyFingerprints` throws if the re-parsed IDs differ from the stored ones, so a parser change that drifts without a new fingerprint version fails loudly instead of silently turning check-offs `new`.

## Matching (`matchHunks`, one-to-one)

1. **exact**: same `id` (same path, content and occurrence).
2. **moved**: same `contentHash` within the same file identity. This covers a shifted occurrence index, or a rename where the path equals the new path or the base-side paths are equal.
3. **fuzzy**: same file identity and kind, with similarity ≥ 0.6 (`FUZZY_THRESHOLD`), paired greedily from the highest score.
   - Similarity is the Dice coefficient over the joined changed text, `2·common / (lenA + lenB)`, from jsdiff `diffChars` (`maxEditLength` 2000). Above 20,000 characters, or if the diff aborts, it falls back to line-level `diffArrays`.
   - Characters rather than lines, because a one-line amend (`-a +b` to `-a +c`) scores exactly 0.5 at line level.
   - Two meta units of the same file always pair as fuzzy, e.g. a binary file whose blob changed.
4. Everything else is `new` (added) or dropped (removed). There is never fuzzy matching across unrelated files.

Similarity is memoized per content-hash pair. On a synthetic 1.2 MB, 2,400-hunk snapshot with 900 changed hunks, deriving a view took about 1.7 s cold and about 85 ms per check-off after that.

## Deriving review state (`deriveReview(current, state, snapshots)`)

- **Hunk.** Run `matchHunks(checked-off hunks, current hunks)`. Each check-off is loaded from the snapshot it was made in, so check-offs from any earlier snapshot count, not only the previous one.
  - `exact` or `moved` means `reviewed`; `fuzzy` means `changed`; unmatched means `new`.
  - `reviewedAs` names the check-off (its `hunkId` is the record key, for unmarking) and its snapshot, for interdiffs.
  - If a check-off's snapshot is missing, only an exact ID match is possible.
- **File.** `reviewed` if all hunks are reviewed, `new` if all are new, otherwise `changed`.
- **Commit.** If its `commitKey` is signed off, the commit is `reviewed`. Otherwise follow its lineage back through each snapshot's `mapping.commits`. If an earlier version was signed off, the commit is `changed`, with `differingHunks`: its hunks that don't exact- or moved-match the signed-off version. Otherwise it is `new`.
  - A rebase that only changes context keeps hunk check-offs but changes the patch-id. The commit is flagged with `differingHunks: []`: a holistic re-look with nothing new to read.

## Snapshot mapping

Written by the CLI, relative to the previous snapshot in the same review dir.

- **Commits** pair in this order: identical SHA, equal patch-id, then `git range-diff --no-patch --abbrev=40` pairs (`=` and `!`). If range-diff can't run, e.g. the old commits were garbage-collected after a force-push, commits fall back to an exact subject match.
- **Patch-ids** use `git patch-id --verbatim`, so an indentation-only amend changes the patch-id. Merge and empty commits have a null patch-id and pair by SHA.
- **Hunks** use the same `matchHunks` as derivation.

`summarizeSnapshot(snapshot)` counts what the stored mapping says changed and lists changed and new commits; the CLI's `snapshot` output is built from it. `changesBetween(snapshots, from, to)` and `changesSincePhase(snapshots, phase)` compare any two snapshots, e.g. "what did hardening change since the latest implementation snapshot".

## Git invocation

Diffs use git's defaults, pinned against `diff.*` config:

```
--no-ext-diff --no-color --no-textconv --no-relative --src-prefix=a/ --dst-prefix=b/ -M -l1000 -O/dev/null
--full-index -U3 --inter-hunk-context=0 --diff-algorithm=myers --indent-heuristic
--ignore-submodules=none --submodule=short
```

Every call also gets `--no-optional-locks -c core.quotePath=false -c color.ui=never -c diff.suppressBlankEmpty=false -c log.showSignature=false`.

- Patch-ids hash the diff text, context included. `diff.suppressBlankEmpty=true` alone would change every commit's patch-id, and the sign-offs with it. A test sets a dozen hostile repo-local options and asserts byte-identical diffs and patch-ids.
- `--full-index` gives binary and mode-only changes real blob IDs to fingerprint.
- `--no-optional-locks` keeps `git status` from rewriting the worktree's index.
- The CLI diffs against `merge-base(base, head)`, lists commits with `rev-list base..head`, and never fetches.

## Storage

```
<review dir>/
  snapshots/<YYYYMMDDTHHMMSSZ>-<phase>-<head12>.json   immutable, written by the CLI
  review-state.json                                     written by a review UI
```

- Snapshot IDs are file stems. They sort by time and contain no colons, which some sync tools and file systems reject.
- **Immutability.** A snapshot is written to a hidden temp file and hard-linked into place. An existing file raises `EEXIST` and is never overwritten, and a crash can't leave truncated JSON behind. An unreadable snapshot is named in the error.
- **Idempotency.** A rerun is a no-op (`exists`) when a snapshot with the same head, merge-base and phase exists and HEAD hasn't moved since. A rerun with a corrected base writes a new snapshot. The same head with a new phase writes a new snapshot, so the phase is recorded. If HEAD returns to an earlier SHA after other snapshots, it is snapshotted again, so the latest snapshot always reflects HEAD.
- The previous snapshot is the latest one in the dir. If the clock runs behind it, `createdAt` is bumped by a second to keep the order.
- Paths are joined with `/`, never `node:path`, so adapters can use vault-relative or URL-like paths.

```ts
interface TextFileAdapter {
  exists(path): Promise<boolean>;
  read(path): Promise<string>;
  write(path, data): Promise<void>;    // creates missing parent dirs
  listFiles(dir): Promise<string[]>;   // file names directly in dir; [] if missing
}
snapshotReader(adapter, reviewDir): SnapshotReader
reviewStateStore(adapter, reviewDir): ReviewStateStore
readReviewState(adapter, reviewDir)            // read-only
updateReviewState(store, mutate)               // re-read, mutate, write
readAllSnapshots(reader): Promise<Snapshot[]>  // oldest first
```

`updateReviewState` re-reads the file before every write, so another writer's check-offs on other keys survive. There is no compare-and-swap; two writes within the same few milliseconds can still lose one.

## Formats

Both files carry `schemaVersion` (currently 1) and `kind`. Readers reject unknown kinds and versions (`parseSnapshot`, `parseReviewState`).

### Snapshot (abbreviated)

```json
{
  "schemaVersion": 1,
  "kind": "differential-review-snapshot",
  "fingerprintVersion": "h1",
  "id": "20261026T050148Z-hardening-3bf56e17e9b5",
  "createdAt": "2026-10-26T05:01:48.257Z",
  "phase": "hardening",
  "repo": null,
  "branch": "ag_grid_36",
  "head": "3bf56e17e9b57054b2a8d5e1299f64d683f5b449",
  "base": { "name": "dev", "source": "option", "ref": "origin/dev", "sha": "c93175dc…", "mergeBase": "0073b5e9…" },
  "previousSnapshotId": "20261026T050147Z-implementation-3bf56e17e9b5",
  "diff": "diff --git a/client/package.json b/client/package.json\nindex …",
  "files": [{
    "path": "client/package.json", "oldPath": "client/package.json", "newPath": "client/package.json",
    "status": "modified", "binary": false, "oldMode": null, "newMode": null,
    "hunks": [{
      "id": "h1:1ad0ccd0f9a194f0", "contentHash": "h1:5d35bd54c984359a", "occurrence": 0,
      "kind": "text", "header": "@@ -87,8 +87,8 @@",
      "oldStart": 87, "oldLines": 8, "newStart": 87, "newLines": 8,
      "added": 2, "removed": 2, "whitespaceOnly": false
    }]
  }],
  "commits": [{
    "sha": "0dc06dc4…", "parents": ["0073b5e9…"],
    "patchId": "77de0a3ca8aa85d4b3ae6b4f143b7ee7b9083255",
    "subject": "Tidy ag-grid usage ahead of 36 upgrade",
    "message": "…", "author": "…", "authorDate": "2026-10-22T18:13:45-04:00",
    "diff": "…per-commit diff against the first parent…",
    "files": ["…same shape as files[]…"]
  }],
  "mapping": {
    "previousSnapshotId": "20261026T050147Z-implementation-3bf56e17e9b5",
    "previousHead": "3bf56e17…",
    "rangeDiff": true,
    "commits": [{ "sha": "0dc06dc4…", "previousSha": "0dc06dc4…", "method": "sha", "patchIdChanged": false }],
    "droppedCommits": [],
    "hunks": [{ "id": "h1:1ad0ccd0f9a194f0", "previousId": "h1:1ad0ccd0f9a194f0", "match": "exact", "similarity": 1 }],
    "droppedHunks": []
  }
}
```

- `files[].hunks` fingerprint the cumulative diff (`mergeBase..head`); `commits[].files` hold per-commit fingerprints, used to show only the differing hunks of a flagged commit.
- `base.source` says how the base was chosen: `option` (`--base`), `remote-head`, or an integration's own value.
- `mapping` is null for the first snapshot. `mapping.commits[].method` is `sha`, `patch-id`, `range-diff`, `subject` or null (new). `mapping.hunks[].match` is `exact`, `moved`, `fuzzy` or `new`.
- Sizes seen in practice: about 65 KB for 3 commits and 2 files, about 150 KB for 5 commits and 22 files. Per-commit diffs usually outweigh the cumulative one.

### Review state

```json
{
  "schemaVersion": 1,
  "kind": "differential-review-state",
  "updatedAt": "2026-10-26T06:00:00Z",
  "hunks": {
    "h1:1ad0ccd0f9a194f0": { "snapshotId": "20261026T050147Z-implementation-3bf56e17e9b5",
                             "path": "client/package.json", "reviewedAt": "2026-10-26T06:00:00Z" }
  },
  "commits": {
    "77de0a3ca8aa85d4b3ae6b4f143b7ee7b9083255": {
      "sha": "0dc06dc4…", "subject": "Tidy ag-grid usage ahead of 36 upgrade",
      "snapshotId": "20261026T050147Z-implementation-3bf56e17e9b5",
      "signedOffAt": "2026-10-26T06:05:00Z", "note": "optional"
    }
  }
}
```

- `hunks` is keyed by fingerprints from the cumulative branch diff. A file check-off (`markFileReviewed`) writes one record per hunk; files have no record of their own.
- `commits` is keyed by `commitKey()`: the patch-id, or `sha:<sha>` for merges and empty commits.
- Mutations are pure and return new objects: `markHunksReviewed`, `unmarkHunks`, `markFileReviewed`, `signOffCommit`, `revokeCommitSignoff`.

## Decisions

- **Hunk check-offs live on the cumulative branch diff.** Per-commit fingerprints exist only for commit re-looks.
- **64-bit truncated SHA-256** fingerprints, computed synchronously in pure TypeScript so the core stays synchronous and Node-free.
- **No auto-fetch.** The base is whatever the worktree already has.
- **Dirty worktrees warn, not fail.** The snapshot covers committed HEAD.
- **Merged-in branches' commits are included.** They have null patch-ids and pair by SHA.

## Known limitations

- **Hunks that merge or split.** Git merges two changes 7 or fewer lines apart into one hunk, e.g. when upstream deletes the lines between them or new code lands next to a reviewed hunk. The merged hunk has a new content hash, and the small old hunk can score below 0.6 against it, so identical changed lines can come back `changed` or `new`. This fails safe. A fix would fingerprint contiguous change runs within hunks, as `h2`.
- **Non-UTF-8 content** is decoded lossily (U+FFFD). Fingerprints and patch-ids stay deterministic, but the stored diff text isn't byte-exact.
- **Phases are a fixed list.** Adding one isn't a schema change, but free-form phases aren't supported yet.

## Persistent conversations

Comments use source coordinates, independent of rendered rows. A thread records `origin` (`snapshotId`, path and base path, hunk ID, old/new side, inclusive range, quoted text and up to three context lines on each side), its author, body, creation time and open/resolved status. The original anchor never changes. Replies carry a thread ID, author, human/agent source, body, creation time and optional response snapshot ID. Both records have their own kind and schema version 1. Their types and validators live in `annotations.ts`.

A reviewer UI writes `annotations/threads/<id>.json` and may append human replies. The CLI only appends `annotations/replies/<id>.json` through a dedicated agent writer, using an atomic no-clobber link like snapshots. Each response has its own ID and file. Resolution changes never rewrite replies or check-offs. IDs are validated before use as path components. The vault adapter creates missing directory parents before writing.

`deriveThreads` locates each original quote on its declared side within the current file's diff hunks. A unique quote establishes a placement. If several matches exist, exactly one must also match the saved surrounding context. A renamed file can match through its base-side path. A same-snapshot selection is validated at its original coordinates, including repeated text. Similar hunk matches only suggest where to inspect changed code, never a replacement line or a resolved request.

Placement is derived separately from resolution: `active` in the original snapshot, `moved` when located in a later one, `outdated` when the file remains but the quote cannot be located confidently, and `unmapped` when the file is absent. Saved excerpts remain available without their source snapshots. The first UI supports ranges within a single cumulative-diff hunk. Expanding complete files and commenting on per-commit diffs remain separate work.

`buildReviewView` carries thread views alongside review states. An open thread with a candidate hunk keeps that hunk visible even when reviewed or carried from the selected baseline. An unplaced thread stays accessible separately. These visibility rules never change check-off counts.
