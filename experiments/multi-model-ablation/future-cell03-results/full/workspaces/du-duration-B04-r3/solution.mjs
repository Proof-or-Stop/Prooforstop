// formatDuration(seconds) — compact human-readable duration string. Specified exactly in prompt.md.
// Trims leading and trailing zero units; KEEPS interior zero units between two non-zero units.

const UNITS = [
  { suffix: 'd', size: 86400 },
  { suffix: 'h', size: 3600 },
  { suffix: 'm', size: 60 },
  { suffix: 's', size: 1 },
];

function validate(seconds) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) {
    throw new Error('formatDuration expects a number, got ' + typeof seconds);
  }
  if (!Number.isInteger(seconds)) {
    throw new Error('formatDuration expects an integer number of seconds, got ' + seconds);
  }
  if (seconds < 0) {
    throw new Error('formatDuration expects a non-negative number of seconds, got ' + seconds);
  }
}

function decompose(seconds) {
  // Returns an array of { suffix, value } in d/h/m/s order.
  const parts = [];
  let rem = seconds;
  for (const u of UNITS) {
    const value = Math.floor(rem / u.size);
    rem -= value * u.size;
    parts.push({ suffix: u.suffix, value });
  }
  return parts;
}

function firstNonZero(parts) {
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].value !== 0) return i;
  }
  return -1;
}

function lastNonZero(parts) {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].value !== 0) return i;
  }
  return -1;
}

export default function formatDuration(seconds) {
  validate(seconds);

  if (seconds === 0) return '0s';

  const parts = decompose(seconds);
  const first = firstNonZero(parts);
  const last = lastNonZero(parts);

  // first/last are both >= 0 here because seconds > 0.
  // Keep the inclusive window [first, last]; interior zeros remain in place.
  const window = parts.slice(first, last + 1);

  return window.map((p) => `${p.value}${p.suffix}`).join(' ');
}
