# Task: text-stats

Create a file `solution.mjs` that **default-exports** a function `analyze(text)`.

`analyze(text)` returns an object `{ words, sentences, avgWordLen, topWord }`:
- `words` — number of word tokens (split on whitespace; strip non-letters; ignore empties).
- `sentences` — number of sentences (count runs of `.`/`!`/`?`; if there is text but no terminator, count 1).
- `avgWordLen` — mean length of the word tokens, rounded to 1 decimal (0 if no words).
- `topWord` — the **most frequent word, compared case-INSENSITIVELY, returned lower-cased**
  (e.g. `"The the THE dog"` → `topWord` is `"the"`). Ties: the one that reaches the top count first.
- Empty / whitespace-only input → `{ words: 0, sentences: 0, avgWordLen: 0, topWord: '' }`.
- Non-string input throws an `Error`.

Only create/modify `solution.mjs`. Do not modify any other file.
