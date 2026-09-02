# REVIEW Finding Triage Prompt Change Proposal

Status: executable Agent-side proposal

Authority: subordinate projection of
`docs/requirements/decisions/dynamic-finding-system-execution-plan.md`

Scope: Agent prompts, public Agent guidance, REVIEW-only prompt-envelope
assembly safety, and semantic prompt tests

## 1. Decision

Proof-or-Stop should teach every active modular REVIEW prompt-delivery role and
the Story Owner one bounded Finding-triage discipline:

> Repair mandatory current-Story defects now. Preserve and route genuinely
> non-applicable defects with evidence. When the future official Dynamic
> Finding System exists, allow its narrow signed defer-with-proof disposition
> only for eligible verified applicable low or medium Findings. Never widen a
> Story merely to make the repository globally green.

This document is executable because it defines the exact Agent behavior,
delivery surfaces, semantic rejection cases, and verification work for the
prompt change. It is not a runtime implementation plan.

The complete B-9a49 branch also contains separately reviewed CHK-005 and
CHK-006 acceptance-infrastructure and identity-migration repairs, including
acceptance coverage-basis support. Those repairs have their own authority and
acceptance evidence. This proposal neither specifies nor authorizes them;
statements here about this proposal or prompt change describe only the REVIEW
Finding-triage slice, not every file in the delivered branch.

## 2. Authority and boundary

The Dynamic Finding System Execution Plan is the authoritative target-state
design. This proposal is its Agent-side projection. If the two documents ever
disagree, the Dynamic Finding plan wins and this proposal must be updated.
This Story does not amend the Dynamic Finding plan or its runtime, and it does
not retain retired verdict vocabulary as a legacy input alias. A retired term
may appear here only to prohibit its delivery as active Agent guidance.

This proposal may change:

- the canonical REVIEW Finding triage contract appended to active REVIEW roles;
- declarative Role Contract metadata that adds the
  `defect-triage-and-routing-check` required-check identifier to those same
  roles; this identifier is Agent-visible guidance, not evidence that the
  check ran and not lifecycle gate evidence;
- Story Owner guidance in `AGENTS.md` and `CLAUDE.md`;
- bounded implementer handoff guidance;
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

- `proof-or-stop-review-behavior`;
- `proof-or-stop-review-concept`;
- `proof-or-stop-review-docs`;
- `proof-or-stop-review-quality`; and
- `proof-or-stop-review-test-coverage`.

Story Owner behavior is mirrored byte-for-byte in `AGENTS.md` and `CLAUDE.md`.
The implementer keeps a smaller handoff rule: preserve evidence, report the
out-of-item issue, and never widen the assigned item or Story unilaterally.

Here, "five active modular REVIEW roles" means this canonical prompt-delivery
set. It does not include the active topology-critic lane, other active roles
outside this modular REVIEW delivery set, compatibility aliases, or retired
lanes that may still exist in broader runtime inventories. Those surfaces
neither receive this contract nor gain its required-check identifier.

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
| Input | Disposition | After applicability is established, what exact future assessment plan or non-applicable route binding applies? | Consume only an available official signed binding; never infer or mint one in prompt prose. |
| Derived result | Gate impact | Does current machine policy block this lifecycle transition? | Consume the current machine-computed result from facts recognized by current policy. In the future official system, the gate derives it from fresh signed applicability and disposition facts; prompt prose never decides it. |

Severity does not determine applicability. Applicability does not rewrite
severity or Finding truth. Deferral is a disposition after `applicable`, not an
applicability verdict and not a resolution state. Disposition does not itself
rewrite the observation, evidence state, severity, or applicability. Gate
impact is not a fifth discretionary Agent input.

In the future official system, the final assessment binding is a discriminated
union rather than generic action prose:

- Every future final `applicable` assessment binds exactly one
  `dispositionPlan`: `repair_current` or `defer_with_proof`.
- `repair_current` forbids `acceptedRoute`; `defer_with_proof` requires the
  exact accepted `finding_route` tuple.
- Final `pre_existing_unaffected`, `out_of_scope`, `duplicate`, and
  `not_reproduced_under_current_witness` verdicts bind no `dispositionPlan` and
  require the exact `acceptedRoute`.
