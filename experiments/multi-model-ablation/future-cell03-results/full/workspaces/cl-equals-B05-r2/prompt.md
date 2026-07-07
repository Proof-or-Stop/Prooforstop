# Task: parseArgs

Create a file `solution.mjs` that **default-exports** a function `parseArgs(argv)` — a command-line
argument parser supporting two ways to give an option a value: the *inline* `--key=value` form and
the *space-separated* `--key value` form. `argv` is an array of strings (the raw arguments, *not*
including the node binary or script path). It returns:

```js
{ options: { /* name -> string value or boolean true */ }, positionals: [ /* strings */ ] }
```

Parsing rules:

- **Inline value** `--key=value` sets `options.key = value` (a string).
- **Space-separated value** `--key value`: if a `--key` token is *immediately followed* by a token
  that is **not** itself an option (does not start with `-`) and is not the `--` terminator, that
  following token is consumed as the value, so `options.key = value`. Otherwise `--key` is a
  boolean flag (`options.key = true`).
- A value (in either form) is preserved **verbatim**, including any `=`, spaces, or leading digits
  it contains. For example `--filter=status=open` sets `options.filter = "status=open"`.
- **`--`** (a bare double dash) is the options terminator: every token after it is a positional.
- Any token that is not an option and not `--` is a **positional**, pushed in order.
- Flag names use the raw spelling after `--` (e.g. `--log-level` → `options['log-level']`).
- An empty `argv` returns `{ options: {}, positionals: [] }`.

Return the object described above. Only create/modify `solution.mjs`; do not modify any other file.
