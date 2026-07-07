export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');
  const s = input.trim();
  if (s === '') return [];

  const integerPattern = /^[+-]?\d+$/;
  const rangePattern = /^([+-]?\d+)-([+-]?\d+)$/;

  const parseInteger = (value) => {
    if (!integerPattern.test(value)) throw new Error('invalid number: ' + value);
    const number = Number(value);
    if (!Number.isInteger(number)) throw new Error('invalid number: ' + value);
    return number;
  };

  const out = new Set();
  for (const rawTok of s.split(',')) {
    const tok = rawTok.trim();
    if (tok === '') throw new Error('empty token');

    if (integerPattern.test(tok)) {
      out.add(parseInteger(tok));
    } else {
      const match = tok.match(rangePattern);
      if (!match) throw new Error('malformed token: ' + tok);

      const a = parseInteger(match[1]);
      const b = parseInteger(match[2]);
      if (a > b) throw new Error('reversed range');
      for (let i = a; i <= b; i++) out.add(i);
    }
  }
  return [...out].sort((x, y) => x - y);
}
