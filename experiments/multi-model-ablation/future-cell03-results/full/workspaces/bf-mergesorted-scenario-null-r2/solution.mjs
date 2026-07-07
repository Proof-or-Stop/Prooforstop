function isRecord(record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    typeof record.key === 'number' &&
    !Number.isNaN(record.key)
  );
}

function validateInput(records, name) {
  if (!Array.isArray(records)) {
    throw new Error(`${name} must be an array`);
  }

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];

    if (!isRecord(record)) {
      throw new Error(`${name}[${index}] must be an object with a numeric key`);
    }

    if (index > 0 && records[index - 1].key > record.key) {
      throw new Error(`${name} must be sorted by key in non-decreasing order`);
    }
  }
}

export default function mergeSorted(a, b) {
  validateInput(a, 'a');
  validateInput(b, 'b');

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
