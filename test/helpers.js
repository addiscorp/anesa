import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');

/** A fresh folder under TMPDIR, by its real path (macOS /var → /private/var). */
export async function fixture(name = 'fx') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `leftovers-${name}-`));
  return fs.realpath(d);
}

/** Remove a fixture the way the fleet does: find -delete, never rm -rf. */
export function removeFixture(dir) {
  try { execFileSync('find', [dir, '-delete']); } catch { /* already gone */ }
}

/** @param {string} file @param {number} size */
export async function writeBytes(file, size) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Random bytes so no filesystem can compress or dedupe them away.
  await fs.writeFile(file, crypto.randomBytes(size));
}

/**
 * A long-running child whose working directory is `cwd`. Killed by its own PID only.
 * @param {string} cwd @param {{ignoreTerm?: boolean}} [opts]
 */
export async function child(cwd, opts = {}) {
  const code = opts.ignoreTerm
    ? "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"
    : "console.log('ready'); setInterval(() => {}, 1000)";
  const c = spawn(process.execPath, ['-e', code], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    c.stdout.once('data', resolve);
    c.once('error', reject);
  });
  const exited = new Promise((resolve) => c.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    pid: /** @type {number} */ (c.pid),
    exited,
    kill() { try { process.kill(/** @type {number} */ (c.pid), 'SIGKILL'); } catch { /* gone */ } },
  };
}

/** Run the CLI; never throws. @param {string[]} args @param {{cwd?: string}} [opts] */
export function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.stdin.end();
    c.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
