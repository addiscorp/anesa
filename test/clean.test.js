import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planClean, refusal, runClean } from '../src/clean.js';
import { alive, child, exists, fixture, removeFixture, runCli } from './helpers.js';

/** @type {string[]} */ const fixtures = [];
/** @type {{kill: () => void}[]} */ const kids = [];
after(() => { for (const k of kids) k.kill(); for (const f of fixtures) removeFixture(f); });

async function workdir(name = 'clean') {
  const d = await fixture(name);
  fixtures.push(d);
  await fs.mkdir(path.join(d, 'target', 'sub'), { recursive: true });
  await fs.writeFile(path.join(d, 'target', 'sub', 'f.txt'), 'data');
  return d;
}

// Fast settings for tests; the CLI uses 10 s / 3 s like the zsh.
const fast = { termWaitMs: 600, settleMs: 100, systemPlistDirs: [] };

test('refuses dangerous roots (path check only, before anything is looked at)', () => {
  const home = os.homedir();
  for (const d of ['/', home, path.dirname(home), '/Users', '/home', '/Volumes', '/Volumes/Projects', '/Volumes/Other',
    '/System', '/System/Library/CoreServices', '/Library', '/Library/Caches', '/Applications', '/Applications/Foo.app',
    '/usr', '/usr/local', '/etc', '/var/log', '/private/tmp', '/opt/homebrew', '/Users/someone', '/home/someone', '/mnt/disk', '/tmp']) {
    assert.ok(refusal(d, { home }), `should refuse ${d}`);
  }
  for (const d of ['/Volumes/Projects/claude/old-checkout', '/Users/someone/project', '/home/someone/x/target', '/tmp/x/y']) {
    assert.equal(refusal(d, { home }), null, `should allow ${d}`);
  }
});

test('planClean refuses a dangerous root and a non-folder', async () => {
  const r = await planClean('/');
  assert.deepEqual([r.ok, !r.ok && r.code], [false, 'refused']);
  const d = await workdir();
  const f = path.join(d, 'target', 'sub', 'f.txt');
  const r2 = await planClean(f);
  assert.deepEqual([r2.ok, !r2.ok && r2.code], [false, 'not_a_folder']);
});

test('a system launch agent pointing in: refuses, touches nothing', async () => {
  const d = await workdir();
  const sys = await fixture('sysagents'); fixtures.push(sys);
  await fs.writeFile(path.join(sys, 'com.example.thing.plist'), `<string>${path.join(d, 'target')}/run.sh</string>`);
  const kid = await child(path.join(d, 'target')); kids.push(kid);
  const r = await planClean(d, { ...fast, systemPlistDirs: [sys] });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'system_agents');
  assert.deepEqual(r.plan?.systemAgents, [path.join(sys, 'com.example.thing.plist')]);
  assert.ok(await exists(d));
  assert.ok(alive(kid.pid));
});

test('sccache and this process are never in the plan', async () => {
  const d = await workdir();
  const listProcesses = async () => [
    { pid: 999991, command: 'sccache', via: /** @type {const} */ ('exe'), path: path.join(d, 'target', 'sccache') },
    { pid: process.pid, command: 'node', via: /** @type {const} */ ('cwd'), path: d },
    { pid: 999992, command: 'cargo', via: /** @type {const} */ ('cwd'), path: path.join(d, 'target') },
  ];
  const r = await planClean(d, { ...fast, listProcesses });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.plan.processes.map((p) => p.pid), [999992]);
});

