// Walk a folder like `du`: allocated size (blocks * 512), symlinks never
// followed, hard links counted once, other filesystems not entered unless asked.
import fs from 'node:fs/promises';
import path from 'node:path';

/** Folder names that are regenerable build output or caches. */
export const JUNK_NAMES = new Set([
  'node_modules', 'target', '.target', '.next', '.nuxt', '.svelte-kit', '.open-next',
  'dist', 'build', '.turbo', '.cache', '.parcel-cache', '.wrangler', 'DerivedData',
  '.gradle', '__pycache__', '.venv', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.tmp', 'coverage',
]);

/** A folder that holds a CACHEDIR.TAG says it is a cache (cargo, many tools). */
export const CACHEDIR_TAG = 'CACHEDIR.TAG';

/**
 * @param {string} name folder name
 * @param {string[]} entries its entries
 * @returns {string | null} why it is junk, or null
 */
export function junkKind(name, entries) {
  if (JUNK_NAMES.has(name)) return name;
  if (entries.includes(CACHEDIR_TAG)) return CACHEDIR_TAG;
  return null;
}

/** @param {number} n */
function limiter(n) {
  let active = 0;
  /** @type {(() => void)[]} */
  const queue = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active++;
    /** @type {() => void} */ (queue.shift())();
  };
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject).finally(() => { active--; next(); }));
    next();
  });
}

/** Keep the `n` largest items seen so far, largest first. */
class Top {
  /** @param {number} n */
  constructor(n) { this.n = n; /** @type {{path: string, bytes: number, junk?: string | null}[]} */ this.items = []; }
  /** @param {{path: string, bytes: number, junk?: string | null}} item */
  add(item) {
    const items = this.items;
    if (this.n <= 0) return;
    if (items.length === this.n && item.bytes <= items[items.length - 1].bytes) return;
    let i = items.length;
    while (i > 0 && items[i - 1].bytes < item.bytes) i--;
    items.splice(i, 0, item);
    if (items.length > this.n) items.pop();
  }
}

/**
 * @typedef {{name: string, type: 'dir' | 'file' | 'link' | 'other', bytes: number,
 *   junk: string | null, children?: Node[]}} Node
 * @typedef {{root: string, bytes: number, files: number, dirs: number,
 *   tree: Node[], biggest: {dirs: {path: string, bytes: number, junk: string | null}[], files: {path: string, bytes: number}[]},
 *   junk: {bytes: number, count: number, byKind: Record<string, number>, items: {path: string, bytes: number, kind: string}[]},
 *   unreadable: {count: number, paths: string[]}, mounts: string[]}} ScanResult
 */

/**
 * @param {string} dir
 * @param {{depth?: number, biggest?: number, crossMounts?: boolean, concurrency?: number}} [opts]
 * @returns {Promise<ScanResult>}
 */
export async function scan(dir, opts = {}) {
  const depth = opts.depth ?? 2;
  const top = opts.biggest ?? 20;
  const crossMounts = opts.crossMounts ?? false;
  const limit = limiter(opts.concurrency ?? 64);
  const root = await fs.realpath(path.resolve(dir));
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory()) throw Object.assign(new Error(`${dir} isn't a folder`), { code: 'ENOTDIR' });

  let files = 0, dirs = 0;
  const seenInodes = new Set();
  const unreadable = { count: 0, /** @type {string[]} */ paths: [] };
  /** @type {string[]} */ const mounts = [];
  const bigDirs = new Top(top), bigFiles = new Top(top), bigJunk = new Top(top);
  let junkBytes = 0, junkCount = 0;
  /** @type {Record<string, number>} */ const byKind = {};

  /**
   * @param {string} abs @param {import('node:fs').Stats} st @param {number} level
   * @param {string | null} enclosing kind of the junk folder this is inside (counted there), or null
   * @returns {Promise<{bytes: number, junk: string | null, children?: Node[]}>}
   */
  async function walk(abs, st, level, enclosing) {
    dirs++;
    let bytes = st.blocks * 512;
    /** @type {string[]} */ let entries;
    try {
      entries = await limit(() => fs.readdir(abs));
    } catch {
      unreadable.count++;
      if (unreadable.paths.length < 20) unreadable.paths.push(abs);
      return { bytes, junk: null, children: level < depth ? [] : undefined };
    }
    const kind = level > 0 && !enclosing ? junkKind(path.basename(abs), entries) : null;
    const keep = level < depth;
    /** @type {Node[] | undefined} */ const children = keep ? [] : undefined;
    await Promise.all(entries.map(async (name) => {
      const p = path.join(abs, name);
      /** @type {import('node:fs').Stats} */ let cst;
      try { cst = await limit(() => fs.lstat(p)); } catch { return; }
      if (cst.isDirectory()) {
        if (!crossMounts && cst.dev !== rootStat.dev) { mounts.push(p); return; }
        const inside = enclosing ?? kind;
        const child = await walk(p, cst, level + 1, inside);
        bytes += child.bytes;
        bigDirs.add({ path: p, bytes: child.bytes, junk: child.junk ?? inside });
        if (children) children.push({ name, type: 'dir', bytes: child.bytes, junk: child.junk, ...(child.children ? { children: child.children } : {}) });
        return;
      }
      let b = cst.blocks * 512;
      if (cst.nlink > 1) {
        const key = `${cst.dev}:${cst.ino}`;
        if (seenInodes.has(key)) b = 0; else seenInodes.add(key);
      }
      files++;
      bytes += b;
      bigFiles.add({ path: p, bytes: b });
      if (children) children.push({ name, type: cst.isFile() ? 'file' : cst.isSymbolicLink() ? 'link' : 'other', bytes: b, junk: null });
    }));
    if (kind) {
      junkCount++;
      junkBytes += bytes;
      byKind[kind] = (byKind[kind] ?? 0) + bytes;
      bigJunk.add({ path: abs, bytes, junk: kind });
    }
    if (children) sortNodes(children);
    return { bytes, junk: kind, children };
  }

  const res = await walk(root, rootStat, 0, null);
  return {
    root,
    bytes: res.bytes,
    files,
    dirs,
    tree: res.children ?? [],
    biggest: { dirs: bigDirs.items, files: bigFiles.items },
    junk: {
      bytes: junkBytes,
      count: junkCount,
      byKind: Object.fromEntries(Object.entries(byKind).sort((a, b) => b[1] - a[1])),
      items: bigJunk.items.map(({ path: p, bytes, junk }) => ({ path: p, bytes, kind: /** @type {string} */ (junk) })),
    },
    unreadable,
    mounts: mounts.sort(),
  };
}

/** Biggest first, then by name, so output is stable. @param {Node[]} nodes */
function sortNodes(nodes) {
  nodes.sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
