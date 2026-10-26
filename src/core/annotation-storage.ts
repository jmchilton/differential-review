// Threads are reviewer-owned; each reply is a separate immutable file so writers never share a document.
import { annotationId, parseReviewReply, parseReviewThread, type ReviewAnnotations, type ReviewReply, type ReviewThread } from "./annotations.js";
import type { ReadOnlyFileAdapter, TextFileAdapter } from "./storage.js";

export function annotationDir(reviewDir: string, kind: "threads" | "replies"): string {
  return `${reviewDir.replace(/\/$/, "")}/annotations/${kind}`;
}
export function annotationPath(reviewDir: string, kind: "threads" | "replies", id: string): string {
  return `${annotationDir(reviewDir, kind)}/${annotationId(id)}.json`;
}
export async function readAnnotations(adapter: ReadOnlyFileAdapter, reviewDir: string): Promise<ReviewAnnotations> {
  async function read<T>(kind: "threads" | "replies", parse: (value: unknown) => T): Promise<T[]> {
    const names = (await adapter.listFiles(annotationDir(reviewDir, kind))).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => {
      const path = annotationPath(reviewDir, kind, name.slice(0, -5));
      try {
        const value = parse(JSON.parse(await adapter.read(path)));
        if ((value as { id: string }).id !== name.slice(0, -5)) throw new Error("id does not match filename");
        return value;
      } catch (e) { throw new Error(`unreadable annotation ${path}: ${(e as Error).message}`); }
    }));
  }
  const [threads, replies] = await Promise.all([read("threads", parseReviewThread), read("replies", parseReviewReply)]);
  return { threads, replies };
}
export interface AnnotationStore {
  read(): Promise<ReviewAnnotations>;
  writeThread(thread: ReviewThread): Promise<void>;
  writeReply(reply: ReviewReply): Promise<void>;
}
export function annotationStore(adapter: TextFileAdapter, reviewDir: string): AnnotationStore {
  return {
    read: () => readAnnotations(adapter, reviewDir),
    writeThread: (thread) => adapter.write(annotationPath(reviewDir, "threads", thread.id), JSON.stringify(parseReviewThread(thread), null, 2) + "\n"),
    async writeReply(reply) {
      const path = annotationPath(reviewDir, "replies", reply.id);
      if (await adapter.exists(path)) throw new Error(`reply already exists: ${reply.id}`);
      await adapter.write(path, JSON.stringify(parseReviewReply(reply), null, 2) + "\n");
    },
  };
}
