# B-5964 Plan

## CHK-001
Fix the verifier source fallback parser first. Replace the regex construction that treats phase names as raw regex with a literal-safe object-key parser for DEFAULT_PHASE_TOOLS. Add synthetic regression coverage for the `*` key plus normal phases so `npm run test:process-fact-contract` can pass without relying on dist imports.

## CHK-002
Introduce a code-local typed process fact registry as the first source-of-truth layer. Keep runtime behavior compatible, but make the registry express command identity, lifecycle, level, phase/rootOnly status, producer, consumer gate, artifact/signature, reviewer lane, and destructive risk. Existing COMMAND_POLICIES and PROCESS_FACT_LEVELS can remain, but the verifier must compare them against the registry.

## CHK-003
Expand the process-fact contract to consume the registry and emit actionable drift diagnostics for command registration, phase gate alignment, L4 gate evidence, signed artifact coverage, reviewer lane naming, and config narrowing guarantees. Update docs to state the registry/source-of-truth rule and the project-config-can-only-narrow rule. Run build, process-fact contract, flow stability smoke, and story validate.

## CHK-004
Close the explicit scope gap for execution/validation status and review pass facts. Ensure the registry distinguishes validation status, execution/test evidence, verificationEvidence, review pass, finding, and gate evidence. The contract should fail if validate/test evidence/review_pass_set/finding_add are missing from registry coverage, and handler-level pass-only finding conversion must remain a hardcoded fallback rather than prompt-only behavior.
