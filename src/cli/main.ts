#!/usr/bin/env node
// CLI entry point (package.json `bin`).
import { run } from "./run.js";

run(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => {
  process.exitCode = code;
});
