# B-3784 User-Acceptance Transcript

## Expected outcome (from CHK-001/002 userSees)
```
✓ multi-host authority smoke passed
✓ autopilot authority smoke passed: local usable, shadow advisory, authority fail-closed, projection-only event recorded
```

## Actual output (run from repo root with authority_trust.env present)
```
$ node packages/main/dist/tasks/multi-host-authority-smoke.js
✓ multi-host authority smoke passed

$ node packages/main/dist/tasks/autopilot-authority-smoke.js
✓ autopilot authority smoke passed: local usable, shadow advisory, authority fail-closed, projection-only event recorded
```

## Diff notes
- No deviation between expected and actual
- Both smokes now pass from repo root even when authority_trust.env contains LATTICE_AUTHORITY_LIVE_URL=https://staging.hostneutral.net
- Fix delivered by B-6745 (fileReader:NO_DISK for multi-host; cwd:root temp dir for autopilot) and merged into B-3784 branch
- npm run test:all: 162/163 passed; autopilot-authority PASS, multi-host-authority PASS
- 1 failure (rollout-check) is pre-existing concurrency flake, explicitly out of scope per CHK-003

## Self-check
1. Did the actual output match the expected transcript? Yes
2. Were there surprises? No — fix was already in place via B-6745
3. Did edge cases pass? Yes — shadow mode still returns warn; E2 assertion still enforces local mode
4. Any regressions? None — all previously passing smokes still pass
5. Is the work done from user's perspective? Yes — both smoke tests pass from repo root
