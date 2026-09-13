# Managed inventory critic disposition transport

B-0980 BUG-002 was reproduced when RR-036 returned inventory dispositions in
an unsupported top-level field. Its failed provider output remains unchanged.
The configured project had no native invocation broker, so the managed review
path also needs an authenticated way to finish the inventory critic receipt.

The managed final envelope accepts an optional `inventoryCritic` object only
for the topology critic lane. Its `epochId` and positive `wave` must match the
signed inventory-purpose ReviewRun and current OPEN epoch before import.
`findingDispositions` contains provider-authored classifications. Each `finding`
reference identifies an existing `findingId` or a zero-based
`proposalFindingIndex` in that same final proposal. Duplicate classifications
use `canonicalFinding` with the same reference forms. The importer resolves
indexes from exact, signed findings allocated for that successful receipt.
Providers must not guess future finding IDs.

The provider emits one final JSON object. It does not call
`review_inventory_critic_set` or place `findingDispositions` at the top level.
The owner imports only the actual run ID and successful terminal receipt ID;
there is no owner-supplied classification argument. Sealed proposal integrity,
live material, signed purpose, current wave and existing terminal/read checks
remain enforced. Ordinary reviewer results remain compatible.

The managed ingress and native critic command share a private receipt writer.
Native actor checks remain in the native command. The managed ingress verifies
the actual receipt independently and takes the inventory lock after ordinary
terminal metadata locks have been released. A retry after terminal publication
can finish the missing critic receipt. An exact existing receipt retains its
original timestamp and signature; mismatched content remains refused.

This transport does not resolve findings, waive mandatory reading, certify
topology, advance a Story, or establish TEST/DONE authority. A critic must still
report incomplete reading and classify every required observation, including
its own new verified findings.

Verification uses disposable repositories and a synthetic provider through the
actual managed worker, successful terminal receipt, importer and inventory
validator. Such fixture evidence is not a real Story review credential. Lab
RED/GREEN and independent audit results are maintained separately by the Lab
tool; this document does not claim completed audit or integration.

The new ingress checks material dirty files before terminal persistence and
again under the inventory lock before critic persistence. Existing material
exclusion policy permits deferred Story/runtime metadata. Unknown Git status
fails closed. Both uncommitted and committed material drift are refusal cases.
The repository validation command runs the same full transport suite pinned
for this Lab, including successful imports, replay, crash recovery and refusals.

## Follow-up to the first independent audit

The first actual Claude CLI audit rejected candidate 8e77ab1c7e with seven
findings. Its original verdict and failed test records remain in Lab evidence.
The follow-up completes terminal process-event bookkeeping and invokes the
official metadata commit-or-defer helper before critic validation. A critic
refusal still returns failure and creates no critic receipt. Repeating that
refusal preserves one terminal record and one process event. OPEN inventory
metadata legitimately remains deferred under the existing policy; this repair
does not force Git commits or widen review lineage acceptance.

Own finding references must use proposal indexes, including canonical references.
Resolved primary finding identities must be unique. Distinct duplicates may
share a canonical finding; the original signed Finding evidence is not rewritten
by a critic disposition. The managed critic receipt has an explicit additional
artifact-producer registration alongside the existing managed evidence binding.

The fixed verification command includes thirteen disposable integration scenarios:
normal findings, pass, crash recovery, wrong wave, uncommitted and committed
material drift, missing disposition with terminal bookkeeping, duplicate canonical
mapping, not_verified classification, guessed own-ID refusal, existing-ID
mapping, index ambiguity, and cancellation before first import. The pass scenario additionally tests legitimate
pending metadata and Git-status failure. A synthetic read proxy supplies an
ambiguous index only inside the disposable fixture; it grants no real authority.

The verifier guard runs before its final failure gate. Subprocess controls execute
that actual guard and gate against a positive input and seven removed-authority-token
inputs, checking nonzero refusal before success banners. Three fixture children run
per batch, with a 120-second inner cleanup watchdog and a 135-second outer timeout.
Five batches allow up to 675 seconds, plus 80 seconds for eight subprocess controls,
leaving 145 seconds of margin within the pinned 900-second budget. Scenario names
are emitted before launch. A failed batch waits for all children before returning.
No fresh audit or integration is asserted by this follow-up description.

## Second-audit triage and compatibility boundary

