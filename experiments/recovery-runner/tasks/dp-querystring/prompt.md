# Task: parseQuery (migration to new query-string parser)

We are replacing a third-party query-string dependency with our own parser. Create a file
`solution.mjs` that **default-exports** a function `parseQuery(qs)` matching the new parser's
contract.

`parseQuery` takes a URL query string and returns a plain object.

Contract:

- A leading `?` is optional and stripped if present (`"?a=1"` and `"a=1"` parse identically).
- Pairs are separated by `&`. Within a pair, the **first** `=` separates key from value; any
  later `=` characters are part of the value (`"a=b=c"` → key `"a"`, value `"b=c"`).
- An empty input (`""`, `"?"`) returns `{}`.
- Empty segments produced by stray separators are ignored (`"a=1&&b=2"` → `{a:'1', b:'2'}`,
  `"&a=1"` → `{a:'1'}`).
- **Keys and values are percent-decoded** with `decodeURIComponent`, and `+` is decoded to a
  space (form encoding). Decode `+` to space *before* percent-decoding.
- A key with **no `=`** (a bare flag, e.g. `"a&b=2"`) maps to the empty string `""`.
- A key with `=` but no value (`"a="`) also maps to `""`.
- **Repeated keys collect into an array, in order of appearance.** The first occurrence stores
  a single string value; the second occurrence of the same key converts the entry to an array
  `[firstValue, secondValue]`; each further occurrence pushes onto that array.
  - `"a=1&a=2"` → `{ a: ['1', '2'] }`
  - `"a=1&a=2&a=3"` → `{ a: ['1', '2', '3'] }`
  - `"a=1&b=2"` → `{ a: '1', b: '2' }` (no array — each key appears once)

Examples:

```js
parseQuery('?name=John+Doe&city=NYC')   // => { name: 'John Doe', city: 'NYC' }
parseQuery('flag&x=1')                   // => { flag: '', x: '1' }
parseQuery('tag=a&tag=b&tag=c')          // => { tag: ['a', 'b', 'c'] }
```

Return the parsed object. Only create/modify `solution.mjs`; do not modify any other file.
