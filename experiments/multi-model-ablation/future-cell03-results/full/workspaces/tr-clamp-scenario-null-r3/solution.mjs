export default function mapRange(value, inMin, inMax, outMin, outMax) {
  const args = [value, inMin, inMax, outMin, outMax];

  if (!args.every(Number.isFinite)) {
    throw new Error('All arguments must be finite numbers');
  }

  if (inMin === inMax) {
    throw new Error('Input range must not be degenerate');
  }

  if (value <= inMin) {
    return outMin;
  }

  if (value >= inMax) {
    return outMax;
  }

  const ratio = (value - inMin) / (inMax - inMin);
  const mapped = outMin + ratio * (outMax - outMin);
  const rounded = Math.round(mapped);
  const low = Math.min(outMin, outMax);
  const high = Math.max(outMin, outMax);

  return Math.min(high, Math.max(low, rounded));
}
