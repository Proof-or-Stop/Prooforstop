// mergeSorted — stable merge of two key-sorted record arrays into one sorted array.
//
// Classic two-pointer merge. On a tie (equal keys across the two inputs) the record from `a`
// is emitted first to keep the merge stable; crucially, BOTH records are emitted (a merge keeps
// every element — it is not a set union).

function validateInput(arr, label) {
  if (!Array.isArray(arr)) {
    throw new Error(`mergeSorted: ${label} must be an array, got ${typeof arr}`);
  }
  let prev = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const rec = arr[i];
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      throw new Error(`mergeSorted: ${label}[${i}] must be a record object`);
    }
    if (typeof rec.key !== 'number' || Number.isNaN(rec.key)) {
      throw new Error(`mergeSorted: ${label}[${i}].key must be a number`);
    }
    if (rec.key < prev) {
      throw new Error(`mergeSorted: ${label} is not sorted non-decreasingly by key at index ${i} (${rec.key} < ${prev})`);
    }
    prev = rec.key;
  }
}

export default function mergeSorted(a, b) {
  validateInput(a, 'first argument');
  validateInput(b, 'second argument');

  const out = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const ra = a[i];
    const rb = b[j];
    if (ra.key <= rb.key) {
      // ra.key <= rb.key: emit from `a` first (stable on ties), advance only i.
      out.push(ra);
      i++;
      if (ra.key === rb.key) j++;
    } else {
      out.push(rb);
      j++;
    }
  }

  while (i < a.length) {
    out.push(a[i]);
    i++;
  }
  while (j < b.length) {
    out.push(b[j]);
    j++;
  }

  return out;
}
