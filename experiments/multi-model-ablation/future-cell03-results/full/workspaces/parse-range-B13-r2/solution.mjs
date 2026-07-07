export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');

  if (input.trim() === '') return [];

  const values = new Set();
  const integerPattern = /^[+-]?\d+$/;
  const rangePattern = /^([+-]?\d+)\s*-\s*([+-]?\d+)$/;

  for (const rawToken of input.split(',')) {
    const token = rawToken.trim();

    if (token === '') {
      throw new Error('malformed token');
    }

    const rangeMatch = token.match(rangePattern);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);

      if (start > end) {
        throw new Error('reversed range');
      }

      for (let value = start; value <= end; value += 1) {
        values.add(value);
      }
      continue;
    }

    if (!integerPattern.test(token)) {
      throw new Error('malformed token');
    }

    values.add(Number(token));
  }

  return [...values].sort((a, b) => a - b);
}
