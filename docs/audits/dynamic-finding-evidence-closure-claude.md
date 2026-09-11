# Claude CLI verification — Dynamic Finding safety checkpoint

Audit session: `48a9f5f0-9b81-4034-9164-f2e8cfdf8c9c`.
Audited implementation: `c81a0bba48a13abe91de22bfc4d825cda0082cbb`.
This is a read-only Lab maintenance audit, not formal Story or release authority.

# Follow-up to audit 48a9f5f0 — host isolation + closure corrections

## 1. Actual exits (this mixed-provider host: `zsh → claude → codex → ChatGPT.app`)

| Command | Exit | Literal tail |
|---|---|---|
| `node packages/main/dist/tasks/dynamic-finding-runtime-integration-smoke.js` | **0** | `DYNAMIC_FINDING_RUNTIME_INTEGRATION PASS 17` |
| `node packages/main/tests/red/red-dynamic-finding-evidence-closure.mjs` | **0** | `DFEC_SUMMARY {"total":9,"passed":9,"failed":0,...}` / `DYNAMIC_FINDING_EVIDENCE_CLOSURE PASS` |

Both were exit 1 in my prior session. I ran these two binaries, not the wrapping `npm run test:dynamic-finding-evidence-closure` script (its other two members passed last session and are unchanged by this diff).

## 2. Host-isolation correction — disposition: resolved, mechanism accurately scoped

`isolated-finding-fixture.ts` double-spawns (launcher → `detached` worker, launcher `process.disconnect()`s and exits) and the worker busy-waits on `process.ppid === launcher` until re-parented. Effect on the production observer: `observeNativeHostProcess` walks from `process.ppid`, its loop guard is `pid > 1`, so a worker re-parented to pid 1 yields **no observation at all** (`null`). The refusals at `native-review-evidence.ts:194` (mixed ancestry) and `:200` (host mismatch) are therefore *avoided by having no provider lineage*, not spoofed or relaxed — and bindings issued inside the worker carry no `processLineageDigest`. `git diff --stat c67db15efc..HEAD` confirms no production observer, broker, host-policy or hook file is touched (projection, process-fact-registry, 2 handlers, 3 tasks, 1 script, 1 doc). Honest consequence: these fixtures no longer exercise the real provider-host branches in any host.

**Actual broker/CLI execution still occurs:** the smoke still configures `nativeReviewInvocation.brokers = nativeReviewFixtureBrokers()` (`:37`) and still awaits `runBrokeredNativeReviewCli` (`:131`), which spawns the real CLI with the one-shot attestation over fd 3; case count rose 15 → 17.

**Cleanup/exit semantics — sound, with two bounded caveats:**
- Exit code propagates via the `outcome.json` written-then-renamed by the worker; nonzero ⇒ helper throws ⇒ top-level-await rejection ⇒ nonzero host exit. Entry is allowlisted to exactly the two smokes; `MARKER` in `argv` prevents recursion.
- Caveats: stdout is **buffered** and only flushed after the outcome appears or the 120 s deadline (a hung suite prints nothing until then); the process-group `SIGTERM` (`process.kill(-workerPid)`) fires only when the outcome file is absent, so a worker that writes the outcome and then hangs before `process.exit` is not killed. Both are bounded and fail toward an error, not a false pass. `rmSync(scratch)` unlinks a log the worker may still hold — harmless on POSIX.
- Cosmetic only: `evidence-state-gate-smoke.ts:39` places the call among imports; ESM hoisting means lines 40-43 are evaluated first regardless.

## 3. Closure risk — disposition: resolved against the actual test, not object shape

My prior residual (retained `storyFilesHash` would reopen closure after a metadata commit) does **not** materialize on the real path. The test now writes a *tracked* `.proof-or-stop/story/actives/<storyId>/metadata-only-test.md`, `git add --force`s it and commits it on a real `story/<storyId>` branch (no `--allow-empty`), and `finding_triage` still reports `complete_repair_closure`. Scope that precisely: proven for Story-metadata paths under `.proof-or-stop/story/actives/<id>/`, not for arbitrary "metadata".

The same test then proves closure is not a latch:
- mutating the compiled artifact `build/defect.mjs` ⇒ reason ≠ `complete_repair_closure`; restoring it ⇒ closure returns;
- `setRuntimeEvidenceKeyStatusForTest(root, 'revoked')` ⇒ closure reopens despite the identical metadata HEAD.

Reader/writer basis: `finding-applicability-projection.ts:132-135` now requires an exact `redReceiptId`/`greenReceiptId` pair and re-reads both (`readHistoricalFindingRuntimeEvidence` + `readMaterialBoundRepairRuntimeEvidence`) before comparing the closure binding; any throw lands in the existing `catch` ⇒ `state:'required'`. `finding-ledger.ts:2004-2010` gates the narrower reuse: clean tree (`readMaterialDirtyFiles`), `receipt.sourceMaterialHash === currentMaterialHash`, and `git merge-base --is-ancestor receipt.headHash HEAD` — only then is `receipt.headHash` substituted for the current HEAD, while trust, blobs, env allowlist, toolchain and build-policy digest still go through `verifyRuntimeEvidenceCurrent`. Writer side `finding-applicability.ts:468-473` revalidates both receipts and recomputes the binding inside the append fence (`CAS_CONFLICT: repair closure proof changed`).

## 4. Remaining newly introduced blockers

**None.** The one blocker from audit 48a9f5f0 (registered inventory suite red on a mixed-provider host) is cleared, verified by exit 0 above. Two non-blocking notes: a stored closure record lacking the `red`/`green` receipt pair now reads as `required` (fail-closed compatibility break, not a bypass), and `closureEvidenceRefs` is consumed positionally (`[0]`/`[1]`) with a missing entry failing closed at the receipt-carrier check.

## 5. Unchanged disclosures

Full public-query qualification collectors, automatic L4 deferral recall integration and complete unrelated-material re-attestation release remain **incomplete**; `enforce` remains refused (`finding-qualification.ts:154`/`:158` ⇒ never eligible; `finding-applicability-projection.ts:71-73` downgrades to `warn`). This is **not** a full-plan PASS and does not qualify the Story for DONE or release.

