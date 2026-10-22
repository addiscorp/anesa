import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inside, listProcessPaths, selfAndAncestors } from '../src/procs.js';
import { child, fixture, removeFixture, runCli } from './helpers.js';

let root = '';
/** @type {Awaited<ReturnType<typeof child>> | null} */ let kid = null;

before(async () => {
  root = await fixture('procs');
  await fs.mkdir(path.join(root, 'server', 'app', 'deep'), { recursive: true });
  await fs.mkdir(path.join(root, 'quiet'));
  kid = await child(path.join(root, 'server', 'app', 'deep'));
});

after(() => { kid?.kill(); removeFixture(root); });

test('a child started inside a folder is found by its working directory, with pid and command', async () => {
  const all = await listProcessPaths();
  const found = inside(all, root);
  const me = found.find((p) => p.pid === kid?.pid);
  assert.ok(me, `pid ${kid?.pid} not among ${JSON.stringify(found)}`);
  assert.equal(me.via, 'cwd');
  assert.equal(me.path, path.join(root, 'server', 'app', 'deep'));
  assert.match(me.command, /node/);
  // Not reported for a sibling folder.
  assert.ok(!inside(all, path.join(root, 'quiet')).some((p) => p.pid === kid?.pid));
});

test('this process and its parents are never reported', async () => {
  const ex = await selfAndAncestors();
  assert.ok(ex.has(process.pid));
  assert.ok(ex.has(process.ppid));
  const fake = [{ pid: process.pid, command: 'node', via: /** @type {const} */ ('cwd'), path: path.join(root, 'x') }];
  assert.deepEqual(inside(fake, root, { exclude: ex }), []);
});

test('the report lists the process under its top-level folder', async () => {
  const r = /** @type {any} */ (await runCli([root, '--nopretty']));
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const p = report.processes.find((x) => x.pid === kid?.pid);
  assert.deepEqual({ folder: p?.folder, via: p?.via }, { folder: 'server', via: 'cwd' });
  const h = /** @type {any} */ (await runCli([root, '--human']));
  assert.match(h.stdout, new RegExp(`• server .*\\n(.*\\n)*\\s+⚠ running: node \\(pid ${kid?.pid}\\) in server/app/deep`));
});
