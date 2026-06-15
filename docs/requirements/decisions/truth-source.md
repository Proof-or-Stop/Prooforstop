# Source of Truth Management

## Definitions

- **Source of truth** = `docs/requirements/decisions/*.md` (human discussion and decisions — the "why")
- **Reverse extraction** = `docs/requirements/extracted/*.md` (a reference automatically extracted from code/Story)
- **A Story is not the source of truth** — a Story is an execution plan, while the source of truth is the requirements and decisions

## Design Principles

- The source of truth is Markdown files, not converted to JSON
- It is scanned and extracted from the .md files in real time on every pass, with no intermediate cache
- Automatically created Stories are not included in the truth, to avoid circular dependencies
- When a Story is created, the discussion's key points are automatically captured into `docs/requirements/decisions/B-xxx.md`
- `grill.json` is a story-local planning artifact, not a source of truth. Grill clarifies intent; evidence proves behavior. A grill record can flag questions not yet digested, but cannot replace the decisions documents, `verificationEvidence`, or the validation evidence from `lattice validate`.

## Closed-loop Flow

```
truth_scan (scan requirements)
  → truth_analyze (analyze contradictions/ambiguities/gaps)
  → truth_to_story (break down into Stories)
  → development → task_scan/flow_list (extract code reality)
  → gap_analyze (compare the gap)
  → convergence_check (decide whether converged)
```

## MCP Tools

| Tool | Purpose |
|---|---|
| `truth_scan` | Scan docs/requirements/ to extract requirements/decisions/constraints |
| `truth_nav` | Generate/update the NAV.md navigation index |
| `truth_analyze` | Analyze contradictions/ambiguities/gaps |
| `truth_to_story` | Break down into Stories once the requirements have converged |
| `gap_analyze` | Report the gap between the source of truth and code reality |
| `convergence_check` | Decide whether it has converged |
