export default function roundMoney(amount, places = 2, mode = 'half-even') {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new TypeError('amount must be a finite number');
  }

  if (!Number.isInteger(places) || places < 0) {
    throw new RangeError('places must be a non-negative integer');
  }

  const scale = 10 ** places;
  const scaled = amount * scale;
  let rounded;

  if (mode === 'half-up') {
    rounded = Math.sign(scaled) * Math.floor(Math.abs(scaled) + 0.5);
  } else if (mode === 'half-even') {
    const sign = Math.sign(scaled);
    const abs = Math.abs(scaled);
    const lower = Math.floor(abs);
    const fraction = abs - lower;

    if (fraction < 0.5) {
      rounded = sign * lower;
    } else if (fraction > 0.5) {
      rounded = sign * (lower + 1);
    } else {
      rounded = sign * (lower % 2 === 0 ? lower : lower + 1);
    }
  } else if (mode === 'floor') {
    rounded = Math.floor(scaled);
  } else if (mode === 'ceil') {
    rounded = Math.ceil(scaled);
  } else {
    throw new Error('unknown rounding mode');
  }

  return rounded / scale;
}
