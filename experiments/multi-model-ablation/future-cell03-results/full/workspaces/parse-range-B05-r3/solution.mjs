export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');

  const s = input.trim();
  if (s === '') return [];

  const out = new Set();
  const integer = '[+-]?\\d+';
  const numberPattern = new RegExp(`^${integer}$`);
  const rangePattern = new RegExp(`^(${integer})\\s*-\\s*(${integer})$`);

  for (const rawTok of s.split(',')) {
    const tok = rawTok.trim();
    if (tok === '') throw new Error('empty token');

    const rangeMatch = tok.match(rangePattern);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      if (a > b) throw new Error('reversed range');
      for (let i = a; i <= b; i++) out.add(i);
      continue;
    }

    if (numberPattern.test(tok)) {
      const n = Number(tok);
      out.add(n);
    } else {
      throw new Error('malformed token: ' + tok);
    }
  }

  return [...out].sort((x, y) => x - y);
}
