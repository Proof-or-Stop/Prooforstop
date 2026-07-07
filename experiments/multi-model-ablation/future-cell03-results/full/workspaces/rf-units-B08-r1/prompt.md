# Task: convert

Create a file `solution.mjs` that **default-exports** a function `convert(value, from, to)` — a
units converter that handles three independent measurement domains: **length**, **mass**, and
**temperature**.

The function takes a numeric `value`, a `from` unit string, and a `to` unit string, and returns the
converted numeric value.

Supported units (case-insensitive; surrounding whitespace ignored):

- **Length** — canonical base is the metre:
  - `mm` (millimetre), `cm` (centimetre), `m` (metre), `km` (kilometre),
    `in` (inch = 0.0254 m), `ft` (foot = 0.3048 m), `mi` (mile = 1609.344 m).
- **Mass** — canonical base is the gram:
  - `mg` (milligram), `g` (gram), `kg` (kilogram), `t` (tonne = 1 000 000 g),
    `oz` (ounce = 28.349523125 g), `lb` (pound = 453.59237 g).
- **Temperature** — canonical base is degrees Celsius:
  - `C` (Celsius), `F` (Fahrenheit), `K` (Kelvin).
  - `F = C * 9/5 + 32`,  `K = C + 273.15` (and the inverses).

Rules / behaviour:
- Converting a unit to itself returns the value unchanged.
- You may **not** convert across domains: `convert(1, 'm', 'kg')` must throw an `Error`. Likewise
  mixing temperature with length/mass throws.
- An **unknown** unit string throws an `Error`.
- Non-finite / non-number `value` throws a `TypeError`.
- Conversions should be exact up to floating-point (callers compare with a small epsilon).

Implement the three domains with a clean per-domain structure (a base unit plus to-base / from-base
conversion for each domain). Return a JavaScript number. Only create/modify `solution.mjs`; do not
modify any other file.
