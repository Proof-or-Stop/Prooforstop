function assertSortedRecords(records, name) {
  if (!Array.isArray(records)) {
    throw new Error(`${name} must be an array`);
  }

  let previousKey = -Infinity;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (
      record === null ||
      typeof record !== 'object' ||
      !Object.prototype.hasOwnProperty.call(record, 'key') ||
      typeof record.key !== 'number' ||
      Number.isNaN(record.key)
    ) {
      throw new Error(`${name}[${i}] must be an object with a numeric key`);
    }

    if (record.key < previousKey) {
      throw new Error(`${name} must be sorted by key in non-decreasing order`);
    }
    previousKey = record.key;
  }
}

export default function mergeSorted(a, b) {
  assertSortedRecords(a, 'a');
  assertSortedRecords(b, 'b');

  const merged = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;

  while (i < a.length && j < b.length) {
    if (a[i].key <= b[j].key) {
      merged[k] = a[i];
      i += 1;
    } else {
      merged[k] = b[j];
      j += 1;
    }
    k += 1;
  }

  while (i < a.length) {
    merged[k] = a[i];
    i += 1;
    k += 1;
  }

  while (j < b.length) {
    merged[k] = b[j];
    j += 1;
    k += 1;
  }

  return merged;
}
