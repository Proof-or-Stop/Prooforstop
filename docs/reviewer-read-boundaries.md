# Independent reviewer reads and owner publication

Independent readers can inspect a Story while another session owns its lease.
They must use observational commands; producing dispatch records or signed gate
evidence remains a separate operation.

| Intent | Reader command | Protected writer |
|---|---|---|
| Read a canonical role prompt with current Story/checklist context | `proof-or-stop agent_prompt --role=ROLE --storyId=B-xxxx --readOnly` | Omit `--readOnly` only when the owner intentionally prepares and records dispatch context |
| Inspect current review inventory and drift | `proof-or-stop review_inventory_status --storyId=B-xxxx` | `--refresh` persists detected invalidation under the owner and inventory lock |
| Inspect managed asset drift | `proof-or-stop check --json` | `--apply` / `--upgrade` modify managed assets and remain unavailable in advisory read-only reviewer mode |

`agent_prompt --readOnly --format=json` returns `readOnly: true`,
`canMintReviewEvidence: false`, and `envelope: null`. Its v1 JSON also preserves
`roleBodyDigest` and `knownExecutionEnvironment` for diagnostic consumers. Its current Task Context
passes the same schema and reviewer authority-content checks. It acquires no
Story owner lease and publishes no dispatch event, Prompt Envelope or ReviewRun.
For migrated REVIEW lanes, the canonical bootstrap still requires
`review_run_start`; fetching a prompt does not replace independent review or its
required signed evidence. The INIT and product reviewer must still record their
results through their normal reviewer commands.

`dispatch` is an owner publication operation. Its non-owner refusal supplies an
executable `agent_prompt --readOnly` recovery command for registered Story-only
roles. This advice is not issued for checklist/finding/cluster targets or
purpose-bound inventory dispatches: removing those bindings would change the
review task. Those readers consume the owner's prepared dispatch. No recovery
path automatically takes over a lease.

Inventory status verifies the existing epoch and recomputes current material,
acceptance scope, reviewer roster and candidate-routing drift. A default read
may display INVALIDATED while the persisted epoch is still OPEN. This is an
unsigned observation, not a new signed fact. Explicit refresh signs and stores
the invalidation. Existing producer and gate paths continue checking live
lineage under their mutation lock and refuse stale inventory even when nobody
has refreshed its status. Corrupt signed input is never converted into a pass.

The read-only boundary concerns Story state, leases, managed assets and gate
evidence. CLI runtime diagnostics may still record activity/cache information
under the existing runtime policy. It is not a promise of zero filesystem IO.

## Regression proof

Run `npm run test:reviewer-read-boundaries`. The same executable also runs from
the process-fact contract check. It creates an isolated temporary repository,
uses production StoryStore/handlers to seed test state, and invokes this Lab's
actual CLI in distinct owner/reviewer sessions. It tests the two historical INIT
roles, inventory drift, actionable dispatch refusal and default managed checks,
alongside protected write attempts and unchanged Story bytes. It never mutates
real Story state or leases.

The historical investigation found 28 Story-aware prompt owner refusals across
8 Stories, 115 inventory-status refusals across 7 Stories, and 17 dispatch
refusals across 4 Stories in the retained 2026-08-30 through 2026-09-11 logs.
The default managed-check reviewer refusal was a separate isolated reproduction.
These are invocation counts, not defect counts or measured delay. The regression
replays the failure classes with current production code, not the old Story
state, and does not establish end-to-end Story speedup.

## Maintenance previews and diagnostic guidance

The following preview calls use the same strict mode resolver in raw CLI admission
and typed handlers. They never acquire an owner lease or publish business evidence.
Runtime activity logging remains permitted. Snapshot reports are observations and
must not be used as newly issued gate evidence.

| Reader operation | Execute mode and authority |
|---|---|
| `story_reconcile --dryRun` or default | `--dryRun=false` repairs under the shared main write lock |
| `quorum_prune --dryRun` or default | `--apply` or `--dryRun=false` requires the Story owner and the existing transactional protections |
| `capability_release_backfill --dryRun` or default | Explicit `--apply` still requires the current plan digest; `--dryRun=false` alone retains the existing preview behavior |
| `verification_evidence_refresh_stale --storyId=B-xxxx --dryRun` | Omitting dryRun (or false) remains an owner write and may execute pinned verification commands |
| `guard_session_status --storyId=B-xxxx` | `guard_session_check` rechecks the diff and writes recorded state |
| `init_preflight --storyId=B-xxxx` | `scope_freeze_check` generates frozen scope evidence; preflight only inspects prerequisites |
| `codex doctor` | `codex verify` executes heartbeats and records verification evidence |
| `acceptance_rollout_report_read --storyId=B-xxxx --json` | `acceptance_rollout_report` produces a new signed report, including when json is requested |

Conflicting apply/preview combinations and invalid boolean values fail before
handler IO. Quorum recovery also rejects apply:false combined with dryRun:false.
The three historical protected writers retain their authority; their refusal
messages now identify a directly usable observation command with its limits.

