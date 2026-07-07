// In-house SemVer 2.0.0 precedence comparator (replaces the `semver` dependency).
//
//   compareVersions(a, b) -> -1 | 0 | 1
//
//   - compare major.minor.patch numerically
//   - build metadata ('+...') ignored
//   - a version WITH a prerelease ranks BELOW the same version without one
//   - prerelease identifiers compared left-to-right: numeric<alphanumeric,
//     numeric compared numerically, alnum compared lexically, longer wins on tie

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_RE = /^\d+$/;

function parseVersion(v) {
  if (typeof v !== 'string') {
    throw new TypeError('compareVersions expects strings, got ' + typeof v);
  }

  const match = VERSION_RE.exec(v);
  if (!match) {
    throw new Error(`invalid semantic version: "${v}"`);
  }

  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] === undefined ? null : match[4].split('.'),
  };
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumericStrings(a, b) {
  if (a.length !== b.length) return cmp(a.length, b.length);
  return cmp(a, b);
}

function isNumericId(id) {
  return NUMERIC_RE.test(id);
}

// Compare two single prerelease identifiers per SemVer §11.4.
function compareIdentifier(a, b) {
  const an = isNumericId(a);
  const bn = isNumericId(b);
  if (an && bn) return compareNumericStrings(a, b);
  if (an && !bn) return -1; // numeric < alphanumeric
  if (!an && bn) return 1;
  // both alphanumeric: ASCII lexical
  return cmp(a, b);
}

// Compare two prerelease id lists (both non-null).
function comparePrerelease(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const c = compareIdentifier(a[i], b[i]);
    if (c !== 0) return c;
  }
  // all shared identifiers equal: more identifiers wins
  return cmp(a.length, b.length);
}

export default function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);

  for (let i = 0; i < 3; i++) {
    const c = compareNumericStrings(va.core[i], vb.core[i]);
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
