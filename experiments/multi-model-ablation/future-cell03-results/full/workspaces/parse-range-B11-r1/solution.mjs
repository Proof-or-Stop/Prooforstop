const INTEGER_TOKEN = /^[+-]?\d+$/;
const RANGE_TOKEN = /^([+-]?\d+)\s*-\s*([+-]?\d+)$/;

function toInteger(value) {
  if (!INTEGER_TOKEN.test(value)) {
    throw new Error('invalid integer: ' + value);
  }

  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error('invalid integer: ' + value);
  }

  return number;
}

export default function parseRange(input) {
  if (typeof input !== 'string') {
    throw new Error('input must be a string');
  }

  const trimmed = input.trim();
  if (trimmed === '') {
    return [];
  }

  const values = new Set();

  for (const rawToken of trimmed.split(',')) {
    const token = rawToken.trim();
    if (token === '') {
      throw new Error('empty token');
    }

    const rangeMatch = token.match(RANGE_TOKEN);
    if (rangeMatch) {
      const start = toInteger(rangeMatch[1]);
      const end = toInteger(rangeMatch[2]);

      if (start > end) {
        throw new Error('reversed range: ' + token);
      }

      for (let value = start; value <= end; value += 1) {
        values.add(value);
      }
      continue;
    }

    values.add(toInteger(token));
  }

  return [...values].sort((left, right) => left - right);
}
