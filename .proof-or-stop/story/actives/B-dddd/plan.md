# B-dddd Plan

## Objective

Implement the conservative M0-M2 foundation for playbook promotion governance: explicit outcome recording, append-only learning-store persistence, and a host-neutral command surface. This story closes the assessment-recording gap only. It does not activate candidates, schedule promotion workers, add trial traffic, or make learning artifacts gate evidence.

## Scope Controls

Allowed:
- Red/repro smoke coverage for explicit playbook outcome recording.
- Learning-store outcome ledger primitives under `.lattice/learning/`.
- Host-neutral `playbook_outcome_record` command and command metadata.
- Regression coverage that proves helped requires concrete exposure and structured verdict source.

Excluded:
- Automatic candidate-to-active mutation.
- Runtime MemoryFreshnessPack candidate surfacing.
- DONE settlement hooks.
- Scheduled promotion worker/timer.
- Matched-control or trial-traffic serving.
- Host-specific Codex/Claude playbook namespaces.

## CHK-001

Add red/repro coverage for the missing playbook outcome lifecycle.

Implementation approach:
- Extend the existing playbook smoke because it already builds proposals, candidates, digest checks, command metadata, and negative controls.
- First encode the behavior the product needs: outcome recording must be explicit; ordinary story/DONE completion cannot be treated as helped; candidate helped requires a concrete exposure mode and structured verdict source.
- Keep the test independent of runtime memory consumption so candidate playbooks remain learning material unless explicitly activated elsewhere.

Verification:
- Run the focused playbook smoke command after implementation.
- Evidence must cover `CHK-001:happy:0`, `CHK-001:edge:0`, and `CHK-001:adversarial:0`.

## CHK-002

Implement learning-store outcome ledger primitives with safe write discipline.

Implementation approach:
- Add leaf type definitions for playbook outcome records and the outcome ledger envelope in `experience-layer-types.ts`.
- Add learning-store helpers for resolving, reading, validating, appending, and writing the outcome ledger in `learning-store.ts`.
- Reuse canonical JSON serialization and the existing learning owner root behavior; write under `.lattice/learning/`, keeping artifacts non-authoritative and material-hash excluded.
- Preserve append-only behavior by reading existing records, validating the new record, writing the full ledger atomically, and verifying prior records remain present.

Verification:
- Smoke asserts append preserves existing records.
- Smoke asserts invalid records fail closed without corrupting the ledger.
- Smoke asserts neutral/unknown remain observability outcomes, not decisive positive helped samples.

## CHK-003

Expose a host-neutral outcome recording command and smoke coverage.

Implementation approach:
- Add `playbook_outcome_record` to the existing playbook handler rather than a new host-specific namespace.
- Use the same playbook write lock wrapper so concurrent hosts serialize learning-store writes.
- Require `playbookId`, `outcome`, `exposureMode`, and `verdictSource` arguments. `helped` requires `exposureMode != none` plus a structured verdict source; DONE success alone is not a verdict source.
- Register the command in command catalog, command policy, and process fact registry as audit-only metadata with `authority=non_authoritative` and `gateEvidence=false`.
- The command must not change playbook status, call `playbook_activate`, file findings, or write gate evidence.

Verification:
- Smoke asserts CLI/handler output includes `authority: non_authoritative` and `gateEvidence: false`.
- Smoke asserts candidate status remains `candidate` after recording outcomes.
- Smoke asserts no `lattice codex ...` or `lattice claude ...` playbook outcome alias is introduced.

## Validation Plan

Focused validation first:
- `npm --prefix packages/main run build`
- Run the existing playbook smoke or the nearest package script that includes `packages/main/src/tasks/experience-layer-playbook-smoke.ts`.

Story validation later:
- Record verificationEvidence for each checklist item after focused tests pass.
- Run `lattice validate --story=B-dddd` in TEST.
- Bump the CLI patch version after the runtime behavior change merges to main, per project version discipline.
