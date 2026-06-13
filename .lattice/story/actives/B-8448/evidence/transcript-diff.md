# B-8448 Transcript Diff

## Expected

The user should be able to open
`docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md`
and review a detailed English-only execution plan for migrating
`packages/main/src/cli-engine.ts`. The document should include every
Chinese-bearing source line from `cli-engine.ts` with a proposed English
translation, not only a representative catalog.

## Actual

The document includes:

- `English-Only Policy`
- `Execution Phases`
- `Translation Review Table`
- `Complete Line-Level Translation Manifest`
- `Reviewer Checklist`

The manifest validation command reported:

```text
sourceCount=762
manifestRows=762
badProposedEnglish=0
fallback=0
malformed=0
```

The Lattice validation run reported:

```text
status=pass
allPass=true
npm test: PASS
verification intent coverage: 3/3 covered
```

## Diff

Expected and actual match. The review document now provides a complete
line-level review packet for all 762 Chinese-bearing `cli-engine.ts` lines.
Rows are intentionally marked `review-draft`, so they are ready for human
approval or rewrite before a later implementation story changes source text.

No source translation was applied in this story. `packages/main/src/cli-engine.ts`
was not modified.
