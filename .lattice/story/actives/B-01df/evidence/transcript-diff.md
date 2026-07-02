# B-01df User-Value Transcript Diff

Story: B-01df
Phase: TEST
Date: 2026-07-02

## Expected

The user-visible M1 outcome is a host-neutral read-only command:

```bash
lattice source_lineage_audit --domain=learning --json
```

Expected behavior:

- emits JSON for the learning domain;
- includes `canonicalSourceKey`, `canonicalSourceKeyVersion`, and
  `canonicalizationPolicyHash`;
- reports `duplicateCanonicalSourceGroups` and `missingLineageCount`;
- reports `authority: "non_authoritative"` and `gateEvidence: false`;
- rejects unsupported domains clearly;
- does not create seeds, proposals, candidates, outcomes, promotion decisions,
  active playbooks, runtime blocking policy, or DONE settlement rows.

## Actual

Local dist CLI command:

```bash
node packages/main/dist/cli.js source_lineage_audit --domain=learning --json
```

Observed summary:

```json
{
  "schemaVersion": "proofbound.source-lineage-audit.v1",
  "domain": "learning",
  "authority": "non_authoritative",
  "gateEvidence": false,
  "sourceRecordCount": 1603,
  "missingLineageCount": 4,
  "duplicateGroups": 364,
  "recordsHaveKey": true
}
```

Unsupported domain command:

```bash
node packages/main/dist/cli.js source_lineage_audit --domain=runtime --json
```

Observed result:

```text
source_lineage_audit: unsupported domain "runtime" (supported: learning)
```

Verification:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/source-lineage-audit-smoke.js
lattice validate --storyId=B-01df --json
```

Observed result:

- build passed;
- source-lineage focused smoke passed: `TOTAL 6 | PASS 6 | FAIL 0`;
- `lattice validate` passed all 31 configured validation commands.

## Diff Notes

- Expected JSON shape is present.
- Expected non-authoritative / non-gate boundary is present.
- Expected unsupported-domain diagnostic is present.
- The command found real learning-source posture in the current repository:
  1603 source records, 4 missing-lineage records, and 364 duplicate canonical
  source groups. This proves the audit is not merely theoretical.
- No evidence here claims seed observe, batch proposal, candidate approval,
  automatic promotion, DONE settlement default-on, runtime blocking, receipt
  proof, release readiness, or production readiness.

## Self-Check

- Did the actual output satisfy the PLAN outcome? Yes.
- Did the output broaden the claim beyond M1? No.
- Did any learning artifact become gate evidence? No.
- Did any mutating playbook path run as part of the audit command? No.
- Remaining limitation: REVIEW used explicit local reviewer lanes because
  independent reviewer subagents failed due quota. The lane evidence is recorded
  as local review, not multi-host assurance.
