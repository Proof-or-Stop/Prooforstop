# B-5f42 Real-machine acceptance — transcript & diff

Verified on 2026-06-16 in worktree .worktrees/B-5f42 (branch story/B-5f42), built from source.
CJK test input was constructed from UTF-8 bytes so this evidence file stays English-only.

## Expected (PLAN outcome)
- Layer 1: a git commit / lattice story-metadata command containing CJK triggers an immediate
  english-only warning; the command still proceeds (warn-only).
- Layer 2: the validate REVIEW->TEST preflight hard-fails when current-story commits or
  author-controlled metadata contain CJK; passes on English-only artifacts.

## Actual

### Layer 1 — PreToolUse(Bash) hook
Command (CJK built from bytes): `printf '{"tool_input":{"command":"git commit -m \"fix <cjk>\""}}' | node .claude/hooks/english-only-guard.cjs`
Output:
```
warn english-only: CJK detected in this git commit / lattice metadata command; Lattice artifacts must be English. This is a warning only; the validate REVIEW->TEST gate is the hard stop.
exit=0
```
English-only command -> no output, exit=0. (Warn-only confirmed: never blocks.)

### Layer 2 — validate english-artifacts gate
- REVIEW->TEST preflight ran "CLI gate preflight: all pass" — the new english-artifacts gate is part of the set and PASSED on this story (all artifacts English). This story dogfoods its own gate.
- Smoke `node packages/main/dist/tasks/english-only-guards-smoke.js`:
```
✓ Test 1: detectCjk detects Chinese (positions reported), ignores ASCII/English
✓ Test 2: hook CJK range is byte-for-byte in sync with core/cjk-detect.ts
✓ Test 3: gate ignores legacy Chinese outside the story dir; English-only story passes
✓ Test 4: CJK fixture flips gate ok=false (named source+line); English-only flips ok=true
✓ Test 5: real defaultGitLogReader parsed git log main..HEAD with 0 notes (36 commit record(s))
✓ Test 6: hook warns on CJK commit/metadata, stays silent on English/unguarded, exits 0 on bad stdin
✓ All english-only guards smoke tests passed
```
- Deliberate-fail proof (Test 4): feeding the gate a CJK fixture flips ok=false and names the source+line, so the block is real, not silent.

### Full battery
`lattice validate` all green (static + logic + integration + e2e). `lattice init` into a temp dir (temp HOME) confirmed `.claude/hooks/english-only-guard.cjs` is installed and settings.json references it (F-002 fix).

## Diff vs expected
No difference. Both layers behave exactly as the PLAN outcome specifies.

## Scope notes
- Coverage is commits + lattice story author-controlled metadata only (diff/story-scoped); legacy Chinese is never flagged (Test 3).
- Out of scope (deferred): broad active-source/doc scan (already owned by Phase 3 / english-open-source-surface-smoke.ts), a blocking hook, and a Codex-host equivalent.
- Pre-existing, unrelated: `npm run test:english-surface` fails on legacy CJK in three older task files; not in the validate battery and out of this story's surface.
