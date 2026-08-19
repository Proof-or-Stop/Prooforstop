# Plan — B-e10d: target-binding store + owner-gated red_evidence_binding_set

Second W2 leaf. Adds the red-target-bindings.json store + the subsystem's first mutating CLI command, landing the complete 13-point wiring recipe. Reuses W2a canonDigest. Changes NO gate verdict.

Resolved facts: binding identity = `{acceptanceTargetRef, adapterId, testCaseRef}` (§1.1.3 lines 209-238); stored entry adds `createdAt`; targetBindingDigest = canonDigest over the 3-field subobject ONLY (strip createdAt). Store file schema proofstory.red_target_bindings.v1 = `{schemaVersion, storyId, bindings:[{acceptanceTargetRef,adapterId,testCaseRef,createdAt}], createdAt, updatedAt}`. binding-freeze (chain-head) is W2c, OUT of scope here.

## CHK-001 — Persist red-target-bindings.json through StoryStore with exactly one binding per acceptance target
Approach: core/store.ts read/write for .lattice/story/actives/<id>/red-target-bindings.json (schema proofstory.red_target_bindings.v1); enforce exactly one binding per acceptanceTargetRef (§1.1.3) — a second write for the same ref is a duplicate-target rejection, not an overwrite. Types in core/types.ts declare the binding entry + v1 file shape.
Files: core/red-evidence/target-bindings.ts (new), core/store.ts, core/types.ts.
Verification: smoke asserts a first write persists, a second write for the same acceptanceTargetRef rejects (duplicate), a different target appends a second binding.

## CHK-002 — Compute targetBindingDigest over the createdAt-stripped three-field subobject only
Approach: target-bindings.ts computes targetBindingDigest = canonDigest (W2a) over exactly `{acceptanceTargetRef,adapterId,testCaseRef}` with createdAt (and any storage metadata) stripped.
Files: core/red-evidence/target-bindings.ts.
Verification: RED differential — canonDigest over a STORED entry (with createdAt) does NOT equal the recorded targetBindingDigest, while canonDigest over the 3-field stripped subobject DOES.

## CHK-003 — Export expectedRedTargets as one shared resolver and gate binding writes on target membership
Approach: extract the module-private expectedRedTargets (core/proofstory.ts:887, used :916) into a shared exported resolver WITHOUT changing its computed set; red_evidence_binding_set rejects (§3.3) any acceptanceTargetRef not in expectedRedTargets.
Files: core/proofstory.ts, handlers/red-evidence.ts.
Verification: same-set assertion (exported resolver returns identical set for representative inputs); a write with an out-of-set ref rejects.

## CHK-004 — Resolve the authorizing binding from a committed tree ref and never from the live story directory
Approach: target-bindings.ts committed-tree reader resolves `<ref>:.lattice/story/actives/<id>/red-target-bindings.json` via git show, never the live directory (§1.1.3 anti-swap).
Files: core/red-evidence/target-bindings.ts.
Verification: a test where the committed tree and the live directory hold DIFFERENT bindings asserts the reader returns the committed one.

## CHK-005 — Register red-target-bindings.json in the lifecycle artifact set and the ProofStory artifact path list
Approach: add the filename to LATTICE_LIFECYCLE_ARTIFACT_FILENAMES (core/lifecycle-registry.ts:599) so the classifier's unknown-top-level-artifact rejection (:849) accepts it, and to the ProofStory artifact path list.
Files: core/lifecycle-registry.ts.
Verification: the scope classifier returns lifecycle metadata (not null) for the file; a story touching it can reach DONE (RED signal A closes).

## CHK-006 — Register red_evidence_binding_set at every wiring point including the closed mutation-command union
Approach: register in registry.ts (dispatchability — command-ownership-contract.ts:136), cli/command-catalog.ts (MAIN_TOOLS, defined :228), core/command-policy.ts, core/config.ts, core/process-fact-levels.ts, core/process-fact-registry.ts, AND the two the spec never names: the closed AgentDispatchMutationCommand union (core/types.ts:69) and the per-role permittedMutations arrays gating entryPermitsMutation (agent-dispatch-registry.ts:435).
Files: registry.ts, cli/command-catalog.ts, core/command-policy.ts, core/config.ts, core/process-fact-levels.ts, core/process-fact-registry.ts, core/types.ts, core/agent-dispatch-registry.ts.
Verification: lifecycle-registry-contract.ts (bidirectional, checkProcessFactLifecycle() ~:150) and command-ownership-contract.ts pass only when all points present.

## CHK-007 — Gate the command through the owner lease and resolved agent mutation authority
Approach: the command flows through the single CLI choke point (cli-engine.ts:1372) as a storyScopedMutating ownership class gated by enforceStoryOwnerLeaseGate and by resolveAgentMutationAuthority (agent-dispatch-registry.ts:504) via entryPermitsMutation (:435); rejected under a FOREIGN active owner lease (§4.1).
Files: handlers/red-evidence.ts, core/agent-dispatch-registry.ts, core/command-policy.ts.
Verification: a call while a foreign session holds an active owner lease rejects; the owner's call succeeds.

## CHK-008 — Update the four hard-coded ProofStory command enumerations and the frozen catalog order assertion
Approach: update the process-fact-levels map (verify-process-fact-contract.mjs near :160) plus the three command-name enumeration arrays (:1013 MAIN_TOOLS/catalog, :1229 command-policy, :1265 process-fact-levels+registry), and the frozen trailing-order assertion at command-catalog-smoke.ts:102-109.
Files: scripts/verify-process-fact-contract.mjs, packages/main/src/tasks/command-catalog-smoke.ts.
Verification: node scripts/verify-process-fact-contract.mjs passes only when all four enumerations include the command; command-catalog-smoke asserts the new command's trailing position.

## CHK-009 — Register red-evidence-target-binding-smoke in lattice.config.json validate.commands and prove no gate verdict changes
Approach: create packages/main/src/tasks/red-evidence-target-binding-smoke.ts covering store uniqueness, createdAt-strip digest both directions, expectedRedTargets same-set + membership gate, committed-tree reader, foreign-lease rejection, and running the three existing contracts; register it in lattice.config.json validate.commands. Prove NO existing gate verdict changes (redEvidenceSatisfied/missingRedEvidence and all gates untouched).
Files: packages/main/src/tasks/red-evidence-target-binding-smoke.ts, lattice.config.json.
Verification: the smoke passes under the full validate suite; an assertion pins that redEvidenceSatisfied/missingRedEvidence outputs are unchanged for a representative story.
