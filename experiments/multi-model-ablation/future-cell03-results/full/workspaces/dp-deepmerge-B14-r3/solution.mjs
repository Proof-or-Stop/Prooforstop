// Immutable deep-merge helper (new-API contract).
//
//   - plain objects merge recursively
//   - arrays at the same key CONCATENATE (target ++ source)
//   - scalars / type-mismatches: source wins
//   - undefined source values are skipped; explicit null overwrites
//   - never mutates either input
//
// "plain object" = typeof 'object', not null, not Array.

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Deep structural clone for values that we have to copy into a fresh result.
// (Used so array elements / carried-over subtrees are not shared by reference
// where the contract requires a copy of merged containers.)
function cloneDeep(v) {
  if (Array.isArray(v)) {
    return v.map((el) => cloneDeep(el));
  }
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      out[k] = cloneDeep(v[k]);
    }
    return out;
  }
  return v;
}

// Concatenate two arrays into a fresh array, copying elements so that the
// result shares no references with either source array.
function concatArrays(a, b) {
  return a.concat(b).map((el) => cloneDeep(el));
}

function mergeKey(targetVal, sourceVal) {
  // source undefined => keep target as-is
  if (sourceVal === undefined) {
    return cloneDeep(targetVal);
  }
  // both plain objects => recurse
  if (isPlainObject(targetVal) && isPlainObject(sourceVal)) {
    return mergeObjects(targetVal, sourceVal);
  }
  // both arrays => concatenate
  if (Array.isArray(targetVal) && Array.isArray(sourceVal)) {
    return concatArrays(targetVal, sourceVal);
  }
  // anything else: source wins (deep-copied so result is independent)
  return cloneDeep(sourceVal);
}

function mergeObjects(target, source) {
  const result = {};

  // start from target's keys
  for (const key of Object.keys(target)) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = mergeKey(target[key], source[key]);
    } else {
      result[key] = cloneDeep(target[key]);
    }
  }

  // bring in keys that exist only in source
  for (const key of Object.keys(source)) {
    if (Object.prototype.hasOwnProperty.call(target, key)) continue;
    if (source[key] === undefined) continue; // skip undefined-only keys
    result[key] = cloneDeep(source[key]);
  }

  return result;
}

export default function deepMerge(target, source) {
  return mergeKey(target, source);
}
