const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*))*))?(?:\+([\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?$/;

function parseVersion(version) {
  if (typeof version !== "string") {
    throw new Error("Version must be a string");
  }

  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new Error(`Malformed version: ${version}`);
  }

  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] === undefined ? null : match[4].split("."),
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

function isNumericIdentifier(identifier) {
  return /^\d+$/.test(identifier);
}

function comparePrerelease(a, b) {
  if (a === null && b === null) {
    return 0;
  }

  if (a === null) {
    return 1;
  }

  if (b === null) {
    return -1;
  }

  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];

    if (left === right) {
      continue;
    }

    const leftNumeric = isNumericIdentifier(left);
    const rightNumeric = isNumericIdentifier(right);

    if (leftNumeric && rightNumeric) {
      return compareNumericStrings(left, right);
    }

    if (leftNumeric) {
      return -1;
    }

    if (rightNumeric) {
      return 1;
    }

    return left < right ? -1 : 1;
  }

  if (a.length === b.length) {
    return 0;
  }

  return a.length < b.length ? -1 : 1;
}

export default function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (let i = 0; i < 3; i += 1) {
    const coreOrder = compareNumericStrings(left.core[i], right.core[i]);
    if (coreOrder !== 0) {
      return coreOrder;
    }
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}
