# B-0f04 Codex PM Verification

Role: Codex PM/verifier. Claude Code wrote the primary audit report; this file
independently checks the high-risk claims that could trigger follow-up work.

Scope: verification only. No production code changes were made by Codex.

## Sources checked

- Koala CLI TS worktree:
  `/Users/jek/Documents/Work/Orchestrate/.worktrees/B-0f04`
- Cord Team Python authority:
  `/Users/jek/Documents/Work/Koala/cord-team`
- Koala Mac/Swift runner:
  `/Users/jek/Documents/Work/Koala/Koala`

Commands used:

```bash
node /Users/jek/Documents/Work/Orchestrate/packages/main/dist/cli.js session_brief
git status --short
git show --stat --oneline 772e9ffd 04b23702 933bf32e
rg -n "client_name|clientName|authority_mode|authorityMode|command_catalog_digest|evidence_schema_digest|runner_id|device_id|producerRunId|verifierRunId|provider|model|vendor|signature" packages/main/src/core/authority-contracts.ts packages/main/src/core/authority-submit.ts packages/main/src/core/authority-client.ts
rg -n "class _EvidenceSignedView|verify_signed_actor_payload|_validate_evidence_envelope|_require_authority_handshake|_require_actor_key_binding|_require_l2_evidence_quality|require_distinct_l2_provider|l2_run_bindings_required" src/cord_team/services/authority_records.py src/cord_team/config.py src/cord_team/schemas/command.py
rg -n "verifyServerSignature|AuthorityReceipt|receiptID|receiptKind|receipt\\.signature|verify.*receipt|signature" Sources/Koala/Core/Runner/LocalRunnerService.swift Sources/Koala/Core/Authority/AuthorityModels.swift Sources/Koala/Core/Authority/AuthorityClient.swift
```

## Verification results

### HV-1: production authority rejects current CLI POSTs

Verdict: confirmed, conditional on using the CLI as an enforce-mode authority
client against the Python authority.

Evidence:

- CLI `buildEnvelope` only sends a minimal object:
  `authority-submit.ts:68-88`. It omits handshake fields, run bindings,
  provider/model/vendor, commandDigest, transcriptHash, and signature.
- CLI `EvidenceEnvelopeContract` has run/provider/signature fields but no
  authority handshake fields:
  `authority-contracts.ts:110-146`.
- Python evidence validation calls `_require_authority_handshake` after signed
  actor validation:
  `authority_records.py:485-521`.
- Under `production_enforce_authority`, Python rejects missing or wrong
  `authorityMode` and then requires `clientName`, `clientVersion`,
  `commandCatalogDigest`, `evidenceSchemaDigest`, and `authorityMode`:
  `authority_records.py:524-582`.
- Python anti-hallucination preset requires run bindings and provider diversity:
  `config.py:87-100`; enforcement rejects missing run bindings at
  `authority_records.py:1139-1153` and requires producer/verifier run records for
  diversity at `authority_records.py:903-918`.

Conclusion: FU-1 and FU-2 are valid if PD-1 chooses "CLI is an enforce-mode
authority client." If the CLI remains local/shadow only, these are not current
functional blockers.

### HV-2: CLI lacks actor-key/runner/signature path for L2 authority evidence

Verdict: confirmed, and the actual Python path is stricter than a runner-heartbeat
check alone.

Evidence:

- Python `verify_signed_actor_payload` rejects unknown actors and unsigned
  payloads before evidence policy checks:
  `signed_actor.py:24-64`.
- Evidence submission wraps the envelope in `_EvidenceSignedView` and calls that
  verifier:
  `authority_records.py:485-495` and `authority_records.py:1857-1867`.
- Python production actor binding / L2 runner heartbeat checks are additional
  gates when configured:
  `authority_records.py:584-633`.
- CLI submit path has no actor-key registration, runner registration/heartbeat,
  or signing before POST:
  `authority-submit.ts:68-88`, `authority-client.ts:138-158`.
- Mac runner does have actor key registration, runner registration, heartbeat,
  and signed evidence:
  `LocalRunnerService.swift:103-151`, `:632-641`.

Conclusion: FU-3 is valid. If the CLI is promoted to a first-class runner/client,
it needs actor-key registration, runner identity/heartbeat as applicable, and
envelope signing. Otherwise the product should document CLI as non-runner and
delegate authority runner submission to Mac/runner.

### HV-3: clients do not cryptographically verify server receipts

Verdict: confirmed from inspected surfaces.

Evidence:

- CLI response type accepts `receipt?: unknown`, and `submitEvidence` only posts
  the envelope and parses the response:
  `authority-contracts.ts:476-483`, `authority-client.ts:138-158`.
- No CLI receipt verification path was found in the inspected authority client
  files.
- Mac verifies server JobSpec signature:
  `LocalRunnerService.swift:244-251`.
- Mac records receipt id/kind from the response:
  `LocalRunnerService.swift:568-590`.
- No Mac receipt-signature verification path was found by the receipt/signature
  search. The observed signature verification is JobSpec verification, not
  AuthorityReceipt verification.

Conclusion: FU-4 is valid as security hardening independent of PD-1.

## Report quality check

Claude's primary report only changed
`.koala/story/actives/B-0f04/evidence/cross-end-contract-audit.md` across the
three implementer commits:

- `772e9ffd` CHK-001: one evidence file, 235 insertions.
- `04b23702` CHK-002: same evidence file, 32 insertions / 11 deletions.
- `933bf32e` CHK-003: same evidence file, 120 insertions / 6 deletions.

No production code was modified in B-0f04 before this PM verification artifact.

The report's key boundary is correct: B1/B2/B3 are blockers only if PD-1 resolves
that Koala CLI must become a full enforce-mode authority client. In the current
local/shadow CLI posture with Mac/runner as the canonical authority submitter,
they are follow-up design work rather than current operational blockers.

## PM conclusion

Accept the B-0f04 audit report as verified evidence for DEV. The recommended
follow-up stories are not duplicates of the active B-4622/B-da5b backlog and
should be created only after PD-1 is resolved.
