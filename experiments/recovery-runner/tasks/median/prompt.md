# Task: median

Create a file `solution.mjs` in the current directory that **default-exports** a function
`median(numbers)`.

`median` takes an array of numbers and returns the median:
- Sort the values; for an **odd** count return the middle value.
- For an **even** count return the **average of the two middle values**, e.g. `[1,2,3,4]` → `2.5`,
  `[10,20]` → `15`.
- Works on unsorted input, e.g. `[10,2,8,4,6]` → `6`.
- A single element returns itself, e.g. `[5]` → `5`.
- An empty array throws an `Error`.

Only create/modify `solution.mjs`. Do not modify any other file.
