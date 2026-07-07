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

    const a = Number(match[1]);
    if (match[2] !== undefined) {
      const b = Number(match[2]);
      if (a > b) throw new Error('reversed range');
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      out.add(a);
    }
  }
  return [...out].sort((x, y) => x - y);
}
