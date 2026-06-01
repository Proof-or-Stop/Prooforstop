# CHK-002 Taxonomy Strategy — B-1148

Defines the compact taxonomy, scope rules, content limits, and duplicate policy for all B-1148 backfill entries. Consistent with `docs/requirements/decisions/dev-memory.md`.

---

## Taxonomy

Use only the categories defined in `dev-memory.md`. No custom categories.

| category | when to use | examples for B-1148 backfill |
|----------|-------------|------------------------------|
| `failure-mode` | Something went wrong and how to avoid it | Cross-story gate bypass; pass-only finding_add misclassified |
| `pattern` | A reusable approach that worked well | INIT_CHECK repair fallback with explicit acknowledge; reviewRunId binding for reviewer evidence |
| `workflow` | A process or sequence that worked well | Stale-lease takeover flow; pre-push hook build order |
| `tool-quirk` | Unexpected behavior of a tool | ppid instability in Claude Code Bash calls; packages/main must build before recursive tsc |
| `guard-bypass` | Something that circumvented a gate (document, don't encourage) | Declared-artifact classifier ordering that allowed source reclassification |
| `anti-pattern` | An approach that looks reasonable but causes problems | Shallow natural-language evidence commands; reviewer seizing owner-gated story mutating commands |
| `other` | Catch-all — use sparingly | Only if no other category applies; justify in the entry |

Priority order for ambiguous entries: if a lesson is primarily about "what went wrong," prefer `failure-mode`; if it's primarily about "how to do it correctly," prefer `pattern` or `workflow`; if it's about a surprising tool behavior, prefer `tool-quirk`.

---

## Scope Rules

| scope | when to use | rationale |
|-------|-------------|-----------|
| `project` | Koala-specific operational lessons — owner lease, INIT_CHECK, delivery-check, flow-fact policy, reviewer lane protocol | These lessons are only meaningful in the Koala development context; they reference Koala CLI commands, Koala story lifecycle, and Koala-internal gate semantics |
| `global` | Genuinely cross-project agent-collaboration lessons — lessons that apply when any agent team uses any Koala-like structured workflow tool | Examples: session ID stability across fresh shells, fail-closed vs fail-open tool checks |
| `story-candidate` | Ephemeral session-local captures not yet promoted | Not used in B-1148 backfill (we are writing directly to project/global from canonical sources) |

**Default: `project`** — when in doubt, use project scope. A lesson is only global if it applies equally to a team using a completely different workflow tool.

**Overlap rule**: when a topic applies to both Koala-specific and cross-project contexts, write one primary entry. Prefer `project` scope with a note in the lesson about cross-project applicability rather than duplicating as a global entry. Exception: if the cross-project lesson is phrased at a higher abstraction level and fully independent of Koala internals, a separate global entry is justified (but must not duplicate the project entry's text).

---

## Content Limits

Each entry stores:

| field | requirement |
|-------|-------------|
| `summary` | ≥10 chars, ≤120 chars — one-line headline of the lesson |
| `trigger` | ≥5 chars — when does this lesson fire (what symptom or situation) |
| `lesson` | ≥10 chars — what to do differently |
| `reusePrompt` | ≥5 chars — a concrete search/recall prompt for future sessions |
| `tags` | 2–6 tags, kebab-case |
| `sourceStoryId` | Required for all B-1148 backfill entries with a story source |
| `evidenceRefs` | Required: at least one path to story artifact (summary.json, delivery-check.json, or decisions doc) |
| `gateEvidence` | Always `false` |
| `authority` | Always `"non_authoritative"` |

**Prohibited content:**
- Full lifecycle histories or phase-by-phase transcripts
- Long code diffs or full file contents
- Verbatim test output beyond a short representative excerpt
- Any text that could be misread as gate evidence ("this story passed because...", "validated by delivery-check...")
- Claims about authority or signed artifacts

---

## Duplicate Policy

1. **Before capturing any entry**, check all existing entries in `~/.koala/dev-memory/experience.jsonl` and `.koala/dev-memory/experience.jsonl` for semantic overlap.
2. An entry is a **duplicate** if its core lesson (trigger + lesson fields) is essentially the same as an existing entry, even if phrased differently.
3. An entry is a **near-duplicate** if it covers the same story/command but adds a meaningfully different angle or failure mode. In that case, keep both but cross-reference via tags or sourceStoryId.
4. The B-ad2c entries cover: session preflight workflow, CLI lag during self-hosting, reviewer evidence classification, delivery review binding, reviewer lane seizing. Do not re-capture these topics.
5. When in doubt about duplication, mark as `skip` with rationale in the manifest rather than capture.

---

## Application to B-1148 Backfill Candidates

| candidate | category | scope | note |
|-----------|----------|-------|------|
| Owner lease ppid instability | `tool-quirk` | `project` | Koala-specific; CLAUDE_CODE_SESSION_ID is Koala env |
| Owner lease fail-closed coordination | `workflow` | `project` | Koala-specific lifecycle; takeover/forceTakeover workflow |
| Main write lock reentrancy | `failure-mode` | `project` | Koala internal; reentrancy registry is Koala-specific |
| Pre-push hook build order | `tool-quirk` | `project` | Koala monorepo-specific build dependency |
| Pre-push hook fail-closed on node missing | `pattern` | `project` | Cross-applicable but framed as Koala hook design; project scope |
| INIT_CHECK fallback/repair | `workflow` | `project` | Koala-specific command; CI/no-subagent context |
| Evidence quality: shallow commands | `anti-pattern` | `project` | Koala verification gates specific |
| Flow fact policies: pass-only normalization | `tool-quirk` | `project` | Koala-specific handler behavior |
| Reviewer lane: reviewRunId required | `workflow` | `project` | Koala-specific reviewer protocol |
| riskSignal dismiss | `workflow` | `project` | Koala-specific gate cost management |
| Cross-story gate bypass | `failure-mode` | `project` | Koala-specific combination review incident |

---

*Generated by koala-implementer (B-1148 CHK-002).*
