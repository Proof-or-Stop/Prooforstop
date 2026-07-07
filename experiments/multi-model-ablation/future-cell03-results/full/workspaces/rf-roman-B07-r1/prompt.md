# Task: roman

Create a file `solution.mjs` that **default-exports** a function `roman(mode, input)` — a Roman
numeral codec with three modes.

`mode` is one of the strings `'encode'`, `'decode'`, `'validate'`:

- **`'encode'`** — `input` is an integer `1..3999`. Return its **standard** (modern) Roman numeral
  string in uppercase. Standard form uses the subtractive pairs (`IV`, `IX`, `XL`, `XC`, `CD`, `CM`)
  rather than the additive `IIII` / `LXXXX` style.
  - Examples: `4 → "IV"`, `9 → "IX"`, `14 → "XIV"`, `40 → "XL"`, `90 → "XC"`, `400 → "CD"`,
    `900 → "CM"`, `1994 → "MCMXCIV"`, `2023 → "MMXXIII"`, `3888 → "MMMDCCCLXXXVIII"`.
  - A non-integer, or an integer outside `1..3999`, throws a `RangeError`.

- **`'decode'`** — `input` is a Roman numeral string (any letter case). Return the integer it
  represents. Decoding must accept standard subtractive forms. An empty string or a string with
  characters outside `IVXLCDM` throws an `Error`.

- **`'validate'`** — `input` is a string. Return `true` if it is a well-formed standard Roman
  numeral for some integer `1..3999` such that `encode(decode(input)) === input.toUpperCase()`,
  otherwise return `false`. (i.e. it is in canonical standard form.) Never throws for `'validate'`.

Rules:
- An unknown `mode` throws an `Error`.
- `encode` returns uppercase; `decode` accepts mixed case.

Implement the three modes with a clean shared structure (e.g. a single ordered value/symbol table
driving both encode and decode). Only create/modify `solution.mjs`; do not modify any other file.
