# Codex + Koala

Codex agents can use koala CLI with activity source tagging.

```bash
# Recommended entry (tags source=codex in activity.jsonl)
KOALA_ACTIVITY_SOURCE=codex koala session_brief

# Daily operations
KOALA_ACTIVITY_SOURCE=codex koala story_create '...'
KOALA_ACTIVITY_SOURCE=codex koala checklist_update '...'
```

Alternatively, use the dedicated Codex bootstrap script:

```bash
node packages/koala/bin/koala-codex.js status
```

See `.Codex/agents/` for sub-agent prompt files.
