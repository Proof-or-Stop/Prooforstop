# Task: parseRange

Create a file `solution.mjs` in the current directory that **default-exports** a function
`parseRange(input)`.

`parseRange` takes a string describing a set of integers and returns a sorted array of distinct
integers:
- Comma-separated tokens, e.g. `"1,4,9"` → `[1, 4, 9]`.
- A range `"a-b"` (inclusive, a ≤ b) expands to every integer from a to b, e.g. `"11-13"` → `[11, 12, 13]`.
- Mixed, e.g. `"1-5,8,11-13"` → `[1, 2, 3, 4, 5, 8, 11, 12, 13]`.
- Whitespace around tokens is ignored, e.g. `" 1 , 4 "` → `[1, 4]`.
- Duplicates are removed and the result is sorted ascending, e.g. `"3,1,2,2"` → `[1, 2, 3]`.
- An empty string `""` returns `[]`.
- Invalid input throws an `Error`: a malformed token (e.g. `"1-"`, `"a"`, `"1-2-3"`) or a reversed
  range where a > b (e.g. `"5-1"`).

Only create/modify `solution.mjs`. Do not modify any other file.
