# W2d — Assertion-envelope validation and matcher admissibility

Implements Workstream 2 area 4 of `docs/requirements/decisions/red-evidence-subsystem-spec.md`: §1.1 (envelope
schema + every field's validation rule), §1.3 (the three quantified minimum-specificity rules), §1.11.4 (the
exact entropy formula), the `assertionDigest` scope, and the §1.1.3 committed-binding check — terminating at a
**read-only** `red_evidence_envelope_check(storyId, assertionFile)` operator pre-flight.

## Invariants (hold across every item)
- Validation is **schema-time and fail-closed**; anything decidable from the envelope alone is rejected without
  spending a run.
- Rejections carry the correct §1.6 tag: **R1-1** missing target-exercised proof · **R1-2** below-threshold or
  class-only matcher set (minimum specificity) · **R1-3** matcher and path BOUNDS, explicitly including path
  validation (a schema-bounds tag, NOT specificity) · **R1-6** unregistered or mismatched target binding.
  R1-2 and R1-3 must never be collapsed.
- The command is **read-only**: no gate verdict, no gate wiring, no enforcement-mode change, no chain record.
- Cross-references anchor on **command/function names**, never line numbers — those files drift.
- Commits authored as `lattice-implementer <lattice-implementer@noreply.local>`; artifacts English-only.

## Reserved for later leaves
Spawning processes and capturing output, receipt persistence and chunk framing, and the GREEN confirmation
append entrypoint. This leaf validates envelopes and never executes one.

## CHK-001 — Declare the assertion envelope schema with unique matcher ids and a kind enum limited to literal-line and class with no pattern language

packages/main/src/core/red-evidence/envelope.ts declares the section 1.1 envelope: matcher ids unique within the envelope; kind restricted to the closed set {literal-line, class}; NO pattern/regex dialect exists anywhere in the type or the validator (section 1.11 rule 1 pins literal-line as a whole-line trimmed string comparison, nothing compiled).

## CHK-002 — Enforce trimmed literal values within one to maxMatcherLen bytes and the closed stream and polarity enums

Literal values MUST be stored trimmed (leading/trailing whitespace rejects) with byte length in 1..policy.maxMatcherLen; stream and polarity are closed enums, polarity being {present-in-red, absent-in-green, present-in-green}. Byte length, not code-unit length.

## CHK-003 — Require at least one present-in-red matcher and allow greenExempt only on present-in-red

Section 1.1: an envelope with no present-in-red matcher is rejected; greenExempt carried by any other polarity is rejected. greenExempt is an assertion-subobject field and is therefore covered by assertionDigest.

## CHK-004 — Reject the timeout-is-failure with script-exit linkage incompatibility at schema time via the expectedExitClass enum

expectedExitClass is a closed enum; an envelope combining timeout-is-failure with a script-exit adapter linkage is REJECTED at schema time, not deferred to a run, because it is decidable from the envelope alone.

## CHK-005 — Validate supplementaryArtifact targetArtifactRef path syntax rejecting absolute, empty, dot, dot-dot and backslash segments

Section 1.1: targetArtifactRef is slash-normalized and validated SYNTACTICALLY (realpath cannot classify a path that does not yet exist, which is the RED case). Absolute paths and empty/dot/dot-dot/backslash segments reject.

## CHK-006 — Implement minimum-specificity rule 1 rejecting degenerate literals via the forbiddenCatchAlls blocklist

Section 1.3 rule 1: value must be trimmed, non-empty, and not a member of policy.forbiddenCatchAlls (the hygiene blocklist of punctuation-only lines). The frozen default policy from W2a supplies the list; policyDigest sha256:470db38278a59387f2105c8bcdcca59ee52c8706cb3c69f7e150d3cd1154d767.

## CHK-007 — Implement minimum-specificity rule 2 as a length AND entropy CONJUNCTION, not a disjunction

Section 1.3 rule 2: admissible iff len(value) >= policy.minMatcherLen AND entropyBits(value) >= policy.minMatcherEntropyBits. An OR implementation admits matchers the spec forbids; the RED evidence is a differential table over the frozen default policy that separates AND from OR.

## CHK-008 — Implement minimum-specificity rule 3 so a class matcher can never be the sole present-in-red evidence

