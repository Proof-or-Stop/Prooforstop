export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');

  const source = input.trim();
  if (source === '') return [];

  const values = new Set();
  const integerPattern = /^[+-]?\d+$/;
  const rangePattern = /^([+-]?\d+)\s*-\s*([+-]?\d+)$/;

  for (const rawToken of source.split(',')) {
    const token = rawToken.trim();
    if (token === '') throw new Error('empty token');

    if (integerPattern.test(token)) {
      values.add(Number(token));
      continue;
    }

    const range = token.match(rangePattern);
    if (!range) throw new Error('malformed token: ' + token);

    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start > end) throw new Error('reversed range');

    for (let value = start; value <= end; value += 1) {
      values.add(value);
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}
