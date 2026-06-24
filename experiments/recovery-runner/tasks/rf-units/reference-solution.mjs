// Units converter across three independent domains (length / mass / temperature).
// Each domain has a canonical base unit; conversion is value -> base -> target.

// ---- Length: base = metre ----------------------------------------------------
const LENGTH = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  in: 0.0254,
  ft: 0.3048,
  mi: 1609.344,
};

// ---- Mass: base = gram -------------------------------------------------------
const MASS = {
  mg: 0.001,
  g: 1,
  kg: 1000,
  t: 1000000,
  oz: 28.349523125,
  lb: 453.59237,
};

// ---- Temperature: base = degrees Celsius -------------------------------------
// Affine conversions, so we cannot use a single multiplicative factor.
const TEMP_UNITS = new Set(['c', 'f', 'k']);

function tempToCelsius(value, unit) {
  switch (unit) {
    case 'c': return value;
    case 'f': return (value - 32) * 5 / 9;
    case 'k': return value - 273.15;
    default:  throw new Error(`Unknown temperature unit: '${unit}'`);
  }
}

function tempFromCelsius(celsius, unit) {
  switch (unit) {
    case 'c': return celsius;
    case 'f': return celsius * 9 / 5 + 32;
    case 'k': return celsius + 273.15;
    default:  throw new Error(`Unknown temperature unit: '${unit}'`);
  }
}

function domainOf(unit) {
  if (Object.prototype.hasOwnProperty.call(LENGTH, unit)) return 'length';
  if (Object.prototype.hasOwnProperty.call(MASS, unit))   return 'mass';
  if (TEMP_UNITS.has(unit))                               return 'temperature';
  return null;
}

function normalize(u) {
  if (typeof u !== 'string') throw new TypeError('unit must be a string');
  return u.trim().toLowerCase();
}

export default function convert(value, from, to) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('value must be a finite number');
  }
  const f = normalize(from);
  const t = normalize(to);

  const fd = domainOf(f);
  const td = domainOf(t);
  if (fd === null) throw new Error(`Unknown unit: '${from}'`);
  if (td === null) throw new Error(`Unknown unit: '${to}'`);
  if (fd !== td) {
    throw new Error(`Cannot convert across domains: '${from}' (${fd}) -> '${to}' (${td})`);
  }

  if (f === t) return value;

  if (fd === 'length') {
    const base = value * LENGTH[f];   // to metres
    return base / LENGTH[t];          // metres to target
  }

  if (fd === 'mass') {
    const base = value * MASS[f];     // to grams
    return base / MASS[t];            // grams to target
  }

  // temperature
  const celsius = tempToCelsius(value, f);
  return tempFromCelsius(celsius, t);
}
