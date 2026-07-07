export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');
  const s = input.trim();
  if (s === '') return [];
  const out = new Set();
  const parseInteger = (value) => {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) throw new Error('invalid integer: ' + value);
    return Number(trimmed);
  };

  for (const rawTok of s.split(',')) {
    const tok = rawTok.trim();
    if (tok === '') throw new Error('empty token');
    const rangeMatch = tok.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
    if (rangeMatch) {
      const a = parseInteger(rangeMatch[1]);
      const b = parseInteger(rangeMatch[2]);
      if (a > b) throw new Error('reversed range');
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      const n = parseInteger(tok);
      out.add(n);
    }
  }
  return [...out].sort((x, y) => x - y);
}
