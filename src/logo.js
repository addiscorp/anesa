// The anesa mark: "anesa" in the DOS Rebel figlet font, kept as text so there
// is no dependency. Coloured as zega colours its mark: the solid blocks
// bright, the shaded ░ edge dim.
import { colorsFor } from './color.js';

export const LOGO = [
  '  ██████   ████████    ██████   █████   ██████  ',
  ' ░░░░░███ ░░███░░███  ███░░███ ███░░   ░░░░░███ ',
  '  ███████  ░███ ░███ ░███████ ░░█████   ███████ ',
  ' ███░░███  ░███ ░███ ░███░░░   ░░░░███ ███░░███ ',
  '░░████████ ████ █████░░██████  ██████ ░░████████',
  ' ░░░░░░░░ ░░░░ ░░░░░  ░░░░░░  ░░░░░░   ░░░░░░░░ ',
];

/** The mark for this stream, indented, without a trailing newline. @param {NodeJS.WriteStream} stream */
export function logo(stream) {
  const c = colorsFor(stream);
  return LOGO.map((row) => '  ' + row.trimEnd().replace(/█+|░+/g, (run) => (run[0] === '█' ? c.bold(run) : c.dim(run)))).join('\n');
}
