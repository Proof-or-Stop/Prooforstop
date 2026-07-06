export default function mapRange(value, inMin, inMax, outMin, outMax) {
  const args = [value, inMin, inMax, outMin, outMax];

  if (!args.every(Number.isFinite)) {
    throw new Error("mapRange arguments must be finite numbers");
  }

  if (inMin === inMax) {
    throw new Error("input range must not be degenerate");
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

  return Math.min(Math.max(rounded, Math.min(outMin, outMax)), Math.max(outMin, outMax));
}
