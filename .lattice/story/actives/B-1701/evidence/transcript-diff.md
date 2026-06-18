# Transcript Diff

Story: B-1701
Head: c371d1c0e177b2fcdf0ff4d997fa8c0edc149024

## Planned Outcome

The ordinary developer path should use the generated
`lattice_authority_trust.env` + `lattice_staging-client.env` bundle locally in
the target workspace. The live runner / receipt / gate-consumption path should
still require `LATTICE_AUTHORITY_PROJECT_ID` and `LATTICE_AUTHORITY_GATE_ACTOR_*`.

## Actual Validation

- `npm run build` -> pass
- `node packages/main/dist/tasks/authority-status-smoke.js` -> pass
- `node packages/main/dist/tasks/authority-client-smoke.js` -> pass
- `npm run test:docs-drift-smoke` -> pass
- `lattice validate --story=B-1701 --json` -> pass

## Diff Notes

- Updated the CLI status note and user-facing docs to say the bundle is
  generated locally in the target workspace and is not a cross-host portable
  artifact.
- Kept the live-only `PROJECT_ID` / `GATE_ACTOR_*` boundary unchanged for the
  real receipt flow.
- No functional change to bundle generation, signature verification, or receipt
  verification behavior.
