# Task: roundMoney

Create a file `solution.mjs` that **default-exports** a function `roundMoney(amount, places, mode)` —
a money/decimal rounder that supports several rounding modes.

Arguments:
- `amount` — a finite number to round.
- `places` — a non-negative integer number of decimal places to round to (default `2` if omitted /
  `undefined`).
- `mode` — one of the strings (default `'half-even'` if omitted / `undefined`):
  - `'half-up'`   — round half away from zero (`2.5 → 3`, `-2.5 → -3`).
  - `'half-even'` — **banker's rounding**: round to nearest; on an exact halfway tie, round to the
    **even** neighbour (`0.5 → 0`, `1.5 → 2`, `2.5 → 2`, `3.5 → 4`, `-2.5 → -2`).
  - `'floor'`     — round toward negative infinity.
  - `'ceil'`      — round toward positive infinity.

Return the rounded number (e.g. `2.5 → 2` for half-even at 0 places; `1.005` at 2 places half-up is
subject to normal binary-float representation — callers compare with a small epsilon and avoid
values that are not exactly representable).

Rules:
- A non-finite or non-number `amount` throws a `TypeError`.
- A `places` that is not a non-negative integer throws a `RangeError`.
- An unknown `mode` throws an `Error`.
- Rounding at `places` decimal places means scaling by `10^places`, applying the mode at integer
  granularity, then unscaling.

Implement the modes with a clean branch structure (scale → per-mode integer rounding → unscale).
Only create/modify `solution.mjs`; do not modify any other file.
