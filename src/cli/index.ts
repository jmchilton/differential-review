// Node API (`differential-review/node`): snapshotting and a CLI that integrations can re-target.
export { baseCandidates, chooseBase, resolveBaseRef, type BaseChoice } from "./base.js";
export { nodeReadAdapter, writeSnapshot, writeAgentReply } from "./node-storage.js";
export { DIR_TARGET, UsageError, createCli, required, run, str, type Io, type Options, type Target, type TargetFlags, type Values } from "./run.js";
export { createSnapshot, type SnapshotOptions, type SnapshotResult } from "./snapshot.js";
