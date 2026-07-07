export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');
  const s = input.trim();
  if (s === '') return [];

  const intPattern = /^[+-]?\d+$/;
  const rangePattern = /^([+-]?\d+)\s*-\s*([+-]?\d+)$/;
  const out = new Set();

  const toInteger = (value) => {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new Error('invalid integer: ' + value);
    return n;
  };

  for (const rawTok of s.split(',')) {
    const tok = rawTok.trim();
    if (tok === '') throw new Error('empty token');

    const range = tok.match(rangePattern);
    if (range) {
      const a = toInteger(range[1]);
      const b = toInteger(range[2]);
      if (a > b) throw new Error('reversed range');
      for (let i = a; i <= b; i++) out.add(i);
      continue;
    }

    if (!intPattern.test(tok)) throw new Error('malformed token: ' + tok);
    out.add(toInteger(tok));
  }

  return [...out].sort((x, y) => x - y);
}
