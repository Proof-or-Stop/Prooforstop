# Task: interpolate (template-string interpolator)

Create a file `solution.mjs` that **default-exports** a function `interpolate(template, context)`
implementing the templating mini-language specified below **exactly**.

`template` is a string. `context` is a plain object mapping variable names to values. The function
returns the rendered string.

## Specification

The renderer scans `template` left to right and produces output character by character:

1. **Placeholders.** A `{` begins a placeholder. It is followed by a *variable name* and a closing
   `}`. The whole `{name}` is replaced by `String(context[name])`.
   - A variable name matches `[A-Za-z_][A-Za-z0-9_]*` (a leading letter/underscore, then
     letters/digits/underscores). Surrounding spaces inside the braces are **not** allowed —
     `{ x }` is invalid.
   - If the name is not an own-property of `context`, throw an `Error`.
   - An unterminated placeholder (a `{` with no matching `}`) is invalid — throw an `Error`.
   - An empty placeholder `{}` is invalid — throw an `Error`.

2. **Escapes.** A backslash `\` introduces an escape sequence. Exactly three escapes are defined,
   and each emits a single literal character to the output:
   - `\{` emits a literal `{`
   - `\}` emits a literal `}`
   - `\\` emits a literal `\`

   Any other character following a backslash (including end-of-string) is an **invalid escape** —
   throw an `Error`. An escaped brace is *only* a literal character; it never begins or ends a
   placeholder.

3. **Literal characters.** Any other character (not `{`, `}`, or `\`) is copied verbatim to the
   output.

4. **Stray closing brace.** A `}` that is not part of a placeholder and not escaped is invalid —
   throw an `Error`.

### Examples

```
interpolate('Hello, {name}!', { name: 'Ada' })            === 'Hello, Ada!'
interpolate('{a}-{b}', { a: 1, b: 2 })                     === '1-2'
interpolate('100\\% done', {})                             === '100\\% done'   // \\ -> one backslash
interpolate('a \\{ b', {})                                 === 'a { b'         // \{ -> literal {
```

Return a string. Only create/modify `solution.mjs`; do not modify any other file.
