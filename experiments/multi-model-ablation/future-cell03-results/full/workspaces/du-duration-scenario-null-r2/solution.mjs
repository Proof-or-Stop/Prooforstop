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
  const parts = units.map(([suffix, unitSeconds]) => {
    const value = Math.floor(remaining / unitSeconds);
    remaining %= unitSeconds;
    return { value, suffix };
  });

  let start = 0;
  while (start < parts.length && parts[start].value === 0) {
    start += 1;
  }

  let end = parts.length - 1;
  while (end >= start && parts[end].value === 0) {
    end -= 1;
  }

  return parts
    .slice(start, end + 1)
    .map(({ value, suffix }) => `${value}${suffix}`)
    .join(" ");
}
