# Task: validateEmail

Create a file `solution.mjs` that **default-exports** a function `validateEmail(input)` — a
validator for a pragmatic subset of email addresses (an `addr-spec` of the form
`local-part "@" domain`).

The contract:
- `input` must be a string. Anything else throws a `TypeError`.
- The address must contain **exactly one** `@`, splitting it into a non-empty `local-part` and a
  non-empty `domain`.
- **local-part** rules (unquoted dot-atom form):
  - Allowed characters are ASCII letters `A`–`Z`/`a`–`z`, digits `0`–`9`, and the following
    "atom" punctuation: `! # $ % & ' * + - / = ? ^ _ \` { | } ~` and the dot `.`.
  - It may not start or end with a dot, and may not contain two consecutive dots.
  - Total length 1..64 characters.
- **domain** rules (dot-separated labels):
  - One or more labels separated by single dots; no leading/trailing dot, no empty labels.
  - Each label is 1..63 characters of ASCII letters, digits, or hyphen `-`, and may not start or
    end with a hyphen.
  - The domain must contain at least one dot (i.e. at least two labels), and the final label (the
    TLD) must be all ASCII letters and at least 2 characters long.
  - Total domain length 1..255 characters.

Behaviour:
- Return `true` if `input` satisfies every rule above.
- Return `false` if `input` is a string that violates any rule.
- Throw a `TypeError` only when `input` is not a string.

Return a boolean for any string input. Only create/modify `solution.mjs`; do not modify any other
file.
