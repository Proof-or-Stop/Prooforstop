# B-d43b TEST Transcript Diff

Story: B-d43b — Add Codex adapter evidence gate scope regression coverage

Command run from the story worktree:

```bash
lattice validate --story=B-d43b --json
```

Expected outcome:

- Full story validation passes.
- The configured validate command list includes the Codex adapter gate scope smoke.
- The smoke proves provider-only prose mentioning Codex does not require Codex adapter evidence.
- The smoke still proves real adapter surfaces such as `.lattice-codex`, `verify_codex`, `.codex/hooks.json`, `lattice codex verify`, and `lattice codex doctor` require Codex adapter evidence.
- Verification intent coverage is complete.
- No Authority Server, production, or receipt-backed proof is claimed by this local adapter-gate regression story.

Actual observed transcript summary:

- `lattice validate --story=B-d43b --json` passed.
- Runtime was approximately 87 seconds.
- It ran 28 configured validation commands.
- `configured validate.commands[0]` ran `npm --prefix packages/main run build` and passed.
- `configured validate.commands[7]` ran `node packages/main/dist/tasks/codex-adapter-gate-scope-smoke.js` and passed.
- The smoke output was:

```text
✓ codex adapter gate scope smoke passed: provider-only Codex text ignored; adapter surfaces required
```

- Verification intent coverage reported `9/9 covered` and `0 required missing`.
- The result artifact records `localAdapterGateScopeEvidenceOnly=true`, `authorityChanged=false`, `receiptVerified=false`, and `productionDone=false`.

Expected vs actual diff:

- No behavioral diff found.
- The new regression coverage was exercised by the real built runtime after `tsc`.
- The full validate path and focused fast validate wiring both include the smoke.
- The story remains intentionally local-only: it adds regression coverage for Lattice's Codex adapter evidence gate scope and does not claim Authority Server completion or production proof.

Acceptance verdict:

Accepted. The observed TEST run matches the story scope and the baseline item 3 success criteria.
