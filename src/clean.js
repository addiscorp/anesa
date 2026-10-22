// `clean <folder>`: stop what runs from inside it, keep it from restarting,
// delete it, prune git's records of worktrees that were in it.
// A port of `clean` in /Volumes/Projects/skills/clean-up/clean-up.zsh.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inside, listProcessPaths, run, selfAndAncestors } from './procs.js';

/** Never stopped: the sccache server is shared by every agent's builds. */
export const SPARED_COMMANDS = new Set(['sccache']);

/**
 * Why `dir` must never be cleaned, or null. Pure: looks at the path only.
 * @param {string} dir absolute, real path
 * @param {{home?: string}} [ctx]
 * @returns {string | null}
 */
export function refusal(dir, ctx = {}) {
  const home = path.resolve(ctx.home ?? os.homedir());
  const d = path.resolve(dir);
  const parts = d.split(path.sep).filter(Boolean);
  if (parts.length === 0) return 'the filesystem root';
  // Every top-level folder: /Users, /Volumes, /System, /Library, /home, /usr, /etc …
  if (parts.length === 1) return 'a top-level system folder';
  if (d === home) return 'your home folder';
  if (home.startsWith(d + path.sep)) return 'a folder that holds your home folder';
  // Anyone's home, and the shared projects root.
  if (parts.length === 2 && ['Users', 'home'].includes(parts[0])) return "a user's home folder";
  // A whole disk (/Volumes/X, /mnt/X, /media/X) and the second level of system folders.
  if (['Volumes', 'mnt', 'media'].includes(parts[0]) && parts.length === 2) return 'a whole disk';
  if (['System', 'Library', 'Applications', 'private', 'usr', 'etc', 'var', 'bin', 'sbin', 'opt', 'proc', 'sys', 'dev', 'boot', 'lib', 'lib64', 'root', 'srv', 'run', 'snap'].includes(parts[0]) && parts.length === 2) {
    return 'a system folder';
  }
  if (parts[0] === 'System') return 'a system folder';
  return null;
}

/**
 * @typedef {{pid: number, command: string, via: string, path: string}} Proc
 * @typedef {{
 *   home?: string,
 *   systemPlistDirs?: string[],
 *   listProcesses?: () => Promise<import('./procs.js').ProcPath[]>,
 *   launchctl?: (args: string[]) => Promise<number>,
 *   systemctl?: ((args: string[]) => Promise<number>) | null,
 *   git?: (args: string[]) => Promise<number>,
 *   termWaitMs?: number, settleMs?: number,
 *   log?: (line: string) => void,
 * }} Ctx
 * @typedef {{dir: string, processes: Proc[], launchAgents: string[], systemAgents: string[],
 *   systemdUnits: string[], gitRepos: string[]}} Plan
 */

/** @param {Ctx} ctx */
function defaults(ctx) {
  const home = ctx.home ?? os.homedir();
  return {
    home,
    systemPlistDirs: ctx.systemPlistDirs ?? (process.platform === 'darwin' ? ['/Library/LaunchAgents', '/Library/LaunchDaemons'] : []),
    listProcesses: ctx.listProcesses ?? listProcessPaths,
    launchctl: ctx.launchctl ?? (async (/** @type {string[]} */ a) => (await run('launchctl', a)).code ?? 1),
    systemctl: ctx.systemctl === undefined ? null : ctx.systemctl,
    git: ctx.git ?? (async (/** @type {string[]} */ a) => (await run('git', a)).code ?? 1),
    termWaitMs: ctx.termWaitMs ?? 10_000,
    settleMs: ctx.settleMs ?? 3_000,
    log: ctx.log ?? (() => {}),
  };
}

/** Is systemctl on PATH? (Linux user units.) */
export async function findSystemctl() {
  const r = await run('systemctl', ['--version']);
  if (r.missing) return null;
  return async (/** @type {string[]} */ a) => (await run('systemctl', a)).code ?? 1;
}

/** @param {string} dir @param {string} ext @param {string} needle */
async function filesMentioning(dir, ext, needle) {
  /** @type {string[]} */ const hits = [];
  let names;
  try { names = await fs.readdir(dir); } catch { return hits; }
  for (const n of names.sort()) {
    if (!n.endsWith(ext)) continue;
    const f = path.join(dir, n);
    try { if ((await fs.readFile(f, 'utf8')).includes(needle)) hits.push(f); } catch { /* unreadable */ }
  }
  return hits;
}

/**
 * Main repos of git worktrees inside `dir` (a `.git` file saying
 * `gitdir: <repo>/worktrees/<name>`), up to 4 levels down like the zsh.
 * @param {string} dir
 */
async function worktreeRepos(dir) {
  /** @type {Set<string>} */ const repos = new Set();
  /** @param {string} d @param {number} level */
  async function look(d, level) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.name === '.git' && e.isFile()) {
        try {
          const m = /^gitdir: (.*)\/worktrees\/.*$/m.exec(await fs.readFile(p, 'utf8'));
          if (m) repos.add(m[1]);
        } catch { /* unreadable */ }
      } else if (e.isDirectory() && level < 3) {
        await look(p, level + 1);
      }
    }
  }
  await look(dir, 0);
  return [...repos].sort();
}

/**
 * Processes running from inside `dir` or from `dir` itself, except sccache and this process + its parents.
 * @param {string} dir @param {ReturnType<typeof defaults>} c @param {Set<number>} exclude
 */
