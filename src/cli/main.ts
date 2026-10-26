// CLI entry point bundled to dist/differential-review.cjs.
import { run } from "./run";

run(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => {
  process.exitCode = code;
});
