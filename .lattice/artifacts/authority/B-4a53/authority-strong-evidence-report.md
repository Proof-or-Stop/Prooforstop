# Authority Strong Evidence Report: B-4a53

Authority readiness: BLOCKED (authorityUrlConfigured=false, actorKeyConfigured=false, runnerConfigured=false, sessionConfigured=false, serverPublicKeyPinned=false)
Authority receipt: BLOCKED (no verified AuthorityReceipt; receiptVerified=false; productionDone=false)
Authority strong evidence verification: BLOCKED fail-closed

## Result

- Story: B-4a53
- Strong evidence result: BLOCKED_FAIL_CLOSED
- Authority mode: off
- Receipt verified: false
- Production done: false
- Strong evidence consumed: false

No AuthorityReceipt was returned or verified. No job id, receipt id, or receipt file is claimed by this report.

## Diagnostics

| Command | Exit | Result |
| --- | ---: | --- |
| `lattice authority_status --json` | 0 | Authority mode off; Authority URL absent; actor key absent; runner absent; session absent; server public key not pinned; receiptVerified=false; productionDone=false. |
| `lattice conduit_status --json` | 0 | Conduit available for diagnostics/handoff only; runnerProvisioned=false; receiptVerified=false; productionDone=false; mode=off. |
| `lattice authority_enforce_policy --json` | 1 | Failed closed because `LATTICE_AUTHORITY_URL` is not set; policy discovery reports no receipt, no gate pass, and no evidence submission. |
| Environment presence check for `KOALA_AUTHORITY_*` and `LATTICE_AUTHORITY_*` | 0 | URL, actor key/key path, runner, session, and server public key variables are all absent or empty. Values were not printed. |
| Authority job create | skipped | Readiness proved no Authority URL is configured, so no real Authority job target exists. |

## Environment Presence

The redacted environment presence check found no non-empty Authority URL, actor key, actor key path, runner id, session id, or server public key variable in either the `KOALA_AUTHORITY_*` or `LATTICE_AUTHORITY_*` families.

## Next Actions

1. Set an Authority URL, for example `KOALA_AUTHORITY_URL=https://<authority-host>` or `LATTICE_AUTHORITY_URL=https://<authority-host>`.
2. Configure an actor key or key path, for example `KOALA_AUTHORITY_ACTOR_KEY` or `KOALA_AUTHORITY_ACTOR_KEY_PATH`, with corresponding `LATTICE_AUTHORITY_*` aliases if that wrapper expects them.
3. Configure runner and session identity, for example `KOALA_AUTHORITY_RUNNER_ID` and `KOALA_AUTHORITY_SESSION_ID`, with matching `LATTICE_AUTHORITY_*` aliases if needed.
4. Pin the Authority server public key, for example `KOALA_AUTHORITY_SERVER_PUBLIC_KEY` or `KOALA_AUTHORITY_SERVER_PUBLIC_KEY_PATH`, with matching `LATTICE_AUTHORITY_*` aliases if needed.

## Mechanical Verification

The mechanical verification parses the JSON report and checks the required markdown/transcript lines plus false invariants for `receiptVerified`, `productionDone`, `strongEvidenceConsumed`, readiness fields, and absence of `jobId`, `receiptId`, and `receiptFile` keys.

Result will be recorded in `.koala/story/actives/B-4a53/evidence/transcript-diff.md` after the command is run.