The shared native schema in cli/command-catalog.ts requires reason.min(10).
Native and managed receipt ingress now share validInventoryCriticReason in the
runtime writer; early managed shape validation uses the same trimmed floor.
Whitespace-only optional identifiers also refuse before signing. This closes
an actual parity gap while preserving existing disposition semantics.

Historical epoch rejection is an existing admission rule, not a new terminal
loss mechanism. core/review-run.ts at pre-Lab baseline 2433b80377 and the current
checkout is byte-identical (SHA256 3c1fcd86e8bd33db2d1e11da4d286bcf62a2f70f47c8809b473a2fe2d142fbc9). Its
assertCurrentReviewRunForEvidence verifies the signed run and then requires the
same current OPEN epoch/wave/cutoff for inventory-completeness evidence, before
the importer reaches the newly added critic block preflight. Moving that preflight
cannot admit cancelled or old-wave evidence. This repair deliberately preserves
the pre-existing refusal; it does not introduce a historical mutation exemption.
Original host-run results/receipts remain inspectable, and prior terminal records
remain durable. Official wave/cancel fixtures verify refusal without changing
stored findings, events, inventory records, or the original provider receipt.

## Fourth candidate: provider schema and direct refusal coverage

The Claude provider schema is deliberately flat: optional findingId/index fields
carry no anyOf and reason carries no minLength. The local parser and shared writer
remain authoritative for exactly-one-reference and the trimmed ten-character floor.
The verifier generates the critic-specific Claude schema, parses it, rejects
unsupported combinators/length keywords and checks its existing 16 KiB cap.

managed_review_proposal_set is a compatibility-only callback for older adapters,
not this feature's inventory transport. An inventoryCritic argument now receives
MANAGED_INVENTORY_FINAL_ENVELOPE_REQUIRED, instructing the provider to emit the
block in its final assistant JSON. The CLI catalog exposes the same restriction;
no owner-supplied classification or callback authority is added.

The disposable pass case directly invokes the proposal writer while its real
fixture provider capability is active and proves an invalid block is refused
without a proposal file. The existing-ID case modifies only the disposable sealed
proposal, verifies refusal, restores identical bytes, then verifies acceptance.
That negative exercises both digest/shape defenses; it does not claim a forged
proposal was authentic. Separate source-guard deletion subprocesses pin the writer
and consumer shape guards in addition to the five importer authority controls.

MANAGED_CRITIC_FIXTURE_RUNTIME_POLICY owns the test-only 120/135-second limits and
15-second cleanup margin. Each driver child receives its own absolute deadline;
the fixture clamps its watchdog to the lesser of 120 seconds and actual remaining
time minus cleanup margin. Malformed, foreign and exhausted envelopes refuse.
Per-scenario start and elapsed milliseconds are emitted; measurements are retained
with the run evidence. This policy does not alter production admission limits.

Version handling remains at the official Lab integration stage. The required
`finish --confirm --bump patch` prepares the release candidate, updates shared
version assets, builds, audits that exact prepared candidate, and performs local
integration checks. A pre-finish repair audit is not release approval; its PASS
cannot be reused after version/base changes unless the tool validates freshness.
No bump, main integration or release completion is claimed by this repair document.

### Static source evidence refresh

The fourth candidate initially failed the runtime contract at static AST evidence
freshness, while the same check passed on main 0.3.357. This was treated as an
applicable candidate regression. Existing command indexes were remapped by exact
executable/argv identity, unchanged call digests and exact current source excerpts;
all pre-existing dependency bindings were retained. Two changed excerpts were
reviewed against the explicit fixture allowlist and unchanged runtime child calls.
The new driver's child_process imports are static, and its stdin guard evaluator
uses an explicit node -e shim, so both real subprocess calls are visible to the
scanner. Two separate exceptions bind only the exact driver invocation: the eight
final-guard controls and the thirteen-case companion fixture. Their current-source
and dependency evidence includes the isolated/native fixture chain. They do not
grant production authority or exempt arbitrary callers. The candidate static scan
reported needsReview=0; runtime contract and the changed driver are rerun separately.

The fourth candidate's post-driver-change thirteen-case run passed. Its slowest
observed case was existing-id at 37167 ms, below the 120000 ms inner cap.
These are per-case wall measurements under three-way local concurrency, not
full-development timing or a product benchmark result. The desktop runtime
coverage check initially lacked package-local smol-toml and ws in this Lab;
copying its already installed identical dependencies to the packager's required
paths restored CLI_AUDIT_RUNTIME_COVERAGE_GREEN without a tracked dependency change.
