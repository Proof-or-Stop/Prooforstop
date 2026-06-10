# B-c886 Transcript Diff

## Expected

Layer 2 Engineering Baseline unlock contract should fail closed:

- expected safety refusals use `expectedBlockReasons` and `refusalEvidenceRefs`
- risky migration/security PASS requires explicit gate evidence
- malformed, fake, stale, local-only, or incoherent proof cannot authorize Engineering claims
- `target=engineering` maps to `CLAIM-ENGINEERING-DEV`
- Claude/Codex host verdicts remain audit-only

## Actual Commands

```bash
npm run build
npm --prefix packages/main run test:lattice-baseline-smoke
lattice validate --story=B-c886
```

## Actual Result

- `npm run build`: PASS
- `npm --prefix packages/main run test:lattice-baseline-smoke`: PASS
- `lattice validate --story=B-c886`: PASS
- verification intent coverage: 15/15 covered
- CHK-005 unavailable-host edge: waived because both required hosts were available in this run; single-host evidence was not counted as two-host evidence

## Diff Notes

No gap found between PLAN outcome and actual behavior. The implemented contract remains local Engineering-layer proof only; it does not unlock Loop Engineering, Production Safety, Authority receipts, or production-grade unattended claims.
