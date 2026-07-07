const CORE_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_ID_RE = /^[0-9]+$/;
const VALID_NUMERIC_ID_RE = /^(0|[1-9][0-9]*)$/;

function assertValidNumericIdentifier(identifier, version) {
  if (NUMERIC_ID_RE.test(identifier) && !VALID_NUMERIC_ID_RE.test(identifier)) {
    throw new Error(`invalid numeric identifier "${identifier}" in "${version}"`);
  }
}

function splitIdentifiers(value, version) {
  if (value === undefined) {
    return null;
  }

  const identifiers = value.split('.');
  for (const identifier of identifiers) {
    assertValidNumericIdentifier(identifier, version);
  }
  return identifiers;
}

function parseVersion(version) {
  if (typeof version !== 'string') {
    throw new Error('version must be a string');
  }

  const match = CORE_RE.exec(version);
  if (!match || match[0] !== version) {
    throw new Error(`invalid semantic version "${version}"`);
  }

  const [, major, minor, patch, prerelease] = match;
  return {
    core: [major, minor, patch],
    prerelease: splitIdentifiers(prerelease, version),
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

function comparePrerelease(a, b) {
  const sharedLength = Math.min(a.length, b.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const result = compareIdentifiers(a[index], b[index]);
    if (result !== 0) {
      return result;
    }
  }

  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}

export default function compareVersions(a, b) {
  const versionA = parseVersion(a);
  const versionB = parseVersion(b);

  for (let index = 0; index < 3; index += 1) {
    const result = compareNumericStrings(versionA.core[index], versionB.core[index]);
    if (result !== 0) {
      return result;
    }
  }

  if (versionA.prerelease === null && versionB.prerelease === null) {
    return 0;
  }
  if (versionA.prerelease === null) {
    return 1;
  }
  if (versionB.prerelease === null) {
    return -1;
  }
  return comparePrerelease(versionA.prerelease, versionB.prerelease);
}