`npm run test:maintenance-preview-boundaries` runs isolated actual CLI calls with
independent owner/reviewer identities, populated stale diagnostic input, unchanged
Story/lease bytes, protected execute attempts, and parameter boundary checks.
This proves maintenance read behavior, not whole-Story delivery speed.

## Consistent command effects and worktree observations

`reviewer_list --storyId=B-xxxx` is a read. Adding `--forceReviewer=behavior`
changes the roster and is an owner write, including its configured pre/post hooks,
activity and generic Story command event. All three runtime surfaces consume the
same argument-aware ownership result as admission. Historical name-only reader
helpers remain compatibility APIs; they do not override runtime admission.
Explicit read telemetry opt-in cannot enable hooks or Story events. The legacy
dryRun writer activity suppression is retained; it does not bypass writer
admission, hooks or Story-event rules. Existing
handler-owned immutable transactions retain their generic-event exclusions.

Runtime closure resolves each Story workspace once and uses that same source for
phase, readiness and owner lease. It does not renew a lease or acquire a lock.
Validation self-reentry requires the live async context's acquisition token to
match the current holder generation. Matching the Story ID or operating-system
PID alone is insufficient. Unknown lock state grants neither ownership nor availability: it appears as a
blocking issue in runtime closure. The transition orchestrator passes the observed
lock to enforce-mode phase-advance / DONE preflight. This source binding
only proves phase-advance and DONE preflight wiring; evaluator policy for validation
writes and guarded main-mirror reads does not prove those callers are integrated.
The new unknown-lock tests exercise the observer and evaluator separately, not a
full lifecycle command. Status observation itself still runs. A nascent directory without holder metadata is
indistinguishable from an interrupted acquisition, so neither its age nor a
caller-supplied Story ID grants a write exemption. Retry after acquisition settles
and inspect `proof-or-stop doctor` plus `runtime_closure_status`. An orphan may be
removed manually only after all processes sharing the repository have been stopped
and absence of an owner has been independently confirmed; preserve a backup and
remove only that lock directory. Missing/corrupt metadata alone is insufficient,
and no automatic cleanup is authorized by this diagnostic.

Queue staleness accepts valid, non-future Story creation/start/event timestamps
from the authoritative worktree. When those are old, it also checks the latest
non-merge commit exclusive to the Story branch relative to the repository's
resolved integration baseline. An inherited main commit, merge-only sync,
directory timestamp or owner heartbeat does not invent Story activity. Missing authoritative state or incomplete progress observation is
`unknown-worktree`, never an assertion of staleness. This diagnostic never
authorizes deletion or cleanup. Optional Git observations run only when recorded
activity is insufficient, with defaults of four worktree probes and a
1000 ms monotonic subprocess budget per projection. For a broader explicit
diagnostic, queue_governance_status accepts --gitProbeLimit (up to 1000) and
--gitProbeBudgetMs (up to 60000). Baseline resolution and the
commit query share that deadline; each worktree result is cached within the
projection. Zero disables probes. Integration candidate refs and their observed commits are
cached once per shared Git directory and ordinary/linked checkout mode within
this projection. Each worktree still checks its own HEAD ancestry; its log uses
the observed commit, so unrelated histories cannot borrow another tree's result.
The cache is discarded after the projection, including across later ref changes. Budget exhaustion,
Git failure and unavailable authoritative metadata remain unknown. These caps
bound the additional progress probes, not the entire pre-existing projection or
filesystem setup. No historical Story/log tree is scanned for commit activity.

The deprecated `currentValidationStoryId` option remains accepted for compatibility
but emits a warning once per process. It is ignored for authorization: detached
or foreign callers cannot impersonate a lock owner with a matching Story ID.
Runtime readiness receives the metadata root directly from the selected StoryStore.

Maintenance mode delegates have their own command-bound executable identity
boundary. The CLI verifies their pinned bytes before invoking argument classification,
including for previews, and checks the consumer boundary before write effects.
Malformed or contradictory mode arguments retain authoritative-runtime admission
but return their precise refusal without advertising a bootstrap rebuild.

`node scripts/verify-command-observation-boundaries.mjs` exercises real CLI
writes and reads, a linked worktree with a divergent main mirror, reversed
Story/directory ages, and a separate process holding the validation lock. These
checks prove the bounded observation defects, not global participant migration,
all convergence rules or end-to-end Story speedup. The existing phase-separated
REVIEW/TEST convergence rule is preserved.

Identity-free executable paths require a reviewed pin at registry construction.
Removing a pin fails closed. Missing registered executable bytes get a boundary
refusal when inspected through the consumer API; a missing ESM import may fail
at module loading before that API is reached. Strict typed handlers reject string
booleans even though raw CLI admission accepts the parser's string representation.
Ordinary observation classifier failures omit the best-effort event and preserve
the original command error. Successful validate and TEST-advance canonical
terminals instead throw CanonicalTerminalCloseoutError if classification fails.
Already-failed canonical commands retain the primary error and additionally
report the closeout fault to health, matching the existing persistence policy. `verify-cli-audit-hardening.mjs` includes explicit fault
injection for this defensive path, not a claim of normal argument reachability.