- `unknown` binds neither `dispositionPlan` nor `acceptedRoute`.

Only `applicable + dispositionPlan='defer_with_proof'` plus that exact route may
feed the separate signed `FindingDeferralDisposition`. The final assessment
field is `dispositionPlan`; the deferral copy is
`FindingDeferralDisposition.assessmentDispositionPlan='defer_with_proof'`, and
the manifest binding is `expectedAssessmentDispositionPlan`. These are future
authority fields. The current compatibility CLI must not fabricate them.

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
| `unknown` | Current evidence references, an unresolved `direct_scope` or `counter_evidence` basis, current source, scope, and runtime bindings, and the uncertainty that prevents a conclusive verdict; no `nonBlockingProof`, `acceptedRoute`, or `dispositionPlan`. It fails closed for any issue that would otherwise block. |

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
- the ledger-derived cumulative deferral horizon or renewal allowance is
  exhausted.

Mandatory repair means preserving RED or reproduction evidence, establishing
root cause, fixing the defect, and recording fresh GREEN or closure evidence.
Unknown applicability fails closed; it is not permission to route or defer.

The future machine owns two additional pre-round floors. They must not be
collapsed into this Agent repair rule:

- `REQUIRED_ASSESSMENT_INVALID = { missing, re_attestation_required, stale,
  unsigned, tampered, mismatched, incomplete, expired, unknown }`. A verified
  open high or critical Finding in this set enters a transient
  assessment-integrity floor before severity, round, and advisory policy. That
  floor does not itself prove applicability or require current-Story repair. A
  fresh strong non-applicable assessment releases it; a fresh `applicable`
  assessment converts high or critical to the distinct mandatory-repair floor;
  weak, unknown, or invalid proof remains blocked.
- In the future system, invalid claimed deferral lineage is an independent first
  floor, regardless of the current assessment. In that future system, only a
  fresh signed superseding
  `pre_existing_unaffected`, `out_of_scope`, or `duplicate` verdict satisfying
  its independent strong proof contract, or a signed `disproven` truth
  transition with current counter-evidence, or complete repair closure releases
  that lineage floor. In that future system, complete repair closure is a
  distinct release path and does not weaken the exact allowlist for non-repair
  supersession. In that future system,
  `not_reproduced_under_current_witness` never releases claimed-deferral lineage
  or mandatory repair. In the future system, invalid or exhausted lineage also
  creates a downstream mandatory-repair classification; once that obligation is
  active, only a fresh signed
  `MandatoryRepairClassification(state='closure_proven')` clears it. In that
  future system, lineage-floor superseding proof does not clear the whole block.
  These future transient integrity, lineage, and mandatory-repair floors are
  machine-derived gate state, not permission for an Agent to broaden scope.

## 7. Future official defer-with-proof disposition

`defer_with_proof` is a disposition after `applicable`, not an applicability
verdict. The authoritative future system may sign it only for an otherwise
eligible verified applicable `low` or `medium` Finding. Current repair remains
the default; deferral is the bounded exception.

The final applicable assessment must first bind
`dispositionPlan='defer_with_proof'` and the exact accepted `finding_route`.
Only then may the separate signed deferral repeat the assessment relationship as
`assessmentDispositionPlan='defer_with_proof'`, and only a matching manifest
entry may bind `expectedAssessmentDispositionPlan='defer_with_proof'`. A
`repair_current`, non-applicable, unknown, or route-mismatched assessment cannot
feed that deferral.

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

Prompt text alone does not mechanically enforce any of these facts. Current
CLI handlers and lifecycle gates remain authoritative. Current command policy
admits `finding_dismiss` only in REVIEW. The ownership gate protects a
Story-scoped Finding through its Story owner session; the B-META shared-audit
case instead uses the main shared-write policy. The handler requires a
substantive reason meeting its minimum length and refuses critical Findings.
Those compatibility conditions do not prove applicability or make the future
target-state deferral system available.

Agents must not fabricate assessment fields, verdicts, disposition plans,
owners, routes, accepted-route proofs, signatures, freshness bindings, expiry,
lineage, receipts, or manifest actions. In particular, they must not fabricate
`dispositionPlan`, `acceptedRoute`, `assessmentDispositionPlan`, or
`expectedAssessmentDispositionPlan`.

