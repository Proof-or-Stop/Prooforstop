// mapRange: linear remap of `value` from [inMin,inMax] onto [outMin,outMax], clamped to the
// output interval and returned as an integer-valued number. Supports increasing and decreasing
// output intervals.

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function assertFinite(name, x) {
  if (!isFiniteNumber(x)) {
    throw new Error(`mapRange: argument '${name}' must be a finite number, got ${x}`);
  }
}

// Round a real-valued result to the nearest integer using JavaScript's Math.round semantics.
function toInt(x) {
  return Math.round(x);
}

// Clamp an integer result into the inclusive interval defined by the two output bounds, regardless
// of which bound is larger.
function clampToOut(n, outMin, outMax) {
  const lo = Math.min(outMin, outMax);
  const hi = Math.max(outMin, outMax);
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

export default function mapRange(value, inMin, inMax, outMin, outMax) {
  assertFinite('value', value);
  assertFinite('inMin', inMin);
  assertFinite('inMax', inMax);
  assertFinite('outMin', outMin);
  assertFinite('outMax', outMax);

  if (inMin === inMax) {
    throw new Error('mapRange: inMin and inMax must differ (degenerate input interval)');
  }

  // Endpoint clamping pins to the corresponding output bound exactly.
  if (value <= inMin) return toInt(outMin);
  if (value >= inMax) return toInt(outMax);

  // Linear interpolation in real arithmetic.
  const frac = (value - inMin) / (inMax - inMin);
  const raw = outMin + frac * (outMax - outMin);

  // Round to an integer, then clamp defensively into the output interval.
  const rounded = toInt(raw);
  return clampToOut(rounded, outMin, outMax);
}
