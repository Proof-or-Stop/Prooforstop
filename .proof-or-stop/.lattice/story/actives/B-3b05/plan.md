# Plan: B-3b05 Actionable milestone-ledger desync hint in coverage gates + review_pass_set writer-provenance validation

Decision of record: `B-record-plus-warn-default-enforce-optin` (see decision.json — warn default because EXP-001/B-e71f proved same-session Claude subagent reviewers are mechanically indistinguishable from owner self-signs; enforce is opt-in config for hosts with per-thread session separation).

## CHK-001: Milestone coverage gap output includes an actionable milestone_ledger_set remediation hint

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/proofstory.ts (uncovered_required_milestones gap message construction ~1670-1690)
- Test: packages/main/tests/ (extend the suite covering evaluateDoneIntentEquivalence / milestone coverage gaps; follow the existing test layout for proofstory)

**Approach**:
- Where `uncovered_required_milestones` (and only there — not_applicable / shrinkage rows stay quiet) is emitted, append a remediation line containing the literal command name `milestone_ledger_set` and the affected milestone ids, with the exact command shape, e.g.:
  `→ Fix: lattice milestone_ledger_set '{"storyId":"B-xxxx","milestones":[... update status/checklistRefs/verificationIntentRefs for: M1, M2 ...]}' (see lattice milestone_ledger_set --help)`
- Desync framing: when every listed milestone's checklistRefs point at checklist items that are ALL status=done (the B-f458 case), prefix the hint with an explicit desync statement: "Ledger out of sync: checklist coverage exists but ledger row(s) <ids> remain planned."
- Message-layer only: the gap's id, severity, pass/fail decision, and gap-count semantics must be byte-identical for identical inputs. Only the human-readable message text grows.

**Verify**:
- `npm --prefix packages/main run build` green
- New/extended logic tests: desync scenario output contains `milestone_ledger_set` and the desync prefix; non-desync uncovered scenario contains the command hint but NOT the desync prefix; not_applicable/shrinkage rows produce no hint; gap ids/severities unchanged vs prior behavior for same fixtures
- Red probe flips green: `rg -q "milestone_ledger_set" packages/main/src/core/proofstory.ts` exits 0

**DoneWhen**:
- All three CHK-001 verification intents have passing logic-test evidence
- No gate semantics drift (adversarial intent proven by test asserting identical gap sets pre/post for fixture inputs)

## CHK-002: review_pass_set records writer session identity and validates it against the story owner lease session

**Owner**: lattice-implementer
**DependsOn**: CHK-001 (serialization only — same worktree/build; no logical dependency)
**Files**:
- Modify: packages/main/src/handlers/finding.ts (review_pass_set path: capture writer identity, warn/enforce validation, persist + sign)
- Modify: packages/main/src/core/review-run.ts (signReviewPass/verifyReviewPass: versioned signature domain including writerSessionId + sessionSource for NEW records; legacy records without the fields verify via the legacy domain)
- Modify: packages/main/src/core/types.ts (ReviewPass record: optional writerSessionId, sessionSource, provenanceFlag fields)
- Modify (read-only import): packages/main/src/core/owner-session.ts getSessionIdentity; packages/main/src/core/story-owner-lease.ts current lease read
- Modify if needed: packages/main/src/core/process-fact-registry.ts + scripts/verify-process-fact-contract.mjs (review-passes.json artifact signature description drift; keep `npm run test:process-fact-contract` green — CHK-002 owns any contract-script edits)
- Create (optional, if separation is cleaner): packages/main/src/core/review-pass-provenance.ts (pure fn: resolve mode, compare sessions, produce flag/error)
- Test: packages/main/tests/ (new provenance tests + legacy-fixture verification test)

**Approach**:
- On every review_pass_set: resolve `getSessionIdentity()` → persist `writerSessionId` + `sessionSource` on the pass record; include both in the NEW signature domain (versioned: presence of writerSessionId selects the new domain; absence selects legacy — no re-signing of history).
- Read the story owner lease (existing story-owner-lease read API). If lease exists AND `lease.sessionId === writerSessionId`:
  - warn mode (DEFAULT, hardcoded fallback when config absent/invalid): persist `provenanceFlag: "same_session_write"` on the record, and print a stderr warning with BOTH session ids and neutral semantics: same-session write = subagent-or-self, not mechanically distinguishable (EXP-001).
  - enforce mode (opt-in via config — follow the audit-config/lifecycle-config pattern; do NOT invent a new config file if an existing gate-mode config fits): reject with a provenance error naming both session ids; nothing persisted.
- No lease present → record identity, no flag (nothing to compare against).
- This story does NOT wire provenanceFlag into any blocking gate (canPassReviewGuard untouched). Audit-only consumption.
- Handler coding convention (CLAUDE.md): any schema constraint gets runtime re-validation at handler entry AND at every consumer; grep consumers of the new fields before finishing.

**Verify**:
- `npm --prefix packages/main run build` green; `npm run test:process-fact-contract` green
- Logic tests: (1) non-owner-session pass records identity, verifies signature, no flag; (2) owner-session pass in warn mode persists with same_session_write flag + stderr warning; (3) enforce mode rejects with both session ids in the error; (4) legacy pass fixture (no writerSessionId) still verifies; (5) default mode resolves to warn on absent/invalid config; (6) tampering persisted writerSessionId breaks the record signature; (7) explicit-env spoof records sessionSource=explicit-env
- Real-machine transcript (recorded as manual_transcript evidence): in this repo, call review_run_start + review_pass_set from the owner session and capture the visible warn flag in actual CLI output
- Red probe flips green: `rg -q "writerSessionId" packages/main/src/handlers/finding.ts` exits 0

**DoneWhen**:
- All four CHK-002 verification intents have passing evidence (logic tests + the real-machine transcript)
- Legacy-record verification proven by test with a pre-change fixture
- Default-warn asserted by test (preMortem 1 mitigation)
