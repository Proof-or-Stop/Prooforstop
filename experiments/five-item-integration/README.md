# Five-item maintenance integration contract

This managed Lab starts from local main 04e66fdbaeaeeb540a80c9f8e16085a5ee468f5a
(0.3.285). The user explicitly requested local integration on 2026-09-09.
The original Lab and its evidence remain preserved. This is local maintenance,
not a formal Story DONE or authorization for remote publication.

The pinned command is `node experiments/five-item-integration/verify.mjs`.
Its first assertion reproduces acceptance of an explicitly required invalid
implementation pin by the real baseline CLI, with prepared independent dependencies
and dist. After pin enforcement exists, it also checks imported helper tampering. The remaining
checks protect hashing, recovery, signed intent history, shared execution,
resource safety, the latest main quorum coordinator, and process/runtime facts.
They deliberately require the candidate controls to be present before GREEN.
A missing dependency is never accepted as the target RED.

Keep current main's modular quorum implementation and its existing regression
contracts. Migrate resource declarations by command identity, not old row numbers.
Do not represent historical 134-command results as current 135-command results.
Preserve adverse trials and performance limitations in the evidence archive.
New source requires new verification and an independent Claude CLI audit.

Use the repository's native Lab red/green/finish sequence. Do not modify that
framework to bypass clean-main, locking, version, build, or cleanup requirements.
Only `finish --confirm` integrates and applies the shared release version rules.

## Publication recovery after receipt-fanout integration

Current main deliberately gives an ordinary invocation a fresh observation. A previous
PASS is not a reason to suppress that invocation. The Lab's interrupted-publication
exception uses a signed pending record under the Story's `causal-evidence/pending-publications`.
It binds the exact pre-write checklist, request, owner generation, current execution
identity and signed receipt bundle. Recovery re-enters the normal output, identity,
selector, freshness and canonical-import checks. A successful canonical write retires
the pending record. Corruption refuses before a child runs; changed inputs cannot
use the old key. This is local maintenance evidence, not hostile-host protection.

The historical sequential-consumer experiments used broader reuse assumptions. Their
original source and results remain archived. Current controls exercise a real batch's
shared execution, failed-publication recovery and deliberate ordinary reexecution
separately; counts from these different scenarios must not be conflated.
