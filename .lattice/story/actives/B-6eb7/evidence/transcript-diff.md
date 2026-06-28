# B-6eb7 real-machine acceptance transcript + diff

## Expected (PLAN outcome)
The three L4 repro-first rationale strings read "material-code bug/feature" instead of "file-declaring
stories"; grep finds no remaining "file-declaring" in the two registry files; verify-process-fact-contract
passes; npm test green. Behavior zero (classifier unchanged).

## Actual (run from the story worktree)
```
$ grep -rcn 'file-declaring' packages/main/src/core/process-fact-levels.ts packages/main/src/core/process-fact-registry.ts
process-fact-levels.ts:0
process-fact-registry.ts:0
$ grep -rc 'material-code bug/feature' packages/main/src/core/process-fact-levels.ts packages/main/src/core/process-fact-registry.ts
process-fact-levels.ts:2   process-fact-registry.ts:1   (3 total)
$ git diff main --stat   # 3 changed lines, all inside rationale: string values
$ git diff main -- packages/main/src/core/ | grep -c classifyReproFirstRequirement
0   # classifier untouched
$ npm --prefix packages/main run build   # clean (tsc)
$ node scripts/verify-process-fact-contract.mjs
Process fact contract verified
$ lattice validate (REVIEW->TEST preflight)
CLI gate preflight: all pass
```

## Diff (expected vs actual)
No difference. The three rationale strings now match the shipped B-8628 semantics; no "file-declaring"
remains in the two registry files; the classifier/gate/mode/blocking logic is untouched (behavior zero);
build + contract + preflight green.

## Note
Concept reviewer F-001 (residual "file-declaring" in repro-evidence-binding-dev-gate-smoke.ts) was
withdrawn (resolved/disproven): that file is outside B-6eb7's scope-boundary and the 4 occurrences are
accurate descriptions of test fixtures that literally declare files (files:{modify:[...]}), not gate-
semantics claims.

## Limitations
Prose/contract-alignment only; no behavior change. The classifier semantics shipped in B-8628.
