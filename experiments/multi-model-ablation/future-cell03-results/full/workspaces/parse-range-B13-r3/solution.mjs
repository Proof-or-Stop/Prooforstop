const INTEGER_PATTERN = /^[+-]?\d+$/;
const RANGE_PATTERN = /^([+-]?\d+)\s*-\s*([+-]?\d+)$/;

function toInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error('integer out of range: ' + value);
  }
  return number;
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
      throw new Error('malformed token');
    }

    const range = token.match(RANGE_PATTERN);
    if (range) {
      const start = toInteger(range[1]);
      const end = toInteger(range[2]);

      if (start > end) {
        throw new Error('reversed range');
      }

      for (let value = start; value <= end; value += 1) {
        values.add(value);
      }
      continue;
    }

    if (!INTEGER_PATTERN.test(token)) {
      throw new Error('malformed token');
    }

    values.add(toInteger(token));
  }

  return [...values].sort((left, right) => left - right);
}
