# B-1123 Plan

## CHK-001
Add TS authority runner contract and signing primitives. Create small host-neutral modules for canonical JSON bytes, SHA-256 digest, Ed25519 key export/import, sign, and verify. Define runner-facing types for actor key registration, runner registration, heartbeat, job claim/spec, lease heartbeat/release, provider events, verifier bindings, and authority receipts. Include smoke coverage for deterministic canonicalization, valid signature verification, invalid signature rejection, required actor/run bindings, and the no-receipt/no-L2+ boundary.

Non-goals for this checklist: no long-running runner loop, no provider CLI execution, no secure keychain storage, and no DONE gate promotion.

## CHK-002
Extend the existing AuthorityClient with typed runner endpoint methods: actor key registration, runner register, runner heartbeat, job claim, job heartbeat, job release, provider event submission, and receipt response parsing that preserves unknown server fields. Add a fake-authority-server smoke that asserts expected method/path/body behavior and error handling for missing authority URL or malformed responses. Keep policy discovery read-only: it must not submit evidence, register runners, or create receipts.

Non-goals for this checklist: no real server dependency in tests, no paid authority requirement for ordinary local workflows, and no provider command execution.
