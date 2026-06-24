# B-70e4 — Real-machine acceptance: transcript + diff

Rhythm: PLAN outcome = **expected** → run on a real machine (staging Authority) → captured output = **actual** → diff.

## User-facing capability under test

A Proofbound user runs `authority_receipt_verify --proofPath /v1/receipts/{id}/proof` against a
**real** Authority to verify a signed gate_decision receipt. Before this story the proof fetch
hit the protected endpoint **unauthenticated** and 401'd, so verification failed even though the
receipt was valid. After this story the fetch carries `Authorization: Bearer <customer key>`, the
proof is fetched, the receipt-ref is written, and the TEST/DONE gates are consumed.

## Run 1 — real machine, real server (the user path)

Command (creds sourced from the 3 root config files; staging URL, never localhost):

```
source ./lattice_senior_authority_trust.env \
  && export LATTICE_AUTHORITY_CUSTOMER_API_KEY="$(cat ./lattice_senior_staging-client.env | tr -d '\n')" \
  && node packages/main/dist/tasks/authority-live-receipt-ref-gate-smoke.js
```

This exercises the actual user-facing handler end-to-end: `runAuthorityReceiptVerify` → `loadProof`
(builds `AuthorityClient` via `resolveAuthorityClientAuth(process.env)`) → `fetchGateReceiptProof`
(`authenticated: true`) against `https://staging.hostneutral.net`.

| | Expected (PLAN) | Actual (run) | Diff |
|---|---|---|---|
| Proof fetch on protected endpoint | succeeds with Bearer auth (no 401) | staging proof fetched | match |
| Receipt-ref written | yes | receipt ref written | match |
| TEST/DONE gates consumed | yes | TEST/DONE gates consumed | match |
| Negative control (tampered) | blocked | negative control blocked | match |

Actual output:

```
PASS authority live receipt-ref gate smoke: staging proof fetched, receipt ref written, TEST/DONE gates consumed, negative control blocked
```

**Diff: none. Actual == expected.**

## Run 2 — deterministic regression (no network)

```
npm run --prefix packages/main test:authority-receipt-proof-auth
```

| | Expected (PLAN) | Actual (run) | Diff |
|---|---|---|---|
| With a customer key → Bearer header | sent | Bearer header sent | match |
| Happy path → schema-valid proof parses | `outcome.ok===true` + data shape | happy-path parses ok===true | match |
| Without a key / empty string | fail-closed, no request | fail-closed for both unset and empty-string keys | match |

Actual output:

```
PASS authority receipt proof auth smoke: Bearer header sent, happy-path parses ok===true, and fail-closed for both unset and empty-string keys
```

**Diff: none. Actual == expected.** Red/green confirmed during the spike: reverting `authenticated: true`
makes the Bearer assertion FAIL.

## 5-question user-value self-check

1. **Does it solve the user's real problem?** Yes — receipt verification against a real Authority
   no longer 401s; the gate-decision receipt is fetched and verified end-to-end.
2. **Did I run it the way a user would, on a real machine?** Yes — Run 1 hits the real staging
   server through the real handler, with creds from the user's 3 root config files (not localhost,
   no gamed gate, no fabricated evidence).
3. **Is the output what a user expects?** Yes — proof fetched, receipt-ref written, gates consumed,
   tampered control blocked. Expected == actual on every row.
4. **Are failure modes safe?** Yes — missing or empty-string customer key fails closed and sends no
   request to the protected endpoint (pinned deterministically).
5. **Is it durably covered?** Yes — the deterministic smoke (`test:authority-receipt-proof-auth`) is
   registered as a package.json script + smoke-manifest entry and runs in `lattice validate`.
