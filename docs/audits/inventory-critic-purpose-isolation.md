# Inventory critic purpose isolation: implementation audit

Story: B-29bc. This is a development evidence record, not a DONE certificate.
Read current lifecycle and freshness through the repository-local CLI; this log
does not authorize a transition or certify completion of B-7abb or B-03b7.

## Failure and bounded repair

B-7abb needed an independent completeness critic before returning from REVIEW
to remediation. Its inventory assignment was routed through topology admission,
which required a business commit with a role-named Git author. The actual user
identity is Harmonynet <26995688+Harmonynet@users.noreply.github.com>.
Changing that identity would not establish independent review.

The controlling code paths are `src/handlers/story-dispatch.ts`,
`src/handlers/review-run.ts`, `src/handlers/review-inventory.ts`, and their
`src/core/` counterparts under `packages/main/`. The existing topology
business-author consumer is `packages/main/src/core/topology-critic-receipt.ts`.

The repair introduces explicit `reviewPurpose=inventory-completeness` and
`inventoryEpochId` on critic dispatch and run admission. An inventory assignment
uses a distinct `inventory-critic-review` dispatch carrier. It binds the signed
current OPEN epoch, Story, review round, wave, cutoff, scope, required-lane digest
and run-sequence boundary. Dispatch/run publication and inventory transitions
share the existing inventory lock. The signed run and completeness receipt
retain that subject. The intended contract also requires both signed readManifest
and mechanical readLog on terminals, and complete per-Finding dispositions.
The original implementation did not fully enforce those retained requirements;
the independent-review discoveries and bounded correction are recorded below.

Omitted purpose retains the original topology path. There is no automatic
fallback from a topology refusal to inventory, no username allowlist, and no
replacement of independent execution with Git author text. Historical run
signatures without new fields keep their old signature domain, but an unbound
legacy/topology run cannot issue the new inventory-purpose receipt.

## RED and GREEN provenance

- Test-only RED: `0c726415eab8a599ae2844d42386bc5a57d49d07`.
  `node packages/main/dist/tasks/review-inventory-handler-smoke.js --purpose-only`
  exited 1 after `B29BC_INVENTORY_SETUP PASS`. Required signed lanes had
  terminated and both default-topology controls had passed. The explicit
  inventory dispatch assertion failed with the existing missing role-authored
  implementation provenance error. Setup failures are not counted as this RED.
- Implementation GREEN: `91d8133a8f92aff7e02efff4fea31362bd6f4949`.
  The same public dispatch assertion passes. The campaign also obtains a
  signature-valid run, signed terminal reads and an accepted exact-set critic
  receipt, with both Harmonynet and a second ordinary contributor in disposable
  Git repositories, and with legacy and full-envelope run modes.
- Final compatibility fixture corrections:
  `f7f80b4aaf7840f6c1f604e5609c2df2b4cfdcf8`. The full inventory handler and
  ProofStory suites passed after the bounded fixture corrections below.
- Formal CHK-001 evidence was written by `verification_evidence_batch_add` in
  metadata commit `211fcc3`. Its four intent rows bind the combined public
  purpose/epoch command. The recorded batch reports one unique execution key,
  one command execution, three reused results, and no command reruns or false
  freshness. This is a historical execution record, not permission to reuse it
  after later material or scope changes without CLI validation.

The earlier PLAN artifact `RED-INVENTORY-AUTHOR-001` is only preliminary symptom
evidence: its disposable epoch did not finish required lanes. Its old proposed
GREEN command is not the completed-lane witness. The committed test-only RED
above and the tool-executed current checklist witness establish the implemented
RED/GREEN relation; this log neither rewrites that preliminary record nor claims
that its incomplete setup is accepted by the repaired guard.

## Executed development checks

The following commands exited zero on the completed implementation/fixture
snapshot. Formal gate evidence is separately produced and checked by the CLI.

