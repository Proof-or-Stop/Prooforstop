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
