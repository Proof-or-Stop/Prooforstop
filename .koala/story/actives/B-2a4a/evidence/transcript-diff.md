# B-2a4a Transcript Diff

## Expected

A maintainer can inspect `story_review` output and docs without confusing two different facts:

```json
{
  "planReviewRound": 1,
  "reviewRound": 1
}
```

The numeric fields above are PLAN review count fields. Signed artifacts still use:

```ts
reviewRound: string // ISO 8601 review round id
```

## Actual

`node scripts/verify-story-review-structured-output.mjs`:

```text
ok missing-intent
ok advisory-only
ok high-risk
story review structured output verified
```

The smoke asserts:

- `story_review.planReviewRound` is an integer and 1-based.
- legacy `story_review.reviewRound` equals that numeric PLAN round alias.
- stable `story_review` fields still include `summary`, `issues`, `_hint`, and `_reviewPrompt`.

`npm run test:field-regression-cli-smoke`:

```text
✓ field regression CLI smoke passed
```

The smoke now directly asserts CLI-created `finding.reviewRound`, `reviewPass.reviewRound`, and pass-only converted review pass `reviewRound` all equal `story.currentReviewRound` and match ISO 8601 shape.

`npm run test:process-fact-contract`:

```text
Process fact contract verified
```

The contract requires docs to include both:

- `reviewRound: string (ISO 8601 review round id)`
- `story_review.planReviewRound: number (PLAN review round count)`

## Diff

No user-visible gap remains. The CLI keeps backward compatibility for `story_review.reviewRound`, but the preferred field and docs now make the numeric PLAN count explicit, while signed artifact `reviewRound` remains an ISO string fact.
