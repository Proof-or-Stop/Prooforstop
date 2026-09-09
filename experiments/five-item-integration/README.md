# Five-item maintenance integration contract

This managed Lab starts from local main 04e66fdbaeaeeb540a80c9f8e16085a5ee468f5a
(0.3.285). The user explicitly requested local integration on 2026-09-09.
The original Lab and its evidence remain preserved. This is local maintenance,
not a formal Story DONE or authorization for remote publication.

The pinned command is `node experiments/five-item-integration/verify.mjs`.
Its first assertion reproduces the executed bootstrap helper identity omission
on the baseline, with prepared independent dependencies and dist. The remaining
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
