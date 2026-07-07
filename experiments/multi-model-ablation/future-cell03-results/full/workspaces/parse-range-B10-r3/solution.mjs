export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');
  const s = input.trim();
  if (s === '') return [];

  const integerPattern = '[+-]?\\d+';
  const singleInteger = new RegExp(`^${integerPattern}$`);
  const rangePattern = new RegExp(`^(${integerPattern})\\s*-\\s*(${integerPattern})$`);

  const out = new Set();
  for (const rawTok of s.split(',')) {
    const tok = rawTok.trim();
    if (tok === '') throw new Error('empty token');

    const range = tok.match(rangePattern);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > b) throw new Error('reversed range');
      for (let i = a; i <= b; i++) out.add(i);
    } else if (singleInteger.test(tok)) {
      const n = Number(tok);
      out.add(n);
    } else {
      throw new Error('malformed token: ' + tok);
    }
  }
  return [...out].sort((x, y) => x - y);
}
