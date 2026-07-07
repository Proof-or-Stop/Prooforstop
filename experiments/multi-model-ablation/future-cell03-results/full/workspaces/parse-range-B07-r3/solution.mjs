export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');

  const source = input.trim();
  if (source === '') return [];

  const values = new Set();
  const integerPattern = '-?\\d+';
  const singlePattern = new RegExp(`^${integerPattern}$`);
  const rangePattern = new RegExp(`^(${integerPattern})-(${integerPattern})$`);

  for (const rawToken of source.split(',')) {
    const token = rawToken.trim();
    if (token === '') throw new Error('empty token');

    const rangeMatch = token.match(rangePattern);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start > end) throw new Error('reversed range');
      for (let value = start; value <= end; value += 1) values.add(value);
      continue;
    }

    if (singlePattern.test(token)) {
      values.add(Number(token));
      continue;
    }

    throw new Error('malformed token: ' + token);
  }

  return [...values].sort((a, b) => a - b);
}
