import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scan } from '../src/scan.js';
import { human, parseSize } from '../src/format.js';
import { fixture, removeFixture, writeBytes, runCli } from './helpers.js';

// Small sizes: writes to a busy shared disk can stall for seconds per MB.
const U = 100 * 1024;
let root = '', outside = '';

before(async () => {
  root = await fixture('scan');
  outside = await fixture('outside');
  // Sizes: big (3 U) > app (1 U + more) > small things.
  await writeBytes(path.join(root, 'big', 'blob.bin'), 3 * U);
  await writeBytes(path.join(root, 'app', 'src', 'main.js'), 1 * U);
  await writeBytes(path.join(root, 'app', 'src', 'deep', 'x', 'leaf.txt'), 5000);
  await writeBytes(path.join(root, 'app', 'node_modules', 'dep', 'index.js'), 40 * 1024);
  await writeBytes(path.join(root, 'app', 'node_modules', 'dep', 'node_modules', 'inner', 'i.js'), 10 * 1024);
  await writeBytes(path.join(root, 'rust', 'target', 'debug', 'bin'), 70 * 1024);
  await fs.writeFile(path.join(root, 'rust', 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  await writeBytes(path.join(root, 'tool', 'cachey', 'data'), 20 * 1024);
  await fs.writeFile(path.join(root, 'tool', 'cachey', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  await fs.writeFile(path.join(root, 'empty.txt'), '');
  await fs.writeFile(path.join(root, 'one-byte.txt'), 'x');
  // A hard link: du counts its blocks once. Same folder, so which of the two
  // names gets the blocks doesn't change any folder's total.
  await fs.link(path.join(root, 'big', 'blob.bin'), path.join(root, 'big', 'blob-link.bin'));
  // Symlinks to big things outside: never followed.
  await writeBytes(path.join(outside, 'huge.bin'), 10 * U);
  await fs.symlink(path.join(outside, 'huge.bin'), path.join(root, 'link-to-file'));
  await fs.symlink(outside, path.join(root, 'link-to-dir'));
});

after(() => { removeFixture(root); removeFixture(outside); });

test('total matches du -sk (allocated size, hard links once, symlinks not followed)', async () => {
  const r = await scan(root);
  const du = Number(execFileSync('du', ['-sk', root], { encoding: 'utf8' }).split(/\s/)[0]);
  assert.equal(r.bytes / 1024, du);
  // The 1M behind the symlinks is outside and not counted.
  assert.ok(r.bytes < 10 * U, `got ${r.bytes}`);
});

test('symlinks are entries, not the things they point to', async () => {
  const r = await scan(root, { depth: 1 });
  const link = r.tree.find((n) => n.name === 'link-to-dir');
  assert.equal(link?.type, 'link');
  assert.equal(link?.children, undefined);
  assert.ok(!r.biggest.files.some((f) => f.path.startsWith(outside)));
});

test('junk: well-known names and CACHEDIR.TAG, counted once (nested node_modules inside the outer one)', async () => {
  const r = await scan(root);
  const kinds = Object.keys(r.junk.byKind).sort();
  assert.deepEqual(kinds, ['CACHEDIR.TAG', 'node_modules', 'target']);
  assert.equal(r.junk.count, 3);
  const items = Object.fromEntries(r.junk.items.map((i) => [path.relative(root, i.path), i]));
  assert.deepEqual(Object.keys(items).sort(), ['app/node_modules', 'rust/target', 'tool/cachey']);
  // Each junk total is that folder's whole size: compare with du.
  for (const [rel, item] of Object.entries(items)) {
    const du = Number(execFileSync('du', ['-sk', path.join(root, rel)], { encoding: 'utf8' }).split(/\s/)[0]);
    assert.equal(item.bytes / 1024, du, rel);
  }
  assert.equal(r.junk.bytes, Object.values(items).reduce((s, i) => s + i.bytes, 0));
  // The top-level tree marks them.
  const app = r.tree.find((n) => n.name === 'app');
  assert.equal(app?.children?.find((n) => n.name === 'node_modules')?.junk, 'node_modules');
});

test('depth: 1 lists only the top, 2 adds children, 4 goes four down; biggest first', async () => {
  const d1 = await scan(root, { depth: 1 });
  assert.ok(d1.tree.every((n) => n.children === undefined));
  const names = d1.tree.map((n) => n.name);
  assert.deepEqual(names.slice(0, 3), ['big', 'app', 'rust']);
  for (let i = 1; i < d1.tree.length; i++) assert.ok(d1.tree[i - 1].bytes >= d1.tree[i].bytes);

  const d2 = await scan(root, { depth: 2 });
  const app2 = d2.tree.find((n) => n.name === 'app');
  assert.deepEqual(app2?.children?.map((n) => n.name), ['src', 'node_modules']);
  assert.ok(app2?.children?.every((n) => n.children === undefined));

  const d4 = await scan(root, { depth: 4 });
  const deep = d4.tree.find((n) => n.name === 'app')?.children?.find((n) => n.name === 'src')?.children?.find((n) => n.name === 'deep');
  assert.deepEqual(deep?.children?.map((n) => n.name), ['x']);
  assert.equal(deep?.children?.[0].children, undefined);
});

test('biggest: the n largest folders and files anywhere, largest first', async () => {
  const r = await scan(root, { biggest: 3 });
  assert.equal(r.biggest.dirs.length, 3);
  assert.deepEqual(r.biggest.dirs.map((d) => path.relative(root, d.path)), ['big', 'app', 'app/src']);
  assert.match(path.relative(root, r.biggest.files[0].path), /^big\/blob(-link)?\.bin$/);
  assert.equal(path.relative(root, r.biggest.files[1].path), 'app/src/main.js');
  assert.equal(r.biggest.dirs[0].bytes, (await scan(path.join(root, 'big'))).bytes);
  assert.ok(r.biggest.dirs.every((d, i, a) => i === 0 || a[i - 1].bytes >= d.bytes));
  // Inside junk is marked with the junk it is inside.
  const all = await scan(root, { biggest: 100 });
  assert.equal(all.biggest.dirs.find((d) => d.path.endsWith('node_modules/dep'))?.junk, 'node_modules');
});

test('unreadable folders are counted, not fatal', { skip: process.getuid?.() === 0 && 'root reads everything' }, async () => {
  const locked = path.join(root, 'locked');
  await fs.mkdir(path.join(locked, 'inner'), { recursive: true });
  await fs.chmod(locked, 0o000);
  try {
    const r = await scan(root);
    assert.equal(r.unreadable.count, 1);
    assert.deepEqual(r.unreadable.paths, [locked]);
  } finally {
    await fs.chmod(locked, 0o755);
    removeFixture(locked);
  }
});

test('a file is not a folder', async () => {
  await assert.rejects(scan(path.join(root, 'one-byte.txt')), { code: 'ENOTDIR' });
  const r = /** @type {any} */ (await runCli([path.join(root, 'one-byte.txt')]));
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stderr).error.code, 'not_a_folder');
});

test('JSON report: bytes, junk total, tree pruned by --min-size; --human differs and has sizes', async () => {
  const j = /** @type {any} */ (await runCli([root, '--min-size', '100K', '--nopretty']));
  assert.equal(j.code, 0, j.stderr);
  const r = JSON.parse(j.stdout);
  assert.equal(r.ok, true);
  assert.equal(r.root, root);
  assert.equal(typeof r.bytes, 'number');
  assert.equal(r.junk.count, 3);
  // Top-level folders always listed; below them only >= 100K.
  assert.ok(r.tree.some((n) => n.name === 'tool'));
  const app = r.tree.find((n) => n.name === 'app');
  assert.deepEqual(app.children.map((n) => n.name), ['src']);
  assert.ok(app.children.every((n) => n.bytes >= U));
  const h = /** @type {any} */ (await runCli([root, '--human', '--biggest', '2']));
  assert.equal(h.code, 0, h.stderr);
  assert.match(h.stdout, /^reclaimable: \d/m);
  assert.match(h.stdout, /\[junk: node_modules\]/);
  assert.match(h.stdout, /biggest folders/);
  assert.throws(() => JSON.parse(h.stdout));
});

test('sizes read like du -h', () => {
  assert.equal(human(0), '0B');
  assert.equal(human(4096), '4.0K');
  assert.equal(human(1536 * 1024), '1.5M');
  assert.equal(human(189 * 1024 ** 3), '189G');
  assert.equal(parseSize('100M'), 100 * 1024 * 1024);
  assert.equal(parseSize('4096'), 4096);
  assert.ok(Number.isNaN(parseSize('lots')));
});
