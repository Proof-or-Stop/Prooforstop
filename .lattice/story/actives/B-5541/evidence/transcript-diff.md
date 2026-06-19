# B-5541 real-machine verification (doc-only)

**User value**: docs/requirements/NAV.md (the source-of-truth index) no longer has
Chinese, its titles correspond to the actual files, and koala is gone (except the 1
contextual rename-plan title the user chose to keep).

## Actual (run from worktree, after `lattice truth_nav`)
- `head -3 NAV.md` → "# Source of Truth Navigation" / "> 65 files" (was "# 真相源导航" / "> 52 个文件")
- `grep -cP '[\x{4e00}-\x{9fff}]' NAV.md` → 0 (was 14)
- `grep -ci koala NAV.md` → 1 (the kept "Koala-to-Lattice Role Naming Execution Plan"; was 4)
- authority-client-role entry → "Lattice CLI Authority Client Role" (was stale "Koala CLI...")
- cc-learnings/role-separation/stack-layering → rebranded to Lattice, NAV titles match current H1

## Diff
3 decision-doc H1 lines (koala→Lattice) + regenerated NAV.md. Doc-only, 0 production change.

## 5-question self-check
1. Concrete? Yes — exact before/after counts. 2. User-perspective? Yes — read NAV.md as the user would.
3. Done? Yes — all 3 complaints resolved. 4. Noise? No. 5. Plain summary? "NAV.md is now English, current, and koala-free except the rename-plan title."
