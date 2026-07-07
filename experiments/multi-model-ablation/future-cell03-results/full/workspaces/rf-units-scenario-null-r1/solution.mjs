const domains = [
  {
    name: "length",
    baseUnit: "m",
    units: {
      mm: factor(0.001),
      cm: factor(0.01),
      m: factor(1),
      km: factor(1000),
      in: factor(0.0254),
      ft: factor(0.3048),
      mi: factor(1609.344),
    },
  },
  {
    name: "mass",
    baseUnit: "g",
    units: {
      mg: factor(0.001),
      g: factor(1),
      kg: factor(1000),
      t: factor(1_000_000),
      oz: factor(28.349523125),
      lb: factor(453.59237),
    },
  },
  {
    name: "temperature",
    baseUnit: "c",
    units: {
      c: {
        toBase: (value) => value,
        fromBase: (value) => value,
      },
      f: {
        toBase: (value) => (value - 32) * (5 / 9),
        fromBase: (value) => value * (9 / 5) + 32,
      },
      k: {
        toBase: (value) => value - 273.15,
        fromBase: (value) => value + 273.15,
      },
    },
  },
];

const unitLookup = new Map();

for (const domain of domains) {
  for (const [unit, conversion] of Object.entries(domain.units)) {
    unitLookup.set(unit, { domain, conversion });
  }
}

function factor(multiplier) {
  return {
    toBase: (value) => value * multiplier,
    fromBase: (value) => value / multiplier,
  };
}

function normalizeUnit(unit) {
  if (typeof unit !== "string") {
    throw new Error("Unknown unit");
  }

  const normalized = unit.trim().toLowerCase();
  const match = unitLookup.get(normalized);

  if (!match) {
    throw new Error(`Unknown unit: ${unit}`);
  }

  return { ...match, unit: normalized };
}

export default function convert(value, from, to) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Value must be a finite number");
  }

  const source = normalizeUnit(from);
  const target = normalizeUnit(to);

  if (source.domain !== target.domain) {
    throw new Error(`Cannot convert from ${source.domain.name} to ${target.domain.name}`);
  }

  if (source.unit === target.unit) {
    return value;
  }

  const baseValue = source.conversion.toBase(value);
  return target.conversion.fromBase(baseValue);
}
