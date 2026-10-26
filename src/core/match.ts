// Cross-snapshot hunk matching: exact fingerprint, then moved (same content), then fuzzy within a file.
import { diffArrays, diffChars } from "diff";
import type { ParsedFile } from "./diff";
import type { HunkKind, HunkMatch, HunkMatchKind } from "./types";

/** Minimum similarity for a fuzzy match to count as "changed" rather than unrelated. */
export const FUZZY_THRESHOLD = 0.6;
// Above this many characters, similarity is computed on lines instead of characters.
const CHAR_DIFF_LIMIT = 20000;
const MAX_EDIT_LENGTH = 2000;

export interface HunkRef {
  id: string;
  contentHash: string;
  kind: HunkKind;
  path: string;
  /** Base-side path; null for added files. */
  basePath: string | null;
  /** Normalized changed lines; null when unknown (only exact matching possible). */
  changed: string[] | null;
}

export interface HunkPair {
  oldId: string;
  newId: string;
  match: Exclude<HunkMatchKind, "new">;
  similarity: number;
}

export interface MatchResult {
  pairs: HunkPair[];
  /** New ids without a counterpart. */
  added: string[];
  /** Old ids without a counterpart. */
  removed: string[];
}

export function hunkRefs(files: ParsedFile[]): HunkRef[] {
  return files.flatMap((f) =>
    f.hunks.map((h) => ({
      id: h.id,
      contentHash: h.contentHash,
      kind: h.kind,
      path: f.path,
      basePath: f.basePath,
      changed: h.changed,
    })),
  );
}

export function sameFile(a: Pick<HunkRef, "path" | "basePath">, b: Pick<HunkRef, "path" | "basePath">): boolean {
  return a.path === b.path || (a.basePath !== null && a.basePath === b.basePath);
}

function dice(common: number, a: number, b: number): number {
  return a + b === 0 ? 1 : (2 * common) / (a + b);
}

function lineSimilarity(a: string[], b: string[]): number {
  const parts = diffArrays(a, b, { maxEditLength: MAX_EDIT_LENGTH });
  if (!parts) return 0;
  const common = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.count, 0);
  return dice(common, a.length, b.length);
}

/** Dice similarity of changed text: characters for normal hunks, lines for huge ones. */
export function similarity(a: string[], b: string[]): number {
  const ta = a.join("\n");
  const tb = b.join("\n");
  if (ta === tb) return 1;
  if (ta.length + tb.length > CHAR_DIFF_LIMIT) return lineSimilarity(a, b);
  const parts = diffChars(ta, tb, { maxEditLength: MAX_EDIT_LENGTH });
  if (!parts) return lineSimilarity(a, b);
  const common = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.length, 0);
  return dice(common, ta.length, tb.length);
}

/** One-to-one matching of old hunks to new hunks. */
export function matchHunks(oldRefs: HunkRef[], newRefs: HunkRef[], threshold = FUZZY_THRESHOLD): MatchResult {
  const pairs: HunkPair[] = [];
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();
  const take = (i: number, j: number, match: HunkPair["match"], sim: number) => {
    usedOld.add(i);
    usedNew.add(j);
    pairs.push({ oldId: oldRefs[i].id, newId: newRefs[j].id, match, similarity: sim });
  };

  const oldById = new Map<string, number>();
  oldRefs.forEach((r, i) => oldById.set(r.id, i));
  newRefs.forEach((r, j) => {
    const i = oldById.get(r.id);
    if (i !== undefined && !usedOld.has(i)) take(i, j, "exact", 1);
  });

  newRefs.forEach((r, j) => {
    if (usedNew.has(j)) return;
    const i = oldRefs.findIndex((o, k) => !usedOld.has(k) && o.contentHash === r.contentHash && sameFile(o, r));
    if (i >= 0) take(i, j, "moved", 1);
  });

  const candidates: { i: number; j: number; sim: number }[] = [];
  newRefs.forEach((r, j) => {
    if (usedNew.has(j)) return;
    oldRefs.forEach((o, i) => {
      if (usedOld.has(i) || o.kind !== r.kind || !sameFile(o, r) || !o.changed || !r.changed) return;
      const sim = similarity(o.changed, r.changed);
      // A file has at most one meta unit, so two of the same file always pair.
      if (sim >= threshold || r.kind === "meta") candidates.push({ i, j, sim });
    });
  });
  candidates.sort((a, b) => b.sim - a.sim || a.j - b.j || a.i - b.i);
  for (const c of candidates) {
    if (!usedOld.has(c.i) && !usedNew.has(c.j)) take(c.i, c.j, "fuzzy", c.sim);
  }

  return {
    pairs,
    added: newRefs.filter((_, j) => !usedNew.has(j)).map((r) => r.id),
    removed: oldRefs.filter((_, i) => !usedOld.has(i)).map((r) => r.id),
  };
}

/** Per-new-hunk view of a match result, in new-hunk order. */
export function toHunkMatches(newRefs: HunkRef[], result: MatchResult): HunkMatch[] {
  const byNew = new Map(result.pairs.map((p) => [p.newId, p]));
  return newRefs.map((r) => {
    const p = byNew.get(r.id);
    return p
      ? { id: r.id, previousId: p.oldId, match: p.match, similarity: round(p.similarity) }
      : { id: r.id, previousId: null, match: "new", similarity: 0 };
  });
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
