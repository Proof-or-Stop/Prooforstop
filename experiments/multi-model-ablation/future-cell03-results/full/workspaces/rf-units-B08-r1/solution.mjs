const identity = (value) => value;

const domains = [
  {
    name: 'length',
    baseUnit: 'm',
    units: {
      mm: { toBase: (value) => value * 0.001, fromBase: (value) => value / 0.001 },
      cm: { toBase: (value) => value * 0.01, fromBase: (value) => value / 0.01 },
      m: { toBase: identity, fromBase: identity },
      km: { toBase: (value) => value * 1000, fromBase: (value) => value / 1000 },
      in: { toBase: (value) => value * 0.0254, fromBase: (value) => value / 0.0254 },
      ft: { toBase: (value) => value * 0.3048, fromBase: (value) => value / 0.3048 },
      mi: { toBase: (value) => value * 1609.344, fromBase: (value) => value / 1609.344 },
    },
  },
  {
    name: 'mass',
    baseUnit: 'g',
    units: {
      mg: { toBase: (value) => value * 0.001, fromBase: (value) => value / 0.001 },
      g: { toBase: identity, fromBase: identity },
      kg: { toBase: (value) => value * 1000, fromBase: (value) => value / 1000 },
      t: { toBase: (value) => value * 1000000, fromBase: (value) => value / 1000000 },
      oz: { toBase: (value) => value * 28.349523125, fromBase: (value) => value / 28.349523125 },
      lb: { toBase: (value) => value * 453.59237, fromBase: (value) => value / 453.59237 },
    },
  },
  {
    name: 'temperature',
    baseUnit: 'c',
    units: {
      c: { toBase: identity, fromBase: identity },
      f: {
        toBase: (value) => (value - 32) * 5 / 9,
        fromBase: (value) => value * 9 / 5 + 32,
      },
      k: {
        toBase: (value) => value - 273.15,
        fromBase: (value) => value + 273.15,
      },
    },
  },
];

const units = new Map();

for (const domain of domains) {
  for (const [unit, conversion] of Object.entries(domain.units)) {
    units.set(unit, { domain, conversion });
  }
}

function normalizeUnit(unit) {
  if (typeof unit !== 'string') {
    throw new Error('Unknown unit');
  }

  return unit.trim().toLowerCase();
}

export default function convert(value, from, to) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('value must be a finite number');
  }

  const fromUnit = normalizeUnit(from);
  const toUnit = normalizeUnit(to);
  const fromEntry = units.get(fromUnit);
  const toEntry = units.get(toUnit);

  if (!fromEntry) {
    throw new Error(`Unknown unit: '${from}'`);
  }

  if (!toEntry) {
    throw new Error(`Unknown unit: '${to}'`);
  }

  if (fromUnit === toUnit) {
    return value;
  }

  if (fromEntry.domain !== toEntry.domain) {
    throw new Error(
      `Cannot convert from ${fromEntry.domain.name} to ${toEntry.domain.name}`,
    );
  }

  const baseValue = fromEntry.conversion.toBase(value);
  return toEntry.conversion.fromBase(baseValue);
}
