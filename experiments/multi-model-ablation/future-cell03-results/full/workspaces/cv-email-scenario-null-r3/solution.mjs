const LOCAL_PUNCTUATION = "!#$%&'*+-/=?^_`{|}~.";

function isAsciiLetter(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code) {
  return code >= 48 && code <= 57;
}

function isLocalPartCharacter(char) {
  const code = char.charCodeAt(0);
  return isAsciiLetter(code) || isAsciiDigit(code) || LOCAL_PUNCTUATION.includes(char);
}

function isDomainLabelCharacter(char) {
  const code = char.charCodeAt(0);
  return isAsciiLetter(code) || isAsciiDigit(code) || char === "-";
}

function isValidLocalPart(localPart) {
  if (localPart.length < 1 || localPart.length > 64) {
    return false;
  }

  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) {
    return false;
  }

  for (const char of localPart) {
    if (!isLocalPartCharacter(char)) {
      return false;
    }
  }

  return true;
}

function isValidDomainLabel(label) {
  if (label.length < 1 || label.length > 63) {
    return false;
  }

  if (label.startsWith("-") || label.endsWith("-")) {
    return false;
  }

  for (const char of label) {
    if (!isDomainLabelCharacter(char)) {
      return false;
    }
  }

  return true;
}

function isValidDomain(domain) {
  if (domain.length < 1 || domain.length > 255) {
    return false;
  }

  if (domain.startsWith(".") || domain.endsWith(".") || !domain.includes(".")) {
    return false;
  }

  const labels = domain.split(".");
  if (labels.length < 2) {
    return false;
  }

  for (const label of labels) {
    if (!isValidDomainLabel(label)) {
      return false;
    }
  }

  const tld = labels[labels.length - 1];
  if (tld.length < 2) {
    return false;
  }

  for (const char of tld) {
    if (!isAsciiLetter(char.charCodeAt(0))) {
      return false;
    }
  }

  return true;
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

  return isValidLocalPart(localPart) && isValidDomain(domain);
}
