export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');

  const trimmed = input.trim();
  if (trimmed === '') return [];

  const integerPattern = '[+-]?\\d+';
  const integerRe = new RegExp(`^${integerPattern}$`);
  const rangeRe = new RegExp(`^(${integerPattern})\\s*-\\s*(${integerPattern})$`);
  const values = new Set();

  for (const rawToken of trimmed.split(',')) {
    const token = rawToken.trim();
    if (token === '') throw new Error('empty token');

    const rangeMatch = token.match(rangeRe);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start > end) throw new Error('reversed range');
      for (let value = start; value <= end; value += 1) values.add(value);
      continue;
    }

    if (!integerRe.test(token)) throw new Error('malformed token');
    values.add(Number(token));
  }

  return [...values].sort((a, b) => a - b);
}
