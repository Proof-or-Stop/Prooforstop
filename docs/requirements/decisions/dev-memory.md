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
| `koala dev_memory_finish` | Finish a session: report/promote project entries, or write story candidates |
| `koala dev_memory_start` | Wrapper: run preflight then emit agent startup guidance |

### `dev_memory_finish` — `--storyId` is optional

`koala dev_memory_finish` works in three modes:

**Outside Koala (no active story, no `--scope=global`)** — for ordinary non-Koala sessions. Does NOT require or create `.koala/story/actives`. Reads recent project dev-memory entries (filtered by `--query` when provided). Returns a summary of retained entries, or a clear empty-state message when none exist. Does NOT touch story directories.

**Story-candidate write (active story branch, no `--scope=global`)** — defaults to the current `story/<id>` branch and writes session experience candidates to `<root>/.koala/story/actives/<storyId>/dev-memory-candidates.jsonl`, with `scope: story-candidate`, `sourceStoryId`, `gateEvidence: false`, `authority: non_authoritative`, de-duped by id. Use `--storyId=<id>` to override the target story explicitly; this is a target override within this same path, not a separate mode.

**Global promotion (`--scope=global`)** — copies relevant project entries into global dev-memory, de-duped by id, as `scope: global`, non-authoritative. Does not create or append story candidates, even when run from an active story branch. Useful for promoting cross-project lessons.

### `dev_memory_start` — prompt-only memory wrapper (not lifecycle worktree initialization)

`koala dev_memory_start` is a **prompt-only memory wrapper**, intentionally separate from Koala's story lifecycle and worktree initialization. It is not a replacement for story phase transitions — the Koala story lifecycle remains unchanged. `dev_memory_start` runs preflight and emits startup guidance text only; **it does not launch any binary** and does not start or advance any story phase. Always safe to run.

`koala dev_memory_start --agent=claude|codex|gemini` adds per-agent startup guidance to the output.

### Lattice Parallel Dispatch Consumers

`parallel_dispatch` and `parallel_report` may surface dev-memory entries as
bounded `experienceRefs` when the caller passes `includeExperience=true`. This
is a projection-only read path:

- It reads existing project and global JSONL files with the dev-memory reader.
- Missing memory files return an empty list.
- Results are searched with the existing dev-memory search routine and capped by
  `maxExperienceRefs`.
- Emitted refs contain only `id`, `category`, `summary`, `source`, `scope`,
  `gateEvidence:false`, and `authority:"non_authoritative"`.
- These refs are not evidence refs and cannot satisfy review, test, delivery,
  receipt, DONE, or production authority gates.

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