| Command | Observed success selector |
| --- | --- |
| `node packages/main/dist/tasks/review-inventory-handler-smoke.js --purpose-only` | `B29BC_PURPOSE_LOCKED_FRESHNESS PASS` |
| `node packages/main/dist/tasks/review-inventory-handler-smoke.js` | `review inventory real handler smoke: PASS` |
| `node packages/main/dist/tasks/review-inventory-epoch-smoke.js` | `B29BC_PURPOSE_TAMPER_TERMINAL_DISPOSITION PASS` |
| `node packages/main/dist/tasks/proofstory-pre-review-check-smoke.js` | `ProofStory pre-review check smoke: PASS` |
| `node packages/main/dist/tasks/agent-dispatch-registry-smoke.js` | `agent-dispatch-registry-smoke PASS` |
| `node packages/main/dist/tasks/review-run-smoke.js` | `review-run Prompt Envelope smoke: PASS` |
| `node packages/main/dist/tasks/prompt-registry-smoke.js` | `prompt registry smoke passed` |
| `node scripts/verify-process-fact-contract.mjs` | Successful exit, including the purpose producer/consumer guard |

The public campaign checks malformed purpose/epoch arguments, canonical and
registered-alias ingress, missing dispatch, forged epoch and dispatch bindings,
an actual cancellation/publication lock interleaving, finalized/rebegun epochs,
scope drift, dirty-run refusal and committed source-cutoff drift. The pure epoch
suite also re-signs invalid semantic substitutions before checking rejection;
it is not limited to corrupting a hash. The original campaign covered critic
terminal-read rejection and incomplete historical Finding dispositions, but
missed required-lane PASS read-log omission and a current critic's own discovery.
Those omissions are not evidence that all terminal paths were protected.

## Independent-review discoveries and remediation

On the frozen material
`53c005326e1983ac509b225500969c1c668c04f4e4655d049c6dd35f94dc067d`,
the independent inventory critic registered these observations through the CLI:

- `B-29bc:F-001`: original required-lane passes RP-001, RP-002 and RP-004
  carried a readManifest but no mechanical readLog. RP-003 was the positive
  control with a log. The original `evidenceForRun` PASS predicate checked the
  signature without requiring both read fields; `recordReviewPass` likewise
  admitted an incomplete terminal during an OPEN inventory. This violated the
  decision's Saturation rule, not merely a preferred reporting style.
- `B-29bc:F-002`: `evaluateReviewInventoryWave` collected current Findings only
  from required lanes, omitting the separately purpose-bound critic. The real
  `review_inventory_critic_set` rejected RR-005's exact F-001 disposition with
  `REVIEW_INVENTORY_FINDING_DISPOSITION_INVALID`. Passing an empty list would
  have concealed the observation and was not used as recovery.
- `B-29bc:F-003` and `B-29bc:F-004` recorded the audit text's contradictory
  promise about reading evidence. The independent RI-002 critic linked their
  cause to F-001 without deleting observations, lowering severity or claiming
  repair. RI-002 wave 2 certified zero new families, not correctness. Its
  signed completeness receipt authorized the one return to DEV.

The two runtime predicates predated this branch, but both directly contradicted
CHK-001's retained read-evidence and exact-Finding-set acceptance. They were
therefore repaired here. The official scope update added only
`packages/main/src/handlers/finding.ts` for the shared PASS producer guard;
the inventory consumer, regression suites and process-fact registry/verifier
were already scoped. No unrelated global-green repair was authorized.

Test-only commit `d2461f5794` built successfully and produced actual exit-1 RED:
the epoch smoke reported both incomplete signed PASS admission and omitted
critic discovery; the public handler smoke reported a missing expected exception
for a manifest-only PASS. An earlier test-authoring compile error was corrected
before that commit's successful build and is not counted as RED.

The bounded production correction requires both read fields in OPEN-inventory
PASS publication and in lane coverage, including pass-only `finding_add`
normalization. Aggregation additionally consumes signed, current, exact-purpose
critic Findings without counting the critic as another required lane. Default
topology, wrong subject, tampered signature and missing read evidence remain
ineligible. A later critic PASS cannot hide an earlier same-wave Finding.

The public discovery witness uses a separate disposable repository: the critic
records its Finding before its first receipt, an empty disposition is refused,
and an exact disposition is accepted. An early test revision tried to replace
an already-issued empty-set receipt and correctly received `conflicting receipt`;
the test setup was corrected, not the immutable-receipt production rule. The
original empty-set success and all topology/freshness assertions remain intact.

