# B-b663 User-Value Transcript Diff

## Expected

The user asked that documentation audit follow the same ordinary-development
automatic 3x2/3x1 policy.

Expected observable result:

- The execution plan no longer treats direct decision-doc edits as a permanent
  always-on 3x2 target policy.
- Documentation and decision-doc audit start with ordinary REVIEW.
- Documentation and decision-doc audit escalate to full 3x2 only when the first
  REVIEW round records at least two countable problems.
- Escalated documentation audit can use the same explicit degraded 3x1 fallback
  only when policy or approval allows it.
- The document remains honest that current runtime may still enforce legacy
  direct decision-doc 3x2 until a follow-up implementation story migrates the
  gate.

## Actual

Manual policy assertions:

```text
doc policy and English-only checks passed
```

Formal TEST validation:

```text
lattice validate --story=B-b663 --json
status: pass
allPass: true
summary: Project validation commands passed; validate.ts/js/mts not found and no configured validate.command(s); used advisory fallback command discovery
verification intent coverage: 6/6 covered, 0 required missing
npm test: pass
```

Reviewer result:

```text
concept: PASS
quality: PASS
test-coverage: PASS
docs: PASS
findings: 0
```

## Diff Notes

- Expected and actual match for the documentation policy change.
- The document is still a plan, not runtime implementation.
- Runtime migration remains a follow-up implementation task for the hard gate.
