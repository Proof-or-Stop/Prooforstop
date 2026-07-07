const hasOwn = Object.prototype.hasOwnProperty;
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enumerableOwnKeys(value) {
  return [
    ...Object.keys(value),
    ...Object.getOwnPropertySymbols(value).filter((key) =>
      propertyIsEnumerable.call(value, key),
    ),
  ];
}

function copyContainer(value) {
  if (Array.isArray(value)) {
    return value.slice();
  }

  if (isPlainObject(value)) {
    const result = {};
    for (const key of enumerableOwnKeys(value)) {
      result[key] = value[key];
    }
    return result;
  }

  return value;
}

function mergeObjects(target, source) {
  const result = {};

  for (const key of enumerableOwnKeys(target)) {
    result[key] = target[key];
  }

  for (const key of enumerableOwnKeys(source)) {
    const sourceValue = source[key];

    if (sourceValue === undefined) {
      continue;
    }

    result[key] = hasOwn.call(target, key)
      ? mergeValues(target[key], sourceValue)
      : sourceValue;
  }

  return result;
}

function mergeValues(target, source) {
  if (source === undefined) {
    return target;
  }

  if (isPlainObject(target) && isPlainObject(source)) {
    return mergeObjects(target, source);
  }

  if (Array.isArray(target) && Array.isArray(source)) {
    return target.concat(source);
  }

  return copyContainer(source);
}

export default function deepMerge(target, source) {
  return mergeValues(target, source);
}
