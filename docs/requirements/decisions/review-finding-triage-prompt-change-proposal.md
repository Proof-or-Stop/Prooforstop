# REVIEW Finding Triage Prompt Change Proposal

Status: executable Agent-side proposal

Authority: subordinate projection of
`docs/requirements/decisions/dynamic-finding-system-execution-plan.md`

Scope: Agent prompts, public Agent guidance, a bounded documentation-only
amendment to the Dynamic Finding target-state plan, REVIEW-only prompt-envelope
assembly safety, and semantic prompt tests

## 1. Decision

Proof-or-Stop should teach every active REVIEW lane and the Story Owner one
bounded Finding-triage discipline:

> Repair mandatory current-Story defects now. Preserve and route genuinely
> non-applicable defects with evidence. When the future official Dynamic
> Finding System exists, allow its narrow signed defer-with-proof disposition
> only for eligible verified applicable low or medium Findings. Never widen a
> Story merely to make the repository globally green.

This document is executable because it defines the exact Agent behavior,
delivery surfaces, semantic rejection cases, and verification work for the
prompt change. It is not a runtime implementation plan.

## 2. Authority and boundary

The Dynamic Finding System Execution Plan is the authoritative target-state
design. This proposal is its Agent-side projection. If the two documents ever
disagree, the Dynamic Finding plan wins and this proposal must be updated.

This proposal may change:

- the canonical REVIEW Finding triage contract appended to active REVIEW roles;
- Story Owner guidance in `AGENTS.md` and `CLAUDE.md`;
- bounded implementer handoff guidance;
- the documentation-only Dynamic Finding plan amendment that makes the
  target-state verdict vocabulary and compatibility boundary authoritative,
  without implementing those target-state records or commands;
- pre-digest REVIEW Task Context authority validation in prompt-envelope
  assembly, without changing Dynamic Finding records or lifecycle facts;
- semantic mutation tests and approved prompt digests; and
- a non-runtime digest check for this proposal.

This proposal does not authorize changes to:

- Finding schemas or stored records;
- handlers or CLI command behavior;
- lifecycle predicates or REVIEW, TEST, and DONE gates;
- process-fact registries;
- severity, applicability, freshness, or supersession computation; or
- historical Finding data.

Prompt text guides Agents. The CLI, handler, signed verifier, and gate remain
the only mechanical authorities for lifecycle facts.

## 3. Affected Agent surfaces

This change does not copy the same contract into every source template. The
canonical contract is appended once during assembly to the five active modular
REVIEW roles:

- `lattice-review-behavior`;
- `lattice-review-concept`;
- `lattice-review-docs`;
- `lattice-review-quality`; and
- `lattice-review-test-coverage`.

Story Owner behavior is mirrored byte-for-byte in `AGENTS.md` and `CLAUDE.md`.
The implementer keeps a smaller handoff rule: preserve evidence, report the
out-of-item issue, and never widen the assigned item or Story unilaterally.

This assembly model keeps the five active modular REVIEW roles consistent
without creating five independent copies that can drift.

## 4. Keep inputs separate and derive gate impact

Agents must keep four decision inputs independent and treat gate impact as a
separate machine-derived result:

| Kind | Dimension | Question | Agent obligation |
| --- | --- | --- | --- |
| Input | Observation and evidence state | What was observed, and is it suspected, verified, or disproven? | Preserve the observation, its evidence, and its evidence state. |
| Input | Severity | How harmful is the observation? | Preserve the original severity; do not use it as a scope shortcut. |
| Input | Applicability | Does the verified Finding belong to this target Story and current material? | Propose only the verdict supported by current evidence; unknown fails closed. |
| Input | Disposition | After applicability is established, what authorized action applies: current repair, evidence-backed routing, or a future official signed deferral? | Consume only an available official disposition; never infer or mint one in prompt prose. |
| Derived result | Gate impact | Does current machine policy block this lifecycle transition? | Consume the current machine-computed result from facts recognized by current policy. In the future official system, the gate derives it from fresh signed applicability and disposition facts; prompt prose never decides it. |

Severity does not determine applicability. Applicability does not rewrite
severity or Finding truth. Deferral is a disposition after `applicable`, not an
applicability verdict and not a resolution state. Disposition does not itself
rewrite the observation, evidence state, severity, or applicability. Gate
impact is not a fifth discretionary Agent input.