async function procsIn(dir, c, exclude) {
  const all = await c.listProcesses();
  return inside(all, dir, { includeSelf: true, exclude }).filter((p) => !SPARED_COMMANDS.has(p.command));
}

/**
 * Work out what `clean` would do. Changes nothing.
 * @param {string} target @param {Ctx} [ctx]
 * @returns {Promise<{ok: true, plan: Plan} | {ok: false, code: string, message: string, plan?: Plan}>}
 */
export async function planClean(target, ctx = {}) {
  const c = defaults(ctx);
  let dir;
  try {
    if (!(await fs.stat(target)).isDirectory()) throw new Error();
    dir = await fs.realpath(path.resolve(target));
  } catch {
    return { ok: false, code: 'not_a_folder', message: `${target} isn't a folder` };
  }
  const why = refusal(dir, { home: c.home });
  if (why) return { ok: false, code: 'refused', message: `refusing to delete ${dir}: ${why}` };

  const exclude = await selfAndAncestors();
  const processes = await procsIn(dir, c, exclude);
  const launchAgents = await filesMentioning(path.join(c.home, 'Library', 'LaunchAgents'), '.plist', dir);
  /** @type {string[]} */ const systemAgents = [];
  for (const d of c.systemPlistDirs) systemAgents.push(...await filesMentioning(d, '.plist', dir));
  const systemdUnits = c.systemctl
    ? (await filesMentioning(path.join(c.home, '.config', 'systemd', 'user'), '.service', dir)).map((f) => path.basename(f))
    : [];
  const gitRepos = await worktreeRepos(dir);
  /** @type {Plan} */ const plan = { dir, processes, launchAgents, systemAgents, systemdUnits, gitRepos };
  if (systemAgents.length) {
    return {
      ok: false, code: 'system_agents', plan,
      message: `system launch agents point into ${dir} (need sudo, not touched); unload them first (sudo launchctl bootout system <plist>), then run clean again`,
    };
  }
  return { ok: true, plan };
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const alive = (/** @type {number} */ pid) => { try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; } };

/**
 * Carry out a plan from planClean.
 * @param {Plan} plan @param {Ctx} [ctx]
 */
export async function runClean(plan, ctx = {}) {
  const c = defaults(ctx);
  const dir = plan.dir;
  const done = {
    /** @type {string[]} */ disabledUnits: [], /** @type {string[]} */ unloadedAgents: [],
    /** @type {Proc[]} */ stopped: [], /** @type {Proc[]} */ killed: [],
    deleted: false, /** @type {string[]} */ prunedRepos: [],
  };
  // The same guard again: a plan is plain data and could have been edited.
  const why = refusal(dir, { home: c.home });
  if (why) return { ok: false, code: 'refused', message: `refusing to delete ${dir}: ${why}`, done };

  for (const unit of plan.systemdUnits) {
    if (c.systemctl && (await c.systemctl(['--user', 'disable', '--now', unit])) === 0) {
      done.disabledUnits.push(unit); c.log(`  ✓ disabled ${unit}`);
    }
  }
  for (const plist of plan.launchAgents) {
    await c.launchctl(['bootout', `gui/${process.getuid?.() ?? 0}`, plist]);
    try {
      await fs.rename(plist, `${plist}.disabled-by-clean`);
      done.unloadedAgents.push(plist);
      c.log(`  ✓ unloaded ${path.basename(plist)} (kept as ${path.basename(plist)}.disabled-by-clean)`);
    } catch { /* gone already */ }
  }

  // Only the PIDs in the plan are signalled and waited on.
  let pending = plan.processes.filter((p) => { try { process.kill(p.pid, 'SIGTERM'); return true; } catch { return false; } });
  const deadline = Date.now() + c.termWaitMs;
  const termed = [...pending];
  while (pending.length && Date.now() < deadline) {
    await sleep(Math.min(500, c.termWaitMs));
    pending = pending.filter((p) => alive(p.pid));
  }
  pending = pending.filter((p) => alive(p.pid));
  for (const p of pending) {
    try {
      process.kill(p.pid, 'SIGKILL');
      done.killed.push(p);
      c.log(`  ! killed ${p.command} (pid ${p.pid}) after ${Math.round(c.termWaitMs / 1000)} s`);
    } catch { /* exited meanwhile */ }
  }
  done.stopped = termed.filter((p) => !done.killed.includes(p));

  await sleep(c.settleMs);
  const back = await procsIn(dir, c, await selfAndAncestors());
  if (back.length) {
    return { ok: false, code: 'restarted', message: `something restarted inside ${dir}; nothing deleted`, processes: back, done };
  }
  c.log('  ✓ nothing running inside it');

  // find -delete, as the zsh does: never rm -rf, never follows a symlink.
  await run('find', [dir, '-delete']);
  try {
    await fs.lstat(dir);
    return { ok: false, code: 'delete_failed', message: `couldn't delete everything in ${dir} (permissions?)`, done };
  } catch { /* gone: good */ }
  done.deleted = true;
  c.log(`  ✓ deleted ${dir}`);
  for (const g of plan.gitRepos) {
    if ((await c.git([`--git-dir=${g}`, 'worktree', 'prune'])) === 0) {
      done.prunedRepos.push(g); c.log(`  ✓ pruned worktrees of ${g}`);
    }
  }
  return { ok: true, done };
}
