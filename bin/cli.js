#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(JSON.stringify({ ok: false, error: { code: 'internal', message: String(err?.stack ?? err) } }) + '\n');
    process.exitCode = 1;
  },
);
