export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');
  const s = input.trim();
  if (s === '') return [];
  const out = new Set();
  for (const rawTok of s.split(',')) {
    const tok = rawTok.trim();
    if (tok === '') throw new Error('empty token');
    const match = tok.match(/^([+-]?\d+)(?:\s*-\s*([+-]?\d+))?$/);
    if (!match) throw new Error('malformed token: ' + tok);

    if (match[2] !== undefined) {
      const a = Number(match[1]);
      const b = Number(match[2]);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('bad bound');
      if (a > b) throw new Error('reversed range');
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      const n = Number(match[1]);
      out.add(n);
    }
  }
  return [...out].sort((x, y) => x - y);
}
