# Transcript Diff

Expected user-visible outcome:

```text
User sees a committed decision document that explains exactly how to resolve or disprove F-009 before any Layer2 capability claim is made, with Claude/Codex host input and final auditor checks recorded.
```

Actual transcript:

```text
lattice validate --story=B-e155 --json
status: pass
allPass: true
Project validation commands passed
Verification intent coverage: 12/12 covered (0 required missing)
Reviewer status before TEST: concept PASS, quality PASS, test-coverage PASS, docs PASS
Findings: B-e155:F-001 resolved; B-e155:F-002 resolved
NAV: 42 decision markdown files and 42 decision links
```

Diff notes:

- Expected executable F-009 plan exists under docs/requirements/decisions.
- Actual document includes phases, fail-closed tests, evidence pack, and DONE criteria.
- Expected two-host input is inspectable; actual document includes Claude and Codex command trails plus captured draft excerpts.
- Expected no false capability claim; actual document states it does not unlock Layer2 by itself and keeps higher claims locked.
- Expected NAV sync; actual NAV count and decision links are 42/42.
