const INTEGER = /^[+-]?\d+$/;
const RANGE = /^([+-]?\d+)-([+-]?\d+)$/;

function parseInteger(value) {
  if (!INTEGER.test(value)) {
    throw new Error(`Invalid token: ${value}`);
  }

  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Invalid integer: ${value}`);
  }

  return number;
}

export default function parseRange(input) {
  if (typeof input !== 'string') {
    throw new Error('Input must be a string');
  }

  const trimmed = input.trim();
  if (trimmed === '') {
    return [];
  }

  const values = new Set();

  for (const rawToken of trimmed.split(',')) {
    const token = rawToken.trim();
    if (token === '') {
      throw new Error('Invalid empty token');
    }

    const rangeMatch = token.match(RANGE);
    if (rangeMatch) {
      const start = parseInteger(rangeMatch[1]);
      const end = parseInteger(rangeMatch[2]);

      if (start > end) {
        throw new Error(`Reversed range: ${token}`);
      }

      for (let value = start; value <= end; value += 1) {
        values.add(value);
      }
      continue;
    }

    values.add(parseInteger(token));
  }

  return [...values].sort((left, right) => left - right);
}
