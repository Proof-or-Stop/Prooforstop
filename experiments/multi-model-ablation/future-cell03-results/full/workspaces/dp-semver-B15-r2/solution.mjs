const CORE_NUMBER_RE = /^(0|[1-9][0-9]*)$/;
const IDENTIFIER_RE = /^[0-9A-Za-z-]+$/;
const DIGITS_RE = /^[0-9]+$/;

function assertDotIdentifiers(value, version, kind, rejectLeadingZeroNumerics) {
  if (value === '') {
    throw new Error(`empty ${kind} in "${version}"`);
  }

  for (const identifier of value.split('.')) {
    if (identifier === '' || !IDENTIFIER_RE.test(identifier)) {
      throw new Error(`invalid ${kind} identifier "${identifier}" in "${version}"`);
    }
    if (
      rejectLeadingZeroNumerics &&
      DIGITS_RE.test(identifier) &&
      !CORE_NUMBER_RE.test(identifier)
    ) {
      throw new Error(`invalid numeric ${kind} identifier "${identifier}" in "${version}"`);
    }
  }
}

function parseVersion(version) {
  if (typeof version !== 'string') {
    throw new Error(`compareVersions expects strings, got ${typeof version}`);
  }
  if (version === '') {
    throw new Error('empty version string');
  }

  const buildParts = version.split('+');
  if (buildParts.length > 2) {
    throw new Error(`invalid build metadata in "${version}"`);
  }
  if (buildParts.length === 2) {
    assertDotIdentifiers(buildParts[1], version, 'build metadata', false);
  }

  const versionWithoutBuild = buildParts[0];
  const prereleaseStart = versionWithoutBuild.indexOf('-');
  const coreText =
    prereleaseStart === -1 ? versionWithoutBuild : versionWithoutBuild.slice(0, prereleaseStart);
  const prereleaseText =
    prereleaseStart === -1 ? null : versionWithoutBuild.slice(prereleaseStart + 1);

  const core = coreText.split('.');
  if (core.length !== 3 || core.some((part) => !CORE_NUMBER_RE.test(part))) {
    throw new Error(`invalid version core "${coreText}" in "${version}"`);
  }

  let prerelease = null;
  if (prereleaseText !== null) {
    assertDotIdentifiers(prereleaseText, version, 'prerelease', true);
    prerelease = prereleaseText.split('.');
  }

  return { core, prerelease };
}

function compareNumericStrings(a, b) {
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrereleaseIdentifier(a, b) {
  const aNumeric = DIGITS_RE.test(a);
  const bNumeric = DIGITS_RE.test(b);

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
    const comparison = comparePrereleaseIdentifier(a[i], b[i]);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

export default function compareVersions(a, b) {
  const versionA = parseVersion(a);
  const versionB = parseVersion(b);

  for (let i = 0; i < 3; i += 1) {
    const comparison = compareNumericStrings(versionA.core[i], versionB.core[i]);
    if (comparison !== 0) {
      return comparison;
    }
  }

  const prereleaseA = versionA.prerelease;
  const prereleaseB = versionB.prerelease;
  if (prereleaseA === null && prereleaseB === null) {
    return 0;
  }
  if (prereleaseA === null) {
    return 1;
  }
  if (prereleaseB === null) {
    return -1;
  }
  return comparePrerelease(prereleaseA, prereleaseB);
}
