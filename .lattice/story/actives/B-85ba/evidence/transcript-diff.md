# B-85ba User-Value Transcript Diff

## Expected

Running the completed story should show that the INIT scope anti-expansion gate is mechanically enforced before INIT_CHECK: missing boundaries block, excluded future keywords block, pending scope extension proposals block, repeat discarded directions require mitigation, and INIT reviewer lanes cannot mutate checklist or story-level scope directly.

## Actual

`lattice validate --story=B-85ba` passed on 2026-06-13. It ran the project fallback validation command `npm test`, which completed `story-lifecycle` and `gap-convergence` with `ALL PASS`. It also reported verification intent coverage `15/15 covered`.

Focused reviewer and local verification also passed:

- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:scope-anti-expansion-smoke`
- `npm --prefix packages/main run test:worktree-authority-smoke`
- `npm --prefix packages/main run test:flow-stability-smoke`
- `node scripts/verify-process-fact-contract.mjs`
- `npm run test:runtime-fact-contract`
- `npm test`

## Diff Notes

Expected and actual match. The only advisory note is that no dedicated `validate.ts/js/mts` exists, so Lattice used fallback discovery and ran the repository `npm test` script. The story-specific smoke and contract commands cover the anti-expansion behaviors more directly than the fallback validation script.

## Acceptance

Accepted from the product/process perspective: the change closes the INIT expansion routes found during review, including the late F-013 `story_update` bypass, and keeps scope expansion routed through explicit proposal/decision evidence rather than reviewer-side mutation.
