# B-1148 User-Visible Validation Transcript

Story: B-1148 - Backfill Koala historical process learnings into dev-memory
Date: 2026-06-01
Verifier: Codex supervisor after Claude implementation/review

## Expected outcome

When a future agent starts Koala work and asks dev-memory about prior process lessons, the project memory should return concise, reusable experience entries instead of requiring the agent to reread old chat. The output must:

- include entries related to process/fact forgery, authority, reviewer flow, fallback/repair, and owner lease lessons;
- show source story references and evidence refs;
- mark entries as non-authoritative experience, not gate evidence;
- keep preflight output bounded so session startup context is not polluted;
- exclude duplicate or unverified historical topics from formal captured entries.

## Actual transcript

### Build

Command:

```bash
npm --prefix packages/main run build
```

Result: pass. `tsc` completed with exit code 0.

### Search

Command:

```bash
KOALA_PROJECT_ROOT=/Users/jek/Documents/Work/Orchestrate/.worktrees/B-1148 \
node packages/main/dist/cli.js dev_memory_search \
  --query="流程伪造 事实伪造 authority reviewer" --limit=5
```

Result: pass. Search returned 3 entries:

- `f668c60` - reviewer run binding lesson, source `B-ad12`, refs `.koala/story/actives/B-ad12/summary.json`
- `9a9c568` - reviewer pass-only `finding_add` normalization lesson, source `B-9b8f`, refs `.koala/story/actives/B-9b8f/summary.json`
- `0b952b0` - `init_check_repair` fallback/acknowledgement lesson, source `B-95d8`, refs `.koala/story/actives/B-95d8/summary.json`

All rendered entries included `Source: <storyId> (non_authoritative)` and `Refs`.

### Preflight

Command:

```bash
KOALA_PROJECT_ROOT=/Users/jek/Documents/Work/Orchestrate/.worktrees/B-1148 \
node packages/main/dist/cli.js dev_memory_preflight \
  --query="流程伪造 事实伪造 authority reviewer" --maxEntries=5
```

Result: pass. Preflight returned 5 entries and reported `5 entries, ~23 lines`.

Observed entries included existing B-ad2c global lessons plus B-1148 project backfill entries. All entries showed non-authoritative source/ref metadata and stayed within the bounded output target.

### Regression tests

Command:

```bash
node scripts/verify-dev-memory.mjs
```

Result: pass. `61 passed, 0 failed`.

Important covered regression: `preflight output is bounded (B-1148 CHK-005 edge)` now writes to `dm.resolveProjectMemoryPath(tmpPreflightDir)`, asserts `result.entries.length === 5`, and verifies an expected `B-testN` `sourceStoryId`, so an empty/trivial preflight result can no longer pass.

### Process fact contract

Command:

```bash
npm run test:process-fact-contract
```

Result: pass. Output ended with `Process fact contract verified`.

### Koala validate

Command:

```bash
koala validate --story=B-1148 --json
```

Result: pass. Koala reported:

- project validation commands passed;
- `Verification intent coverage: 15/15 covered (0 required missing)`;
- latest `test-evidence.json` result: PASS.

## Expected vs actual diff

- Expected searchable historical lessons: matched. Representative query returns reviewer/authority/fallback lessons.
- Expected non-authoritative boundary: matched. Rendered entries show `(non_authoritative)` and refs; manifest states dev-memory is not gate evidence.
- Expected bounded startup context: matched. Preflight returns 5 entries and about 23 lines.
- Expected duplicate/unverified-topic handling: matched by manifest and search behavior; needs-human-confirmation story IDs were not captured as formal entries.
- Expected verification coverage: matched. `koala validate` reports 15/15 covered with no required missing intent.

Acceptance verdict: accepted.

Limitations: dev-memory entries are intentionally experience hints only. They do not replace delivery evidence, reviewer passes, CI, or server authority receipts.
