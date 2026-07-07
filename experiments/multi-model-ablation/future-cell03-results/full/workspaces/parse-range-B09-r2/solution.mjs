const INTEGER_TOKEN = /^[+-]?\d+$/;
const RANGE_TOKEN = /^([+-]?\d+)\s*-\s*([+-]?\d+)$/;

function parseInteger(text) {
  if (!INTEGER_TOKEN.test(text)) {
    throw new Error('invalid integer: ' + text);
  }

  const value = Number(text);
  if (!Number.isInteger(value)) {
    throw new Error('invalid integer: ' + text);
  }
  return value;
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
      const start = parseInteger(rangeMatch[1]);
      const end = parseInteger(rangeMatch[2]);
      if (start > end) {
        throw new Error('reversed range');
      }

      for (let value = start; value <= end; value += 1) {
        values.add(value);
      }
      continue;
    }

    values.add(parseInteger(token));
  }

  return [...values].sort((a, b) => a - b);
}
