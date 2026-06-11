# B-4bd4 Plan

## Goal

Resolve PD-1 before implementation work starts:

Should Koala CLI remain a thin local/shadow lifecycle client while Mac/runner/CI
produce canonical authority evidence, or should Koala CLI become a first-class
enforce-mode authority client accepted by Cord Team Python authority in
production?

This story is decision-only. It must not modify production TS/Python/Swift
implementation code.

## Roles

- Claude Code CLI executes the decision work and writes the primary artifacts.
- Codex acts as PM/verifier: scope control, evidence review, checklist evidence,
  REVIEW/TEST/DONE gate coordination.
- Reviewers independently check concept, quality, docs, and test coverage.

## Reviewer Advisory Handling

INIT reviewers passed with advisories. PLAN handles them as follows:

- Define terms inline in the decision artifact: PD-1, FU-1/FU-3, L2+,
  trustLevel, thin client, enforce-mode client.
- Write the derivation in story evidence and the durable contract in
  `docs/requirements/decisions/authority-client-role.md`.
- Include a Milestone 2-6 routing table in both the derivation and durable
  contract.

## Deliverables

- `.koala/story/actives/B-4bd4/evidence/authority-client-role-decision.md`
  contains detailed evidence, tradeoff analysis, and milestone routing.
- `docs/requirements/decisions/authority-client-role.md` contains the durable
  PD-1 authority-client role contract for future agents.

## Checklist Execution

### CHK-001

Collect source-backed PD-1 inputs from B-0f04 and existing truth-source docs.

Done when:

- The evidence artifact lists current CLI posture, Python authority production
  requirements, Mac runner responsibilities, and FU-1/FU-3 dependency facts.
- The artifact defines the core terms needed by a new agent.
- The artifact does not introduce implementation claims beyond cited evidence.

### CHK-002

Write the PD-1 role decision.

Done when:

- The durable truth-source doc states the recommended CLI role.
- The doc states what Koala CLI may or may not claim for L2+ evidence.
- The story evidence and durable doc link to each other.
- The doc clearly says which guarantees remain unimplemented until later
  milestones land.

### CHK-003

Route Milestones 2-6 based on the decision.

Done when:

- A routing table covers Milestones 2 through 6.
- Each row names owning repo, required/deferred/docs-only status, prerequisite,
  and validation expectation.
- The routing table explicitly prevents PD-1-dependent implementation from
  starting until the user approves the decision.
- The routing avoids duplicating B-4622, B-da5b, and B-0f04.

## Validation Plan

- `verification_evidence_batch_add` records docs/manual evidence for every
  verificationIntent.
- REVIEW requires concept, quality, test-coverage, and docs reviewer passes.
- TEST runs `koala validate --json`.
- DONE requires summary, transcript diff, and delivery check.

## Out Of Scope

- No CLI handshake implementation.
- No EvidenceEnvelope field implementation.
- No actor-key registration, runner heartbeat, or envelope signing
  implementation.
- No receipt verification implementation.
- No Python authority or Mac runner code changes.
