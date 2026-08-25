# Plan: B-a2a6 Cache the prompt-envelope snapshot across reviewer evidence readiness checks

Decision of record: keep the cache scoped to one evidence collection, preserve direct-call fallback behavior, and retain all integrity, freshness, scope, signature, and gate checks.

## CHK-001: Reuse one prompt-envelope snapshot across reviewer evidence collection

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/review-run.ts
- Modify: packages/main/src/core/review-incremental-context.ts
- Test: packages/main/src/tasks/review-incremental-context-smoke.ts

**Approach**:
- Read the prompt-envelope ledger once for a non-empty reviewer evidence collection and thread the immutable snapshot through binding, verifier, and incremental-context checks.
- Preserve the uncached direct-read fallback for independent callers and skip the ledger read for an empty collection.
- Add executable mutation, source-isolation, and N-record read-bound cases for reordered, duplicate, missing, mismatched, stale, foreign, and cutoff-boundary inputs.

**Verify**:
- npm --prefix packages/main run build
- node packages/main/dist/tasks/review-incremental-context-smoke.js
- node packages/main/dist/tasks/review-incremental-context-smoke.js --cutoff-verifier-only
- git diff --check

**DoneWhen**:
- Cached and uncached outputs agree for valid and refusal cases.
- Empty collections perform zero envelope reads and non-empty collections use one collection snapshot.
- All CHK-001 verification intents have current passing evidence.

## CHK-002: Prove cached and uncached verification preserve identical evidence semantics

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/tasks/review-incremental-context-smoke.ts

**Approach**:
- Compare aggregate verifier results for zero, one, and many records with duplicate, missing, mismatched, stale, foreign, and reordered envelope inputs.
- Instrument the cached and uncached paths to prove constant envelope-read behavior and equal incremental cutoff outcomes.

**Verify**:
- node packages/main/dist/tasks/review-incremental-context-smoke.js --cutoff-verifier-only
- npm --prefix packages/main run build

**DoneWhen**:
- Cached and uncached evidence, cutoff, integrity, and gate classifications remain field-for-field equivalent.
- All CHK-002 verification intents have current passing evidence.
