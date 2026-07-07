function isAlpha(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

function isLocalAtomChar(ch) {
  const code = ch.charCodeAt(0);

  if (isAlpha(code) || isDigit(code) || ch === ".") {
    return true;
  }

  return "!#$%&'*+-/=?^_`{|}~".includes(ch);
}

function isDomainLabelChar(ch) {
  const code = ch.charCodeAt(0);
  return isAlpha(code) || isDigit(code) || ch === "-";
}

export default function validateEmail(input) {
  if (typeof input !== "string") {
    throw new TypeError("validateEmail input must be a string");
  }

  const atIndex = input.indexOf("@");
  if (atIndex === -1 || atIndex !== input.lastIndexOf("@")) {
    return false;
  }

  const localPart = input.slice(0, atIndex);
  const domain = input.slice(atIndex + 1);

  if (
    localPart.length < 1 ||
    localPart.length > 64 ||
    domain.length < 1 ||
    domain.length > 255
  ) {
    return false;
  }

  if (
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..")
  ) {
    return false;
  }

  for (const ch of localPart) {
    if (!isLocalAtomChar(ch)) {
      return false;
    }
  }

  if (
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    !domain.includes(".") ||
    domain.includes("..")
  ) {
    return false;
  }

  const labels = domain.split(".");
  const tld = labels[labels.length - 1];

  if (tld.length < 2) {
    return false;
  }

  for (const label of labels) {
    if (
      label.length < 1 ||
      label.length > 63 ||
      label.startsWith("-") ||
      label.endsWith("-")
    ) {
      return false;
    }

    for (const ch of label) {
      if (!isDomainLabelChar(ch)) {
        return false;
      }
    }
  }

  for (const ch of tld) {
    if (!isAlpha(ch.charCodeAt(0))) {
      return false;
    }
  }

  return true;
}