test('stops a child running inside, unloads a user launch agent, deletes the folder', async () => {
  const d = await workdir();
  const home = await fixture('home'); fixtures.push(home);
  const agents = path.join(home, 'Library', 'LaunchAgents');
  await fs.mkdir(agents, { recursive: true });
  const plist = path.join(agents, 'dev.server.plist');
  await fs.writeFile(plist, `<string>${d}/target/serve</string>`);
  await fs.writeFile(path.join(agents, 'unrelated.plist'), '<string>/somewhere/else</string>');
  /** @type {string[][]} */ const launchctlCalls = [];
  const launchctl = async (/** @type {string[]} */ a) => { launchctlCalls.push(a); return 0; };

  const kid = await child(path.join(d, 'target', 'sub')); kids.push(kid);
  const planned = await planClean(d, { ...fast, home, launchctl });
  assert.ok(planned.ok, JSON.stringify(planned));
  assert.ok(planned.ok && planned.plan.processes.some((p) => p.pid === kid.pid));
  assert.deepEqual(planned.ok && planned.plan.launchAgents, [plist]);

  const r = await runClean(planned.ok ? planned.plan : /** @type {never} */ (null), { ...fast, home, launchctl });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(await kid.exited, { code: null, signal: 'SIGTERM' });
  assert.equal(await exists(d), false);
  assert.equal(await exists(plist), false);
  assert.ok(await exists(`${plist}.disabled-by-clean`));
  assert.ok(await exists(path.join(agents, 'unrelated.plist')));
  assert.deepEqual(launchctlCalls.map((a) => [a[0], a[2]]), [['bootout', plist]]);
});

test('a child that ignores TERM is killed after the wait', async () => {
  const d = await workdir();
  const kid = await child(d, { ignoreTerm: true }); kids.push(kid);
  const planned = await planClean(d, fast);
  assert.ok(planned.ok);
  const r = await runClean(planned.ok ? planned.plan : /** @type {never} */ (null), fast);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.done.killed.map((p) => p.pid), [kid.pid]);
  assert.deepEqual(await kid.exited, { code: null, signal: 'SIGKILL' });
  assert.equal(await exists(d), false);
});

test('prunes git worktree records of worktrees that were inside', async () => {
  const repo = await fixture('repo'); fixtures.push(repo);
  const d = await workdir();
  const git = (/** @type {string[]} */ ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  git('worktree', 'add', '-q', path.join(d, 'wt'), '-b', 'wt');
  assert.match(git('worktree', 'list'), /\/wt /);
  const planned = await planClean(d, fast);
  assert.ok(planned.ok);
  assert.deepEqual(planned.ok && planned.plan.gitRepos, [await fs.realpath(path.join(repo, '.git'))]);
  const r = await runClean(planned.ok ? planned.plan : /** @type {never} */ (null), fast);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.doesNotMatch(git('worktree', 'list'), /\/wt /);
});

test('CLI without a terminal and without --yes changes nothing', async () => {
  const d = await workdir();
  const kid = await child(d); kids.push(kid);
  const r = /** @type {any} */ (await runCli(['clean', d]));
  assert.equal(r.code, 1);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, 'needs_yes');
  assert.ok(err.error.plan.processes.some((/** @type {any} */ p) => p.pid === kid.pid));
  assert.ok(await exists(path.join(d, 'target', 'sub', 'f.txt')));
  assert.ok(alive(kid.pid));
});

test('CLI clean --yes stops the child and deletes the folder', async () => {
  const d = await workdir();
  const kid = await child(path.join(d, 'target')); kids.push(kid);
  const r = /** @type {any} */ (await runCli(['clean', d, '--yes', '--nopretty']));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.done.deleted, true);
  assert.ok(out.done.stopped.some((/** @type {any} */ p) => p.pid === kid.pid));
  assert.deepEqual(await kid.exited, { code: null, signal: 'SIGTERM' });
  assert.equal(await exists(d), false);
});

// Never point the CLI itself at a real dangerous root with --yes: if the guard
// were broken, the test would be the disaster. The guard is tested on the
// planner above; here only the CLI's error shape.
test('CLI errors are JSON on stderr with a code; --human writes text', async () => {
  const d = await workdir();
  const f = path.join(d, 'target', 'sub', 'f.txt');
  const r = /** @type {any} */ (await runCli(['clean', f, '--yes']));
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stderr).error.code, 'not_a_folder');
  const u = /** @type {any} */ (await runCli(['clean']));
  assert.equal(u.code, 1);
  assert.deepEqual(Object.keys(JSON.parse(u.stderr).error), ['code', 'message', 'hint']);
  const h = /** @type {any} */ (await runCli(['clean', f, '--human']));
  assert.match(h.stderr, /isn't a folder/);
  assert.ok(await exists(f));
});
