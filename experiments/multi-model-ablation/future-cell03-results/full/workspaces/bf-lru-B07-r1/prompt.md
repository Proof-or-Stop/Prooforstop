# Task: createLRU

Create a file `solution.mjs` that **default-exports** a factory function
`createLRU(capacity)` returning a least-recently-used (LRU) cache object with this API:

- `get(key)` — return the value stored for `key`, or `undefined` if absent. A successful
  `get` counts as a **use**: it makes `key` the most-recently-used entry.
- `put(key, value)` — insert or update `key`. This counts as a use (the entry becomes
  most-recently-used). If inserting a **new** key would exceed `capacity`, first evict the
  **least-recently-used** entry (the one whose most recent `get`/`put` is the oldest).
  Updating the value of an existing key never evicts anything.
- `has(key)` — return `true`/`false` without counting as a use.
- `size` — a getter returning the current number of entries.
- `keys()` — return an array of the current keys ordered **least-recently-used first,
  most-recently-used last**.

Rules:
- `capacity` must be a positive integer; otherwise throw an `Error`.
- "Recency" is determined by `get` and `put` only (not `has` / `keys` / `size`).
- The cache never holds more than `capacity` entries.

Return the cache object from `createLRU`. Only create/modify `solution.mjs`; do not modify any
other file.
