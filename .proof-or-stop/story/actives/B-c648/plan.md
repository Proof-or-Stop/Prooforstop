# B-c648 Execution Plan

## Outcome

Create `docs/requirements/decisions/pre-story-mechanism-placement-proof-execution-plan.md` as the canonical proposal for a Story-ID-before-allocation Mechanism Placement Proof. The final document must show exactly what is already solved by Proof-or-Stop, what is missing, where the new intake gate attaches, when it stops without allocating an ID, how it becomes stale, how it rolls out, and how B-3783/B-fb7b would be handled. Claude CLI and Antigravity CLI (`agy`) must independently audit the complete draft; every accepted or rejected finding must have a documented disposition.

## CHK-001 — Document the Mechanism Placement Proof architecture and execution plan

1. Reconfirm the current ownership boundaries from Repro-First, Evidence Runtime, `story_draft` / `draft_check_set`, central `story_create`, verificationIntent planned paths, acceptance topology, and process-fact registry.
2. Write a normative definition and non-goals.
3. Specify the intake sequence, applicability classifier, five mandatory research questions, immutable probe/review schemas, freshness hashes, draft binding, and central no-ID gate.
4. Define verdict semantics: `PROCEED`, `NEEDS_RESEARCH`, and `STOP_NO_STORY`; `unknown` may never become proceed.
5. Define the handoff into PLAN verificationIntent and independent acceptance-topology recomputation without treating candidate evidence as lifecycle proof.
6. Define exact implementation touchpoints, rollout dependencies, config, observability, migration, and tests.
7. Include a worked B-3783/B-fb7b trace showing rejected hypotheses and the selected root `pretest` hook.
8. State that B-8de3 evidence-store integrity work blocks enforce mode, while shadow/warn can start earlier.

Verification: inspect the final Markdown for required normative sections, exact command/artifact names, no parallel lifecycle, no candidate-to-DONE authority leak, no-ID stop semantics, and a complete worked example.

## CHK-002 — Run independent Claude CLI and agy CLI architecture audits and reconcile findings

1. Give both CLIs the same complete draft and the same audit rubric.
2. Require each host to identify blockers, major gaps, minor gaps, and an overall verdict, with section-specific evidence.
3. Audit duplication/authority, all Story creation bypasses, freshness and replay, process-fact two-layer registration, storage integrity dependency, rollout safety, and test completeness.
4. Compare the two reports; revise the document for accepted findings.
5. Append an audit record naming host/version, verdict, findings, and per-finding disposition. Re-run a focused confirmation if a material finding caused revision.
6. Preserve independence: neither CLI may edit the draft or consume the other host report before producing its own first verdict.

Verification: command transcripts from both CLIs plus the final document audit-disposition section must agree on the resolved design; unresolved blocker/high findings prevent checklist completion.

## CHK-003 — Capture Lattice host_run receipts for the Claude and agy architecture audits

1. Re-run the final architecture audit for Claude and agy through the canonical `lattice host_run` choke point rather than an untracked external terminal call.
2. Execute each host through selector-bearing `verification_evidence_add` so the host command, output token, exit status, and receipt are bound to CHK-003.
3. Read the canonical final usage records and cite both distinct `llmuse_` recordIds in section 21 of the decision document.
4. Cite Claude numeric usage fields exactly when the provider reports them. For agy, cite `recorded=unavailable` and the exact `unavailableReason`; do not invent a token count for a host whose print mode exposes no usage surface.
5. Add a mechanical document-versus-ledger check that fails when either final record is absent, the cited state differs from the ledger, or an unavailable record is represented by fabricated numbers.
6. Re-run independent delivery review after the receipts and document provenance are current.

Verification: CHK-003 happy/edge/adversarial selectors must be tool-executed, both canonical host records must exist, the document must match their actual usage state, and delivery check must no longer report `unverified_promise`.

## Exclusions

- No runtime handler, schema, prompt, registry, test, or enforcement implementation in B-c648.
- No change to the B-fb7b root npm test repair.
- No new lifecycle phase and no second canonical acceptance or evidence truth source.
