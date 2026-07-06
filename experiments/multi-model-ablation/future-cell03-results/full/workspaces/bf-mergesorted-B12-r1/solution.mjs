function validateSortedRecords(input, name) {
  if (!Array.isArray(input)) {
    throw new Error(`mergeSorted: ${name} must be an array`);
  }

  let previousKey = -Infinity;

  for (let index = 0; index < input.length; index += 1) {
    const record = input[index];

    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`mergeSorted: ${name}[${index}] must be an object record`);
    }

    if (typeof record.key !== 'number' || Number.isNaN(record.key)) {
      throw new Error(`mergeSorted: ${name}[${index}].key must be numeric`);
    }

    if (record.key < previousKey) {
      throw new Error(`mergeSorted: ${name} must be sorted by key in non-decreasing order`);
    }

    previousKey = record.key;
  }
}

export default function mergeSorted(a, b) {
  validateSortedRecords(a, 'a');
  validateSortedRecords(b, 'b');

  const merged = new Array(a.length + b.length);
  let aIndex = 0;
  let bIndex = 0;
  let mergedIndex = 0;

  while (aIndex < a.length && bIndex < b.length) {
    if (a[aIndex].key <= b[bIndex].key) {
      merged[mergedIndex] = a[aIndex];
      aIndex += 1;
    } else {
      merged[mergedIndex] = b[bIndex];
      bIndex += 1;
    }

    mergedIndex += 1;
  }

  while (aIndex < a.length) {
    merged[mergedIndex] = a[aIndex];
    aIndex += 1;
    mergedIndex += 1;
  }

  while (bIndex < b.length) {
    merged[mergedIndex] = b[bIndex];
    bIndex += 1;
    mergedIndex += 1;
  }

  return merged;
}
