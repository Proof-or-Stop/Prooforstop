# B-1480 Execution Plan — Land the Experience Layer execution-plan doc

Produce ONE English execution-plan decision document at
`docs/requirements/decisions/lattice-experience-layer-execution-plan.md`,
matching the house format of `lattice-llm-usage-ledger-execution-plan.md`.
Plan-only: no source code, no new commands. Source content = the corrected v1.1
draft at repo-root `lattice-experience-layer-v1.1-zh.md`, translated to English
and aligned to real code. No Co-Authored-By trailer anywhere.

## CHK-001 Create the doc in house format
Write the file with a `# Lattice Experience Layer Execution Plan` title, a
`> Story: B-1480` header, and a scope note stating it is a future-execution plan
only (no source code / commands). Include Problem Statement, Principles,
Architecture, Roadmap sections in the freeform style of the usage-ledger plan.
Verification: file exists at the canonical path; head shows title + Story header
+ plan-only scope note.

## CHK-002 Module decomposition + reuse + cut-FTS
Record the grounded module decomposition: new `core/` modules
(experience-layer-types, learning-store incl. signature lookup, finding-signals,
experience-hint-loader) + new `handlers/` modules (learning, playbook), with
one-way inward coupling (handler -> core -> types) and zero outward imports from
existing code (usage-ledger isolation bar). Record reuse-not-rebuild: extend
`dev-memory.ts` for capture, clone the `decision-doc-promotion.ts` digest
pattern (extract a leaf `core/digest.ts` before Phase 2), reuse
`activity-log.ts` appendActivityLog. Record the explicit decision to CUT
full-text search for v1 (no FTS engine exists; Level 2 recall uses structured
filtering + the existing story_list scan).
Verification: doc has a module-decomposition section, a reuse section naming the
three existing files, and an explicit cut-FTS statement.

## CHK-003 Determinism guardrails + back-compat
Document three guardrails: (1) audit-only finding fields (signatureTag,
resolutionType, dismissReasonType, resolve/dismiss evidenceStrength) excluded
from any gate read; (2) finding-signals read via the stable finding accessor
`store.readFindings`, never raw `findings.json`; (3) reviewer hints excluded
from the `promptHash` domain (or pinned per reviewRunId). Document back-compat:
`dismissReasonType` optional; flat-underscore command names.
Verification: doc has a determinism-guardrails section enumerating all three and
a back-compat note.

## CHK-004 Phased roadmap + accurate code anchors
Document the phased rollout (Phase 1a first, then 1b / 1.5 / digest-extract / 2 /
3 / 4); Phase 1a is the verifiable finding-signals slice proven by an unchanged
`currentMaterialHash()` test. Include a code-anchor appendix of REAL file paths
(types.ts, finding.ts, store.ts, advisory.ts, dev-memory.ts,
runtime-artifact-registry.ts, story-review.ts, activity-log.ts,
decision-doc-promotion.ts). No Co-Authored-By trailer.
Verification: doc has a roadmap section naming Phase 1a as the first story and a
code-anchor appendix; every anchored file exists in the repo; grep finds no
Co-Authored-By in the doc.

## Verification strategy
A committed verifier `.lattice/story/actives/B-1480/evidence/verify-b-1480.mjs`
checks: file exists at canonical path; required section headers present; the
three existing-file anchors and all appendix anchors resolve to real files;
explicit cut-FTS + advisory-only + three-guardrail strings present; no
Co-Authored-By in the doc. Prints TOTAL N | PASS N | FAIL 0.

## Out of scope
Implementing any TypeScript module, handler, or command; editing gate logic;
changing any existing repo file other than adding the new doc; building any
search/retrieval engine.
