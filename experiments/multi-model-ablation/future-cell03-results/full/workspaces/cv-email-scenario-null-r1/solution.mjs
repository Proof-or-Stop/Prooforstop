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

  if (!isValidLocalPart(localPart) || !isValidDomain(domain)) {
    return false;
  }

  return true;
}

function isValidLocalPart(localPart) {
  if (localPart.length < 1 || localPart.length > 64) {
    return false;
  }

  if (
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..")
  ) {
    return false;
  }

  return /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/.test(localPart);
}

function isValidDomain(domain) {
  if (domain.length < 1 || domain.length > 255) {
    return false;
  }

  if (domain.startsWith(".") || domain.endsWith(".") || !domain.includes(".")) {
    return false;
  }

  const labels = domain.split(".");
  const tld = labels[labels.length - 1];

  if (!/^[A-Za-z]{2,}$/.test(tld)) {
    return false;
  }

  return labels.every((label) => {
    return (
      label.length >= 1 &&
      label.length <= 63 &&
      /^[A-Za-z0-9-]+$/.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-")
    );
  });
}
