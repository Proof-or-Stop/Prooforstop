// New query-string parser (replaces the old dependency).
//
//   - optional leading '?'
//   - '&'-separated pairs, first '=' splits key/value
//   - '+' -> space, then decodeURIComponent on key and value
//   - bare key (no '=') and 'key=' both yield ''
//   - empty segments ignored
//   - REPEATED keys collect into an array in order of appearance

// Decode one form-encoded component: '+' becomes space, then percent-decode.
function decodeComponent(str) {
  const plus = str.replace(/\+/g, ' ');
  return decodeURIComponent(plus);
}

function setOwn(result, key, value) {
  Object.defineProperty(result, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// Split a query string into raw [key, value|null] pairs. value is null when the
// segment had no '=' at all (a bare flag), '' when it was 'key='.
function splitPairs(qs) {
  const pairs = [];
  for (const segment of qs.split('&')) {
    if (segment === '') continue; // ignore empty segments from stray '&'
    const eq = segment.indexOf('=');
    if (eq === -1) {
      pairs.push([segment, null]);
    } else {
      pairs.push([segment.slice(0, eq), segment.slice(eq + 1)]);
    }
  }
  return pairs;
}

// Insert a decoded key/value into the accumulator, promoting to an array on the
// second-and-later occurrence of the same key.
function assign(result, key, value) {
  if (!Object.prototype.hasOwnProperty.call(result, key)) {
    setOwn(result, key, value);
    return;
  }
  const existing = result[key];
  if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    setOwn(result, key, [existing, value]);
  }
}

export default function parseQuery(qs) {
  if (typeof qs !== 'string') {
    throw new TypeError('parseQuery expects a string, got ' + typeof qs);
  }

  let s = qs;
  if (s.startsWith('?')) s = s.slice(1);
  if (s === '') return {};

  const result = {};
  for (const [rawKey, rawVal] of splitPairs(s)) {
    const key = decodeComponent(rawKey);
    // bare flag (null) and empty value ('') both decode to '' value
    const value = rawVal === null ? '' : decodeComponent(rawVal);
    assign(result, key, value);
  }
  return result;
}
