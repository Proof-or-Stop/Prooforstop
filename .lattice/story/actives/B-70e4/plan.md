# Plan: B-70e4 Authenticate the gate-receipt proof fetch (fix 401) + live smoke materialOverlapAudit

> Verified-spike re-application. The fix was proven green end-to-end against the real
> staging Authority before this story; the reference diff is at `/tmp/tier-c-proof-auth-fix/`.

## CHK-001: fetchGateReceiptProof must request an authenticated read so the customer API key is sent as Bearer auth

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/authority-client.ts

**Verify**:
- `npm --prefix packages/main run build` clean
- `npm run --prefix packages/main test:authority-receipt-proof-auth` prints PASS

**DoneWhen**:
- `fetchGateReceiptProof` passes `authenticated: true` to `get()`
- `get()` attaches `Authorization: Bearer <customerApiKey>` for the proof fetch

## CHK-002: loadProof must construct the AuthorityClient with resolved auth for the proofPath fetch

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/authority-enforce.ts

**Verify**:
- `npm run --prefix packages/main test:authority-receipt-proof-auth` prints PASS (with-auth sends Bearer; no-auth fails closed)

**DoneWhen**:
- `loadProof` resolves auth via `resolveAuthorityClientAuth(process.env)` and passes it as the 4th `AuthorityClient` arg

## CHK-003: The live receipt-ref gate smoke must send an empty-overlap materialOverlapAudit on the DONE gate request, in both the digest input and the signed decision

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/tasks/authority-live-receipt-ref-gate-smoke.ts

**Verify**:
- Live smoke against staging prints `PASS authority live receipt-ref gate smoke: staging proof fetched, receipt ref written, TEST/DONE gates consumed, negative control blocked`

**DoneWhen**:
- `buildPhaseGateRequest` includes `buildNoOverlapMaterialOverlapAuditDefault()` for the DONE phase (so it is in the gateInputDigest)
- `signedTargetGateRequest` includes the same `materialOverlapAudit` in the signed decision payload (digest matches)

## CHK-004: Add a deterministic regression smoke pinning that the proof fetch is authenticated (Bearer) and fail-closed without a key

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002
**Files**:
- Create: packages/main/src/tasks/authority-receipt-proof-auth-smoke.ts
- Modify: packages/main/package.json, packages/main/smoke-manifest.json

**Verify**:
- `npm run --prefix packages/main test:authority-receipt-proof-auth` prints PASS with the fix
- Temporarily removing `authenticated: true` makes it FAIL (red/green confirmed)

**DoneWhen**:
- The test asserts: with a customer key the proof fetch sends `Authorization: Bearer <key>`; without a key it fails closed and sends no request
- Registered as a `package.json` script and a `smoke-manifest.json` entry
