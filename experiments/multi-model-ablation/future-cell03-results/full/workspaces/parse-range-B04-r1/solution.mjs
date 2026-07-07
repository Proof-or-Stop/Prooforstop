const TOKEN_PATTERN = /^(-?\d+)(?:-(-?\d+))?$/;

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
    const match = TOKEN_PATTERN.exec(token);

    if (!match) {
      throw new Error(`malformed token: ${token}`);
    }

    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new Error(`invalid integer: ${token}`);
    }

    if (start > end) {
      throw new Error(`reversed range: ${token}`);
    }

    for (let value = start; value <= end; value += 1) {
      values.add(value);
    }
  }

  return [...values].sort((left, right) => left - right);
}
