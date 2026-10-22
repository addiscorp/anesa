// Which processes run from where: each process's working directory and program.
// Linux reads /proc; macOS (or a Linux without /proc) asks lsof.
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';

/** @typedef {{pid: number, command: string, via: 'cwd' | 'exe', path: string}} ProcPath */

/**
 * @param {string} cmd @param {string[]} args
 * @returns {Promise<{stdout: string, code: number | null, missing: boolean}>}
 */
export function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      const e = /** @type {any} */ (err);
      resolve({ stdout: stdout ?? '', code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, missing: e?.code === 'ENOENT' });
    });
  });
}

/** @returns {Promise<ProcPath[]>} */
async function fromProc() {
  const names = await fs.readdir('/proc');
  /** @type {ProcPath[]} */ const out = [];
  await Promise.all(names.filter((n) => /^\d+$/.test(n)).map(async (n) => {
    const pid = Number(n);
    let command = '';
    try { command = (await fs.readFile(`/proc/${n}/comm`, 'utf8')).trim(); } catch { return; }
    for (const [link, via] of /** @type {const} */ ([['cwd', 'cwd'], ['exe', 'exe']])) {
      try {
        const p = (await fs.readlink(`/proc/${n}/${link}`)).replace(/ \(deleted\)$/, '');
        out.push({ pid, command, via, path: p });
      } catch { /* another user's process, or gone */ }
    }
  }));
  return out;
}

/** @returns {Promise<ProcPath[]>} */
async function fromLsof() {
  // +c 0: the full command name, not the first 15 characters.
  const r = await run('lsof', ['-nP', '+c', '0', '-d', 'cwd,txt', '-Fpcfn']);
  if (r.missing) throw new Error('lsof not found: cannot list processes');
  /** @type {ProcPath[]} */ const out = [];
  let pid = 0, command = '', fd = '';
  for (const line of r.stdout.split('\n')) {
    const tag = line[0], val = line.slice(1);
    if (tag === 'p') { pid = Number(val); fd = ''; }
    else if (tag === 'c') command = val;
    else if (tag === 'f') fd = val;
    else if (tag === 'n' && val.startsWith('/')) out.push({ pid, command, via: fd === 'cwd' ? 'cwd' : 'exe', path: val });
  }
  return out;
}

/**
 * Every process's working directory and program (on macOS also the libraries
 * it has loaded, as lsof lists them under txt).
 * @returns {Promise<ProcPath[]>}
 */
export async function listProcessPaths() {
  if (process.platform === 'linux') {
    try { return await fromProc(); } catch { /* no /proc: fall back */ }
  }
  return fromLsof();
}

/**
 * This process and every parent above it: never reported, never stopped.
 * @returns {Promise<Set<number>>}
 */
export async function selfAndAncestors() {
  const set = new Set([process.pid]);
  /** @type {Map<number, number>} */ const parent = new Map();
  if (process.platform === 'linux') {
    let pid = process.ppid;
    while (pid > 1 && !set.has(pid)) {
      set.add(pid);
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      } catch { break; }
    }
    return set;
  }
  const r = await run('ps', ['-A', '-o', 'pid=,ppid=']);
  for (const line of r.stdout.split('\n')) {
    const [a, b] = line.trim().split(/\s+/).map(Number);
    if (a) parent.set(a, b);
  }
  let pid = process.ppid;
  while (pid > 1 && !set.has(pid)) { set.add(pid); pid = parent.get(pid) ?? 0; }
  return set;
}

/**
 * The processes running from inside `dir` (its cwd or program is there).
 * @param {ProcPath[]} all @param {string} dir absolute, real path
 * @param {{includeSelf?: boolean, exclude?: Set<number>}} [opts]
 *   includeSelf: `dir` itself counts, not only what is below it.
 * @returns {{pid: number, command: string, via: 'cwd' | 'exe', path: string}[]} one per pid
 */
export function inside(all, dir, opts = {}) {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  /** @type {Map<number, ProcPath>} */ const byPid = new Map();
  for (const p of all) {
    if (opts.exclude?.has(p.pid)) continue;
    if (!(p.path.startsWith(prefix) || (opts.includeSelf && p.path === dir))) continue;
    // Prefer the working directory: it says where the process was started.
    const prev = byPid.get(p.pid);
    if (!prev || (prev.via !== 'cwd' && p.via === 'cwd')) byPid.set(p.pid, p);
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid);
}
