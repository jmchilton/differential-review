import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/differential-review.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "info",
  // One tsconfig for all files, so site/src/lib/records.ts doesn't pull in site/tsconfig.json (extends astro).
  tsconfig: "tsconfig.json",
});
