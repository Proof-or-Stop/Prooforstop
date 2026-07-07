// In-house SemVer 2.0.0 precedence comparator.

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const DIGITS_RE = /^\d+$/;

function parseVersion(value) {
  if (typeof value !== 'string') {
    throw new Error('version must be a string');
  }

  const match = VERSION_RE.exec(value);
  if (!match) {
    throw new Error(`invalid version: "${value}"`);
  }

  const prerelease = match[4] === undefined ? null : match[4].split('.');
  if (prerelease !== null) {
    for (const identifier of prerelease) {
      if (isNumeric(identifier) && identifier.length > 1 && identifier[0] === '0') {
        throw new Error(`invalid numeric prerelease identifier: "${identifier}"`);
      }
    }
  }

  return {
    core: [match[1], match[2], match[3]],
    prerelease,
  };
}

function isNumeric(identifier) {
  return DIGITS_RE.test(identifier);
}

function sign(value) {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

function compareNumericStrings(a, b) {
  if (a.length !== b.length) {
    return sign(a.length - b.length);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrereleaseIdentifier(a, b) {
  const aNumeric = isNumeric(a);
  const bNumeric = isNumeric(b);

  if (aNumeric && bNumeric) {
    return compareNumericStrings(a, b);
  }
  if (aNumeric) {
    return -1;
  }
  if (bNumeric) {
    return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a, b) {
  const sharedLength = Math.min(a.length, b.length);

  for (let i = 0; i < sharedLength; i += 1) {
    const result = comparePrereleaseIdentifier(a[i], b[i]);
    if (result !== 0) {
      return result;
    }
  }

  return sign(a.length - b.length);
}

export default function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (let i = 0; i < 3; i += 1) {
    const result = compareNumericStrings(left.core[i], right.core[i]);
    if (result !== 0) {
      return result;
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

  return comparePrerelease(left.prerelease, right.prerelease);
}