## 5. Applicability vocabulary and minimum evidence

The Agent projection uses the current target-state verdict vocabulary:

- `applicable`;
- `pre_existing_unaffected`;
- `out_of_scope`;
- `duplicate`;
- `not_reproduced_under_current_witness`; and
- `unknown`.

The retired name `stale_or_not_reproduced` must not appear in delivered Agent
guidance. Staleness is a freshness state; failure to reproduce under a current,
target-bound witness is an evidence-backed applicability verdict.

Minimum proposal evidence is verdict-specific:

| Candidate | Minimum evidence the Agent must require |
| --- | --- |
| `pre_existing_unaffected` | Deterministic base and head reproduction of the same defect, proof of no worsening, no Story promise to repair it, and a valid owner or route. |
| `out_of_scope` | Signed scope or decision evidence naming the excluded contract, no contradictory checklist or acceptance promise, and a valid owner or route. |
| `duplicate` | A signature-valid live canonical Finding, a live owner or route, and proof that the canonical chain is not circular. |
| `not_reproduced_under_current_witness` | Current target-bound negative command and runtime receipts, fresh source and runtime bindings, a signed command-policy and witness digest, and a live receipted owner or route. An old DONE outcome is never sufficient. |
| `unknown` | Missing, invalid, stale, incomplete, or contradictory applicability proof. It fails closed for any issue that would otherwise block. |

File disjointness, a matching signature tag, reviewer confidence, historical
learning, or a prose assertion is never sufficient proof by itself.

## 6. Mandatory current-Story repair

A verified applicable Finding requires current-Story repair when any of these
conditions is true:

- severity is `critical` or `high`;
- the current Story introduced or worsened the defect;
- it directly violates acceptance, a verification intent, the core user result,
  or a public compatibility promise;
- data integrity, security or privacy, package publish or clean install, the
  primary CLI entrypoint, Agent resolution, historical evidence integrity, or
  lifecycle gates are affected or uncertain;
- REVIEW, TEST, DONE, or their evidence would become misleading;
- claimed deferral lineage is missing, invalid, expired, tampered, ownerless,
  or partially applied; or
- the ledger-derived cumulative deferral horizon or renewal allowance is
  exhausted.

Mandatory repair means preserving RED or reproduction evidence, establishing
root cause, fixing the defect, and recording fresh GREEN or closure evidence.
Unknown applicability fails closed; it is not permission to route or defer.

## 7. Future official defer-with-proof disposition

`defer_with_proof` is a disposition after `applicable`, not an applicability
verdict. The authoritative future system may sign it only for an otherwise
eligible verified applicable `low` or `medium` Finding. Current repair remains
the default; deferral is the bounded exception.

Eligibility requires all of the following:

- current reproduction evidence;
- proof that the Story did not introduce or worsen the defect;
- no direct acceptance or verification-intent relationship;
- no known or uncertain protected-surface impact;
- a canonical defect identity and reason code;
- fresh source, material, runtime, scope, and policy bindings;
- a live owner and an already existing target Story or B-META gap;
- target-side acceptance of the exact immutable route proposal through a valid
  route receipt;
- recheck triggers and finite expiry; and
- an unexhausted ledger-derived cumulative horizon and renewal count.

A valid deferred Finding remains verified, open, visible, and unchanged in
severity. It is advisory for the current Story only through the official signed
disposition. It is not `out_of_scope`, `pre_existing_unaffected`, `duplicate`,
`disproven`, dismissed, resolved, or repaired.

## 8. Current compatibility behavior

The current compatibility CLI does not implement the future signed
`FindingDeferralDisposition` or `defer_with_proof` path. Until the official
commands and artifacts exist, Agents must:

1. start a current reviewer run and carry its `reviewRunId`;
2. record the observation through `finding_add`;
3. preserve reproduction, impact, uncertainty, and source or command evidence;
4. return disposition to the Story Owner;
5. use only fields and commands actually exposed by the current CLI; and
6. follow current mechanical policy without claiming that a target-state
   assessment or deferral occurred.

Agents must not fabricate assessment fields, verdicts, disposition plans,
owners, routes, accepted-route proofs, signatures, freshness bindings, expiry,
lineage, receipts, or manifest actions.

`finding_dismiss`, `gap_log`, and backlog notes are compatibility accounting.
They do not prove applicability, `out_of_scope`, deferral, repair, resolution,
or target acceptance. A compatibility record must never erase, rewrite, or
silently lower the original Finding.