Section 1.3 rule 3: class matchers are supplementary for RED. An envelope whose only present-in-red matcher is a class matcher is rejected — otherwise a lone stderr-nonempty matcher would accept any failing run whatsoever. Class matchers remain exempt from rule 2.

## CHK-009 — Implement the exact section 1.11.4 entropy formula as byteLength times empirical per-byte Shannon entropy, total bits not per-symbol

entropyBits(value) = len(value) x H where len is BYTE length and H is the empirical per-byte Shannon entropy over the byte frequency distribution of value. TOTAL bits, not per-symbol. A per-symbol implementation yields provably different admissibility verdicts on a fixture table — that difference is the RED signal.

## CHK-010 — Compute assertionDigest as CANON over the assertion subobject including policyDigest and excluding assertionDigest

assertionDigest = W2a CANON over the assertion subobject with policyDigest INCLUDED and assertionDigest itself EXCLUDED. A validator that forgets to strip the field, or omits policyDigest, produces a different digest on the same envelope; both directions are asserted.

## CHK-011 — Validate the assertion against the committed target binding and recompute targetBindingDigest, returning tagged R1-1, R1-2, R1-3 and R1-6 rejections

Section 1.1.3: the assertion's adapterId and testCaseRef MUST equal the committed binding for its acceptanceTargetRef (read via the W2b committed-tree reader), and targetBindingDigest MUST recompute over the createdAt-stripped three-field subobject. Rejections carry the section 1.6 tags, mapped correctly: R1-1 = missing target-exercised proof; R1-2 = below-threshold or class-only matcher set (the minimum-specificity failure); R1-3 = matcher and path BOUNDS (a schema-bounds tag that explicitly covers path validation, NOT a specificity tag); R1-6 = unregistered or mismatched target binding. An implementer must not collapse R1-2 and R1-3 into one 'specificity' bucket.

## CHK-012 — Land the read-only red_evidence_envelope_check command following the acceptance_topology_check house pattern and record the section 5.5 fence reasoning

red_evidence_envelope_check(storyId, assertionFile) validates a candidate envelope against the resolved policy and the story's registered binding BEFORE a run is spent, following the verified read-only house pattern of acceptance_topology_check, topology_critic_receipt_check and proofstory_gate_check in packages/main/src/cli/command-catalog.ts (anchored by command name because that file drifts). It changes no gate verdict. SUCCESS OUTPUT CONTRACT: on an admissible envelope it reports the computed assertionDigest, the matched binding reference (acceptanceTargetRef, adapterId, testCaseRef) and the resolved policyDigest, so the operator can proceed; the smoke asserts that success transcript, not only the rejection cases. The story records explicitly that a read-only operator pre-flight is not a new query surface added to satisfy an enforcement need and therefore sits outside the section 5.5 fence.

## CHK-013 — Register red-evidence-envelope-smoke in lattice.config.json validate.commands and wire the new command through the registration recipe

packages/main/src/tasks/red-evidence-envelope-smoke.ts covers the schema rules, the three specificity rules, the exact entropy formula, the assertionDigest both directions, the binding validation and the tagged rejection matrix; register it in lattice.config.json validate.commands and wire red_evidence_envelope_check through the registration points its read-only phase/level class requires, verified by the three existing registry contracts.

## CHK-014 — Define and assert the admissible-envelope success output reporting assertionDigest, matched binding and resolved policyDigest

The operator's primary use case is the happy path: an admissible envelope must produce a legible confirmation carrying the computed assertionDigest, the matched binding reference and the resolved policyDigest. Without this the DONE outcome transcript could only demonstrate rejections. The smoke asserts the success transcript alongside the tagged rejection matrix.

## The three differential proofs (the convergence anchor)
- **Total-bits entropy** — `entropyBits(value) = byteLength(value) × H`. A per-symbol implementation yields
  different admissibility verdicts on a fixture table under the frozen default policy; that difference is the
  RED signal, not an opinion.
- **Conjunction, not disjunction** — rule 2 is length floor **AND** entropy floor. A table containing values
  that satisfy exactly one floor separates AND from OR.
- **assertionDigest scope, both directions** — the digest over the stored object (which carries
  `assertionDigest`) must NOT equal it; the digest over the correctly stripped subobject, with `policyDigest`
  included, MUST.
