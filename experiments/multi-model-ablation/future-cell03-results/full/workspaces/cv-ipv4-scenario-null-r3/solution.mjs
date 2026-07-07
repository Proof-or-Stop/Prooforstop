export default function parseIPv4(input) {
  if (typeof input !== "string") {
    throw new TypeError("parseIPv4 input must be a string");
  }

  const parts = input.split(".");

  if (parts.length !== 4) {
    throw new Error("Invalid IPv4 address");
  }

  return parts.map((part) => {
    if (!/^[0-9]+$/.test(part)) {
      throw new Error("Invalid IPv4 address");
    }

    if (part.length > 1 && part[0] === "0") {
      throw new Error("Invalid IPv4 address");
    }

    const value = Number(part);

    if (value > 255) {
      throw new Error("Invalid IPv4 address");
    }

    return value;
  });
}
