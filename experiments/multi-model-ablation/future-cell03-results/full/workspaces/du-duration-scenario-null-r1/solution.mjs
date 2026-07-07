export default function formatDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 0) {
    throw new Error("seconds must be a non-negative integer");
  }

  if (seconds === 0) {
    return "0s";
  }

  const units = [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ];

  let remaining = seconds;
  const parts = units.map(([suffix, size]) => {
    const value = Math.floor(remaining / size);
    remaining %= size;
    return { value, suffix };
  });

  let first = 0;
  while (first < parts.length && parts[first].value === 0) {
    first += 1;
  }

  let last = parts.length - 1;
  while (last >= 0 && parts[last].value === 0) {
    last -= 1;
  }

  return parts
    .slice(first, last + 1)
    .map(({ value, suffix }) => `${value}${suffix}`)
    .join(" ");
}
