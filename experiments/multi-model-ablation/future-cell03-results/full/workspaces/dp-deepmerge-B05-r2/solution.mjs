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

function ownEnumerableKeys(obj) {
  return Reflect.ownKeys(obj).filter((key) => hasEnumerableOwn(obj, key));
}

function hasEnumerableOwn(obj, key) {
  return Object.prototype.propertyIsEnumerable.call(obj, key);
}

function setDataProperty(obj, key, value) {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
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
    for (const k of ownEnumerableKeys(v)) {
      setDataProperty(out, k, cloneDeep(v[k]));
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
  for (const key of ownEnumerableKeys(target)) {
    if (hasEnumerableOwn(source, key)) {
      setDataProperty(result, key, mergeKey(target[key], source[key]));
    } else {
      setDataProperty(result, key, cloneDeep(target[key]));
    }
  }

  // bring in keys that exist only in source
  for (const key of ownEnumerableKeys(source)) {
    if (hasEnumerableOwn(target, key)) continue;
    if (source[key] === undefined) continue; // skip undefined-only keys
    setDataProperty(result, key, cloneDeep(source[key]));
  }

  return result;
}

export default function deepMerge(target, source) {
  return mergeKey(target, source);
}