## 9. Reviewer and Story Owner responsibilities

Reviewers audit and record. They do not repair implementation, rewrite scope,
create follow-up Stories, or invoke Story Owner accounting commands. Each lane
must use a fresh current-material reviewer envelope. If a role body or policy
changes, the previous envelope and `reviewRunId` are stale and must not be
reused.

The Story Owner consumes registered Findings, current CLI facts, and reviewer
evidence. The Owner decides which currently available action to invoke but may
not treat compatibility accounting as structured applicability or deferral
proof.

When no Finding remains, the reviewer records `review_pass_set`; it never
encodes a pass as a synthetic Finding.

## 10. Semantic test strategy

The prompt tests must fail before the production contract changes and pass only
after all delivery surfaces agree.

GREEN requires:

- exact approved headings and normative clauses;
- the new verdict vocabulary and negative-witness freshness requirements;
- explicit future deferral eligibility and mandatory-repair exclusions;
- explicit current compatibility limitations;
- byte-identical Story Owner guidance across `AGENTS.md` and `CLAUDE.md`;
- English-only proposal and changed guidance slices;
- one canonical contract in every legacy and modular assembled reviewer body;
- no contract in non-review roles;
- refreshed approved prompt and host-render digests; and
- process-fact and runtime-fact contract checks with no protected-runtime diff.

Mutation tests must reject, including after deliberate digest repinning and in
the complete assembled reviewer body:

- the retired pre-current-witness verdict vocabulary;
- treating `defer_with_proof` as an applicability verdict;
- deferring critical or high Findings;
- deferring when protected-surface impact is unknown;
- claiming the compatibility CLI can mint or sign future dispositions;
- treating `finding_dismiss`, `gap_log`, or backlog accounting as deferral
  proof;
- making unknown applicability non-blocking or deferrable; and
- allowing an ownerless or receipt-free official deferral.

The Task Context authority guard must compare normalized concepts, their
semantic relationship, and assertion polarity. It must reject equivalent
authority claims after underscore, hyphen, word-order, or punctuation changes;
it must accept explicit prohibitions and documented legacy-input migration that
normalizes the alias before any official signing step. It remains REVIEW-only
and runs before envelope digests are minted.

Digest pins provide change review, but they are not the semantic oracle. The
independent normative manifest and contradiction mutations must still reject an
inverse contract after a digest is refreshed.

## 11. Consistency with the Dynamic Finding plan

| Dynamic Finding authority | Agent-side projection in this proposal |
| --- | --- |
| Finding truth and severity remain immutable historical facts. | Prompts prohibit deletion, silent severity rewrite, and false resolution. |
| Applicability is a signed target-Story relationship. | Agents propose candidates from current evidence and fail closed without official proof. |
| `not_reproduced_under_current_witness` requires a strong current target-bound witness. | Prompts require fresh negative command/runtime receipts, signed witness bindings, and a live receipted owner or route. |
| Deferral is a disposition after `applicable`. | Prompts never treat `defer_with_proof` as a verdict or `out_of_scope`. |
| Only eligible verified applicable low/medium Findings may defer. | Prompts enumerate the eligibility floor and preserve mandatory repair conditions. |
| Invalid or exhausted deferral lineage enters mandatory repair. | Agents fail closed and do not invent renewals or receipts. |
| Current plan is specification-only until future Stories implement it. | Prompts explicitly say the compatibility CLI cannot exercise the target-state mechanism. |
| Gates consume signed structured facts. | Prompt prose and compatibility accounting are never presented as gate evidence. |

## 12. Completion criteria

This proposal is fully executed only when:

- the proposal is tracked and digest-covered;
- all text added by this change is English;
- the canonical REVIEW contract matches the current Dynamic Finding authority;
- all five REVIEW lanes receive the contract in every supported assembly mode;
- Story Owner guidance is synchronized across Codex and Claude surfaces;
- semantic RED/GREEN mutations prove inverse and obsolete behavior fails even
  after digest repinning;
- approved prompt baselines are refreshed without weakening their independent
  approval boundaries;
- focused and full prompt tests, build, process-fact checks, and runtime-fact
  checks pass; and
- no Dynamic Finding runtime schema, handler, gate, or process-fact protected
  file changes are present.
