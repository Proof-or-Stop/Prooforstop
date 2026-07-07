export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');
  const s = input.trim();
  if (s === '') return [];

  const integerPattern = /^-?\d+$/;
  const rangePattern = /^(-?\d+)-(-?\d+)$/;
  const out = new Set();

  for (const rawTok of s.split(',')) {
    const tok = rawTok.trim();
    if (tok === '') throw new Error('empty token');

    if (integerPattern.test(tok)) {
      out.add(Number(tok));
      continue;
    }

    const range = tok.match(rangePattern);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > b) throw new Error('reversed range');
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      throw new Error('malformed token: ' + tok);
    }
  }

  return [...out].sort((x, y) => x - y);
}
