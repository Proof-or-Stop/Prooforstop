const SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const NUMERIC_ID_RE = /^[0-9]+$/;

function parseVersion(version) {
  if (typeof version !== 'string') {
    throw new Error('version must be a string');
  }

  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new Error(`invalid semantic version: ${version}`);
  }

  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] === undefined ? null : match[4].split('.'),
  };
}

function compareNumericString(a, b) {
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1;
  }

  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

function isNumericIdentifier(identifier) {
  return NUMERIC_ID_RE.test(identifier);
}

function comparePrereleaseIdentifier(a, b) {
  const aIsNumeric = isNumericIdentifier(a);
  const bIsNumeric = isNumericIdentifier(b);

  if (aIsNumeric && bIsNumeric) {
    return compareNumericString(a, b);
  }

  if (aIsNumeric) {
    return -1;
  }

  if (bIsNumeric) {
    return 1;
  }

  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

function comparePrerelease(a, b) {
  const sharedLength = Math.min(a.length, b.length);

  for (let index = 0; index < sharedLength; index++) {
    const result = comparePrereleaseIdentifier(a[index], b[index]);
    if (result !== 0) {
      return result;
    }
  }

  return compareNumericString(String(a.length), String(b.length));
}

export default function compareVersions(a, b) {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);

  for (let index = 0; index < 3; index++) {
    const result = compareNumericString(parsedA.core[index], parsedB.core[index]);
    if (result !== 0) {
      return result;
    }
  }

  if (parsedA.prerelease === null && parsedB.prerelease === null) {
    return 0;
  }

  if (parsedA.prerelease === null) {
    return 1;
  }

  if (parsedB.prerelease === null) {
    return -1;
  }

  return comparePrerelease(parsedA.prerelease, parsedB.prerelease);
}
