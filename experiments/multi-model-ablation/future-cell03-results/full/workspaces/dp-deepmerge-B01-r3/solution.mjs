function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeValues(targetValue, sourceValue) {
  if (sourceValue === undefined) {
    return targetValue;
  }

  if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
    return mergeObjects(targetValue, sourceValue);
  }

  if (Array.isArray(targetValue) && Array.isArray(sourceValue)) {
    return targetValue.concat(sourceValue);
  }

  return sourceValue;
}

function mergeObjects(target, source) {
  const result = {};
  const keys = new Set([...Object.keys(target), ...Object.keys(source)]);

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      if (source[key] === undefined) {
        if (Object.prototype.hasOwnProperty.call(target, key)) {
          result[key] = target[key];
        }
        continue;
      }

      result[key] = mergeValues(target[key], source[key]);
    } else {
      result[key] = target[key];
    }
  }

  return result;
}

export default function deepMerge(target, source) {
  return mergeValues(target, source);
}
