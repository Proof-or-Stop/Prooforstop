# Plan: B-da14 Document merge-time combination-review rule for parallel framework stories

## CHK-001: Document the merge-time combination-review rule

**Owner**: main-agent (doc-only change; no business code — main agent writes per CLAUDE.md fast-lane doc convention)
**DependsOn**: none
**Files**:
- Modify: docs/requirements/decisions/story-lifecycle.md (canonical, detailed section)
- Modify: CLAUDE.md (short summary + see-also pointer)

**Verify**:
- `grep -n "合并态组合审查" docs/requirements/decisions/story-lifecycle.md` → returns the new section
- `grep -n "合并态组合审查" CLAUDE.md` → returns the short summary
- The story-lifecycle.md section contains the enumerated 5-item inspection checklist + B-8db9 citation + out-of-scope sentence
- The CLAUDE.md copy contains a see-also pointer to story-lifecycle.md

**DoneWhen**:
- story-lifecycle.md has a new section 「合并态组合审查（流程框架并行 story）」 with: trigger scope (classifier / gate policy / command entry guards / auto-commit / DONE merge semantics); enumerated inspection checklist (classification priority order, gate policy table, command entry rejection, auto-commit/dirty state, DONE merge semantics); B-8db9 originating incident citation; explicit "ordinary business stories out of scope" sentence
- CLAUDE.md has a short summary near the 对抗审查 / REVIEW area with a see-also pointer naming story-lifecycle.md as canonical
- Rule is worded as advisory discipline — not a CLI gate, not auto-enforced
- The two copies are not independent equals: CLAUDE.md is the short summary, story-lifecycle.md is canonical

## Validation

- `grep` both files for the section marker
- `koala validate --story=B-da14 --json` — verification coverage 全绿

## Rollback

Doc-only change; reverting the two edits restores prior docs with zero code impact.

## Note on channel

Story elevated to high-risk because the description contains the keyword "gate". Despite that, the change is doc-only (CLAUDE.md + one decisions file). Per CLAUDE.md fast-lane convention for documentation changes, the main agent writes the doc edits directly; no koala-implementer dispatch is needed. The high-risk channel still requires decision + ≥3 preMortem + story_review + full REVIEW/TEST/DONE, which this plan satisfies.
