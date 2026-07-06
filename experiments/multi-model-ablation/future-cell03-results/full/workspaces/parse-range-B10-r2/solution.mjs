const INTEGER_TOKEN = /^[+-]?\d+$/;
const RANGE_TOKEN = /^([+-]?\d+)-([+-]?\d+)$/;

function parseIntegerToken(token) {
  if (!INTEGER_TOKEN.test(token)) {
    throw new Error('invalid integer: ' + token);
  }
  return Number(token);
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

    values.add(parseIntegerToken(token));
  }

  return [...values].sort((left, right) => left - right);
}
