export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');
  const s = input.trim();
  if (s === '') return [];
  const out = new Set();
  const integerPattern = /^[+-]?\d+$/;
  const rangePattern = /^([+-]?\d+)\s*-\s*([+-]?\d+)$/;
  const parseIntegerLiteral = (text) => {
    const value = Number(text);
    if (!Number.isInteger(value)) throw new Error('invalid integer: ' + text);
    return value;
  };

  for (const rawTok of s.split(',')) {
    const tok = rawTok.trim();
    if (tok === '') throw new Error('empty token');

    if (integerPattern.test(tok)) {
      out.add(parseIntegerLiteral(tok));
      continue;
    }

    const rangeMatch = tok.match(rangePattern);
    if (rangeMatch) {
      const a = parseIntegerLiteral(rangeMatch[1]);
      const b = parseIntegerLiteral(rangeMatch[2]);
      if (a > b) throw new Error('reversed range');
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      throw new Error('malformed token: ' + tok);
    }
  }
  return [...out].sort((x, y) => x - y);
}
