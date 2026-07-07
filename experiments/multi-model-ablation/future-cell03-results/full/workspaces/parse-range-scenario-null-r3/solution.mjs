const INTEGER_PATTERN = "[+-]?\\d+";
const INTEGER_RE = new RegExp(`^${INTEGER_PATTERN}$`);
const RANGE_RE = new RegExp(`^(${INTEGER_PATTERN})\\s*-\\s*(${INTEGER_PATTERN})$`);

export default function parseRange(input) {
  if (typeof input !== "string") {
    throw new Error("Input must be a string");
  }

  if (input.trim() === "") {
    return [];
  }

  const values = new Set();

  for (const rawToken of input.split(",")) {
    const token = rawToken.trim();

    if (token === "") {
      throw new Error("Invalid empty token");
    }

    if (INTEGER_RE.test(token)) {
      values.add(Number(token));
      continue;
    }

    const rangeMatch = token.match(RANGE_RE);
    if (!rangeMatch) {
      throw new Error(`Invalid token: ${token}`);
    }

    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);

    if (start > end) {
      throw new Error(`Invalid reversed range: ${token}`);
    }

    for (let value = start; value <= end; value += 1) {
      values.add(value);
    }
  }

  return [...values].sort((a, b) => a - b);
}
