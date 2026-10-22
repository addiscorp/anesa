// Command line: JSON for agents by default, `--human` for people.
// Conventions follow Sami's other CLIs (zegadb/cli, simien): bare `--help` is
// JSON, usage mistakes are JSON on stderr with code "usage", exit is 0 or 1.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { scan } from './scan.js';
import { inside, listProcessPaths, selfAndAncestors } from './procs.js';
import { findSystemctl, planClean, runClean } from './clean.js';
import { count, human, parseSize } from './format.js';

// The package name lives in package.json only.
const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
/** @type {string} */
const NAME = Object.keys(pkg.bin)[0];

class UsageError extends Error {}

/** @typedef {{human: boolean, pretty: boolean}} Out */

const HELP = {
  name: NAME,
  version: pkg.version,
  description: pkg.description,
  usage: `${NAME} [options] [folder]  |  ${NAME} clean <folder> [--yes]`,
  commands: {
    report: {
      '[folder]': 'sizes of each folder here and of what is inside it, junk that can be regenerated, and every process running from inside (default: the current folder). Changes nothing.',
    },
    clean: {
      'clean <folder>': 'stop what runs from inside the folder, keep launchd agents / user systemd units from restarting it, then delete it and prune git worktree records',
    },
  },
  options: {
    '--depth <n>': 'how many levels down the report goes (default 2: folders here and what is in them)',
    '--biggest <n>': 'the n biggest folders and files anywhere below (default 20 in JSON; shown in --human only when given)',
    '--min-size <size>': 'leave out entries smaller than this below the top level, e.g. 100M (default 4K: hides empty folders)',
    '--all-filesystems': 'also walk into other disks mounted inside the folder (default: stay on one filesystem, like du -x)',
    '--no-processes': "don't look for running processes",
    '-y, --yes': 'clean: go ahead without asking (required when there is no terminal)',
    '--human': 'readable output for people',
    '--nopretty': 'compact JSON',
    '-V, --version': 'output the version number',
    '-h, --help': 'display help',
  },
};

const HUMAN_HELP = `Usage: ${NAME} [options] [folder]
       ${NAME} clean <folder> [--yes]

${pkg.description}

Report (changes nothing):
  [folder]                 each folder here, what is inside it (biggest first),
                           regenerable junk with its total, and every process
                           whose working directory or program is inside
  --depth <n>              levels to show (default 2)
  --biggest <n>            also list the n biggest folders and files anywhere below
  --min-size <size>        hide entries smaller than this, e.g. 100M (default 4K)
  --all-filesystems        walk into other disks mounted inside (default: don't)
  --no-processes           skip the process lookup

Clean (deletes):
  clean <folder>           stop processes running from inside (TERM, KILL after 10 s,
                           never sccache), unload launch agents / disable user systemd
                           units pointing into it, check nothing came back, delete it
                           (find -delete), prune git worktree records
  -y, --yes                don't ask (required without a terminal)

Output:
  --human                  readable output for people (default: JSON)
  --nopretty               compact JSON
  -V, --version            output the version number
  -h, --help               display help
`;

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const o = {
    command: /** @type {'report' | 'clean' | 'help' | 'version'} */ ('report'),
    human: false, pretty: true, yes: false, processes: true, crossMounts: false,
    depth: 2, biggest: /** @type {number | null} */ (null), minSize: 4097,
    /** @type {string[]} */ positional: [],
  };
  /** @param {string} flag @param {string | undefined} v */
  const intArg = (flag, v) => {
    if (v === undefined || !/^\d+$/.test(v)) throw new UsageError(`${flag} needs a whole number`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--human': o.human = true; break;
      case '--nopretty': o.pretty = false; break;
      case '-y': case '--yes': o.yes = true; break;
      case '--no-processes': o.processes = false; break;
      case '--all-filesystems': o.crossMounts = true; break;
      case '--depth': o.depth = intArg(a, argv[++i]); break;
      case '--biggest': o.biggest = intArg(a, argv[++i]); break;
      case '--min-size': {
        const v = argv[++i];
        const n = v === undefined ? NaN : parseSize(v);
        if (Number.isNaN(n)) throw new UsageError('--min-size needs a size, e.g. 100M');
        o.minSize = n; break;
      }
      case '-h': case '--help': o.command = 'help'; break;
      case '-V': case '--version': if (o.command !== 'help') o.command = 'version'; break;
      default:
        if (a.startsWith('-') && a !== '-') throw new UsageError(`unknown option '${a}'`);
        o.positional.push(a);
    }
  }
  if (o.command === 'report' && o.positional[0] === 'clean') {
    o.command = 'clean';
    o.positional.shift();
    if (o.positional.length !== 1) throw new UsageError(`usage: ${NAME} clean <folder> [--yes]`);
  } else if (o.command === 'report') {
    if (o.positional.length > 1) throw new UsageError(`one folder at a time (got ${o.positional.length})`);
    if (o.yes) throw new UsageError('--yes only goes with clean');
  }
  return o;
}