GREEN correction commit: `0ffe4cc619`. The epoch smoke exited zero with both
`B29BC_RECOVERY` checks passing. The public `--purpose-only` handler smoke
exited zero with `B29BC_CRITIC_OWN_FINDING_DISPOSITION PASS`, as well as the
original purpose/schema/alias/full-envelope/locked-freshness success selectors.
`node scripts/verify-process-fact-contract.mjs` exited zero after adding the
producer/consumer checks. These are observed development executions, not fresh
formal checklist receipts or independent final REVIEW/TEST/DONE certification.
Those are separate CLI-controlled prerequisites after this committed correction.

The cross-purpose campaign presents the real inventory carrier, including
removed/mutated purpose fields and an alias, to the unchanged topology
provenance consumer, with a real default-dispatch positive control. This is
provenance admission coverage, not full topology certificate issuance. The
separate full ProofStory suite exercises the existing signed topology receipt
and gate controls. Inventory receipts retain `authorizesTest=false`; neither a
terminal pass nor a completeness receipt substitutes for TEST/DONE admission.

## Compatibility failures kept visible

These were observed failures, not silently waived assertions:

1. The prompt-registry smoke already failed before implementation on frozen
   reviewer reconstruction pins. Independent source-AST/Git comparison against
   `5c61fe500c^2` established exact byte parity after only the historical managed
   marker projection; coverage needed no body projection. Modular prefixes
   likewise differ only in the renamed modular marker. Tests retain the old
   pins, strict current-marker checks, raw semantic guards and adversarial
   checks. No production historical digest was repinned.
2. Two generated INIT mirrors differed from current canonical rendering only
   in one product-reviewer alias each. Commit `ff4e1bc2c7` changes those exact
   aliases after an official scope-contract update. Both mirrors then matched
   the canonical renderer byte-for-byte. No general managed-asset sync ran.
3. The full handler witness exposed supported alias filtering against canonical
   persisted reviewer lanes. The already-scoped run-list handler now uses the
   existing canonical role equality; its original count assertion, public alias
   equivalence and unknown-lane refusal are retained.
4. Full compatibility fixtures had live legacy config/path/actor transport
   references. Corrections use current canonical configuration, Store path
   helpers and explicit canonical fixture actor transport. Original signed
   receipt/gate assertions remain. Historical commit-qualified paths and
   deliberate legacy negative controls are not rewritten.

The current CLI refused `bug_report` in DEV because bug writes are REVIEW/TEST
only, despite its help describing DEV reporting. This log records the evidence;
it must not be represented as an already-written bug-ledger entry.

## Preserved boundaries and local recovery

The implementation leaves `packages/main/src/core/topology-critic-receipt.ts`,
`packages/main/src/core/machine.ts`, and `proof-or-stop.config.json` unchanged.
The historical critic template remains unchanged; purpose-selected guidance is
composed at the live role-body boundary and included in its body/render binding.
Process-fact registration and its verifier cover the changed signed producers
and consumers. The active inventory operator example was updated in
`docs/requirements/decisions/review-inventory-epoch-and-saturation-gate.md`;
its historical evidence was retained.

Disposable fixture actors, host labels, Git authors and synthetic replay counters
are test inputs. They do not prove actual independent-host quorum, real-world
latency improvement, topology approval or completion of another Story. No
remote publication, Git identity rewrite, lifecycle waiver or direct production
Story JSON mutation is part of this repair.

After B-29bc actually completes its lifecycle and merges to local main, resume
B-7abb in its own worktree with `proof-or-stop session_brief`, then use the
repository-local CLI and current inventory/gate output. Integrate main through
the authorized local workflow. Let the CLI invalidate or refresh changed
material, scope, epoch and run bindings; never declare an old hash fresh by hand.
Finish current required lanes before the explicit inventory critic assignment,
retain all recorded Findings, and complete the inventory before remediation.
The B-7abb classifier repair and B-03b7 lifecycle remain separate work; B-e6d9
must not cross its dependency before B-03b7 is complete.
