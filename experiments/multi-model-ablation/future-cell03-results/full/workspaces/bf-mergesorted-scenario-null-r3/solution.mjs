function validateSortedRecords(records, name) {
  if (!Array.isArray(records)) {
    throw new Error(`${name} must be an array`);
  }

  let previousKey = -Infinity;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];

    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      typeof record.key !== 'number' ||
      Number.isNaN(record.key)
    ) {
      throw new Error(`${name}[${index}] must be an object with a numeric key`);
    }

    if (record.key < previousKey) {
      throw new Error(`${name} must be sorted by key`);
    }

    previousKey = record.key;
  }
}

export default function mergeSorted(a, b) {
  validateSortedRecords(a, 'a');
  validateSortedRecords(b, 'b');

  const merged = [];
  let aIndex = 0;
  let bIndex = 0;

  while (aIndex < a.length && bIndex < b.length) {
    if (a[aIndex].key <= b[bIndex].key) {
      merged.push(a[aIndex]);
      aIndex += 1;
    } else {
      merged.push(b[bIndex]);
      bIndex += 1;
    }
  }

  while (aIndex < a.length) {
    merged.push(a[aIndex]);
    aIndex += 1;
  }

  while (bIndex < b.length) {
    merged.push(b[bIndex]);
    bIndex += 1;
  }

  return merged;
}
