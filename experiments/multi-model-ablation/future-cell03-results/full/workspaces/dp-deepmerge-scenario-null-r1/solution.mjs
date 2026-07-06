const hasOwn = Object.prototype.hasOwnProperty;
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enumerableOwnKeys(value) {
  return Reflect.ownKeys(value).filter((key) => propertyIsEnumerable.call(value, key));
}

function mergeValues(targetValue, sourceValue) {
  if (sourceValue === undefined) {
    return targetValue;
  }

  if (Array.isArray(targetValue) && Array.isArray(sourceValue)) {
    return targetValue.concat(sourceValue);
  }

  if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
    return mergeObjects(targetValue, sourceValue);
  }

  return sourceValue;
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

export default function deepMerge(target, source) {
  if (source === undefined) {
    if (Array.isArray(target)) {
      return target.slice();
    }

    if (isPlainObject(target)) {
      return mergeObjects(target, {});
    }

    return target;
  }

  if (Array.isArray(target) && Array.isArray(source)) {
    return target.concat(source);
  }

  if (isPlainObject(target) && isPlainObject(source)) {
    return mergeObjects(target, source);
  }

  return source;
}
