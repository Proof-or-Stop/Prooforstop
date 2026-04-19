# story_review structured experiment v1

Baseline normalizedScore: 0.375
Best candidate: r09-json-concise Concise JSON
Best normalizedScore: 0.988 (+0.613)
Recommendation: consider implementing r09-json-concise

## Top 3

| rank | candidate | normalizedScore | score | lines | lengthDelta | status |
|---:|---|---:|---:|---:|---:|---|
| 1 | r09-json-concise Concise JSON | 0.988 | 0.588 | 4 | -104 | kept |
| 2 | r02-blocker-first Blocker First | 0.9865 | 0.5865 | 13 | 179 | kept |
| 3 | r07-coverage-table Coverage Table | 0.985 | 0.585 | 14 | -121 | kept |

## All candidates

| candidate | normalizedScore | score | normalizedDelta | lines | lengthDelta | notable contentSummary |
|---|---:|---:|---:|---:|---:|---|
| r09-json-concise Concise JSON | 0.988 | 0.588 | 0.613 | 4 | -104 | has blockerCount; has actionableHint |
| r02-blocker-first Blocker First | 0.9865 | 0.5865 | 0.6115 | 13 | 179 | has blockerCount; has actionableHint |
| r07-coverage-table Coverage Table | 0.985 | 0.585 | 0.61 | 14 | -121 | has blockerCount; has actionableHint |
| r03-fix-command-first Fix Command First | 0.9841 | 0.5841 | 0.6091 | 17 | -9 | has blockerCount; has actionableHint |
| r08-human-readable Human Readable | 0.9838 | 0.5838 | 0.6088 | 18 | -61 | has blockerCount; has actionableHint |
| r04-advisory-bottom Advisory Bottom | 0.9832 | 0.5832 | 0.6082 | 20 | -64 | has blockerCount; has actionableHint |
| r05-risk-section Risk Section | 0.9832 | 0.5832 | 0.6082 | 20 | -77 | has blockerCount; has actionableHint |
| r06-no-review-prompt No ReviewPrompt | 0.6121 | 0.3621 | 0.2371 | 11 | -90 | has blockerCount; missing riskSignals; missing decisionGate; missing reviewPrompt |
| r01-current Current Full Output | 0.375 | 0.225 | 0 | 18 | 0 | has blockerCount; missing missingIntent; missing riskSignals; missing decisionGate |
| r10-minimal Minimal | 0.2374 | 0.1374 | -0.1376 | 6 | -356 | missing blockerCount; missing riskSignals; missing decisionGate; missing reviewPrompt |

## Recommendation

Recommended implementation candidate: **r09-json-concise Concise JSON**.

Use this report as design input, not as an automatic production change.

## Baseline sample

```text
{
  "reviews": [
    {
      "timestamp": "2026-04-19T00:51:50.339Z",
      "issueCount": 1,
      "blockerCount": 0,
      "issues": [
        {
          "type": "review_advisory",
          "severity": "advisory",
          "message": "审查未发现 blocker，但建议对照 _reviewPrompt 中的真相源文档人工复核 testIntent 完整性"
        }
      ],
      "_hash": "fcfd6039437773660a34dfaa07c51fcc229225220aa1dc80a7258d95e3bd197a"
    }
  ]
}
```