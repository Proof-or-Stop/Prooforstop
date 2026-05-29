# Dev Memory — Lightweight Experience Capture

## Status: accepted (B-ad2c)

## Purpose

Dev-memory provides a lightweight, file-backed mechanism for AI agents and humans to capture reusable lessons learned during development — **outside** the formal Koala story and gate lifecycle.

**Dev-memory is non-authoritative context, not Koala gate evidence.**

This is not negotiable: no dev-memory entry, candidate file, or preflight pack can satisfy:
- `delivery_check_set` docsPromises
- `verification_evidence_add` gate receipts
- `review_pass_set` review artifacts
- Any other signed gate artifact

Dev-memory is advisory context only. Its purpose is to help agents recall relevant patterns, anti-patterns, and lessons when starting new work.

---

## Storage Locations

| Scope | Path | Lifetime |
|-------|------|---------|
| **project** | `<projectRoot>/.koala/dev-memory/experience.jsonl` | project lifetime |
| **global** | `~/.koala/dev-memory/experience.jsonl` | machine lifetime |
| **story-candidate** | `<storyDir>/<storyId>/dev-memory-candidates.jsonl` | story lifetime |

- Paths resolve deterministically without Koala daemon running.
- JSONL format: one JSON object per line, schema-versioned via required fields.
- Story candidates are written by `koala dev_memory_finish`. They are **not** automatically promoted to project/global memory — this is a deliberate review step.

---

## Experience Entry Schema

Required fields (validation enforced at write and read time):

| Field | Type | Constraint |
|-------|------|-----------|
| `id` | string | sha7 of content+timestamp; unique per file |
| `createdAt` | string | ISO-8601 |
| `sourceAgent` | string | who captured this |
| `category` | enum | see categories below |
| `scope` | enum | `project` \| `global` \| `story-candidate` |
| `summary` | string | ≥10 chars |
| `trigger` | string | ≥5 chars |
| `lesson` | string | ≥10 chars |
| `reusePrompt` | string | ≥5 chars |
| `gateEvidence` | boolean | **always `false`** |
| `authority` | string | **always `"non_authoritative"`** |

Optional fields: `tags`, `sourceStoryId`, `evidenceRefs`.

### Categories

- `failure-mode` — something that went wrong and how to avoid it
- `pattern` — a reusable approach that worked well
- `anti-pattern` — an approach that looks reasonable but causes problems
- `workflow` — a process or sequence that worked well
- `tool-quirk` — unexpected behavior of a tool (koala CLI, tsc, etc.)
- `guard-bypass` — something that circumvented a gate (note it, don't encourage it)
- `debugging` — a debugging technique that saved time
- `communication` — a communication pattern that worked (or didn't)
- `other` — catch-all

---

## Commands

| Command | Purpose |
|---------|---------|
| `koala dev_memory_capture` | Save a new experience entry |
| `koala dev_memory_search` | Search entries by query, category, agent, or tags |
| `koala dev_memory_list` | List entries (newest first), with `--scope` filter |
| `koala dev_memory_preflight` | Emit a bounded preflight context pack (≤60 lines) |
| `koala dev_memory_finish` | Write story-scoped experience candidates |
| `koala dev_memory_start` | Wrapper: run preflight then emit agent startup guidance |

### `dev_memory_start` — prompt-only by default

`koala dev_memory_start --agent=claude|codex|gemini` runs preflight and emits startup guidance text. **It does not launch any binary** unless an explicit non-dry-run integration is added in a future story. Always safe to run.

---

## Design Decisions

### Why JSONL instead of SQLite or a structured DB?

- Deterministic: readable by `cat`, `grep`, `jq` without any runtime.
- Versionable: JSONL diffs are meaningful in `git diff`.
- Schema-evolvable: unknown fields are ignored; missing required fields cause that entry to be skipped, not a crash.
- No daemon required: path resolution and reads work without Koala running.

### Why are story candidates separate from project memory?

Story candidates are ephemeral "draft" lessons. Promoting them to project/global memory is a deliberate human review step. This prevents noise from accumulating in project memory during active development.

### Why `gateEvidence: false` and `authority: "non_authoritative"` in every entry?

These fields are a reminder baked into every entry. A consumer that tries to interpret a dev-memory entry as gate evidence will see these fields and know it is not valid. The fields also make it machine-checkable: any future gate validator can reject entries with `gateEvidence: false` or `authority: "non_authoritative"`.

---

## Non-Goals

- Dev-memory does NOT replace story-level `verificationEvidence`.
- Dev-memory does NOT replace `docs/requirements/decisions/` for architectural decisions.
- Dev-memory does NOT generate signed artifacts of any kind.
- Dev-memory entries are NOT surfaced in `koala validate` output or gate checks.
- Dev-memory is NOT a replacement for proper test coverage or REVIEW reviewer findings.
