## CHK-001
Implement proofbound.corpus-index.v1 and proofbound.keyword-seeds.v1 in a pure core module. Enumerate configured requirements Markdown deterministically, capture relative path headings byte size and content hash, derive exact and normalized Story identifiers, and add byte-stability golden tests.

## CHK-002
Add host proposal schemas and adapters that reuse core/host-run.ts. Build a single pre-egress sanitizer over every host-bound field, keep raw provenance local, launch Codex and Claude as independent primary proposers, use agy only under the documented fallback policy, and test outages budgets malformed output and secret leakage.

## CHK-003
Implement a bounded local query planner and deterministic scorer over filename heading and body matches. Deduplicate aliases, preserve reason provenance, cap ordinary candidates at eight and query results at ten, and produce ambiguity signals for sparse noisy zero-hit and cutoff-tie cases.

## CHK-004
Define proofbound.candidate-spec-set.v1 and proofbound.reviewer-read-evidence.v1 artifacts. Sign or hash-bind Story inputs corpus digest prompt digest candidates and actual reads, reconcile manifests against mechanical events, and reject missing stale forged or mismatched evidence.

## CHK-005
Register candidate_spec_route and connect the PLAN scope reviewer dispatch and scope_check_save consumer to current candidate evidence. Preserve complete filename enumeration, open questions, structured full-scan escalation, and fail-closed enforce behavior while shadow and warn remain non-breaking.

## CHK-006
Expose current candidate digests to eligible REVIEW and delivery lanes. Reuse routing without merging reviewer authority, reroute on Story diff or corpus drift, and test behavior docs coverage and delivery equivalence plus duplicate-finding suppression.

## CHK-007
Add canonical shadow warn enforce configuration, metrics, quality promotion checks, rollback, process-fact registrations, verifier contracts, prompt alignment, and two-window evaluation evidence. Rollback returns to explicit tool-driven broad review and can never restore corpus prompt injection.

## Delivery sequence
Implement and commit slice-foundation M6A-M6C, then slice-evidence-integration M6D-M6F, then slice-rollout M6G. After each milestone run focused tests, record verification evidence, update checklist status, and inspect lattice milestone_status. Before REVIEW run build, focused contract smokes, process-fact verifier, prompt budget guards, full validate, and host outage and leakage regressions.
