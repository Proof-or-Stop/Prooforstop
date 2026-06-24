# Task: deepMerge (migration to immutable merge helper)

We are migrating off the old `Object.assign`-based shallow merge onto a new immutable
deep-merge helper. Create a file `solution.mjs` that **default-exports** a function
`deepMerge(target, source)` matching the new helper's contract.

Contract:

- **Pure / immutable.** Neither `target` nor `source` (nor any object/array nested inside
  them) may be mutated. Always return a freshly constructed result. Shared sub-objects that
  are not touched by the merge may be returned by reference, but anything that is merged must
  be a new container.
- **Plain objects merge recursively.** When the same key holds a plain object in both
  `target` and `source`, merge them deeply. Keys present in only one side are carried over.
- **Arrays concatenate.** When the same key holds an array in both `target` and `source`,
  the result is the **concatenation** `target[key].concat(source[key])` (target's elements
  first, then source's). Array elements themselves are copied, not merged element-wise.
- **Scalars and type mismatches: source wins.** If `source[key]` is a primitive, or the two
  sides hold different kinds (e.g. object vs array, array vs scalar, object vs scalar), the
  source value replaces the target value.
- **`undefined` in source is ignored** (the target value is kept); but an explicit `null` in
  source *does* overwrite.
- A "plain object" means a value `v` with `typeof v === 'object'`, `v !== null`, and
  `!Array.isArray(v)`. Treat anything else (numbers, strings, booleans, null, arrays,
  functions) as non-mergeable.

Examples:

```js
deepMerge({ a: 1, b: { x: 1 } }, { b: { y: 2 }, c: 3 })
// => { a: 1, b: { x: 1, y: 2 }, c: 3 }

deepMerge({ a: 1 }, { a: undefined, b: 2 })
// => { a: 1, b: 2 }
```

Return the merged value. Only create/modify `solution.mjs`; do not modify any other file.
