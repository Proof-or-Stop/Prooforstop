# Task: evalExpr

Create a file `solution.mjs` that **default-exports** a function `evalExpr(expr)` — an arithmetic
expression evaluator.

Support:
- Numbers: integers and decimals (e.g. `3`, `3.5`, `0.25`).
- Binary operators: `+` `-` `*` `/` `%` and `^` (power).
  - Precedence (low→high): `+` `-`  <  `*` `/` `%`  <  unary `-`/`+`  <  `^`.
  - `+ - * / %` are **left-associative**; `^` is **right-associative** (`2^3^2 = 2^(3^2) = 512`).
  - `/` is **true division** (`7 / 2 = 3.5`, `1 / 4 = 0.25`); `%` is the JS remainder.
- Unary `-` and `+` (e.g. `-3`, `-(2+1)`).
- Parentheses for grouping.
- Built-in functions: `abs(x)`, `sqrt(x)`, `floor(x)`, `ceil(x)`, `round(x)`, `min(a, b, …)`,
  `max(a, b, …)`, `pow(a, b)`, `log(x)` (natural log), `exp(x)`.
- Constants: `pi`, `e`.
- Arbitrary whitespace between tokens is ignored.
- Invalid input throws an `Error` (e.g. `"1 +"`, `"(1 + 2"`, `"abs()"`, `"3 4"`, unknown name).

Return a JavaScript number. Only create/modify `solution.mjs`; do not modify any other file.
