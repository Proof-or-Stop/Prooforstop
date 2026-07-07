const CORE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;
const IDENTIFIER_RE = /^[0-9A-Za-z-]+(?![\s\S])/;
const DIGITS_RE = /^\d+(?![\s\S])/;
const NUMERIC_RE = /^(0|[1-9]\d*)(?![\s\S])/;

function fail(message) {
  throw new Error(message);
}

function parseDotIdentifiers(value, kind, original) {
  if (value === '') {
    fail(`empty ${kind} in "${original}"`);
  }

  const identifiers = value.split('.');
  for (const identifier of identifiers) {
    if (identifier === '' || !IDENTIFIER_RE.test(identifier)) {
      fail(`invalid ${kind} identifier "${identifier}" in "${original}"`);
    }

    if (kind === 'prerelease' && DIGITS_RE.test(identifier) && !NUMERIC_RE.test(identifier)) {
      fail(`invalid numeric prerelease identifier "${identifier}" in "${original}"`);
    }
  }

  return identifiers;
}

function parseVersion(version) {
  if (typeof version !== 'string') {
    fail(`compareVersions expects strings, got ${typeof version}`);
  }

  if (version === '') {
    fail('empty version string');
  }

  const plusIndex = version.indexOf('+');
  let withoutBuild = version;

  if (plusIndex !== -1) {
    if (version.indexOf('+', plusIndex + 1) !== -1) {
      fail(`invalid build metadata in "${version}"`);
    }

    parseDotIdentifiers(version.slice(plusIndex + 1), 'build', version);
    withoutBuild = version.slice(0, plusIndex);
  }

  const dashIndex = withoutBuild.indexOf('-');
  let coreText = withoutBuild;
  let prerelease = null;

  if (dashIndex !== -1) {
    coreText = withoutBuild.slice(0, dashIndex);
    prerelease = parseDotIdentifiers(withoutBuild.slice(dashIndex + 1), 'prerelease', version);
  }

  const coreMatch = CORE_RE.exec(coreText);
  if (!coreMatch) {
    fail(`invalid version core in "${version}"`);
  }

  return {
    core: [BigInt(coreMatch[1]), BigInt(coreMatch[2]), BigInt(coreMatch[3])],
    prerelease,
  };
}

function compareNumber(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareIdentifier(a, b) {
  const aNumeric = NUMERIC_RE.test(a);
  const bNumeric = NUMERIC_RE.test(b);

  if (aNumeric && bNumeric) {
    return compareNumber(BigInt(a), BigInt(b));
  }

  if (aNumeric) return -1;
  if (bNumeric) return 1;

  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function comparePrerelease(a, b) {
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const comparison = compareIdentifier(a[index], b[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return compareNumber(a.length, b.length);
}

export default function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumber(left.core[index], right.core[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }

  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;

  return comparePrerelease(left.prerelease, right.prerelease);
}
