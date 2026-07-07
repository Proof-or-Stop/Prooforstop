# Task: slugify

Create a file `solution.mjs` that **default-exports** a function `slugify(input)` — a URL-slug
generator that turns an arbitrary title string into a clean, lowercase, hyphen-separated slug.

Rules:
- Return a `string`.
- Lowercase all ASCII letters (`A`–`Z` → `a`–`z`).
- Keep ASCII letters and digits (`a`–`z`, `0`–`9`) as-is.
- Convert every run of one or more separator/punctuation characters (anything that is **not** an
  ASCII letter or digit — spaces, underscores, dots, slashes, dashes, symbols, tabs, etc.) into a
  **single** hyphen `-`.
- Collapse so the result never contains two or more hyphens in a row.
- Trim leading and trailing hyphens, so the slug starts and ends with an alphanumeric character
  (or is empty).
- A string that contains no alphanumeric characters slugifies to the empty string `""`.
- Common accented Latin-1 vowels should be folded to their plain ASCII base letter:
  `à á â ã ä å → a`, `è é ê ë → e`, `ì í î ï → i`, `ò ó ô õ ö → o`, `ù ú û ü → u`, `ñ → n`,
  `ç → c` (and their uppercase forms, lowercased). Any other non-ASCII letter is treated as a
  separator.

Examples:
- `slugify("Hello World")` → `"hello-world"`
- `slugify("Café del Mar")` → `"cafe-del-mar"`
- `slugify("  leading")` → `"leading"`

Only create/modify `solution.mjs`; do not modify any other file.
