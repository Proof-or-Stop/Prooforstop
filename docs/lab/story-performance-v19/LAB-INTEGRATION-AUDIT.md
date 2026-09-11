# Lab integration and cleanup audit

Snapshot baseline: main `6632322aec1bda45307df35490a5a2cd53dfd748`. An old GREEN is not proof of compatibility with this main. Historical performance work was checkpointed into the published Lab; non-ancestry alone does not prove that its behavior is missing. File equality also cannot prove semantic coverage.

| Lab | HEAD in main at audit | GREEN matches HEAD | Disposition |
|---|---|---|---|
| b03b7-validation-baseline-convergence | no | yes | Preserve: historical baseline |
| b49df-canonical-identity-20260909 | yes | no | Integrated ancestry confirmed; clean worktree eligible for cleanup |
| closeout-publication-baseline | no | no | Preserve: historical baseline |
| closeout-publication-proof | no | no | Preserve: uncommitted work |
| closeout-transaction-baseline | no | no | Preserve: historical baseline |
| delivery-root-cause-20260911 | no | yes | Preserve: unmerged; needs latest-main integration and acceptance audit |
| dynamic-finding-evidence-closure | no | yes | Preserve: unmerged; needs latest-main integration and acceptance audit |
| dynamic-validation-tier-selection | no | yes | Preserve: unmerged; needs latest-main integration and acceptance audit |
| five-item-integration-20260909 | yes | no | Integrated ancestry confirmed; clean worktree eligible for cleanup |
| five-item-proof-20260908 | yes | no | Integrated ancestry confirmed; clean worktree eligible for cleanup |
| lab-main-lock-scope-20260911 | no | yes | Preserve: unmerged; needs latest-main integration and acceptance audit |
| q022-optimization-20260909 | no | no | Preserve: unmerged; needs latest-main integration and acceptance audit |
| remaining-delivery-verification-20260910 | yes | no | Integrated ancestry confirmed; clean worktree eligible for cleanup |
| repro-first-enforcement-0296 | no | yes | Preserve: unmerged; needs latest-main integration and acceptance audit |
| story-performance-closure-v4 | no | no | Preserve: uncommitted work |
| story-performance-main-0296 | no | no | Current release integrates this checkpoint |
| story-performance-v4-baseline | no | no | Preserve: uncommitted work |
| validation-reuse-proof | no | yes | Preserve: unmerged; needs latest-main integration and acceptance audit |

## Confirmed unmerged GREEN heads outside the release checkpoint

- `b03b7-validation-baseline-convergence` at `3828191b2b05d6727958c4f314a0ec57bd46eecc`: recorded GREEN matches HEAD, but the head is not an ancestor of main. Changed paths relative to the common main ancestor: 12. This is an integration gap, not a claim of complete product readiness.
- `delivery-root-cause-20260911` at `1f23dabb3427cce0f54eec274f1a50ac51372c5d`: recorded GREEN matches HEAD, but the head is not an ancestor of main. Changed paths relative to the common main ancestor: 21. This is an integration gap, not a claim of complete product readiness.
- `dynamic-finding-evidence-closure` at `a58cd309fdb319b68f2983acae124ba4dee764c4`: recorded GREEN matches HEAD, but the head is not an ancestor of main. Changed paths relative to the common main ancestor: 63. This is an integration gap, not a claim of complete product readiness.
- `dynamic-validation-tier-selection` at `0decca4f8bfc08dfe6677ae17c2bf2f96e21194b`: recorded GREEN matches HEAD, but the head is not an ancestor of main. Changed paths relative to the common main ancestor: 8. This is an integration gap, not a claim of complete product readiness.
- `lab-main-lock-scope-20260911` at `9299a7067c330174b5af4d4e1e0b8ad07929a970`: recorded GREEN matches HEAD, but the head is not an ancestor of main. Changed paths relative to the common main ancestor: 8. This is an integration gap, not a claim of complete product readiness.
- `repro-first-enforcement-0296` at `b0ab33dbdc1e1573e9fa6a4999da076b11be2ad3`: recorded GREEN matches HEAD, but the head is not an ancestor of main. Changed paths relative to the common main ancestor: 7. This is an integration gap, not a claim of complete product readiness.
- `validation-reuse-proof` at `2ddf8dc2dd45a41a100daf7ea575b825adcafa27`: recorded GREEN matches HEAD, but the head is not an ancestor of main. Changed paths relative to the common main ancestor: 9. This is an integration gap, not a claim of complete product readiness.

The maintenance records are read-only provenance. Cleanup never rewrites them to fabricate a managed finish or a Story DONE. Ignored local files other than reproducible dependency/build trees are backed up privately before removal; these backups are not release assets.
