## CHK-001

Goal: add root `authority_trust.env` support only for Authority configuration resolution.

Implementation approach:
- Add `authority_trust.env` to `.gitignore` so copied local trust/secret material is never committed.
- Add a small parser for simple env files in `packages/main/src/core/authority-mode.ts` or adjacent Authority config code.
- Load the default file from the project root only when Authority mode is enabled (`shadow` / `enforce`) or an Authority-specific config path asks for it. Off mode must keep zero file-read semantics.
- Merge parsed trust-file values underneath explicit CLI/env values and above `.lattice/authority.md` / localhost defaults.
- Map supported aliases to canonical config: `LATTICE_AUTHORITY_LIVE_URL` -> URL, `LATTICE_AUTHORITY_LIVE_PUBLIC_KEY` -> SERVER_PUBLIC_KEY, `LATTICE_AUTHORITY_CUSTOMER_API_KEY_FILE` -> CUSTOMER_API_KEY_PATH. Accept canonical keys directly too.

Tests:
- Synthetic trust-file text only; do not use real secret values.
- Assert trust file config fills URL/public key/customer key path when explicit env is absent.
- Assert explicit env wins over trust-file values.
- Assert missing trust file is non-fatal and existing authority.md/default behavior remains.
- Assert root `authority_trust.env` is ignored by git.

Out of scope:
- Generic dotenv loading.
- Remote Authority Server changes.
- Receipt creation or Authority DONE promotion.

## CHK-002

Goal: verify default trust-file loading improves Authority readiness without overclaiming Authority completion.

Implementation approach:
- Update Authority status/readiness tests if needed so `authority_status --authorityMode=enforce` can consume the same resolved config.
- Preserve all existing hard facts: `receiptVerified=false`, `productionDone=false`, `canClaimProductionDone=false` unless a verified receipt ref is actually available.
- If the trust file does not include actor key / runner id / project id, readiness warnings for those missing prerequisites should remain.

Tests:
- Add or extend `authority-status-smoke` assertions for trust-file-backed URL/customer key/server public key readiness.
- Add adversarial no-overclaim assertions for receipt/production fields.
- Run targeted Authority smoke(s) plus build.

Operator step after code is verified:
- Copy `/Users/jek/Documents/Work/Koala/cord-team/authority_trust.env` to repository root as `authority_trust.env`.
- Set file mode to `600`.
- Confirm `git status` does not show the file as tracked/untracked due to `.gitignore`.
