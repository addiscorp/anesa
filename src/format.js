// Sizes the way `du -h` writes them, and back.

/** @param {number} bytes */
export function human(bytes) {
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  if (i === 0) return `${n}B`;
  return n < 10 ? `${(Math.ceil(n * 10) / 10).toFixed(1)}${units[i]}` : `${Math.ceil(n)}${units[i]}`;
}

/** "100M", "1.5G", "4096" → bytes, or NaN. @param {string} s */
export function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)\s*([BKMGTP]?)i?B?$/i.exec(s.trim());
  if (!m) return NaN;
  const pow = 'BKMGTP'.indexOf((m[2] || 'B').toUpperCase());
  return Math.round(Number(m[1]) * 1024 ** pow);
}

/** 1234567 → "1,234,567". @param {number} n */
export const count = (n) => n.toLocaleString('en-US');
