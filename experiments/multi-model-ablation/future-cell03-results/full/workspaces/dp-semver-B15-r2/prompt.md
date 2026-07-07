# Task: compareVersions (migration to in-house semver comparator)

We are dropping the `semver` package in favor of a small in-house comparator. Create a file
`solution.mjs` that **default-exports** a function `compareVersions(a, b)` implementing
Semantic Versioning 2.0.0 precedence.

`compareVersions(a, b)` returns:
- `-1` if `a` has lower precedence than `b`,
- `1` if `a` has higher precedence than `b`,
- `0` if they have equal precedence.

Version format: `MAJOR.MINOR.PATCH` optionally followed by `-PRERELEASE`, optionally followed
by `+BUILD`. Examples: `1.2.3`, `1.0.0-rc.1`, `1.0.0-alpha.2+build.5`.

Precedence rules (SemVer §11):

1. Compare `MAJOR`, then `MINOR`, then `PATCH` numerically. The first difference decides.
2. **Build metadata (`+...`) is ignored** for precedence. `1.0.0+a` and `1.0.0+b` are equal.
3. **A version WITH a prerelease has LOWER precedence than the same version WITHOUT one.**
   So `1.0.0-rc.1` < `1.0.0`. (A pre-release is "before" the final release.)
4. When both versions have a prerelease, compare the dot-separated prerelease identifiers
   left to right:
   - **Numeric** identifiers (all digits) compare numerically.
   - **Alphanumeric** identifiers compare lexically in ASCII order.
   - A numeric identifier always has **lower** precedence than an alphanumeric one.
   - If all compared identifiers are equal, the version with **more** identifiers has higher
     precedence. So `1.0.0-alpha` < `1.0.0-alpha.1`.

Validation: a malformed version (missing parts, non-numeric core, empty string, non-string)
throws an `Error`.

Examples:

```js
compareVersions('1.2.3', '1.2.4')           // => -1
compareVersions('2.0.0', '1.9.9')           // =>  1
compareVersions('1.0.0+build7', '1.0.0')    // =>  0  (build ignored)
compareVersions('1.0.0-rc.1', '1.0.0')      // => -1  (prerelease < release)
compareVersions('1.0.0-alpha', '1.0.0-alpha.1') // => -1
```

Return -1, 0, or 1. Only create/modify `solution.mjs`; do not modify any other file.
