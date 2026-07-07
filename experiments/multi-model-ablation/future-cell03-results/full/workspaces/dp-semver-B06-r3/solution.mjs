const CORE_ID_RE = /^(0|[1-9]\d*)$/;
const IDENTIFIER_RE = /^[0-9A-Za-z-]+$/;
const NUMERIC_RE = /^(0|[1-9]\d*)$/;
const ALL_DIGITS_RE = /^\d+$/;

function cmpNum(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpNumericString(a, b) {
  const lengthCompare = cmpNum(a.length, b.length);
  if (lengthCompare !== 0) return lengthCompare;
  return cmpNum(a, b);
}

function validateIdentifiers(text, label, version, rejectNumericLeadingZeroes) {
  if (text === '') {
    throw new Error(`empty ${label} in "${version}"`);
  }

  const ids = text.split('.');
  for (const id of ids) {
    if (id === '' || !IDENTIFIER_RE.test(id)) {
      throw new Error(`invalid ${label} identifier "${id}" in "${version}"`);
    }
    if (rejectNumericLeadingZeroes && ALL_DIGITS_RE.test(id) && !NUMERIC_RE.test(id)) {
      throw new Error(`invalid numeric ${label} identifier "${id}" in "${version}"`);
    }
  }
  return ids;
}

function parseVersion(version) {
  if (typeof version !== 'string') {
    throw new Error('compareVersions expects string arguments');
  }
  if (version === '') {
    throw new Error('empty version string');
  }

  const firstPlus = version.indexOf('+');
  if (firstPlus !== -1 && version.indexOf('+', firstPlus + 1) !== -1) {
    throw new Error(`invalid build metadata in "${version}"`);
  }

  let base = version;
  if (firstPlus !== -1) {
    validateIdentifiers(version.slice(firstPlus + 1), 'build metadata', version, false);
    base = version.slice(0, firstPlus);
  }

  let prerelease = null;
  const firstDash = base.indexOf('-');
  if (firstDash !== -1) {
    prerelease = validateIdentifiers(
      base.slice(firstDash + 1),
      'prerelease',
      version,
      true,
    );
    base = base.slice(0, firstDash);
  }

  const core = base.split('.');
  if (core.length !== 3 || !core.every((id) => CORE_ID_RE.test(id))) {
    throw new Error(`invalid version core in "${version}"`);
  }

  return { core, prerelease };
}

function compareIdentifier(a, b) {
  const aIsNumeric = NUMERIC_RE.test(a);
  const bIsNumeric = NUMERIC_RE.test(b);

  if (aIsNumeric && bIsNumeric) return cmpNumericString(a, b);
  if (aIsNumeric) return -1;
  if (bIsNumeric) return 1;
  return cmpNum(a, b);
}

function comparePrerelease(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const c = compareIdentifier(a[i], b[i]);
    if (c !== 0) return c;
  }
  return cmpNum(a.length, b.length);
}

export default function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);

  for (let i = 0; i < 3; i++) {
    const c = cmpNumericString(va.core[i], vb.core[i]);
    if (c !== 0) return c;
  }

  // cores equal -> handle prerelease precedence
  const pa = va.prerelease;
  const pb = vb.prerelease;
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  return comparePrerelease(pa, pb);
}
