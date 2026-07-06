# Task: mergeSorted

Create a file `solution.mjs` that **default-exports** a function `mergeSorted(a, b)` which
merges two already-sorted arrays of records into one sorted array.

Each input is an array of records of the form `{ key: <number>, value: <any> }`, already sorted
by `key` in non-decreasing order. The function must:

- Return a **new** array containing **every record from both inputs** (the result length is
  always `a.length + b.length` — this is a merge, not a set union; duplicate keys are kept).
- Keep the result sorted by `key` in non-decreasing order.
- Be a **stable** merge: when a record from `a` and a record from `b` have equal `key`, the
  record from `a` comes first. Records within a single input keep their original relative order.
- Not mutate either input array or any of the records.
- Handle empty inputs (`mergeSorted([], b)` returns a copy of `b`'s records in order, etc.).
- Throw an `Error` if either argument is not an array, if any element is not an object with a
  numeric `key`, or if either input is not actually sorted non-decreasingly by `key`.

Return a new array of the record objects. Only create/modify `solution.mjs`; do not modify any
other file.
