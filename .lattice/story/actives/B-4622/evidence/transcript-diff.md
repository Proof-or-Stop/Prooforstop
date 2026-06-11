# B-4622 User-Value Transcript Diff

## Expected

PLAN outcome:

- `scope_check_save` remains PLAN-only.
- Later DEV/REVIEW scope changes use `scope_contract_acknowledge`.
- Command-policy tests pass with that split enforced.
- Later-phase acknowledgement is not relabeled as a PLAN reviewer pass.

## Actual

Documentation check:

```text
docs/requirements/decisions/story-lifecycle.md:99:- **scope_check_save remains PLAN-only signed scope review evidence**
docs/requirements/decisions/story-lifecycle.md:100:- **scope_contract_acknowledge is the DEV/REVIEW later-phase scope acknowledgement path**
docs/requirements/decisions/story-lifecycle.md:101:- **later-phase acknowledgement is not a replacement for a PLAN scope reviewer pass**
```

Command ownership regression:

```text
✓ scope_check_save allowedPhases: PLAN
✓ scope_contract_acknowledge allowedPhases: DEV, REVIEW
✓ command-ownership contract passed
```

Koala validation:

```text
✓ Project validation commands passed
Verification intent coverage: 6/6 covered (0 required missing)
```

Reviewer result:

```text
finding_list: []
review passes: concept, quality, test-coverage, docs
```

## Diff

No user-visible mismatch found. The story now has both the durable lifecycle documentation and a mechanical regression contract that fails if `scope_check_save` is broadened beyond PLAN or if `scope_contract_acknowledge` loses its DEV/REVIEW window.
