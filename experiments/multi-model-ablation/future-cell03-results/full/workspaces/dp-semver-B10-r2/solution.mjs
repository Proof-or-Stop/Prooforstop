// In-house SemVer 2.0.0 precedence comparator (replaces the `semver` dependency).
//
//   compareVersions(a, b) -> -1 | 0 | 1
//
//   - compare major.minor.patch numerically
//   - build metadata ('+...') ignored
//   - a version WITH a prerelease ranks BELOW the same version without one
//   - prerelease identifiers compared left-to-right: numeric<alphanumeric,
//     numeric compared numerically, alnum compared lexically, longer wins on tie

const CORE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRERELEASE_ID_RE = /^[0-9A-Za-z-]+$/;
const BUILD_ID_RE = /^[0-9A-Za-z-]+$/;
const DIGITS_RE = /^\d+$/;
const NUMERIC_RE = /^(0|[1-9]\d*)$/;

function parseVersion(v) {
  if (typeof v !== 'string') {
    throw new TypeError('compareVersions expects strings, got ' + typeof v);
  }
  let rest = v;
  if (rest === '') throw new Error('empty version string');

  // strip build metadata first (does not affect precedence)
  const plus = rest.indexOf('+');
  if (plus !== -1) {
    const build = rest.slice(plus + 1);
    if (build === '') throw new Error(`empty build metadata in "${v}"`);
    for (const id of build.split('.')) {
      if (id === '' || !BUILD_ID_RE.test(id)) {
        throw new Error(`invalid build identifier "${id}" in "${v}"`);
      }
    }
    rest = rest.slice(0, plus);
  }

  // split off prerelease
  let prerelease = null;
  const dash = rest.indexOf('-');
  if (dash !== -1) {
    prerelease = rest.slice(dash + 1);
    rest = rest.slice(0, dash);
    if (prerelease === '') throw new Error(`empty prerelease in "${v}"`);
  }

  const m = CORE_RE.exec(rest);
  if (!m) throw new Error(`invalid version core: "${rest}" in "${v}"`);
  const core = [m[1], m[2], m[3]];

  let ids = null;
  if (prerelease !== null) {
    ids = prerelease.split('.');
    for (const id of ids) {
      if (id === '' || !PRERELEASE_ID_RE.test(id)) {
        throw new Error(`invalid prerelease identifier "${id}" in "${v}"`);
      }
      if (DIGITS_RE.test(id) && !NUMERIC_RE.test(id)) {
        throw new Error(`invalid numeric prerelease identifier "${id}" in "${v}"`);
      }
    }
  }

  return { core, prerelease: ids };
}

function cmpNum(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpNumericString(a, b) {
  if (a.length !== b.length) return cmpNum(a.length, b.length);
  return cmpNum(a, b);
}

function isNumericId(id) {
  return NUMERIC_RE.test(id);
}

// Compare two single prerelease identifiers per SemVer §11.4.
function compareIdentifier(a, b) {
  const an = isNumericId(a);
  const bn = isNumericId(b);
  if (an && bn) return cmpNumericString(a, b);
  if (an && !bn) return -1; // numeric < alphanumeric
  if (!an && bn) return 1;
  // both alphanumeric: ASCII lexical
  return a < b ? -1 : a > b ? 1 : 0;
}

// Compare two prerelease id lists (both non-null).
function comparePrerelease(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const c = compareIdentifier(a[i], b[i]);
    if (c !== 0) return c;
  }
  // all shared identifiers equal: more identifiers wins
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
  if (pa === null && pb !== null) return 1;  // release > prerelease
  if (pa !== null && pb === null) return -1;
  return comparePrerelease(pa, pb);
}
