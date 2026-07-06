const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_ID_RE = /^\d+$/;

function compareNumericStrings(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function parseVersion(version) {
  if (typeof version !== 'string') {
    throw new Error('version must be a string');
  }

  const match = VERSION_RE.exec(version);
  if (!match) {
    throw new Error(`invalid version: ${version}`);
  }

  const prerelease = match[4] === undefined ? null : match[4].split('.');
  if (prerelease) {
    for (const id of prerelease) {
      if (NUMERIC_ID_RE.test(id) && id.length > 1 && id[0] === '0') {
        throw new Error(`invalid prerelease identifier: ${id}`);
      }
    }
  }

  return {
    core: [match[1], match[2], match[3]],
    prerelease,
  };
}

function comparePrereleaseIdentifier(a, b) {
  const aNumeric = NUMERIC_ID_RE.test(a);
  const bNumeric = NUMERIC_ID_RE.test(b);

  if (aNumeric && bNumeric) return compareNumericStrings(a, b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function comparePrerelease(a, b) {
  const sharedLength = Math.min(a.length, b.length);

  for (let i = 0; i < sharedLength; i++) {
    const comparison = comparePrereleaseIdentifier(a[i], b[i]);
    if (comparison !== 0) return comparison;
  }

  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

export default function compareVersions(a, b) {
  const versionA = parseVersion(a);
  const versionB = parseVersion(b);

  for (let i = 0; i < 3; i++) {
    const comparison = compareNumericStrings(versionA.core[i], versionB.core[i]);
    if (comparison !== 0) return comparison;
  }

  const prereleaseA = versionA.prerelease;
  const prereleaseB = versionB.prerelease;

  if (prereleaseA === null && prereleaseB === null) return 0;
  if (prereleaseA === null) return 1;
  if (prereleaseB === null) return -1;
  return comparePrerelease(prereleaseA, prereleaseB);
}
