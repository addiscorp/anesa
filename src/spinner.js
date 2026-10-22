// Progress on stderr while a long walk runs; stdout stays clean either way.
// On a terminal it's a spinner (redrawn in place). Piped, as agents run it,
// it's one compact JSON line every few seconds instead (zega's rule for a
// stream of events: one line each), starting only once the walk has been
// running that long, so a quick scan prints nothing extra. --quiet: neither.
import { colorsFor } from './color.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * @param {boolean} enabled
 * @param {() => string} text what to show next to the spinner, read each frame
 * @param {() => Record<string, unknown>} event what a piped progress line carries
 * @param {NodeJS.WriteStream} [stream]
 * @param {number} [every] ms between piped progress lines
 * @returns {{stop: () => void}}
 */
export function spinner(enabled, text, event, stream = process.stderr, every = 5000) {
  if (!enabled) return { stop() {} };
  if (stream.isTTY !== true) {
    const started = Date.now();
    const timer = setInterval(() => {
      stream.write(JSON.stringify({ progress: { ...event(), elapsedMs: Date.now() - started } }) + '\n');
    }, every);
    timer.unref();
    return { stop() { clearInterval(timer); } };
  }
  const c = colorsFor(stream);
  const started = Date.now();
  let frame = 0;
  const draw = () => {
    const secs = Math.floor((Date.now() - started) / 1000);
    const line = `${c.cyan(FRAMES[frame++ % FRAMES.length])} ${text()} ${c.dim(`${secs}s`)}`;
    // Cut to the terminal's width so the line never wraps (a wrapped line
    // can't be cleared with \r).
    stream.write(`\r\x1b[2K${fit(line, (stream.columns || 80) - 1)}`);
  };
  const restore = () => stream.write('\r\x1b[2K\x1b[?25h');
  const onExit = () => restore();
  const onSignal = () => { restore(); process.exit(130); };
  stream.write('\x1b[?25l');
  process.once('exit', onExit);
  process.once('SIGINT', onSignal);
  draw();
  const timer = setInterval(draw, 80);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      process.off('exit', onExit);
      process.off('SIGINT', onSignal);
      restore();
    },
  };
}

/** `line` cut to `width` visible characters, escape codes kept. @param {string} line @param {number} width */
function fit(line, width) {
  let visible = 0, out = '';
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) { out += part; continue; }
    const room = width - visible;
    if (room <= 0) continue;
    const chars = [...part];
    out += chars.slice(0, room).join('');
    visible += Math.min(chars.length, room);
  }
  return out + '\x1b[0m';
}
