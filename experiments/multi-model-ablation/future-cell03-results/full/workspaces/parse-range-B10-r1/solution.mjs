export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');

  if (input.trim() === '') return [];

  const integerPattern = /^[+-]?\d+$/;
  const rangePattern = /^([+-]?\d+)-([+-]?\d+)$/;
  const values = new Set();

  const parseInteger = (token) => {
    if (!integerPattern.test(token)) throw new Error('invalid integer: ' + token);
    const value = Number(token);
    if (!Number.isSafeInteger(value)) throw new Error('integer out of range: ' + token);
    return value;
  };

  for (const rawToken of input.split(',')) {
    const token = rawToken.trim();
    if (token === '') throw new Error('empty token');

    const rangeMatch = token.match(rangePattern);
    if (rangeMatch) {
      const start = parseInteger(rangeMatch[1]);
      const end = parseInteger(rangeMatch[2]);
      if (start > end) throw new Error('reversed range');

      for (let value = start; value <= end; value++) {
        values.add(value);
      }
    } else {
      values.add(parseInteger(token));
    }
  }

  return [...values].sort((left, right) => left - right);
}
