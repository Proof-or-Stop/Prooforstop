# Role-prompt A/B replay (Story 3 + B-235e campaign)

The ordinary Story 3/B-235e replay commands in this directory are
experiment-only and read-only. They measure a frozen six-sample historical
observation corpus; they do not dispatch a model, execute historical code, call
`agent_prompt --storyId`, call `host_run`, write a review
pass/finding/ReviewRun, or participate in any lifecycle gate. The separately
documented Story 6 live campaign is the deliberate exception: it produces
audit-only prompts through `agent_prompt` and invokes pinned Codex CLI / Claude
CLI provider cells, while remaining ineligible for lifecycle-gate evidence.

## Commands

```bash
node experiments/role-prompt-ab-replay/selfcheck.mjs
node experiments/role-prompt-ab-replay/run.mjs
node experiments/role-prompt-ab-replay/run.mjs --reverse
node experiments/role-prompt-ab-replay/run.mjs \
  --ledger=runtime/operator-run.jsonl --run-id=operator-run-001
node experiments/role-prompt-ab-replay/analyze.mjs \
  --ledger=runtime/operator-run.jsonl
```

## Story 6 live complex-role campaign

`story6-live.mjs` extends the frozen corpus into a real provider matrix: three
historical Story classes, two samples per class, historical legacy/modular arm
labels, three
repetitions, all five migrated complex roles, and both Codex CLI and Claude
CLI. Both arms are now produced through the production `agent_prompt` handler
in an explicitly audit-only experiment. New executions route both historical
arm labels through the one canonical full-envelope producer and persist a
Prompt Envelope plus its bound dispatch event; therefore they are A/A drift
calibration, not evidence of legacy-vs-modular savings. A receipt is inadmissible
unless it proves that producer/mode/envelope/event chain. This short command validates
the 72-cell preregistration and production producer binding without spending
provider tokens:

```bash
npm --prefix packages/main run build
node experiments/role-prompt-ab-replay/story6-live.mjs --selfcheck
```

Execution is deliberately one cell per invocation so the host can serialize
the long campaign and avoid duplicate processes. Exact model IDs are mandatory
pinned inputs. For example:

```bash
node experiments/role-prompt-ab-replay/story6-live.mjs --execute \
  --campaign-id=story6-YYYYMMDD-v1 \
  --cell=clean-pass-01.proof-or-stop-review-story-init.codex-cli.legacy.r1 \
  --codex-model=<exact-model-id> --claude-model=<exact-model-id>
```

Receipts stay under ignored `runtime/story6/`, are `gateEvidence=false`, and
report provider/cache/latency/output dimensions separately. A successful call
remains `PENDING_INDEPENDENT_ADJUDICATION`; missing provider metrics or an
independent adjudication remains `INCONCLUSIVE`, never a bytes-only success.
Receipts created before the `agent_prompt` producer/event binding are archival
only and the current analyzer rejects them. In particular, the tracked
`story6-20260720-v2` summary records the adverse, non-qualifying result that
keeps all five complex roles on `legacy-full-context`; it cannot qualify a new
campaign or activate modular defaults. Regenerate all 72 serialized cells and
obtain fresh independent adjudication before making a new migration claim.
After the serialized campaign, analyze it with:

```bash
node experiments/role-prompt-ab-replay/story6-analyze.mjs \
  --campaign-id=story6-YYYYMMDD-v1 \
  --adjudication=/absolute/path/to/independent-adjudication.json
```

The audit receipts are deliberately not reviewer evidence. The production
REVIEW evidence collector gives them zero credit unless a separately valid,
signed ReviewRun and reviewer pass/finding exist. Existing runtime guards and
their dedicated smokes provide stable rejection codes for run/evidence
signature failures, wrong lanes, Prompt Envelope mismatch/tampering, missing
scope binding, mutation/scope authority denial, missing delivery check, and
missing evaluator evidence. There is currently no standalone wrong-author
reason-code API. The Story 6 invariant smoke now invokes the real
`checkCommitAuthor` negative behavior, and the acceptance audit transcript
reports `wrongAuthorStatus=fail`, `wrongAuthorDispatchEvidence=missing`, and
`wrongAuthorSource=checkCommitAuthor`. These are consumer-derived behavioral
facts, not an invented wrong-author reason code.

Because runtime receipts and adjudication are intentionally ignored, preserve a
reviewable result with `story6-report.mjs --output=<tracked-summary.json>`. The
summary contains only bindings, content digests, coverage, numeric aggregates,
adjudication distributions, limitations, and conservative claims—never raw
prompts, provider outputs, transcripts, tool arguments, or credentials. Re-run
the same command with `--verify=<tracked-summary.json>` to bind the tracked
summary back to all 72 receipt files and the independent adjudication.

The ordinary replay is read-only. Ledger output is opt-in and is confined to
`experiments/role-prompt-ab-replay/runtime/*.jsonl`; that directory is runtime
output. Its committed `.gitignore` excludes generated rows and lock files, so
the documented run/analyze flow leaves `git status --short` clean. Operators may
delete generated rows after inspection.

