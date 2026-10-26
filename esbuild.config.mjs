import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/differential-review.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "info",
});
