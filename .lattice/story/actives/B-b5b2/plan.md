# Plan: B-b5b2 Document root documentation migration guide

## CHK-001: Inventory root-level documentation and classify target homes

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: docs/requirements/NAV.md
- Create: docs/requirements/decisions/root-document-migration-guide.md
- Test: none

**Verify**:
- `find . -maxdepth 1 -type f -name '*.md' | sort` output is represented in the guide inventory.
- `rg "README.md|AGENTS.md|CLAUDE.md|KOALA.md" docs/requirements/decisions/root-document-migration-guide.md` shows host entrypoint files are classified as stay-root or compatibility-root.

**DoneWhen**:
- The guide names the known root Markdown files.
- Each file has a target-home classification.
- Host-neutral entrypoints are kept discoverable from root unless a future compatibility story moves them.

## CHK-002: Write the migration guide and upgrade instructions

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: docs/requirements/NAV.md
- Create: docs/requirements/decisions/root-document-migration-guide.md
- Test: none

**Verify**:
- `rg "Migration Order|Reference Update Rules|Compatibility" docs/requirements/decisions/root-document-migration-guide.md` finds the operational sections.
- `rg "root-document-migration-guide" docs/requirements/NAV.md` confirms the new decision is discoverable.

**DoneWhen**:
- The guide explains destination mapping, migration order, compatibility/redirect strategy, and reference-update rules.
- The guide says future moves must merge or cross-link overlapping existing decisions instead of creating duplicate truth sources.
- The guide does not claim that any root file was already migrated by this story.

## CHK-003: Publish a visible scope-boundary audit note

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: docs/requirements/NAV.md
- Create: docs/requirements/decisions/root-document-migration-guide.md
- Test: none

**Verify**:
- `rg "Scope Boundary Audit|no bulk move|Production Safety|global capability" docs/requirements/decisions/root-document-migration-guide.md` finds the audit note and boundary claims.
- Two Claude CLI read-only audits and one Codex host audit review the final diff for host-neutral placement and no overclaim.

**DoneWhen**:
- The guide includes a visible audit note naming known root documents and stay-root files.
- The audit note states no bulk move was performed in B-b5b2.
- The audit note states this guide does not unlock Production Safety, authority/unattended readiness, or global capability claims.
