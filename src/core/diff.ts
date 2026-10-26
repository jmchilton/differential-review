// Git unified-diff parsing (via jsdiff) and hunk fingerprinting.
import { parsePatch } from "diff";
import { sha256Hex } from "./sha256";
import { FINGERPRINT_VERSION, type FileIndex, type FileStatus, type HunkIndex } from "./types";

export interface ParsedHunk extends HunkIndex {
  /** Raw hunk body lines with their ` `/`+`/`-`/`\` markers. */
  lines: string[];
  /** Normalized changed lines the contentHash is computed from. */
  changed: string[];
}

export interface ParsedFile extends Omit<FileIndex, "hunks"> {
  /** Base-side path, null for added files; used to follow renames across snapshots. */
  basePath: string | null;
  oldBlob: string | null;
  newBlob: string | null;
  /** This file's section of the raw diff, for rendering. */
  text: string;
  hunks: ParsedHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const INDEX_LINE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m;

function hash(text: string): string {
  return `${FINGERPRINT_VERSION}:${sha256Hex(text).slice(0, 16)}`;
}

/** Split a multi-file git diff at `diff --git` lines; a plain unified diff is one section. */
export function splitDiffSections(diffText: string): string[] {
  if (!diffText.trim()) return [];
  const lines = diffText.split("\n");
  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") || sections.length === 0) sections.push([]);
    sections[sections.length - 1].push(line);
  }
  return sections.map((s) => s.join("\n").replace(/\n+$/, "") + "\n");
}

function stripPrefix(name: string | undefined, prefix: string): string | null {
  if (!name || name === "/dev/null") return null;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** Changed lines with trailing whitespace stripped; indentation kept, `\ No newline` kept after changes. */
export function normalizeChangedLines(lines: string[]): string[] {
  const out: string[] = [];
  let afterChange = false;
  for (const line of lines) {
    const marker = line[0];
    if (marker === "+" || marker === "-") {
      out.push(marker + line.slice(1).replace(/\s+$/, ""));
      afterChange = true;
    } else if (marker === "\\") {
      if (afterChange) out.push("\\ No newline at end of file");
    } else {
      afterChange = false;
    }
  }
  return out;
}

export function contentHashOf(changed: string[]): string {
  return hash(changed.join("\n"));
}

export function hunkId(path: string, contentHash: string, occurrence: number): string {
  return hash(`${path}\0${contentHash}\0${occurrence}`);
}

function isWhitespaceOnly(changed: string[]): boolean {
  const squash = (marker: string) =>
    changed
      .filter((l) => l[0] === marker)
      .map((l) => l.slice(1).replace(/\s+/g, ""))
      .join("");
  return squash("-") === squash("+");
}

function fileStatus(p: ReturnType<typeof parsePatch>[number]): FileStatus {
  if (p.isCreate) return "added";
  if (p.isDelete) return "deleted";
  if (p.isRename) return "renamed";
  if (p.isCopy) return "copied";
  return "modified";
}

interface RawHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  kind: HunkIndex["kind"];
}

function metaUnit(file: Omit<ParsedFile, "hunks" | "text" | "basePath">, hasText: boolean): RawHunk | null {
  const modeChanged = !!file.oldMode && !!file.newMode && file.oldMode !== file.newMode;
  const moved = file.status === "renamed" || file.status === "copied";
  if (!file.binary && !moved && !modeChanged && hasText) return null;
  const lines = [
    `# status ${file.status}`,
    `# old ${file.oldPath ?? "-"} ${file.oldMode ?? "-"}`,
    `# new ${file.newPath ?? "-"} ${file.newMode ?? "-"}`,
  ];
  const parts: string[] = [];
  if (moved) parts.push(`${file.status} ${file.oldPath} → ${file.newPath}`);
  if (modeChanged) parts.push(`mode ${file.oldMode} → ${file.newMode}`);
  if (file.binary) {
    lines.push(`# binary ${file.oldBlob ?? "-"}..${file.newBlob ?? "-"}`);
    parts.push("binary file changed");
  }
  if (!parts.length) parts.push(file.status === "deleted" ? "deleted empty file" : `${file.status} empty file`);
  return { header: parts.join(", "), oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines, kind: "meta" };
}

function parseSection(text: string): ParsedFile {
  const patches = parsePatch(text);
  if (patches.length !== 1) throw new Error(`expected one file per diff section, got ${patches.length}`);
  const p = patches[0];
  const oldPath = stripPrefix(p.oldFileName, "a/");
  const newPath = stripPrefix(p.newFileName, "b/");
  const blobs = INDEX_LINE.exec(text);
  const status = fileStatus(p);
  const base = {
    path: (newPath ?? oldPath)!,
    oldPath: status === "added" ? null : oldPath,
    newPath: status === "deleted" ? null : newPath,
    status,
    binary: !!p.isBinary,
    oldMode: p.oldMode ?? null,
    newMode: p.newMode ?? null,
    oldBlob: blobs?.[1] ?? null,
    newBlob: blobs?.[2] ?? null,
  };
  const headers = text.split("\n").filter((l) => l.startsWith("@@"));
  if (headers.length !== p.hunks.length) throw new Error(`hunk header mismatch in ${base.path}`);
  const raw: RawHunk[] = p.hunks.map((h, i) => {
    const m = HUNK_HEADER.exec(headers[i]);
    if (!m) throw new Error(`bad hunk header: ${headers[i]}`);
    return {
      header: headers[i],
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
      lines: h.lines,
      kind: "text",
    };
  });
  const meta = metaUnit(base, raw.length > 0);
  if (meta) raw.unshift(meta);

  const seen = new Map<string, number>();
  const hunks = raw.map((h): ParsedHunk => {
    const changed = h.kind === "meta" ? h.lines : normalizeChangedLines(h.lines);
    const contentHash = contentHashOf(changed);
    const occurrence = seen.get(contentHash) ?? 0;
    seen.set(contentHash, occurrence + 1);
    return {
      id: hunkId(base.path, contentHash, occurrence),
      contentHash,
      occurrence,
      kind: h.kind,
      header: h.header,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      added: changed.filter((l) => l[0] === "+").length,
      removed: changed.filter((l) => l[0] === "-").length,
      whitespaceOnly: h.kind === "text" && isWhitespaceOnly(changed),
      lines: h.lines,
      changed,
    };
  });
  return { ...base, basePath: base.oldPath, text, hunks };
}

/** Parse a git diff into files with fingerprinted hunks. */
export function parseDiff(diffText: string): ParsedFile[] {
  return splitDiffSections(diffText).map(parseSection);
}

/** The JSON-serializable index stored in snapshots. */
export function toFileIndex(file: ParsedFile): FileIndex {
  return {
    path: file.path,
    oldPath: file.oldPath,
    newPath: file.newPath,
    status: file.status,
    binary: file.binary,
    oldMode: file.oldMode,
    newMode: file.newMode,
    hunks: file.hunks.map(({ lines: _lines, changed: _changed, ...hunk }) => hunk),
  };
}