`finding_dismiss`, `gap_log`, and backlog notes are compatibility accounting.
Only the Story Owner may invoke current `finding_dismiss`, and only under the
handler conditions stated above. The command mechanically changes a Finding
from `open` to `dismissed` and therefore removes it from the current REVIEW
blocking predicate. It does not prove applicability, `out_of_scope`, deferral,
repair, resolution, or target acceptance. Gap and backlog routes do not change
that predicate by themselves. A compatibility record must never erase,
rewrite, or silently lower the original Finding.

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
- making unknown applicability non-blocking or deferrable;
- allowing an ownerless or receipt-free official deferral;
- omitting `dispositionPlan` from a final applicable assessment;
- allowing `repair_current` to carry `acceptedRoute`, allowing a non-applicable
  verdict to carry `dispositionPlan`, or allowing `unknown` to carry either;
- feeding `FindingDeferralDisposition` from anything other than exact
  `applicable + dispositionPlan='defer_with_proof'` plus its accepted route;
- allowing any of the nine `REQUIRED_ASSESSMENT_INVALID` states to decay through
  round or advisory policy;
- treating the transient assessment-integrity floor as proof of applicability
  or an automatic current-Story repair order;
- releasing invalid claimed deferral lineage without a fresh signed superseding
  `pre_existing_unaffected`, `out_of_scope`, or `duplicate` verdict satisfying
  its independent strong proof contract, or a signed `disproven` truth
  transition with current counter-evidence;
- treating `not_reproduced_under_current_witness` as permission to release
  claimed-deferral lineage or mandatory repair;
- omitting the downstream mandatory-repair classification created by invalid or
  exhausted lineage; and
- claiming that lineage-floor superseding proof also clears an already active
  mandatory-repair obligation without `closure_proven` evidence.

The Task Context authority guard must compare normalized concepts, their
semantic relationship, and assertion polarity. It must reject equivalent
authority claims after underscore, hyphen, word-order, or punctuation changes;
it may accept a retired term only in explicit prohibitions or historical context
that does not publish the term as active guidance. It remains REVIEW-only and
runs before envelope digests are minted.

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
| A final applicable assessment binds exactly one `dispositionPlan`; non-applicable and unknown verdicts follow the exact route/absence union. | Prompts preserve `repair_current` versus `defer_with_proof`, `acceptedRoute` cardinality, and the separate deferral/manifest field names. |
| Only eligible verified applicable low/medium Findings may defer. | Prompts enumerate the eligibility floor and preserve mandatory repair conditions. |
| Claimed-lineage validity, required-assessment integrity, and downstream mandatory repair are ordered machine floors. | Agents preserve the exact invalid set and release/convert/remain paths; restrict non-repair lineage release to strong `pre_existing_unaffected`, `out_of_scope`, `duplicate`, or `disproven` proof; preserve complete repair closure as the separate repair release path; explicitly exclude `not_reproduced_under_current_witness`; and require `closure_proven` to clear an active mandatory-repair obligation without expanding scope. |
| Current plan is specification-only until future Stories implement it. | Prompts explicitly say the compatibility CLI cannot exercise the target-state mechanism. |
| Gates consume signed structured facts. | Prompt prose and compatibility accounting are never presented as gate evidence. |

## 12. Completion criteria

This proposal is fully executed only when:

- the proposal is tracked and digest-covered;
- all text added by this change is English;
- the canonical REVIEW contract matches the current Dynamic Finding authority;
- all five active modular REVIEW prompt-delivery roles receive the contract in
  every supported assembly mode, while excluded active roles, compatibility
  aliases, and retired lanes receive neither the contract nor its
  required-check identifier;
- Story Owner guidance is synchronized across Codex and Claude surfaces;
- semantic RED/GREEN mutations prove inverse and obsolete behavior fails even
  after digest repinning;
- approved prompt baselines are refreshed without weakening their independent
  approval boundaries;
- focused and full prompt tests, build, process-fact checks, and runtime-fact
  checks pass; and
- no Dynamic Finding runtime schema, handler, gate, or process-fact protected
  file changes are present.
