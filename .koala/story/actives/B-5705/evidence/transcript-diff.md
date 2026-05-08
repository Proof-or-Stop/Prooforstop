# B-5705 User Value Transcript Diff

## Expected

- A fresh `koala session_brief` recorded in story-scoped Claude activity (`docs/story/actives/<storyId>/activity.jsonl`) should count as a fresh heartbeat.
- When that heartbeat exists, the next `UserPromptSubmit` hook run should not print the reminder.
- When no activity exists, the hook should print `建议先运行 koala session_brief 恢复现场` and still exit `0`.

## Actual Transcript

```json
{
  "expected": {
    "freshStoryScopedActivity": "no reminder",
    "missingActivity": "建议先运行 koala session_brief 恢复现场"
  },
  "actual": {
    "freshStoryScopedActivity": {
      "status": 0,
      "output": ""
    },
    "missingActivity": {
      "status": 0,
      "output": "建议先运行 koala session_brief 恢复现场"
    }
  },
  "pass": true
}
```

## Diff

- Expected fresh story-scoped activity to be silent; actual output was empty with status `0`.
- Expected missing activity to show the soft reminder; actual output matched with status `0`.
- No user-visible mismatch remains for the prompt-reminder flow.
