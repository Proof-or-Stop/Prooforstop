const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_ID_RE = /^(0|[1-9]\d*)$/;

function parseVersion(value) {
  if (typeof value !== 'string') {
    throw new Error('version must be a string');
  }

  const match = SEMVER_RE.exec(value);
  if (!match || match[0] !== value) {
    throw new Error(`invalid semantic version: ${value}`);
  }

  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] === undefined ? null : match[4].split('.'),
  };
}

function compareNumericStrings(a, b) {
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1;
  }

  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

function compareIdentifiers(a, b) {
  const aNumeric = NUMERIC_ID_RE.test(a);
  const bNumeric = NUMERIC_ID_RE.test(b);

  if (aNumeric && bNumeric) {
    return compareNumericStrings(a, b);
  }

  if (aNumeric) {
    return -1;
  }

  if (bNumeric) {
    return 1;
  }

  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

function comparePrereleases(a, b) {
  const limit = Math.min(a.length, b.length);

  for (let index = 0; index < limit; index += 1) {
    const comparison = compareIdentifiers(a[index], b[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }

  if (a.length === b.length) {
    return 0;
  }

  return a.length < b.length ? -1 : 1;
}

export default function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericStrings(left.core[index], right.core[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }

  if (left.prerelease === null && right.prerelease === null) {
    return 0;
  }

  if (left.prerelease === null) {
    return 1;
  }

  if (right.prerelease === null) {
    return -1;
  }

  return comparePrereleases(left.prerelease, right.prerelease);
}
