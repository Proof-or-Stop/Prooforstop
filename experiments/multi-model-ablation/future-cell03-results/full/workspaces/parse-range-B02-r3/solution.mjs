const integerPattern = /^[+-]?\d+$/;
const rangePattern = /^([+-]?\d+)\s*-\s*([+-]?\d+)$/;

function parseInteger(token) {
  if (!integerPattern.test(token)) {
    throw new Error(`invalid integer: ${token}`);
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
      throw new Error('malformed token');
    }

    const rangeMatch = token.match(rangePattern);
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
