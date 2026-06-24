# Task: parseArgs

Create a file `solution.mjs` that **default-exports** a function `parseArgs(argv)` — a command-line
argument parser that supports *repeatable* options. `argv` is an array of strings (the raw
arguments, *not* including the node binary or script path). It returns:

```js
{ counts: { /* name -> integer */ }, values: { /* name -> array of strings */ }, positionals: [] }
```

There are two declared option shapes (and only these two need special handling):

- **Repeatable boolean / count flags:** `--verbose` and its short alias `-v`. Each occurrence
  *increments* `counts.verbose`. So `-v -v -v` gives `counts.verbose === 3`. A count flag that never
  appears must be **absent** from `counts` (not `0`).
- **Repeatable valued flags:** `--include=<path>` (and `--exclude=<path>`). Each occurrence
  *appends* its value to an array, so the order of occurrences is preserved. Thus
  `--include=a --include=b` gives `values.include === ['a', 'b']`, and a single `--include=a` gives
  `values.include === ['a']`. A valued flag that never appears must be **absent** from `values`.

Other rules:

- Any token that is not one of the declared options above is a **positional** (this includes
  unknown `--foo` tokens — push the raw token string onto `positionals`).
- `-v` and `--verbose` both feed the *same* `counts.verbose` counter.
- An empty `argv` returns `{ counts: {}, values: {}, positionals: [] }`.

Return the object described above. Only create/modify `solution.mjs`; do not modify any other file.
