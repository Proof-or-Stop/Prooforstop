# Task: parseArgs

Create a file `solution.mjs` that **default-exports** a function `parseArgs(argv)` — a command-line
argument parser. `argv` is an array of strings (the raw arguments, *not* including the node binary
or script path). It returns a structured object:

```js
{ flags: { /* boolean and string options */ }, positionals: [ /* strings */ ] }
```

Parsing rules:

- **Long boolean flag** `--name` sets `flags.name = true`.
- **Long valued flag** `--name=value` sets `flags.name = value` (a string). The value is everything
  after the first `=`.
- **Short flags** start with a single `-` followed by one or more letters. Each letter is its own
  boolean flag: `-v` sets `flags.v = true`; **combined** shorts `-abc` set `flags.a`, `flags.b`,
  and `flags.c` all to `true`.
- **`--`** (a bare double dash) is the *options terminator*: every token after it is a positional,
  even if it looks like a flag.
- Any token that is not an option (and is not `--`) is a **positional**, pushed onto
  `positionals` in order.
- Flag names use the raw spelling after the dashes (e.g. `--out-dir` → `flags['out-dir']`).
- An empty `argv` returns `{ flags: {}, positionals: [] }`.
- A bare `-` (just a dash) is treated as a positional (conventional stdin marker).

Return the object described above. Only create/modify `solution.mjs`; do not modify any other file.
