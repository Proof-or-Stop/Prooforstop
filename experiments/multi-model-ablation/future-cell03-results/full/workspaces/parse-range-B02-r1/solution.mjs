const INTEGER_PATTERN = /^[+-]?\d+$/;
const RANGE_PATTERN = /^([+-]?\d+)\s*-\s*([+-]?\d+)$/;

function parseInteger(value) {
  if (!INTEGER_PATTERN.test(value)) {
    throw new Error(`invalid integer: ${value}`);
  }

  return Number(value);
}

export default function parseRange(input) {
  if (typeof input !== 'string') {
    throw new Error('input must be a string');
  }

  if (input.trim() === '') {
    return [];
  }

  const values = new Set();

  for (const rawToken of input.split(',')) {
    const token = rawToken.trim();

    if (token === '') {
      throw new Error('empty token');
    }

    const rangeMatch = token.match(RANGE_PATTERN);

    if (rangeMatch) {
      const start = parseInteger(rangeMatch[1]);
      const end = parseInteger(rangeMatch[2]);

      if (start > end) {
        throw new Error('reversed range');
      }

      for (let value = start; value <= end; value += 1) {
        values.add(value);
      }
    } else {
      values.add(parseInteger(token));
    }
  }

  return [...values].sort((left, right) => left - right);
}
