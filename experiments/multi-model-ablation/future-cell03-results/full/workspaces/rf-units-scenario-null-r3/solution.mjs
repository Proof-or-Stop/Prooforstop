const identity = (value) => value;

const domains = [
  {
    name: 'length',
    base: 'm',
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
    base: 'g',
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
    base: 'c',
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
  for (const [unit, converters] of Object.entries(domain.units)) {
    units.set(unit, { ...converters, domain: domain.name });
  }
}

function getUnit(unit) {
  if (typeof unit !== 'string') {
    throw new Error(`Unknown unit: ${unit}`);
  }

  const normalized = unit.trim().toLowerCase();
  const definition = units.get(normalized);
  if (!definition) {
    throw new Error(`Unknown unit: ${unit}`);
  }

  return { normalized, definition };
}

export default function convert(value, from, to) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('value must be a finite number');
  }

  const source = getUnit(from);
  const target = getUnit(to);

  if (source.definition.domain !== target.definition.domain) {
    throw new Error(`Cannot convert from ${from} to ${to}`);
  }

  if (source.normalized === target.normalized) {
    return value;
  }

  return target.definition.fromBase(source.definition.toBase(value));
}
