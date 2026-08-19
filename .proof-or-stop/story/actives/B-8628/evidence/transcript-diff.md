# B-8628 real-machine acceptance transcript + diff

## Expected (PLAN outcome)
`lattice story_create` for a docs-only bug / refactor / chore no longer prints the Repro-first
STORY_INTAKE preflight warning; a type=bug|feature declaring a material-code file still does. The
dev-gate smoke prints its pass line; npm test green.

## Actual (run from the story worktree)

RED (red/spike, before the fix): the classifier required=true for docs-bug/docs-feature/material-refactor/chore (4 over-reaches; exit 1).

After the fix (worktree dist), classifyReproFirstRequirement returns:
```
docs-only bug      required=false  reason=bypass_eligible_no_files
docs feature       required=false  reason=bypass_eligible_no_files
material refactor  required=false  reason=bypass_eligible_no_files
chore w/ material  required=false  reason=bypass_eligible_no_files
no-file bug        required=false  reason=bypass_eligible_no_files
material bug        required=true   reason=code_verifiable_behavior_change
material feature    required=true   reason=code_verifiable_behavior_change
high-risk no-file   required=true   reason=high_risk_code_verifiable
```

```
$ npm --prefix packages/main run build           # clean (tsc); no circular import
$ node packages/main/dist/tasks/repro-evidence-binding-dev-gate-smoke.js
repro evidence binding dev gate smoke passed     # ok 37, incl. the B-8628 8-case regression
$ node packages/main/dist/tasks/repro-first-candidate-smoke.js
repro-first candidate smoke passed               # unaffected
$ lattice validate (REVIEW->TEST gate)
CLI gate preflight: all pass; validate PASS, writing test-evidence.json
```

The new primary reason surfaces a specific message (F-002 fix): formatStoryEvidenceBindingGateFailure
for reason=code_verifiable_behavior_change shows "this is a code-verifiable behavior change (a
bug/feature that writes material code)", not the generic default.

## Diff (expected vs actual)
No difference. The 4 over-reach cases are exempt; material bug/feature + high-risk stay required; the
red/spike regression locks both directions; build + smokes + validate green.

## Limitations
Intake exempts no-material-file bug/feature (option A); the DEV-phase repro-evidence-binding gate
re-checks once material files are declared. The off/warn/enforce mode + blocking math + bypass are
unchanged. Reviewers F-001 (comments) + F-002 (formatter case) resolved.
