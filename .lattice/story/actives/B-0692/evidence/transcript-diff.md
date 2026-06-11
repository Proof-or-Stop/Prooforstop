# B-0692 User-Facing Transcript Diff

## Expected

The user runs `npm run test:process-fact-contract` and sees a concrete process fact level registry:

```text
Process Fact Level Registry
- entries: 87 (84 CLI, 3 runtime)
- registry entries:
- story_advance [L4] owner=handlers/story-advance gate=storyMachine phase guards and story_advance preflight gates
- runtime:phase_tools_malformed_allow_all [L1] owner=core/config
- runtime:test_auto_recursive_skip [L2] owner=handlers/test-auto
- runtime:validate_fallback_discovery [L1] owner=handlers/verifier
Process fact contract verified
```

The user can tell that the registry is not just documentation: new CLI commands missing from the registry, process-fact candidates marked L0, L4 entries without `gateConsumer`, pass-only `finding_add`, and reviewer prompt drift are all checked by the contract.

## Actual

`npm run test:process-fact-contract` printed:

```text
Process Fact Level Registry
- entries: 87 (84 CLI, 3 runtime)
- levels: L0=31, L1=14, L2=19, L3=2, L4=21
- registry entries:
- story_advance [L4] owner=handlers/story-advance gate=storyMachine phase guards and story_advance preflight gates
- truth_extract [L2] owner=handlers/truth
- truth_nav [L2] owner=handlers/truth
- doctor [L2] owner=handlers/doctor
- runtime:phase_tools_malformed_allow_all [L1] owner=core/config
- runtime:test_auto_recursive_skip [L2] owner=handlers/test-auto
- runtime:validate_fallback_discovery [L1] owner=handlers/verifier
Process fact contract verified
```

Additional validation:

```text
koala validate --story=B-0692 --json
status: pass
Verification intent coverage: 9/9 covered

npm --prefix packages/main run test:review-pass-discard-smoke
✓ review pass and discard smoke passed

npm run build
tsc pass
```

## Diff

No user-facing gap remains. The actual transcript includes the expected registry summary and the three runtime soft-point entries, and it also shows the quality-review fix that `truth_nav`, `truth_extract`, and `doctor` are L2 rather than L0.
