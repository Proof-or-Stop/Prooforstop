// Money / decimal rounder with selectable rounding mode.
// Strategy: scale by 10^places, round at integer granularity per mode, unscale.

function roundHalfUpInt(x) {
  // round half away from zero at integer granularity
  if (x >= 0) return Math.floor(x + 0.5);
  return -Math.floor(-x + 0.5);
}

function roundHalfEvenInt(x) {
  // banker's rounding at integer granularity (sign-symmetric)
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const fl = Math.floor(a);
  const frac = a - fl;
  let r;
  if (frac < 0.5) {
    r = fl;
  } else if (frac > 0.5) {
    r = fl + 1;
  } else {
    r = fl % 2 === 0 ? fl : fl + 1;
  }
  return r === 0 ? 0 : sign * r;
}

function applyMode(scaled, mode) {
  switch (mode) {
    case 'half-up':   return roundHalfUpInt(scaled);
    case 'half-even': return roundHalfEvenInt(scaled);
    case 'floor':     return Math.floor(scaled);
    case 'ceil':      return Math.ceil(scaled);
    default:          throw new Error(`Unknown rounding mode: '${mode}'`);
  }
}

export default function roundMoney(amount, places, mode) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new TypeError('amount must be a finite number');
  }
  const p = places === undefined ? 2 : places;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 0) {
    throw new RangeError('places must be a non-negative integer');
  }
  const m = mode === undefined ? 'half-even' : mode;
  if (typeof m !== 'string') throw new Error('mode must be a string');

  const factor = Math.pow(10, p);
  const scaled = amount * factor;
  const rounded = applyMode(scaled, m);
  return rounded / factor;
}
