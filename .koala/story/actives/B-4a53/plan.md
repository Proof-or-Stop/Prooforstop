# B-4a53 Plan

## CHK-001 盘点 Authority Server 强证据就绪状态

Scope: read-only readiness diagnostics only. Run authority_status, conduit_status, authority_enforce_policy, and environment presence checks without submitting evidence or claiming receipt verification.

Expected result for this environment: report that Authority mode is off, no Authority URL / actor key / runner id / session id / server public key is configured, receiptVerified remains false, and local workflow remains usable.

Verification: a mechanical report must include the exact conclusion line: Authority readiness: BLOCKED (authorityUrlConfigured=false, actorKeyConfigured=false, runnerConfigured=false, sessionConfigured=false, serverPublicKeyPinned=false).

## CHK-002 尝试提交 Authority job 并获取 receipt 证据

Scope: attempt the real Authority job path only far enough to prove whether this environment can submit. Do not fabricate a job id or receipt. Because policy discovery already failed without LATTICE_AUTHORITY_URL, the expected job attempt is fail-closed before receipt fetch/verify.

Expected result for this environment: authority_job_create is blocked by missing Authority URL or missing job-plan prerequisites; no receiptId exists, receiptVerified=false, productionDone=false.

Verification: a mechanical report must include the exact conclusion line: Authority receipt: BLOCKED (no verified AuthorityReceipt; receiptVerified=false; productionDone=false).

## CHK-003 输出强证据验证结果并保持 gate 边界一致

Scope: write a scoped artifact report under .omx/artifacts/authority/B-4a53 and a user transcript evidence file. The report must distinguish local diagnostics from strong evidence and must not upgrade B-688d/B-0a80 local lifecycle artifacts.

Expected result for this environment: Authority strong evidence verification is BLOCKED fail-closed. The artifact should list command transcripts, readiness fields, the blocked job attempt, and next actions required for a future receipt-backed PASS.

Verification: a mechanical report check must include the exact conclusion line: Authority strong evidence verification: BLOCKED fail-closed.
