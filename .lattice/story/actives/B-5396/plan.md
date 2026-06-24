# Plan: B-5396 Host DONE convergence runbook (docs-only)

## CHK-001: Add the Host DONE convergence / drift-handling section to CLAUDE.md

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: CLAUDE.md

**Verify**:
- `grep -n "Host DONE convergence" CLAUDE.md` → the new section header is present.
- `grep` confirms the two VERBATIM paragraphs (materialHash-only downgrade current-warn-projection; metadata-only pointer to B-9dfb) and the 4 decision-doc references.
- docs-drift preflight passes (`lattice validate --docs-drift` via REVIEW→TEST).

**DoneWhen**:
- A new "Host DONE convergence / drift handling" section exists with the 7 rules + the 2 verbatim wordings + references to proof-admissibility-hardening-execution-plan.md, story-files-hash-material-drift.md, done-prepare-automation-execution-plan.md, review-assurance-floor-execution-plan.md, and `lattice done_prepare --help`.
- No new rules invented; the section is a projection that cites the decision docs as source of truth.

## CHK-002: Mirror the parallel section into AGENTS.md

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: AGENTS.md

**Verify**:
- `grep -n "Host DONE convergence" AGENTS.md` → section present.
- The AGENTS.md section is substance-aligned with the CLAUDE.md section (same 7 rules + 2 verbatim wordings + 4 references).

**DoneWhen**:
- AGENTS.md carries the same discipline as CLAUDE.md (Host = codex), consistent in substance, mirroring the existing version-bump parallel-doc convention.
