import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorLevel, colors, paint, formatJson } from '../src/color.js';
import { spinner } from '../src/spinner.js';
import { LOGO } from '../src/logo.js';
import { fixture, removeFixture, runCli } from './helpers.js';

const tty = { isTTY: true };
const pipe = { isTTY: false };
const ESC = /\x1b\[/;

test('colour follows the terminal and FORCE_COLOR / NO_COLOR, as chalk does', () => {
  assert.equal(colorLevel(pipe, {}), 0, 'piped: none');
  assert.equal(colorLevel(tty, { TERM: 'xterm' }), 1);
  assert.equal(colorLevel(tty, { TERM: 'xterm-256color' }), 2);
  assert.equal(colorLevel(tty, { TERM: 'xterm', COLORTERM: 'truecolor' }), 3);
  assert.equal(colorLevel(tty, { TERM: 'dumb' }), 0, 'dumb terminal: none');
  assert.equal(colorLevel(tty, { TERM: 'xterm', NO_COLOR: '1' }), 0, 'NO_COLOR wins over a terminal');
  assert.equal(colorLevel(pipe, { FORCE_COLOR: '1' }), 1, 'FORCE_COLOR wins over a pipe');
  assert.equal(colorLevel(tty, { TERM: 'xterm', FORCE_COLOR: '0' }), 0);
  assert.equal(colorLevel(tty, { NO_COLOR: '1', FORCE_COLOR: '1' }), 1, 'FORCE_COLOR wins over NO_COLOR');
});

test('JSON is coloured as zega colours it: keys cyan, strings green, numbers yellow, punctuation dim', () => {
  const c = colors(1);
  const out = paint('{"name": "a", "n": 3, "ok": true}', c);
  assert.ok(out.includes('\x1b[36m"name"\x1b[39m'), 'key cyan');
  assert.ok(out.includes('\x1b[32m"a"\x1b[39m'), 'string green');
  assert.ok(out.includes('\x1b[33m3\x1b[39m'), 'number yellow');
  assert.ok(out.includes('\x1b[33mtrue\x1b[39m'), 'literal yellow');
  assert.ok(out.includes('\x1b[2m{\x1b[22m'), 'punctuation dim');
  assert.equal(paint('{"a": 1}', colors(0)), '{"a": 1}', 'level 0 leaves text alone');
});

test('JSON is one compact line when piped, pretty on a terminal, compact there with --nopretty', () => {
  const v = { a: 1, b: ['x'] };
  assert.equal(formatJson(v, pipe), '{"a":1,"b":["x"]}\n');
  const env = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '0';
  try {
    assert.equal(formatJson(v, tty), JSON.stringify(v, null, 2) + '\n');
    assert.equal(formatJson(v, tty, { nopretty: true }), '{"a":1,"b":["x"]}\n');
    assert.equal(formatJson(v, pipe, { always: true }), JSON.stringify(v, null, 2) + '\n', 'help: pretty when piped');
  } finally {
    if (env === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = env;
  }
});

test('progress: a spinner on a terminal, JSON lines when piped, nothing with --quiet', async () => {
  /** @type {string[]} */ let writes = [];
  const fake = (isTTY) => /** @type {any} */ ({ isTTY, columns: 80, write: (s) => { writes.push(s); return true; } });
  const event = () => ({ stage: 'scanning', files: 3 });

  spinner(false, () => 'x', event, fake(true)).stop();
  spinner(false, () => 'x', event, fake(false), 5).stop();
  assert.equal(writes.length, 0, '--quiet: nothing on a terminal or a pipe');

  const s = spinner(true, () => 'scanning', event, fake(true));
  s.stop();
  assert.ok(writes.some((w) => w.includes('scanning')), 'terminal: draws its text');
  assert.ok(writes.at(-1).endsWith('\x1b[?25h'), 'terminal: clears its line and shows the cursor again');

  writes = [];
  const piped = spinner(true, () => 'x', event, fake(false), 20);
  await new Promise((r) => setTimeout(r, 70));
  piped.stop();
  const n = writes.length;
  assert.ok(n >= 2, `piped: a line every interval (got ${n})`);
  for (const w of writes) {
    assert.ok(!/\x1b\[|\r/.test(w), 'piped: no escape codes or carriage returns');
    const line = JSON.parse(w);
    assert.equal(line.progress.stage, 'scanning');
    assert.equal(line.progress.files, 3);
    assert.equal(typeof line.progress.elapsedMs, 'number');
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(writes.length, n, 'piped: nothing after stop');
});

test('the mark is anesa in DOS Rebel', () => {
  assert.equal(LOGO.length, 6);
  assert.ok(LOGO.every((row) => /^[█░ ]+$/.test(row)));
});

test('piped CLI output: one JSON line, no escape codes; a quick scan adds nothing on stderr', async () => {
  const dir = await fixture('color-cli');
  try {
    const r = await runCli([dir]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'one line');
    assert.ok(!ESC.test(r.stdout), 'no colour when piped');
    JSON.parse(r.stdout);
    const h = await runCli(['--human', dir]);
    assert.ok(!ESC.test(h.stdout) && !ESC.test(h.stderr), 'no colour or spinner in piped --human');
    assert.equal(r.stderr, '', 'a scan under 5 s prints no progress lines');
  } finally {
    await removeFixture(dir);
  }
});
