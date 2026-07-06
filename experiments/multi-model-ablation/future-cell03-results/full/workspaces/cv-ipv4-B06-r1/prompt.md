# Task: parseIPv4

Create a file `solution.mjs` that **default-exports** a function `parseIPv4(input)` — a validator
and parser for IPv4 addresses in dotted-decimal notation.

The contract:
- `input` must be a string. Anything else throws a `TypeError`.
- A valid IPv4 address is **exactly four** decimal octets separated by single dots (`.`),
  e.g. `"192.168.0.1"`, `"0.0.0.0"`, `"255.255.255.255"`.
- Each octet:
  - is a non-empty run of ASCII digits `0`–`9` (no signs, no whitespace, no `+`/`-`).
  - represents an integer in the inclusive range `0`–`255`.
  - is written in **canonical form**: it must NOT contain a redundant leading zero.
    `"0"` is valid; `"00"`, `"01"`, `"010"`, `"007"` are all invalid. (A single `0` is the only
    octet that may begin with `0`.)
- No surrounding or interior whitespace is permitted; no trailing dot; no empty octets
  (so `"1.2.3."`, `".1.2.3"`, `"1..2.3"`, `"1.2.3.4.5"`, `"1.2.3"` are all invalid).

Behaviour:
- On a **valid** address, return an array of four numbers — the parsed octets, in order.
  e.g. `parseIPv4("192.168.0.1")` → `[192, 168, 0, 1]`.
- On an **invalid** address (a string that violates any rule above), throw an `Error`.

Return a JavaScript array of four numbers on success. Only create/modify `solution.mjs`; do not
modify any other file.
