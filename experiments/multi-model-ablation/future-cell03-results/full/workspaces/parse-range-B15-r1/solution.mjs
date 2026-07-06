export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');
  const s = input.trim();
  if (s === '') return [];

  const parseInteger = (value) => {
    if (!/^[+-]?\d+$/.test(value)) throw new Error('invalid integer: ' + value);
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('invalid integer: ' + value);
    return number;
  };

  const out = new Set();
  for (const rawTok of s.split(',')) {
    const tok = rawTok.trim();
    if (tok === '') throw new Error('empty token');
    const rangeMatch = tok.match(/^([+-]?\d+)\s*-\s*([+-]?\d+)$/);
    if (rangeMatch) {
      const a = parseInteger(rangeMatch[1]);
      const b = parseInteger(rangeMatch[2]);
      if (a > b) throw new Error('reversed range');
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      out.add(parseInteger(tok));
    }
  }
  return [...out].sort((x, y) => x - y);
}
