// Persistent conversations, independent of reviewer check-offs and renderer coordinates.
import type { ParsedHunk } from "./diff.js";
import { hunkRefs, matchHunks } from "./match.js";
import { snapshotFiles } from "./snapshot.js";
import type { Snapshot } from "./types.js";

export type ReviewSide = "old" | "new";
export type LineRange = [number, number];
export interface ReviewOrigin {
  snapshotId: string;
  path: string;
  basePath: string | null;
  hunkId: string;
  side: ReviewSide;
  range: LineRange;
  quote: string;
  contextBefore: string[];
  contextAfter: string[];
}
export interface ReviewThread {
  schemaVersion: 1;
  kind: "differential-review-thread";
  id: string;
  origin: ReviewOrigin;
  body: string;
  author: string;
  createdAt: string;
  status: "open" | "resolved";
  resolvedAt: string | null;
}
export interface ReviewReply {
  schemaVersion: 1;
  kind: "differential-review-reply";
  id: string;
  threadId: string;
  body: string;
  author: string;
  source: "human" | "agent";
  createdAt: string;
  /** The revision this response refers to, when supplied. */
  snapshotId?: string;
}
export interface ReviewAnnotations { threads: ReviewThread[]; replies: ReviewReply[] }
export interface ThreadPlacement {
  state: "active" | "moved" | "outdated" | "unmapped";
  path: string | null;
  hunkId: string | null;
  /** Only present when the quoted lines were located unambiguously. */
  range: LineRange | null;
}
export interface ReviewThreadView { thread: ReviewThread; replies: ReviewReply[]; placement: ThreadPlacement }
export interface ReviewLineTarget { path: string; hunkId: string; side: ReviewSide; range: LineRange }

export function sourceLines(hunk: ParsedHunk, side: ReviewSide): { line: number; text: string }[] {
  let line = side === "old" ? hunk.oldStart : hunk.newStart;
  const out: { line: number; text: string }[] = [];
  for (const text of hunk.lines) {
    if (text[0] === " " || text[0] === (side === "old" ? "-" : "+")) out.push({ line: line++, text: text.slice(1) });
  }
  return out;
}

function validRange(range: unknown): range is LineRange {
  return Array.isArray(range) && range.length === 2 && range.every((n) => Number.isSafeInteger(n) && n > 0) && range[0] <= range[1];
}
export function annotationId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error("invalid annotation id");
  return id;
}
function nonempty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`annotation ${field} must be non-empty text`);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid annotation object");
  return value as Record<string, unknown>;
}
function parseOrigin(value: unknown): ReviewOrigin {
  const o = object(value);
  for (const key of ["snapshotId", "path", "hunkId"]) nonempty(o[key], key);
  if (o.basePath !== null && typeof o.basePath !== "string") throw new Error("invalid annotation basePath");
  if (o.side !== "old" && o.side !== "new") throw new Error("invalid annotation side");
  if (!validRange(o.range)) throw new Error("invalid annotation range");
  if (typeof o.quote !== "string" || o.quote.split("\n").length !== o.range[1] - o.range[0] + 1) throw new Error("invalid annotation quote");
  for (const key of ["contextBefore", "contextAfter"]) {
    if (!Array.isArray(o[key]) || !(o[key] as unknown[]).every((v) => typeof v === "string")) throw new Error(`invalid annotation ${key}`);
  }
  return o as unknown as ReviewOrigin;
}
export function parseReviewThread(value: unknown): ReviewThread {
  const t = object(value);
  if (t.kind !== "differential-review-thread") throw new Error("not a differential-review thread");
  if (t.schemaVersion !== 1) throw new Error(`unsupported thread schemaVersion ${t.schemaVersion}`);
  nonempty(t.id, "id"); annotationId(t.id);
  for (const key of ["body", "author", "createdAt"]) nonempty(t[key], key);
  parseOrigin(t.origin);
  if (t.status !== "open" && t.status !== "resolved") throw new Error("invalid thread status");
  if (t.resolvedAt !== null && typeof t.resolvedAt !== "string") throw new Error("invalid resolvedAt");
  return t as unknown as ReviewThread;
}
export function parseReviewReply(value: unknown): ReviewReply {
  const r = object(value);
  if (r.kind !== "differential-review-reply") throw new Error("not a differential-review reply");
  if (r.schemaVersion !== 1) throw new Error(`unsupported reply schemaVersion ${r.schemaVersion}`);
  for (const key of ["id", "threadId", "body", "author", "createdAt"]) nonempty(r[key], key);
  annotationId(r.id as string); annotationId(r.threadId as string);
  if (r.source !== "human" && r.source !== "agent") throw new Error("invalid reply source");
  if (r.snapshotId !== undefined) nonempty(r.snapshotId, "snapshotId");
  return r as unknown as ReviewReply;
}

