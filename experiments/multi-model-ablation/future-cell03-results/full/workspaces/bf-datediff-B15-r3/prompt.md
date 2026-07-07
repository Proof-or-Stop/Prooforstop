# Task: daysBetween

Create a file `solution.mjs` that **default-exports** a function `daysBetween(a, b)` which
returns the **whole number of calendar days** from date `a` to date `b` in the proleptic
Gregorian calendar.

Each argument is a date string in ISO form `"YYYY-MM-DD"` (e.g. `"2021-03-14"`). The function
must:

- Parse the year, month (`01`–`12`) and day (`01`–`31`) fields.
- Return `b - a` measured in days: a signed integer. If `b` is after `a` the result is
  positive; if `b` is before `a` it is negative; equal dates give `0`.
- Treat dates as calendar dates only — there are no hours, timezones, or daylight-saving
  effects. One calendar day is always exactly one unit.
- Account correctly for months of different lengths and for **leap years** (a year is a leap
  year iff it is divisible by 4 and not by 100, unless also divisible by 400).
- Throw an `Error` for malformed input: not a string, wrong shape, month out of `1..12`,
  day out of range for that month (e.g. `"2021-02-30"`, `"2021-13-01"`, `"2021-04-31"`),
  or non-numeric fields.

Return a JavaScript number (integer). Only create/modify `solution.mjs`; do not modify any
other file.
