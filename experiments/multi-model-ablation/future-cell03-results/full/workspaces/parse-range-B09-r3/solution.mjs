export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');
  const trimmedInput = input.trim();
  if (trimmedInput === '') return [];

  const integerPattern = '-?\\d+';
  const integerToken = new RegExp(`^${integerPattern}$`);
  const rangeToken = new RegExp(`^(${integerPattern})\\s*-\\s*(${integerPattern})$`);
  const out = new Set();

  for (const rawTok of trimmedInput.split(',')) {
    const tok = rawTok.trim();
    if (tok === '') throw new Error('empty token');

    const rangeMatch = tok.match(rangeToken);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      if (a > b) throw new Error('reversed range');
      for (let i = a; i <= b; i++) out.add(i);
      continue;
    }

    if (integerToken.test(tok)) {
      const n = Number(tok);
      out.add(n);
    } else {
      throw new Error('malformed token: ' + tok);
    }
  }

  return [...out].sort((x, y) => x - y);
}