/** @param {unknown} value @param {Out} out */
function printJson(value, out, stream = process.stdout) {
  stream.write(JSON.stringify(value, null, out.pretty ? 2 : undefined) + '\n');
}

/**
 * @param {Out} out @param {string} code @param {string} message @param {Record<string, unknown>} [extra]
 */
function fail(out, code, message, extra = {}) {
  if (out.human) {
    process.stderr.write(`${NAME}: ${message}\n`);
    if (code === 'usage') process.stderr.write(`  try: ${NAME} --human --help\n`);
  } else {
    // One line on stderr, like simien's usage errors.
    printJson({ ok: false, error: { code, message, ...(code === 'usage' ? { hint: `${NAME} --help` } : {}), ...extra } }, { ...out, pretty: false }, process.stderr);
  }
  return 1;
}

/**
 * Drop entries under `min` bytes, except the folders at the top level (always listed, as the zsh does).
 * @param {import('./scan.js').Node[]} nodes @param {number} min @param {number} level
 * @returns {import('./scan.js').Node[]}
 */
function prune(nodes, min, level = 1) {
  return nodes
    .filter((n) => n.bytes >= min || (level === 1 && n.type === 'dir'))
    .map((n) => (n.children ? { ...n, children: prune(n.children, min, level + 1) } : n));
}

/** @param {ReturnType<typeof parseArgs>} o @param {Out} out */
async function report(o, out) {
  const started = Date.now();
  const dir = o.positional[0] ?? '.';
  /** @type {string[]} */ const warnings = [];
  let result;
  try {
    result = await scan(dir, { depth: o.depth, biggest: o.biggest ?? 20, crossMounts: o.crossMounts });
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    return fail(out, 'not_a_folder', err.code === 'ENOTDIR' ? `${dir} isn't a folder` : `can't read ${dir}: ${err.message}`);
  }
  const root = result.root;
  /** @type {{pid: number, command: string, via: string, path: string, folder: string}[]} */
  let processes = [];
  if (o.processes) {
    try {
      const [all, exclude] = await Promise.all([listProcessPaths(), selfAndAncestors()]);
      // One line per (top-level folder, pid), as the zsh does.
      /** @type {Map<string, (typeof processes)[number]>} */ const seen = new Map();
      for (const top of new Set(all.filter((p) => p.path.startsWith(root + path.sep)).map((p) => p.path.slice(root.length + 1).split(path.sep)[0]))) {
        for (const p of inside(all, path.join(root, top), { includeSelf: true, exclude })) {
          seen.set(`${top}:${p.pid}`, { ...p, folder: top });
        }
      }
      processes = [...seen.values()].sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : a.pid - b.pid));
    } catch (e) {
      warnings.push(`processes not listed: ${/** @type {Error} */ (e).message}`);
    }
  }
  const tree = prune(result.tree, o.minSize);
  const elapsedMs = Date.now() - started;

  if (!out.human) {
    printJson({
      ok: true,
      root,
      bytes: result.bytes,
      files: result.files,
      dirs: result.dirs,
      junk: result.junk,
      processes,
      tree,
      biggest: result.biggest,
      unreadable: result.unreadable,
      mounts: result.mounts,
      warnings,
      elapsedMs,
    }, out);
    return 0;
  }

  const w = (/** @type {string} */ s = '') => process.stdout.write(s + '\n');
  const rel = (/** @type {string} */ p) => path.relative(root, p) || '.';
  w(`${root}  ${human(result.bytes)} in ${count(result.files)} files, ${count(result.dirs)} folders (${(elapsedMs / 1000).toFixed(1)} s)`);
  const kinds = Object.entries(result.junk.byKind).slice(0, 6).map(([k, b]) => `${k} ${human(b)}`).join(', ');
  w(result.junk.count
    ? `reclaimable: ${human(result.junk.bytes)} in ${count(result.junk.count)} junk folders (${kinds}${Object.keys(result.junk.byKind).length > 6 ? ', …' : ''})`
    : 'reclaimable: nothing that looks like build output or caches');
  w();
  /** @type {Map<string, typeof processes>} */ const procsByTop = new Map();
  for (const p of processes) procsByTop.set(p.folder, [...(procsByTop.get(p.folder) ?? []), p]);
  const where = (/** @type {string} */ p) => path.relative(root, p).split(path.sep).slice(0, 3).join('/');
  const procLine = (/** @type {(typeof processes)[number]} */ p) => `      ⚠ running: ${p.command} (pid ${p.pid}) in ${where(p.via === 'cwd' ? p.path : path.dirname(p.path))}`;
  const tag = (/** @type {import('./scan.js').Node} */ n) => (n.junk ? `  [junk: ${n.junk}]` : '');
  /** @param {import('./scan.js').Node[]} nodes @param {string} prefix @param {number} indent */
  const walk = (nodes, prefix, indent) => {
    for (const n of nodes) {
      w(`${' '.repeat(indent)}|---> ${human(n.bytes).padStart(5)}  ${prefix}${n.name}${n.type === 'dir' ? '' : n.type === 'link' ? ' (link)' : ''}${tag(n)}`);
      if (n.children) walk(n.children, `${prefix}${n.name}/`, indent + 6);
    }
  };
  for (const n of tree) {
    if (n.type === 'dir') {
      w(`• ${n.name}  ${human(n.bytes)}${tag(n)}`);
      if (n.children) walk(n.children, `${n.name}/`, 6);
    } else {
      w(`• ${n.name}  ${human(n.bytes)}${n.type === 'link' ? ' (link)' : ''}`);
    }
    for (const p of procsByTop.get(n.name) ?? []) w(procLine(p));
    procsByTop.delete(n.name);
  }
  for (const list of procsByTop.values()) for (const p of list) w(procLine(p));

  if (o.biggest !== null) {
    w();
    w(`biggest folders (anywhere below; each includes what is inside it)`);
    for (const d of result.biggest.dirs) w(`  ${human(d.bytes).padStart(5)}  ${rel(d.path)}${d.junk ? `  [junk: ${d.junk}]` : ''}`);
    w('biggest files');
    for (const f of result.biggest.files) w(`  ${human(f.bytes).padStart(5)}  ${rel(f.path)}`);
    if (result.junk.items.length) {
      w('biggest junk');
      for (const j of result.junk.items) w(`  ${human(j.bytes).padStart(5)}  ${rel(j.path)}  [${j.kind}]`);
    }
  }
  if (result.unreadable.count) {
    w();
    w(`unreadable: ${count(result.unreadable.count)} folders (permission denied), not counted; first: ${result.unreadable.paths[0]}`);
  }
  if (result.mounts.length) {
    w();
    w(`other disks mounted inside, not walked (--all-filesystems to include): ${result.mounts.slice(0, 5).join(', ')}${result.mounts.length > 5 ? ', …' : ''}`);
  }
  for (const m of warnings) w(`warning: ${m}`);
  return 0;
}

