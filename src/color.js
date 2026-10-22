// Colour, as zega's CLI does it (zegadb/cli src/utils/pretty.ts and chalk's
// terminal detection), without a dependency.
//
// JSON on a terminal is pretty-printed (2 spaces) and coloured as an editor
// shows a package.json: keys cyan, strings green, numbers and literals yellow,
// punctuation dim. Piped it is one compact line, uncoloured; `--nopretty`
// forces the compact line on a terminal too. Help is always pretty, coloured
// only on a terminal. `--human` text uses the same muted colours.
//
// Whether a stream gets colour: FORCE_COLOR (0 or false: never; 1, 2, 3 or
// empty: always), then NO_COLOR (set: never), then the stream must be a
// terminal whose TERM isn't "dumb". COLORTERM=truecolor/24bit or a 256-colour
// TERM raises the level, as chalk does.

/** @typedef {0 | 1 | 2 | 3} Level */

/**
 * @param {{isTTY?: boolean}} stream
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Level}
 */
export function colorLevel(stream, env = process.env) {
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 0;
    if (force === '2' || force === '3') return /** @type {Level} */ (Number(force));
    return 1;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
  if (stream.isTTY !== true || env.TERM === 'dumb') return 0;
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 3;
  if (/-256(color)?$/i.test(env.TERM ?? '')) return 2;
  return 1;
}

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  cyan: [36, 39],
};

/** @typedef {(text: string) => string} Paint */
/** @typedef {{[K in keyof typeof CODES]: Paint} & {level: Level}} Colors */

/** @param {Level} level @returns {Colors} */
export function colors(level) {
  /** @type {any} */
  const c = { level };
  for (const [name, [open, close]] of Object.entries(CODES)) {
    c[name] = level === 0 ? (/** @type {string} */ s) => s : (/** @type {string} */ s) => `\x1b[${open}m${s}\x1b[${close}m`;
  }
  return c;
}

/** Colours for a stream, by its terminal and the environment. @param {{isTTY?: boolean}} stream */
export function colorsFor(stream) {
  return colors(colorLevel(stream));
}

const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g;

/** JSON text coloured as zega colours it. @param {string} text @param {Colors} c */
export function paint(text, c) {
  return text.replace(TOKEN, (found, string, colon) => {
    if (string !== undefined) return colon === undefined ? c.green(string) : c.cyan(string) + c.dim(colon);
    return /^[{}[\],:]$/.test(found) ? c.dim(found) : c.yellow(found);
  });
}

/**
 * A value as the text to print, newline included.
 * @param {unknown} value
 * @param {{isTTY?: boolean}} stream
 * @param {{nopretty?: boolean, always?: boolean}} [options] always: pretty even when piped (the help)
 */
export function formatJson(value, stream, options = {}) {
  const terminal = stream.isTTY === true && options.nopretty !== true;
  if (!terminal && options.always !== true) return JSON.stringify(value) + '\n';
  const text = JSON.stringify(value, null, 2);
  return (terminal ? paint(text, colorsFor(stream)) : text) + '\n';
}
