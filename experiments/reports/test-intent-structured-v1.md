# testIntent structured experiment v1

Baseline normalizedScore: 0.6667
Best candidate: t07-reviewer-friendly Reviewer Friendly
Best normalizedScore: 0.9856 (+0.3189)

## Top 3

| rank | candidate | normalizedScore | score | lines | lengthDelta | status |
|---:|---|---:|---:|---:|---:|---|
| 1 | t07-reviewer-friendly Reviewer Friendly | 0.9856 | 0.5856 | 39 | 674 | kept |
| 2 | t05-adversarial-first Adversarial First | 0.9838 | 0.5838 | 39 | 550 | kept |
| 3 | t02-operation-result Operation Result | 0.8246 | 0.4913 | 20 | 253 | kept |

## All candidates

| candidate | normalizedScore | laneCompleteness | typeCoverage | fixtureMapping | adversarial | duplicate | notable contentSummary |
|---|---:|---:|---:|---:|---:|---:|---|
| t07-reviewer-friendly Reviewer Friendly | 0.9856 | 1 | 1 | 1 | 1 | 1 | (all key signals present) |
| t05-adversarial-first Adversarial First | 0.9838 | 1 | 1 | 1 | 1 | 1 | (all key signals present) |
| t02-operation-result Operation Result | 0.8246 | 1 | 1 | 1 | 0 | 1 | weak adversarialStrength |
| t06-compact-json Compact JSON | 0.8219 | 1 | 1 | 1 | 0 | 1 | weak adversarialStrength |
| t03-fixture-mappable Fixture Mappable | 0.8186 | 1 | 1 | 1 | 0 | 1 | weak adversarialStrength |
| t01-current Current Baseline | 0.6667 | 1 | 0 | 0 | 1 | 1 | missing typeCoverage; missing fixtureMapping |
| t10-no-types No Types | 0.6589 | 1 | 0 | 0 | 1 | 1 | missing typeCoverage; missing fixtureMapping |
| t09-missing-adversarial Missing Adversarial | 0.6018 | 0.6667 | 1 | 0 | 0 | 1 | missing threeLanes; missing fixtureMapping; weak adversarialStrength |
| t08-duplicate-noise Duplicate Noise | 0.5468 | 1 | 1 | 0 | 0 | 0.3333 | missing fixtureMapping; weak adversarialStrength; has duplicate antiDuplicate |
| t04-trigger-condition-result Trigger Condition Result | 0.4895 | 1 | 1 | 0 | 0 | 0 | missing fixtureMapping; weak adversarialStrength; has duplicate antiDuplicate |

## Recommendation

Recommended prompt direction: **t07-reviewer-friendly Reviewer Friendly**.

Prefer formats with explicit input/expect fields when writing fixture-heavy stories; avoid duplicate happy/edge/adversarial descriptions.