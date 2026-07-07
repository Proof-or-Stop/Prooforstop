const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(version) {
  if (typeof version !== "string") {
    throw new Error("Malformed version");
  }

  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error("Malformed version");
  }

  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] === undefined ? null : match[4].split("."),
  };
}

function compareNumericStrings(left, right) {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }

  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function isNumericIdentifier(identifier) {
  return /^\d+$/.test(identifier);
}

function comparePrerelease(left, right) {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  const comparedLength = Math.min(left.length, right.length);
  for (let index = 0; index < comparedLength; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];

    if (leftPart === rightPart) {
      continue;
    }

    const leftIsNumeric = isNumericIdentifier(leftPart);
    const rightIsNumeric = isNumericIdentifier(rightPart);

    if (leftIsNumeric && rightIsNumeric) {
      return compareNumericStrings(leftPart, rightPart);
    }

    if (leftIsNumeric) {
      return -1;
    }

    if (rightIsNumeric) {
      return 1;
    }

    return leftPart < rightPart ? -1 : 1;
  }

  if (left.length === right.length) {
    return 0;
  }

  return left.length < right.length ? -1 : 1;
}

export default function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (let index = 0; index < left.core.length; index += 1) {
    const coreComparison = compareNumericStrings(left.core[index], right.core[index]);
    if (coreComparison !== 0) {
      return coreComparison;
    }
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}
