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
    const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    const value = decodeURIComponent(rawValue.replace(/\+/g, " "));

    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const current = result[key];
      if (Array.isArray(current)) {
        current.push(value);
      } else {
        setValue(result, key, [current, value]);
      }
    } else {
      setValue(result, key, value);
    }
  }

  return result;
}

function setValue(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
