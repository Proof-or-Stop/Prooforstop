All data collected. Here is the audit report:

---

## Findings

### F-1: HEAD confirmed at 84df879c on main ✓

HEAD is `84df879c0a570552064ca9caafb7af2f2d57f20c` on branch `main`. Matches expectation.

### F-2: `codex/lattice-cli-english` is a proper ancestor of main with zero right-only commits ✓

- `git merge-base --is-ancestor` confirms the branch is fully contained in main.
- `git log codex/lattice-cli-english --not main` produces zero output — no cherry-picks or dangling commits exist on the branch that aren't reachable from main.

### F-3: da18d879 is an "ours" merge — reasonable ✓

**Evidence of "ours" strategy**: `git diff da18d879^1 da18d879` is zero bytes. The merge tree is identical to its first parent (main before merge).

**Why this is reasonable**: The branch (`codex/lattice-cli-english`) forked at `0f1a59f0` and added only 3 commits (authority workflow docs + implementation). Meanwhile, main accumulated **1580 commits** since the fork point — including newer Authority/baseline/Lattice implementations that supersede the branch's content. A regular merge would have produced ~320k deletions (regressing main to the branch's outdated tree). The "ours" strategy correctly closes the branch by recording the merge relationship (making it an ancestor) without altering main's content.

### F-4: 84df879c is dependency-only, no functional code change ✓

The commit touches exactly 2 files:
- `packages/main/package.json` — adds `ws` and `zod` as runtime deps, `@types/ws` as devDep
- `packages/main/package-lock.json` — corresponding lockfile entries

No `.ts`, `.js`, or other source files are modified. This is a pure dependency declaration commit.

### F-5: Dirty working tree files are not part of HEAD ✓

All dirty files (modified `docs/requirements/decisions/*`, new `docs/koala/framework-audit/2026-06-10/`) are unstaged working-directory changes. They do not appear in any commit reachable from HEAD and are not part of the merge result.

---

## Evidence

| Check | Method | Result |
|---|---|---|
| HEAD SHA | `git rev-parse HEAD` | `84df879c...` |
| Ancestor | `git merge-base --is-ancestor codex/lattice-cli-english main` | exit 0 (true) |
| Right-only | `git log codex/lattice-cli-english --not main` | empty |
| Ours merge | `git diff da18d879^1..da18d879 \| wc -l` | 0 |
| Branch divergence | main had 1580 commits since fork; branch had 3 | ours prevents regression |
| HEAD content | `git show 84df879c --stat` | 2 files: package.json + lock |
| Dirty files | `git status --short` | all unstaged, not in HEAD |

---

## Verdict: **PASS**

All five checks confirm correct merge topology and content boundary. The "ours" merge is the correct strategy given the massive divergence (1580 vs 3 commits), and HEAD is a clean dependency-only follow-up.
