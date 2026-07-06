# Task: validateCardNumber

Create a file `solution.mjs` that **default-exports** a function `validateCardNumber(input)` — a
validator for payment-card-style account numbers using the Luhn (mod-10) checksum.

The contract:
- `input` must be a string. Anything else throws a `TypeError`.
- The string may contain digits, single spaces, and single hyphens as **separators**; these are
  stripped before validation. After stripping separators the remaining characters must all be
  ASCII digits `0`–`9`.
- The stripped digit string must have a length between **2 and 19** inclusive. A length outside
  that range is invalid.
- The number is **valid** iff it passes the Luhn check:
  - Starting from the **rightmost** digit and moving left, double the value of **every second
    digit** (i.e. the 2nd, 4th, 6th, … digits counting from the right). The rightmost digit
    itself is NOT doubled.
  - If a doubled value is greater than 9, subtract 9 from it (equivalently, sum its two digits).
  - Sum all the resulting values (doubled-and-adjusted where applicable, original otherwise).
  - The number passes iff that total is a multiple of 10.

Behaviour:
- Return `true` if the input is a well-formed digit string (after stripping separators) of valid
  length that passes the Luhn check.
- Return `false` if it is a well-formed digit string of valid length that FAILS the Luhn check.
- Throw an `Error` if the input is malformed: contains characters other than digits/spaces/hyphens,
  or the stripped length is outside 2..19.

Return a boolean on a well-formed input. Only create/modify `solution.mjs`; do not modify any
other file.
