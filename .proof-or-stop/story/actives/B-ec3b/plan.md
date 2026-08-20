# Plan

## CHK-001 Capture M0 profiling baseline and runtime hot-path cost

Goal: preserve the current full 1,000,000-record baseline as a correctness/reporting path, while adding a focused index smoke that records representative hot-path runtime-pack costs.

Implementation steps:
- Add a dedicated index smoke task that prints profiling metrics without producing lifecycle evidence.
- Keep the existing full baseline command manual/release-style and report-only.
- Assert all emitted profiling evidence remains non-authoritative and cannot satisfy gates.

Verification:
- Run npm --prefix packages/main run build.
- Run node packages/main/dist/tasks/playbook-runtime-memory-index-smoke.js.
- Run existing runtime memory smokes to confirm behavior did not regress.

## CHK-002 Add M1 derived runtime memory index with atomic rebuild semantics

Goal: introduce a disposable derived runtime memory index that can be rebuilt from source memory/playbook files without readers observing partial state.

Implementation steps:
- Add packages/main/src/core/playbook-runtime-memory-index.ts.
- Define index schema with manifest, indexVersion, source digests, status buckets, token buckets, and source refs.
- Implement rebuild to write temp output, validate manifest/digest, then atomically swap to the active index path.
- Keep the index as cache-like derived data, never proof.

Verification:
- Smoke a normal rebuild and manifest validation.
- Smoke a rejected malformed temp rebuild while previous active index remains readable.
- Confirm authority stays non_authoritative and gateEvidence=false.

## CHK-003 Implement M2 indexed two-stage retrieval with small fixture parity

Goal: make runtime pack generation able to use indexed candidates while matching the existing reference full-scan behavior on small fixtures.

Implementation steps:
- Use index token/status/consumer buckets to collect bounded candidate ids.
- Reuse existing dev-memory search/supersession semantics on the candidate set.
- Reuse existing active-playbook matching/ranking on indexed playbook candidates.
- Keep the public buildMemoryFreshnessPack API stable for existing consumers.

Verification:
- Compare indexed and reference packs for required ids, suppressed ids, deprecated hits, freshness class, render cap, and non-authoritative flags.
- Assert candidate playbooks and malformed playbooks never surface.
- Re-run MVP1, MVP2, baseline small, and the new index smoke.
