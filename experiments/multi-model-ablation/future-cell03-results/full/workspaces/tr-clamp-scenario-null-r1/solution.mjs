export default function mapRange(value, inMin, inMax, outMin, outMax) {
  for (const argument of [value, inMin, inMax, outMin, outMax]) {
    if (typeof argument !== "number" || !Number.isFinite(argument)) {
      throw new Error("mapRange arguments must be finite numbers");
    }
  }

  if (inMin === inMax) {
    throw new Error("Input interval must not be degenerate");
  }

  if (value <= inMin) {
    return outMin;
  }

  if (value >= inMax) {
    return outMax;
  }

  const ratio = (value - inMin) / (inMax - inMin);
  const mapped = Math.round(outMin + ratio * (outMax - outMin));
  const low = Math.min(outMin, outMax);
  const high = Math.max(outMin, outMax);

  return Math.min(Math.max(mapped, low), high);
}
