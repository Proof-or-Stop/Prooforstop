# Task: pluralize

Create a file `solution.mjs` that **default-exports** a function `pluralize(word)` — a regular
English noun pluralizer. Input is always a lowercase, non-empty word of ASCII letters.

Apply these rules, in order (first match wins):

1. **Irregulars** (exact-match lookup): `man → men`, `woman → women`, `child → children`,
   `person → people`, `mouse → mice`, `tooth → teeth`, `foot → feet`, `goose → geese`.
2. **Uncountable / unchanged** (exact-match lookup): `sheep`, `fish`, `series`, `species`,
   `deer` — return the word unchanged.
3. Words ending in a **sibilant cluster** — `s`, `ss`, `sh`, `ch`, `x`, or `z` — add `es`
   (e.g. `bus → buses`, `glass → glasses`, `dish → dishes`, `match → matches`, `box → boxes`,
   `buzz → buzzes`).
4. Words ending in **consonant + `y`**: drop the `y` and add `ies`
   (e.g. `city → cities`, `lady → ladies`, `party → parties`).
   Words ending in **vowel + `y`** (vowel = `a e i o u`) just add `s`
   (e.g. `day → days`, `key → keys`, `boy → boys`, `guy → guys`).
5. Words ending in **consonant + `o`**: add `es` (e.g. `potato → potatoes`, `hero → heroes`).
   Words ending in **vowel + `o`** just add `s` (e.g. `radio → radios`, `studio → studios`).
6. Words ending in `f` or `fe`: drop it and add `ves`
   (e.g. `leaf → leaves`, `knife → knives`, `wolf → wolves`).
7. Otherwise: add `s` (e.g. `cat → cats`, `house → houses`).

Return a `string`. Only create/modify `solution.mjs`; do not modify any other file.