/** @param {string} question */
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

/** @param {ReturnType<typeof parseArgs>} o @param {Out} out */
async function clean(o, out) {
  const log = out.human ? (/** @type {string} */ s) => process.stdout.write(s + '\n') : () => {};
  const ctx = { systemctl: process.platform === 'linux' ? await findSystemctl() : null, log };
  const planned = await planClean(o.positional[0], ctx);
  const plan = planned.plan;
  if (out.human && plan) {
    log(`clean ${plan.dir}`);
    for (const p of plan.processes) log(`  stop process: ${p.pid} ${p.command}`);
    for (const a of plan.launchAgents) log(`  unload launch agent: ${a}`);
    for (const u of plan.systemdUnits) log(`  disable systemd unit: ${u}`);
    for (const g of plan.gitRepos) log(`  prune worktrees of: ${g}`);
    log('  delete the folder');
    if (plan.systemAgents.length) {
      log('  ✗ system launch agents point into it (need sudo, not touched):');
      for (const a of plan.systemAgents) log(`    ${a}`);
    }
  }
  if (!planned.ok) return fail(out, planned.code, planned.message, plan ? { plan } : {});
  if (!plan) throw new Error('unreachable: a plan comes with ok');

  if (!o.yes) {
    if (!process.stdin.isTTY) {
      return fail(out, 'needs_yes', `no terminal to ask in: nothing changed; run again with --yes to clean ${plan.dir}`, { plan });
    }
    if (!out.human) process.stderr.write(JSON.stringify({ plan }, null, 2) + '\n');
    if (!(await ask('Go ahead? [y/N] '))) {
      if (out.human) log('nothing changed');
      else printJson({ ok: false, error: { code: 'declined', message: 'nothing changed' }, plan }, out, process.stderr);
      return 1;
    }
  }
  const r = await runClean(plan, ctx);
  if (!r.ok) {
    return fail(out, /** @type {string} */ (r.code), /** @type {string} */ (r.message), { plan, done: r.done, ...('processes' in r ? { processes: r.processes } : {}) });
  }
  if (!out.human) printJson({ ok: true, plan, done: r.done }, out);
  return 0;
}

/** @param {string[]} argv */
export async function main(argv) {
  const out = { human: argv.includes('--human'), pretty: !argv.includes('--nopretty') };
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) return fail(out, 'usage', e.message);
    throw e;
  }
  if (o.command === 'help') {
    if (out.human) process.stdout.write(HUMAN_HELP); else printJson(HELP, out);
    return 0;
  }
  if (o.command === 'version') {
    process.stdout.write(out.human ? `${pkg.version}\n` : JSON.stringify({ name: NAME, version: pkg.version }) + '\n');
    return 0;
  }
  return o.command === 'clean' ? clean(o, out) : report(o, out);
}
