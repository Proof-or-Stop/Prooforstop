# Task: formatDuration (human-readable duration formatter)

Create a file `solution.mjs` that **default-exports** a function `formatDuration(seconds)`
implementing the formatting rules specified below **exactly**.

`seconds` is a non-negative integer number of seconds. The function returns a compact
human-readable string built from four units.

## Specification

The units, from largest to smallest, are:

| unit | suffix | seconds  |
|------|--------|----------|
| days    | `d` | 86400 |
| hours   | `h` | 3600  |
| minutes | `m` | 60    |
| seconds | `s` | 1     |

1. **Decompose** `seconds` into days, hours, minutes, and seconds using ordinary
   integer division and remainders (e.g. `90061` → 1 day, 1 hour, 1 minute, 1 second).

2. **Render** the units in `d h m s` order, each as `<value><suffix>` (no spaces inside a unit),
   joined by a single space — e.g. `"1d 1h 1m 1s"`.

3. **Trim outer zero units.** Leading zero units (the largest units, while they are zero) and
   trailing zero units (the smallest units, while they are zero) are omitted.
   **Interior zero units are kept** — a zero unit that sits between two non-zero units is
   still printed, so the gap between the largest and smallest present unit is never collapsed.

   Examples:
   - `90000`  → `1d 1h`            (= 1d 1h 0m 0s; trailing `0m 0s` trimmed)
   - `90061`  → `1d 1h 1m 1s`
   - `86461`  → `1d 0h 1m 1s`      (= 1d 0h 1m 1s; interior `0h` **kept**)
   - `3661`   → `1h 1m 1s`         (leading `0d` trimmed)
   - `172800` → `2d`              (= 2d 0h 0m 0s; trailing `0h 0m 0s` trimmed)

4. **Zero.** `formatDuration(0)` returns the string `"0s"`.

5. **Validation.** If `seconds` is negative, not an integer, or not a number, throw an `Error`.

Return a string. Only create/modify `solution.mjs`; do not modify any other file.