export function captureReviewOrigin(snapshot: Snapshot, target: ReviewLineTarget): ReviewOrigin {
  if (!validRange(target.range)) throw new Error("invalid annotation range");
  const file = snapshotFiles(snapshot).find((f) => f.path === target.path);
  const hunk = file?.hunks.find((h) => h.id === target.hunkId && h.kind === "text");
  if (!file || !hunk) throw new Error("annotation target is not a text hunk in this snapshot");
  const lines = sourceLines(hunk, target.side);
  const start = lines.findIndex((l) => l.line === target.range[0]);
  const end = lines.findIndex((l) => l.line === target.range[1]);
  if (start < 0 || end < start) throw new Error("annotation range must be within one diff hunk");
  return {
    snapshotId: snapshot.id, path: file.path, basePath: file.basePath, hunkId: hunk.id,
    side: target.side, range: [...target.range], quote: lines.slice(start, end + 1).map((l) => l.text).join("\n"),
    contextBefore: lines.slice(Math.max(0, start - 3), start).map((l) => l.text),
    contextAfter: lines.slice(end + 1, end + 4).map((l) => l.text),
  };
}
export function createReviewThread(input: Pick<ReviewThread, "id" | "origin" | "body" | "author" | "createdAt">): ReviewThread {
  return parseReviewThread({ ...input, schemaVersion: 1, kind: "differential-review-thread", status: "open", resolvedAt: null });
}
export function setThreadResolved(thread: ReviewThread, resolved: boolean, now: string): ReviewThread {
  return { ...thread, status: resolved ? "resolved" : "open", resolvedAt: resolved ? now : null };
}

/** Quoted source, rather than hunk similarity alone, establishes a line placement. */
export function locateThread(thread: ReviewThread, current: Snapshot, snapshots: Snapshot[]): ThreadPlacement {
  const o = thread.origin;
  const file = snapshotFiles(current).find((f) => f.path === o.path || (o.basePath !== null && f.basePath === o.basePath));
  if (!file) return { state: "unmapped", path: null, hunkId: null, range: null };
  const quoted = o.quote.split("\n");
  const previous = snapshots.find((s) => s.id === o.snapshotId);
  if (current.id === o.snapshotId || (previous && previous.diff === current.diff)) {
    const hunk = file.hunks.find((h) => h.id === o.hunkId);
    const selected = hunk && sourceLines(hunk, o.side).filter((l) => l.line >= o.range[0] && l.line <= o.range[1]);
    if (selected && selected.length === quoted.length && selected.every((l, i) => l.text === quoted[i])) {
      return { state: current.id === o.snapshotId ? "active" : "moved", path: file.path, hunkId: o.hunkId, range: [...o.range] };
    }
  }
  const matches: { hunkId: string; range: LineRange; context: boolean }[] = [];
  for (const h of file.hunks.filter((h) => h.kind === "text")) {
    const lines = sourceLines(h, o.side);
    for (let i = 0; i + quoted.length <= lines.length; i++) {
      if (!quoted.every((text, j) => lines[i + j].text === text)) continue;
      const before = lines.slice(Math.max(0, i - o.contextBefore.length), i).map((l) => l.text);
      const after = lines.slice(i + quoted.length, i + quoted.length + o.contextAfter.length).map((l) => l.text);
      matches.push({ hunkId: h.id, range: [lines[i].line, lines[i + quoted.length - 1].line], context: JSON.stringify(before) === JSON.stringify(o.contextBefore) && JSON.stringify(after) === JSON.stringify(o.contextAfter) });
    }
  }
  const contextual = matches.filter((m) => m.context);
  const certain = matches.length === 1 ? matches[0] : contextual.length === 1 ? contextual[0] : null;
  if (certain) return {
    state: current.id === o.snapshotId ? "active" : "moved", path: file.path, hunkId: certain.hunkId, range: certain.range,
  };
  // Similarity may suggest a hunk to inspect, but never a replacement line or a resolution.
  const oldFile = previous && snapshotFiles(previous).find((f) => f.path === o.path);
  const pair = oldFile && matchHunks(hunkRefs([oldFile]), hunkRefs([file])).pairs.find((p) => p.oldId === o.hunkId);
  return { state: "outdated", path: file.path, hunkId: pair?.newId ?? null, range: null };
}
export function deriveThreads(annotations: ReviewAnnotations, current: Snapshot, snapshots: Snapshot[]): ReviewThreadView[] {
  return annotations.threads.map((thread) => ({
    thread,
    replies: annotations.replies.filter((r) => r.threadId === thread.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    placement: locateThread(thread, current, snapshots),
  })).sort((a, b) => a.thread.createdAt.localeCompare(b.thread.createdAt) || a.thread.id.localeCompare(b.thread.id));
}
