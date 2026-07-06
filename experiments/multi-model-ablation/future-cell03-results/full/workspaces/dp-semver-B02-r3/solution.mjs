const NUMERIC_IDENTIFIER_RE = /^(0|[1-9][0-9]*)$/;
const DIGITS_RE = /^[0-9]+$/;
const SEMVER_IDENTIFIER_RE = /^[0-9A-Za-z-]+$/;

function compareNumericText(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateBuild(build, version) {
  const identifiers = build.split('.');
  for (const identifier of identifiers) {
    if (identifier === '' || !SEMVER_IDENTIFIER_RE.test(identifier)) {
      throw new Error(`invalid build identifier in "${version}"`);
    }
  }
}

function parsePrerelease(prerelease, version) {
  const identifiers = prerelease.split('.');
  for (const identifier of identifiers) {
    if (identifier === '' || !SEMVER_IDENTIFIER_RE.test(identifier)) {
      throw new Error(`invalid prerelease identifier in "${version}"`);
    }
    if (DIGITS_RE.test(identifier) && !NUMERIC_IDENTIFIER_RE.test(identifier)) {
      throw new Error(`invalid numeric prerelease identifier in "${version}"`);
    }
  }
  return identifiers;
}

function parseVersion(version) {
  if (typeof version !== 'string') {
    throw new Error(`version must be a string, got ${typeof version}`);
  }
  if (version === '') throw new Error('empty version string');

  const buildSplit = version.split('+');
  if (buildSplit.length > 2) throw new Error(`invalid build metadata in "${version}"`);
  if (buildSplit.length === 2) {
    if (buildSplit[1] === '') throw new Error(`empty build metadata in "${version}"`);
    validateBuild(buildSplit[1], version);
  }

  const versionWithoutBuild = buildSplit[0];
  const prereleaseStart = versionWithoutBuild.indexOf('-');
  const coreText =
    prereleaseStart === -1 ? versionWithoutBuild : versionWithoutBuild.slice(0, prereleaseStart);
  const prereleaseText =
    prereleaseStart === -1 ? null : versionWithoutBuild.slice(prereleaseStart + 1);

  const core = coreText.split('.');
  if (core.length !== 3 || core.some((part) => !NUMERIC_IDENTIFIER_RE.test(part))) {
    throw new Error(`invalid version core in "${version}"`);
  }

  return {
    core,
    prerelease:
      prereleaseText === null ? null : parsePrerelease(prereleaseText, version),
  };
}

function isNumericPrereleaseIdentifier(identifier) {
  return DIGITS_RE.test(identifier);
}

function comparePrereleaseIdentifier(a, b) {
  const aIsNumeric = isNumericPrereleaseIdentifier(a);
  const bIsNumeric = isNumericPrereleaseIdentifier(b);

  if (aIsNumeric && bIsNumeric) return compareNumericText(a, b);
  if (aIsNumeric) return -1;
  if (bIsNumeric) return 1;
  return compareText(a, b);
}

function comparePrerelease(a, b) {
  const sharedLength = Math.min(a.length, b.length);
  for (let i = 0; i < sharedLength; i += 1) {
    const result = comparePrereleaseIdentifier(a[i], b[i]);
    if (result !== 0) return result;
  }
  return compareText(a.length, b.length);
}

export default function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (let i = 0; i < 3; i += 1) {
    const coreResult = compareNumericText(left.core[i], right.core[i]);
    if (coreResult !== 0) return coreResult;
  }

  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;

  return comparePrerelease(left.prerelease, right.prerelease);
}
