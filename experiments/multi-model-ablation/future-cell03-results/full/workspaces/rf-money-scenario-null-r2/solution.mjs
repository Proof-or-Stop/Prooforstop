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

  if (mode === 'floor') {
    rounded = Math.floor(scaled);
  } else if (mode === 'ceil') {
    rounded = Math.ceil(scaled);
  } else if (mode === 'half-up') {
    rounded = scaled < 0
      ? Math.ceil(scaled - 0.5)
      : Math.floor(scaled + 0.5);
  } else if (mode === 'half-even') {
    const lower = Math.floor(scaled);
    const fraction = scaled - lower;

    if (fraction < 0.5) {
      rounded = lower;
    } else if (fraction > 0.5) {
      rounded = lower + 1;
    } else {
      rounded = lower % 2 === 0 ? lower : lower + 1;
    }
  } else {
    throw new Error(`unknown rounding mode: ${mode}`);
  }

  return rounded / scale;
}
