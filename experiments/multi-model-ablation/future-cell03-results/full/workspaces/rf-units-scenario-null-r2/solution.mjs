const identity = (value) => value;

const domains = [
  {
    name: "length",
    base: "m",
    units: {
      mm: factorUnit(0.001),
      cm: factorUnit(0.01),
      m: factorUnit(1),
      km: factorUnit(1000),
      in: factorUnit(0.0254),
      ft: factorUnit(0.3048),
      mi: factorUnit(1609.344),
    },
  },
  {
    name: "mass",
    base: "g",
    units: {
      mg: factorUnit(0.001),
      g: factorUnit(1),
      kg: factorUnit(1000),
      t: factorUnit(1_000_000),
      oz: factorUnit(28.349523125),
      lb: factorUnit(453.59237),
    },
  },
  {
    name: "temperature",
    base: "c",
    units: {
      c: {
        toBase: identity,
        fromBase: identity,
      },
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

const unitIndex = new Map();

for (const domain of domains) {
  for (const [unit, converters] of Object.entries(domain.units)) {
    unitIndex.set(unit, { domain, unit, converters });
  }
}

function factorUnit(factor) {
  return {
    toBase: (value) => value * factor,
    fromBase: (value) => value / factor,
  };
}

function normalizeUnit(unit) {
  return typeof unit === "string" ? unit.trim().toLowerCase() : "";
}

export default function convert(value, from, to) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("value must be a finite number");
  }

  const fromUnit = normalizeUnit(from);
  const toUnit = normalizeUnit(to);
  const fromEntry = unitIndex.get(fromUnit);
  const toEntry = unitIndex.get(toUnit);

  if (!fromEntry || !toEntry) {
    throw new Error("unknown unit");
  }

  if (fromEntry.domain !== toEntry.domain) {
    throw new Error("cannot convert across measurement domains");
  }

  if (fromEntry.unit === toEntry.unit) {
    return value;
  }

  const baseValue = fromEntry.converters.toBase(value);
  return toEntry.converters.fromBase(baseValue);
}
