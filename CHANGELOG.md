# Changelog

## Unreleased

- Persistent source-range comments, thread placement across revisions, and independent human and agent replies.
- `threads` and `reply` CLI commands. Agents append responses without changing reviewer check-offs or thread resolution.

## 0.1.0 (unreleased)

First standalone release, extracted from [galaxy-brain](https://github.com/jmchilton/galaxy-brain).

- `snapshot`, `list` and `status` commands, with a review dir defaulting to `<git common dir>/differential-review/<branch>` and a base defaulting to `<remote>/HEAD`.
- Pure core library (`differential-review`) and Node API (`differential-review/node`), including `createCli` for integrations with their own storage layout.
