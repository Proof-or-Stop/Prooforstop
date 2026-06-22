// Known-good reference solution — used ONLY to validate acceptance.mjs (S4).
// NOT shown to the solver arms.
export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');
  const s = input.trim();
  if (s === '') return [];
  const out = new Set();
  for (const rawTok of s.split(',')) {
    const tok = rawTok.trim();
    if (tok === '') throw new Error('empty token');
    if (tok.includes('-')) {
      const parts = tok.split('-');
      if (parts.length !== 2) throw new Error('malformed range: ' + tok);
      const a = Number(parts[0].trim());
      const b = Number(parts[1].trim());
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('non-integer range bound: ' + tok);
      if (a > b) throw new Error('reversed range: ' + tok);
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      const n = Number(tok);
      if (!Number.isInteger(n)) throw new Error('non-integer token: ' + tok);
      out.add(n);
    }
  }
  return [...out].sort((x, y) => x - y);
}
