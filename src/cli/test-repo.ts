// Temp git repos and branch records for CLI integration tests, isolated from user git config.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TextFileAdapter } from "../core";
import { nodeReadAdapter } from "./node-storage";

export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.org",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.org",
  GIT_AUTHOR_DATE: "2026-10-26T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-26T00:00:00Z",
  GIT_EDITOR: "true",
};

/** Apply GIT_ENV to this process so the CLI's own git calls are isolated too. */
export function isolateGit(): void {
  Object.assign(process.env, GIT_ENV);
}

export class TestRepo {
  readonly dir: string;
  readonly vault: string;

  constructor() {
    const root = mkdtempSync(join(tmpdir(), "differential-review-"));
    this.dir = join(root, "repo");
    this.vault = join(root, "vault");
    mkdirSync(this.dir);
    this.git("init", "-q", "-b", "main");
    this.git("config", "commit.gpgsign", "false");
  }

  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.dir, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  }

  write(path: string, content: string): void {
    const abs = join(this.dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  read(path: string): string {
    return readFileSync(join(this.dir, path), "utf8");
  }

  /** Replace exactly one occurrence of `from` in a file. */
  edit(path: string, from: string, to: string): void {
    const text = this.read(path);
    if (text.split(from).length !== 2) throw new Error(`expected one ${JSON.stringify(from)} in ${path}`);
    this.write(path, text.replace(from, to));
  }

  commit(message: string, ...extra: string[]): string {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message, ...extra);
    return this.head();
  }

  head(): string {
    return this.git("rev-parse", "HEAD").trim();
  }

  /** A vault branch (or review) record dir with optional index.md frontmatter. */
  record(branch: string, frontmatter: Record<string, string> | null, kind: "branches" | "reviews" = "branches"): string {
    const dir = join(this.vault, "repositories", "demo", kind, "active", branch);
    mkdirSync(dir, { recursive: true });
    const fm = frontmatter ? `---\n${Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n` : "";
    writeFileSync(join(dir, "index.md"), `${fm}# ${branch}\n`);
    return dir;
  }
}

export function numberedLines(n: number, prefix = "x"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}_${i + 1} = ${i + 1}`).join("\n") + "\n";
}

/** What a plugin's adapter does; the CLI itself only has `nodeReadAdapter`. */
export const pluginAdapter: TextFileAdapter = {
  ...nodeReadAdapter,
  async write(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  },
};
