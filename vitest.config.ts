import { defineConfig } from "vitest/config";

// Don't resolve site/tsconfig.json (extends astro) for the shared site/src/lib/records.ts.
export default defineConfig({ oxc: { tsconfig: false } });
