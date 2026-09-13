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
that actual guard and gate against a positive input and five removed-authority-token
inputs, checking nonzero refusal before success banners. Three fixture children run
per batch, with a 120-second inner cleanup watchdog and a 135-second outer timeout.
Five batches allow up to 675 seconds, plus 60 seconds for six subprocess controls,
leaving 165 seconds of margin within the pinned 900-second budget. Scenario names
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
