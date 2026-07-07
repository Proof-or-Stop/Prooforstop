export default function parseQuery(qs) {
  const query = qs.startsWith("?") ? qs.slice(1) : qs;
  const result = {};

  if (query === "") {
    return result;
  }

  for (const segment of query.split("&")) {
    if (segment === "") {
      continue;
    }

    const equalsIndex = segment.indexOf("=");
    const rawKey = equalsIndex === -1 ? segment : segment.slice(0, equalsIndex);
    const rawValue = equalsIndex === -1 ? "" : segment.slice(equalsIndex + 1);
    const key = decodePart(rawKey);
    const value = decodePart(rawValue);

    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const existing = result[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        defineEntry(result, key, [existing, value]);
      }
    } else {
      defineEntry(result, key, value);
    }
  }

  return result;
}

function decodePart(value) {
  return decodeURIComponent(value.replaceAll("+", " "));
}

function defineEntry(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
