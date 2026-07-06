export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');

  const source = input.trim();
  if (source === '') return [];

  const values = new Set();
  for (const rawToken of source.split(',')) {
    const token = rawToken.trim();
    if (token === '') throw new Error('empty token');

    const single = token.match(/^[+-]?\d+$/);
    if (single) {
      values.add(Number(token));
      continue;
    }

    const range = token.match(/^([+-]?\d+)\s*-\s*([+-]?\d+)$/);
    if (!range) throw new Error('malformed token: ' + token);

    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start > end) throw new Error('reversed range');

    for (let value = start; value <= end; value++) {
      values.add(value);
    }
  }

  return [...values].sort((a, b) => a - b);
}
