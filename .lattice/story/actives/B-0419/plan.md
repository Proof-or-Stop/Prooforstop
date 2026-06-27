# Plan: B-0419 Tier-C provider-execution receipt verification (claude)

## CHK-001: Implement the requested Lattice change

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/providers/claude-cli.ts
- Create: none
- Test: none

**Verify**:
- `lattice validate`
- `lattice review_story --storyId=B-0419 --type=pass` (internal reviewer pass path)

**DoneWhen**:
- `packages/main/src/providers/claude-cli.ts` includes one explicit one-line comment in the delegated `provider.claude` bounded execution path.
- No behavior is changed; only the comment text is added.

## CHK-002: Verify evidence and DONE boundaries

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/providers/claude-cli.ts
- Create: none
- Test: none

**Verify**:
- `lattice validate`
- `lattice review_story --storyId=B-0419 --type=pass`

**DoneWhen**:
- The story review path confirms no local Authority claims or DONE overclaim are introduced by this documentation-boundary change.
- Validation evidence remains consistent with current phase material hash.

## CHK-003: Implement Tier-C provider-execution receipt verification (claude) run 92812...

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/providers/claude-cli.ts
- Create: none
- Test: none

**Verify**:
- `lattice validate`
- `lattice story_review --storyId=B-0419`

**DoneWhen**:
- The delegated `provider.claude` branch has the requested one-line code comment.
- Existing receipt and gate wiring behavior stays unchanged.

## CHK-004: Verify Tier-C provider-execution receipt verification (claude) run 92812...

**Owner**: main-agent
**DependsOn**: CHK-003
**Files**:
- Modify: packages/main/src/providers/claude-cli.ts
- Create: none
- Test: none

**Verify**:
- `lattice validate`
- Manual sanity check of review outputs for blocking findings.

**DoneWhen**:
- All planned verification and boundary checks for CHK-003 are completed and recorded.
- Reviewer review for this story can proceed with no PLAN blockers.