`docs/requirements/decisions/proof-or-stop-identity-cutover.md` describes an
unrelated five-arm lifecycle ablation. It is design inspiration for
pre-registration discipline only; it is not this experiment's governing
protocol or acceptance source. `protocol.json`, `corpus.current.json`, and the
canonical role-prompt decision are the runnable Story 3 contract. The original
`corpus.json` is immutable historical evidence; active commands never load it
or normalize its retired wrapper identity.

`lib/replay.mjs` also contains the separately versioned, content-addressed
`B-235e-active-reviewers-v1` campaign. Its old mode comparison is historical
only now that the runtime rejects that retired dispatch mode. It does not alter
`protocol.json`, `corpus.current.json`, their digests, sample semantics, or the
Story 3 result. The
campaign pins the five active reviewer roles, three arms
(`legacy-full`, `modular-full`, `modular-incremental`), exact legacy/modular
role-body bytes and SHA-256 digests, the six frozen Story 3 sample IDs, model,
tools, three symmetric repetitions, order, thresholds, and an independent
adjudication-plan digest.

The committed corpus still lacks exact per-role historical Prompt Envelope
bytes, reviewer outputs, independent adjudication evidence, and provider
receipts. Consequently the B-235e report is deliberately `INCONCLUSIVE` for
every role. It reports exact role-body token estimates, but reports incremental
context reduction, assembled-prompt reduction, seeded recall, false positives,
command misuse, and provider/cache usage as unavailable—not zero. No role enters
the savings denominator, and neither the 50% incremental threshold nor the 40%
assembled target is claimed as met.

## Claim boundary

The authority for each replay sample is the inline `material.content` committed
inside `corpus.current.json`, bound by `materialDigest` and the corpus/experiment
digests. `material.sourceHintPath` is provenance context for a human; it is not
read, executed, or treated as proof that the hinted file's current or historical
bytes equal the inline snapshot. The validator requires
`snapshotAuthority=corpus-json-content-addressed.v1` and
`snapshotId=<sample id>` so an arbitrary path or label cannot silently become
the reconstruction authority.

The canonical corpus includes a small frozen snapshot of real signed historical
findings from Story B-dd81. The validator recomputes the v1 finding signature
over `storyId`, `findingId`, description, severity, creation time, review round,
`reviewRunId`, and `signatureVersion`, and also binds the complete snapshot into
an explicit digest.
The category, evidence state, and source references are corpus-bound metadata;
the v1 finding signature itself does not cover those fields.

The corpus still does not contain exact content-addressed legacy/modular
dispatch prompt snapshots, reviewer output artifacts, or independent
semantic-match adjudication bytes connecting either A/B arm to those findings.
Its prompt bytes/tokens/digest and replay finding recall therefore remain
`INCONCLUSIVE`; the sample-level rows are future oracle seeds marked
`oracle-only-unverified`, never detected findings.
Selfcheck separately uses explicitly labelled hermetic, inline,
content-addressed fixtures to prove that exact prompt measurement and semantic
finding comparison work when all required evidence exists. Those fixtures are
not historical or production evidence.

The current corpus also has no committed dispatch/provider receipt plus
evidence digest, so every known dispatch, provider-processed, output, and cache dimension is
`unavailable(reason)`, never zero. Both corpus and ledger validators reject an
available numeric historical metric—including zero—until a future schema binds
it mechanically to a committed evidence artifact and verified digest.
The ledger likewise rejects available `assembledPromptTokens` unless the record
schema can bind both a prompt digest and reconstruction evidence; the current
schema deliberately has no such evidence field, so canonical rows keep that
dimension unavailable. Empty or wholly unavailable ledgers summarize provider
input as `null` plus a stable unavailable reason, never as an observed zero.

The harness must not be used to claim production prompt savings, provider cost
savings, model-quality parity, gate readiness, or Story completion. A missing,
tampered, version-skewed, asymmetric, under-floor, or invalid-denominator input
is `INCONCLUSIVE` and produces no savings or recall claim. Story 4 owns
incremental eligibility; Stories 5–6 own role migration; Story 7 owns budget
rollout.

All ledger rows carry `namespace=experiment-only` and `gateEvidence=false`.
Their schema intentionally excludes Story IDs, phases, review IDs, authority
claims, raw prompts/completions/transcripts/tool arguments, and credentials.
Appending is serialized by an experiment-local exclusive lock; the ledger is
opened with `O_NOFOLLOW`, validated and appended through the same file
descriptor, fsynced, and checked against its canonical fd path.

Selfcheck proves the no-production-write boundary in a temporary isolated
evidence root. It seeds real-shaped sentinel pass, finding, ReviewRun,
verification, validation, lifecycle, and process-event artifacts; copies the
experiment modules and entrypoints into that sandbox; runs ordinary replay,
ledger replay, and analysis there; then compares every sentinel artifact byte
and the entire sandbox `.proof-or-stop` tree before and after, recursively including
all Story siblings, usage/activity/lifecycle/process-event locations, directory
membership, file bytes, and symlink targets. Mutation-bite checks then add a
sibling Story review pass and a separate usage artifact and require the same
detector to report drift. This avoids races with concurrent real Story metadata
while detecting any new or modified production artifact or process event.
Separate structural tests reject production paths, forged gate authority, Story
references, and normal process-fact/usage-ledger consumption of experiment rows.
