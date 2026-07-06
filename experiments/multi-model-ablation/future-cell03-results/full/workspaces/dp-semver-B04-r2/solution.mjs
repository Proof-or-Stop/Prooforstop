const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_ID_RE = /^\d+$/;

function parseVersion(version) {
  if (typeof version !== 'string') {
    throw new Error('version must be a string');
  }

  const match = VERSION_RE.exec(version);
  if (!match) {
    throw new Error(`invalid semantic version: ${version}`);
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
  return a < b ? -1 : a > b ? 1 : 0;
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
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a, b) {
  const sharedLength = Math.min(a.length, b.length);

  for (let i = 0; i < sharedLength; i += 1) {
    const comparison = compareIdentifiers(a[i], b[i]);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

export default function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (let i = 0; i < 3; i += 1) {
    const comparison = compareNumericStrings(left.core[i], right.core[i]);
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

  return comparePrerelease(left.prerelease, right.prerelease);
}
