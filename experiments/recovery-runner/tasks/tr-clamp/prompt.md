# Task: mapRange

Create a file `solution.mjs` that **default-exports** a function
`mapRange(value, inMin, inMax, outMin, outMax)` — a linear range remapper that maps a numeric
`value` from the input interval `[inMin, inMax]` onto the output interval `[outMin, outMax]`,
clamped to the output interval, and returned as an **integer** number of output units.

Behavior:
- Linear map: a `value` of `inMin` maps to `outMin`; a `value` of `inMax` maps to `outMax`;
  values in between map proportionally.
- The raw mapped value is **rounded to the nearest integer** (`.5` rounds up, i.e. JS
  `Math.round` semantics), and the result is an integer-valued JavaScript number.
- **Clamp**: if `value <= inMin` return `outMin`; if `value >= inMax` return `outMax`. Values in
  between never produce a result outside `[outMin, outMax]`.
- The output bounds may be given in either order. If `outMin <= outMax` the mapping is increasing;
  if `outMin > outMax` it is decreasing (the clamp still pins the endpoints to `outMin`/`outMax`
  respectively).
- Validation — throw an `Error` if:
  - any argument is not a finite number,
  - `inMin === inMax` (degenerate input interval, division by zero).

Examples:
- `mapRange(5, 0, 10, 0, 100)` → `50`
- `mapRange(0, 0, 10, 0, 100)` → `0`
- `mapRange(10, 0, 10, 0, 100)` → `100`
- `mapRange(-3, 0, 10, 0, 100)` → `0` (clamped)

Return an integer-valued `number`. Only create/modify `solution.mjs`; do not modify any other file.
