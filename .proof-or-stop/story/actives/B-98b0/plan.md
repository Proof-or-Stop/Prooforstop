# B-98b0 Wave 2 implementation plan

The canonical milestone ledger owns the four deliverables and the checklist verificationIntent IDs own the detailed acceptance cases. This plan only sequences implementation; it does not create another acceptance matrix.

## CHK-001

Implement one pure structural evaluation path in `packages/main/src/core/acceptance-topology.ts`. It must consume the verified Wave 1A basis artifact plus the normalized Wave 1 topology, produce a deterministic ordered report, distinguish structural pass from compatibility/non-pass states, and resolve the existing flat `proofStory.devGateMode` without reading fuzzy Story prose. Extend types/config only where the shared result needs an explicit schema. No executable command, transcript, verificationEvidence, critic verdict, or caller-supplied completion enters the predicate.

Verify the M1 intent set with direct clean controls and targeted mutations: complete closed basis passes; partial, unsupported, missing, stale, tampered, omitted and invented paths return stable AT codes; observe/warn/enforce share diagnostics and differ only in blocking classification; caller status/authority fields cannot affect the result.

## CHK-002

Expose `acceptance_topology_check` through the production registry and `handlers/proofstory.ts` as a read-only diagnostic over the exact core evaluator. Register command policy, phase availability and the gate-consumed process fact with producer/verifier/consumer/rationale semantics. Update `scripts/verify-process-fact-contract.mjs` so command, handler, registry, core evaluator, lifecycle consumer and guidance omissions bite. Document exact text/JSON behavior in `docs/CLI.md`.

Verify the M2 intent set through the real CLI, malformed/caller-forged arguments, JSON/text determinism, process-fact mutations and prompt-only/mechanical-consumer disconnection. The command must not write evidence, change phase, mint Authority, or revive a writable acceptance matrix.

## CHK-003

Integrate the shared result into the PLAN→DEV branch of `packages/main/src/handlers/transition-orchestrator.ts`. In enforce mode only canonical applicable structural failure blocks; warn and observe report the same result without blocking. PLAN-safe frozen typed declarations may represent genuinely new endpoints without executable code. Encode deterministic compatibility for legacy, docs-only and single-outcome cases and do not introduce Wave 2A critic or Wave 3 executable-evidence prerequisites.

Verify the M3 intent set using isolated temporary repositories and real `story_advance`: complete current basis enters DEV; structural defects block with the intended AT code; new typed declarations enter without fake symbols; compatibility and rollback are deterministic; verificationEvidence and runtime transcripts remain unnecessary at PLAN.

## CHK-004

Create `packages/main/src/tasks/proofstory-acceptance-topology-gate-smoke.ts` as the focused production-chain suite. Cover core/CLI/lifecycle parity, all flat modes, complete and non-pass basis states, legacy/docs-only/single-outcome behavior, typed new paths, multiple ordered diagnostics, C2 topology-only omission, invention outside basis, caller forgery, stale/tampered adapter and binding data, prompt/process-fact disconnection, and scope-leakage guards. Every destructive case follows clean pass → targeted mutation → named failure → exact restoration → clean pass and checks worktree residue.

Run the focused smoke, `node scripts/verify-process-fact-contract.mjs`, `npm --prefix packages/main run build`, and a real CLI transcript before REVIEW. Record evidence against all 25 intent IDs and commit code before marking checklist items done. Root `npm test` remains reserved for canonical DONE-required validation.

## Phase ordering

1. Implement the canonical evaluator before adding consumers.
2. Wire CLI and process-fact contracts to that evaluator.
3. Wire PLAN→DEV to the same evaluator.
4. Complete focused mutation/restoration and docs verification.
5. Enter REVIEW only with a clean tree, current intent evidence, and no open scope gap; obtain all reviewer lanes and real 3×2 before TEST.
