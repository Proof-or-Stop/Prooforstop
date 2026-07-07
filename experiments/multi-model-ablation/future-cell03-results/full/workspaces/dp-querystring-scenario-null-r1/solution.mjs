function decodeFormComponent(component) {
  return decodeURIComponent(component.replace(/\+/g, ' '));
}

function setParsedValue(result, key, value) {
  if (!Object.prototype.hasOwnProperty.call(result, key)) {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return;
  }

  const current = result[key];
  if (Array.isArray(current)) {
    current.push(value);
  } else {
    result[key] = [current, value];
  }
}

export default function parseQuery(qs) {
  if (typeof qs !== 'string') {
    throw new TypeError('parseQuery expects a string');
  }

  const query = qs.startsWith('?') ? qs.slice(1) : qs;
  const result = {};

  if (query === '') {
    return result;
  }

  for (const segment of query.split('&')) {
    if (segment === '') {
      continue;
    }

    const separatorIndex = segment.indexOf('=');
    const rawKey = separatorIndex === -1 ? segment : segment.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? '' : segment.slice(separatorIndex + 1);

    setParsedValue(result, decodeFormComponent(rawKey), decodeFormComponent(rawValue));
  }

  return result;
}
