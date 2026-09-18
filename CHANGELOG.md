# Changelog

## Lab host-activity-log-during-validation - v0.3.419 - 2026-09-18

# Lab host-activity-log-during-validation

## Problem
The Claude Code PostToolUse hook `.claude/hooks/log-tools.cjs` (copied into projects by
`proof-or-stop init`) appended every tool call into the repository even while that worktree was
validating. Fixtures that guard the worktree against mutation observed the host's own bookkeeping.

## Behavior change
When the product's own signal says this worktree is validating (a workspace validation capacity
ticket at `<shared root>/.proof-or-stop/locks/validation-capacity.lock/workspaces/<sha256(worktree)>/`
whose holder pid is alive), the hook appends the entry to a per-worktree spool outside the repository
(`~/.proof-or-stop/activity-spool/<sha256(worktree)>.jsonl`, mode 0600). The next hook call without an
active validation delivers spooled lines to their original targets in order and removes the spool.
Without an active validation the hook writes into the repository immediately, as before.

## Verification
RED/GREEN: `node scripts/verify-host-activity-log-during-validation.mjs` runs the real hook script
against disposable repositories and a disposable HOME.
- Before: 2 repository lines written while the worktree validated.
- After: 0 while validating; after the ticket is released the next call delivers
  `during-validation-1, during-validation-2, after-validation` in order. Controls (no ticket, dead
  holder, ticket for another worktree) still write immediately.
Process-fact contract PASS. verify-entrypoints.mjs and test:proof-or-stop-residue fail identically
on a baseline Lab without this change (pre-existing).

## Self-review hardening: ordering under concurrent hooks
Two hooks flushing at once could interleave, and a new line written directly could overtake older deferred ones. Now a single flusher holds a lock directory (owner pid; a dead owner's lock or an ownerless lock older than 10s is broken), drains until no spool remains and re-checks after release. While a spool or lock exists, new lines queue behind it. New scenarios: 20 deferred lines then 8 hooks started together, a flush lock held by a live pid, and a lock left by a dead pid. RED on the previous hook (3/3 runs): lines interleaved and a new line overtook the pending flush; GREEN: 11 checks, all lines ordered, none lost.

## Independent audit repair
Audit 79a9927e (different vendor) rejected the candidate with four concurrency and recovery findings, all repaired by replacing the single spool file with one atomically published file per record:
1. (high) Validation was checked only before entering the flush, so a validation starting mid-flush kept receiving repository writes. The flusher now re-checks before every record and stops, leaving the rest spooled.
2. (high) Producers appended to the shared spool without holding the flush lock, so a producer could write into an inode the flusher had already rotated away and lose the record. Each record is now written under a private name and renamed into place; producers never share a file.
3. (medium) Stale-lock removal was not exclusive, so a second observer acting on a stale reading could delete a live replacement lock. A stale lock is now reclaimed by renaming it away, which is atomic: only one reclaimer can win, and release removes only a lock this process owns.
4. (medium) A claimed batch had no recovery path and failures deleted it. A record is now removed only after its line reached the target; a claim left by a dead flusher is renamed back into the queue, and a failed target write returns the record to its place and stops so a later hook retries it in order. Delivery is at-least-once, stated in the code: a crash between the append and the removal can repeat one line.
New regressions (barrier-controlled, using a documented test seam): a validation starting mid-flush, three producers publishing while another hook drains, two hooks reclaiming the same stale lock, a record claimed by a dead flusher, and a target that is unwritable and then writable again. RED on the rejected version: 6 failing expectations; GREEN: 21 checks, stable across repeats.

## Second independent audit repair
Audit 2e7b1980 rejected the second candidate with two findings, both repaired by removing the two mechanisms they attacked:
1. (high) A validation could start between the hook's check and its append, so a single repository write could still fail a run. The check/write pair is now inside the product's OWN exclusion: every repository write happens while this hook holds an admitted workspace validation capacity ticket, published by the same atomic rename protocol the validations use. A validation starting meanwhile queues behind that millisecond-long write; one that already holds capacity keeps the hook out entirely, and the line stays queued. The ticket carries the hook's pid, so it is classified stale the moment the hook exits or dies.
2. (medium) Reclaiming a stale lock by renaming it was not a compare-and-swap: two hooks could both act on one dead-owner observation and the second could steal a live replacement. There is no lock any more. Ordering comes from the queue itself: only the OLDEST record is ever claimed (an atomic rename), and a hook stands down while another hook's claim is live, so no lock exists to leak, reclaim or steal.
New and strengthened regressions: a validation arriving while the flusher is paused must add ZERO further lines (not merely fewer); a validation arriving inside an immediate write window leaves that line queued; barrier readiness is asserted rather than assumed; another hook's live claim must not be overtaken; two hooks delivering concurrently keep the deferred order. RED on the rejected version: 4 failing expectations; GREEN: 25 checks, stable across repeats.

## Third independent audit repair
Audit b1aa08c9 rejected the third candidate with three findings, all repaired:
1. (high) Ticket allocation was invisible until publication: a hook could read the ticket numbers, pause, and publish a number a validation had meanwhile taken, then consider itself oldest and write during that validation. The hook now follows the product allocator's complete protocol - it publishes a `.choosing` marker BEFORE reading the numbers and keeps it until the ticket is published - so a validation arriving in that window is always seen.
2. (medium) Checking for live claims and selecting the oldest record were separate operations, so a hook could list only the remaining records and deliver a newer one first. Selection now happens on one coherent view that includes in-flight claims, ordered by record name, so an in-flight record can never be skipped.
3. (medium) Any `.choosing` entry blocked admission, including one left by a crashed process, which could stall host bookkeeping indefinitely. A choosing marker now blocks only while its owner is alive, matching the product's stale classification.
New regressions: a validation publishing its ticket while the hook is inside the choosing window (hook keeps out, line delivered afterwards), an older record in flight while newer ones are queued (nothing passes it, order resumes afterwards), and a dead choosing marker (delivery resumes) with a live one still blocking. RED on the rejected version: 3 failing expectations; GREEN: 32 checks.

## Fourth independent audit repair
Audit eff664c8 rejected the fourth candidate with one high finding: admission read the queue once and then inspected holders, so a competing validator could rename its choosing marker into a lexically earlier ticket in between. The vanished marker read as "not alive", the new ticket was absent from the captured listing, and the hook admitted itself while that validator could already be admitted. Repaired: a queue entry is now classified alive, dead or UNCERTAIN, and only a readable record with a dead pid counts as dead. Anything that vanished or cannot be read while admission is being decided means the queue moved, so the hook retreats and keeps its record queued. New regression: a competing marker that starts with a dead owner (so the hook proceeds) becomes a live, lexically earlier ticket while the hook is paused between listing the queue and inspecting it; the hook must write nothing, retain its record, and deliver it in order once that ticket is gone. RED on the rejected version: 3 failing expectations, including the line written during the handoff; GREEN: 36 checks.

## Fifth independent audit repair
Audit 7eaf66f0 rejected the fifth candidate with two findings, both repaired:
1. (high) Worktree discovery failed open: any Git timeout, execution failure or realpath error returned "no repository", which selected a direct repository append with no validation check and no ticket, restoring exactly the mutation this Lab prevents. Discovery now returns the worktree top, 'non-repository' only when Git positively says so, or 'uncertain'. An uncertain answer keeps the record out of the repository, in a discovery-pending queue keyed by that path; the next hook that can discover the worktree adopts those records into its queue and delivers them in order.
2. (medium) Every contender in the tests was a fabricated ticket directory, so nothing proved the real allocator honors the hook's ticket. The suite now drives the PRODUCT's `withWorkspaceValidationCapacity` in a competing process, in both acquisition orders and in a linked worktree: with the allocator holding capacity the hook writes nothing; with the hook's ticket published first the allocator is not admitted early and only proceeds once that ticket is gone. The hook also yields its remaining records to a waiting validator rather than queue-jumping, and the next hook call delivers them.
RED on the rejected version: the failed-discovery line lands in the repository during an active validation; GREEN: 51 checks.

## Sixth independent audit repair
Audit 31341af5 rejected the sixth candidate with two findings, both introduced by the previous repair and both fixed:
1. The discovery sentinel leaked into path helpers: a later failing lookup could key a queue by the literal string 'uncertain', stranding records that healthy hooks never inspect. The worktree discovered at the start of a hook run is now the single authority for that run - the queue, the validation check and the capacity directory all take it as an argument, and no helper ever turns a sentinel into a path.
2. `git()` discarded stderr, which is what distinguishes "not a git repository" from a failure, so ordinary non-Git directories were classified uncertain and their lines queued forever instead of being written immediately. Git stderr is now captured (never printed) and only a positive "not a git repository" answer selects the direct write.
New controls: a directory outside any repository keeps immediate logging and accumulates no pending queue; a run where discovery succeeds, then fails, then succeeds delivers all three lines in order and leaves no pending queue behind. RED on the rejected version: 3 failing expectations; GREEN: 55 checks.

## Seventh independent audit repair
Audit 8b0fcbb3 rejected the seventh candidate with two recovery findings, both repaired:
1. Every read failure was treated as a malformed record and the claimed file was deleted, so a transient EACCES, EIO or descriptor exhaustion destroyed a valid deferred entry. Reading and parsing are now separate: a record that cannot be READ returns to the queue untouched and delivery stops; only a record that reads fine and is genuinely malformed is discarded.
2. A record deferred by a failed discovery in a directory that is NOT a repository was stranded forever, because the direct-write branch never drained that pending queue. That branch now delivers the deferred records first, in their original order, and clears the queue.
New controls: a spool record made unreadable (mode 0o000) is retained and every line is delivered in order once it can be read again; outside any repository, a success/failure/success discovery sequence delivers all three lines in order and leaves no pending queue. RED on the rejected version: 4 failing expectations, including the silently discarded record; GREEN: 59 checks.

## Eighth independent audit repair
Audit 5977f7d8 rejected the eighth candidate with two findings, both repaired by collapsing the two delivery paths into one:
1. Blocked recovery did not hold newer records back: outside Git an unreadable older record stopped recovery but the current line was appended anyway, and inside Git a failed adoption was ignored and newer records flushed regardless. Adoption now reports whether it succeeded, and a blocked recovery keeps the current record in the pending queue behind the older ones.
2. The non-repository recovery path read and appended records without claiming them, so two concurrent hooks could deliver the same record twice. There is now a single delivery loop with atomic per-record claims and oldest-record ordering; outside a repository it simply skips the validation check and the capacity ticket, since nothing can be validating there.
New controls: an unreadable pending record outside a repository (a newer line must not pass it, order restored afterwards), a pending record that cannot be adopted into the worktree queue (same), and two hooks recovering four queued records concurrently (ordered, nothing duplicated). RED on the rejected version: 4 failing expectations, including a record delivered twice under plain concurrency; GREEN: 65 checks.

## Ninth independent audit repair
Audit 44a4eb6a rejected the ninth candidate with three findings, all repaired:
1. Removing an empty queue directory raced a producer that had just created it and was about to publish into it, losing that record silently. Queue directories are now never removed (an empty one is harmless), and publication retries once if the directory disappears anyway.
2. `adoptPendingRecords` read every enumeration failure as "nothing pending", so an unreadable pending queue let newer records overtake older ones. Only a confirmed ENOENT now means empty; any other failure blocks delivery, and an indeterminate answer after a failed rename blocks too. A record published while adoption is blocked goes into whichever queue is writable - record names are time-ordered, so the merged queues still deliver in order - and nothing is delivered until adoption succeeds.
3. The verifier spawned its live-holder child and ran the build before its try/finally, so a failing build left an orphaned process and sandbox. Setup now has a cleanup scope covering the child and the sandbox, on the build-failure path and on any uncaught error.
New controls: a pending queue that cannot be enumerated blocks newer records and order is restored once it can be read; a nested run with a deliberately failing build stops the verifier and leaves no sandbox behind. RED on the rejected version: 2 failing expectations, with the newer line overtaking the older one; GREEN: 69 checks.

## Tenth independent audit repair
Audit 8fd33b80 rejected the tenth candidate with two findings whose shared cause was the two-queue design (a worktree queue plus a discovery-pending queue joined by an adoption step): publication could fail with no fallback, and a record published by a failed-discovery hook could arrive after another hook had already adopted and moved on, so an older record was delivered last.
Repaired as the audit suggested, by removing adoption altogether: there is now ONE queue per working directory, used whatever discovery says. Publication, ordering and delivery all read that queue, so a record can never be overtaken by a later one; discovery now decides only whether delivery may run (not at all while uncertain, directly outside a repository, ticket-guarded inside one). A second directory exists solely as a fallback when the primary cannot be written, and delivery reads both as one queue ordered by the records' time-ordered names. A queue directory that cannot be enumerated is unknown rather than empty, so nothing is delivered while that is true.
New and rewritten controls: an unreadable queued record blocks newer ones outside a repository; an unwritable primary queue retains the record in the fallback and still delivers in order; an unenumerable queue directory blocks delivery; concurrent recovery of four queued records stays ordered and duplicates nothing. RED on the rejected version: 10 failing expectations; GREEN: 69 checks.

## Eleventh independent audit repair
Audit b3580f44 rejected the eleventh candidate with four findings; three shared one cause - the fallback queue directory - and are fixed by removing it:
1. (high) "fatal: not a git repository: /work/.git" was read as "no repository", although a diagnostic naming a path means broken metadata or a wrong inherited GIT_DIR, and the worktree may be validating. Only git's "(or any of the parent directories)" wording now proves absence, and an explicit GIT_DIR or GIT_WORK_TREE override always reads as uncertain.
2/3. Two directories could never give a coherent view: enumeration was checked once and then ignored, and a producer could publish into one directory between the two listings, so a newer record was delivered first. There is now ONE queue directory; its single listing is the view, and any enumeration failure other than a confirmed absence returns "unknown" and stops delivery. The fallback directory is gone: the queue is this user's own directory, so a lost permission is repaired in place and the record is still published.
4. The queue key hashed the raw cwd string, so '/work' and '/work/' - or a symlink alias - used different queues and could deliver out of order. The key is now the canonical directory identity, resolved independently of Git.
New controls: a path-naming git diagnostic during an active validation writes nothing and recovers afterwards; three equivalent spellings of one directory share exactly one queue and deliver in publication order; a queue directory stripped of all permissions is repaired and still delivers oldest first. RED on the rejected version: 7 failing expectations; GREEN: 72 checks.

## Twelfth independent audit repair
Audit 1dda67be rejected the twelfth candidate with two findings, both repaired:
1. (high) Inherited GIT_DIR / GIT_WORK_TREE could point at another repository, so discovery described repository B while the record was appended to the cwd's worktree A - the hook then held B's capacity ticket and wrote into A during A's validation. Every Git lookup now runs with the repository-selection variables removed (GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CEILING_DIRECTORIES), so discovery always describes the directory the record belongs to.
2. (medium) The queue identity was computed separately for publication and delivery, so a canonicalization failure could publish under the lexical identity while a later run only ever inspected the canonical one, stranding that record. The identity is now resolved ONCE per invocation and passed through; an invocation that cannot canonicalize its cwd publishes but never delivers, and a later canonical run adopts those records before delivering - an unresolved adoption blocks delivery, so nothing passes an older record.
New controls: with overrides selecting another repository and a live validation in the cwd's worktree, the hook writes into neither repository and delivers in order afterwards; a cwd reached through a symlink alias that does not exist yet publishes, waits, and is adopted and delivered first once it can be canonicalized. RED on the rejected version: both fail, including the line written during the other worktree's validation; GREEN: 78 checks.

## Thirteenth independent audit repair
Audit 518842c4 rejected the thirteenth candidate with two path-handling findings, both repaired:
1. (high) A record stored an absolute target built from the spelling used at publication. Queueing through an alias to repository A and then retargeting that alias to repository B delivered the line into B - even while B was validating - and removing the alias left an undeliverable record blocking A's queue. A record now stores the canonical workspace it belongs to plus its target RELATIVE to it; delivery re-derives the destination from that workspace, refuses anything outside the workspace the capacity ticket protects, and discards a record whose workspace no longer exists (its log cannot exist either).
2. (medium) Recovery of records published while canonicalization was unavailable only looked at the spelling the current invocation used, so resuming through the canonical path or another alias stranded them. An unresolved queue now records the spelling that produced it; a canonical run retries every unresolved queue's recorded spelling and adopts the ones that canonicalize to its own directory, whatever spelling either invocation used.
New controls: an alias retargeted between publication and delivery writes nothing into the other repository and the line reaches its own workspace; an alias removed in between does not block the queue; a record published through one alias before its directory existed is adopted and delivered first when resumed through a different alias. RED on the rejected version: the retargeted line lands in the other repository and the cross-alias record is stranded; GREEN: 83 checks.

## Fourteenth independent audit repair
Audit e2df9c12 rejected the fourteenth candidate with three recovery findings, all repaired:
1. Every failure to resolve a record's workspace was read as proof that the workspace had been removed, so one transient EACCES/EIO deleted a valid record. Only a confirmed ENOENT now means removed (its log cannot exist either); any other failure keeps the record and stops delivery.
2. An unresolved queue whose routing metadata could not be read was silently skipped, letting a newer record pass an older one. A queue holding records whose association cannot be read or resolved now blocks delivery; only a proven-unrelated or empty queue is skipped.
3. The adoption glob matched `source.json`, so recovery moved the queue's own routing metadata into the canonical queue (where it was discarded as malformed) and a concurrent producer's later record became undiscoverable. Records are now matched by their exact name shape, so the metadata stays durable and the queue remains discoverable.
New controls: a record whose workspace is temporarily unresolvable is retained and nothing passes it; unreadable routing metadata blocks newer records and order is restored once it can be read; a record published into an unresolved queue after recovery ran is still adopted and delivered. RED on the rejected version: 6 failing expectations, including the silently discarded record; GREEN: 91 checks.

## Fifteenth independent audit repair
Audit 922467b9 rejected the fifteenth candidate with three findings, all repaired:
1. (high) The queue was assumed to be outside the repository because it sits under HOME. When HOME is the validated worktree (or inside it), publication wrote into that worktree before the validation check ever ran. The queue root is now chosen from candidates judged WITHOUT creating them - the deepest existing ancestor is canonicalized so a symlinked HOME is judged by where it really points - and a per-user directory under the system temporary directory is used whenever the home location would fall inside the protected worktree.
2/3. Routing lived in a separate `source.json`, so one failed metadata write left an unroutable record, and an empty queue with unreadable metadata aborted the whole recovery scan. Each unresolved record now carries the spelling it was published through, so routing is atomic with the record itself. The scan continues past queues that cannot be associated but still blocks delivery while a queue holding records is unreadable, and a record with no routing at all is discarded rather than blocking every workspace that shares the queue root.
New controls: with HOME inside a validating worktree, a full recursive snapshot of that worktree shows no new entry at all, and the lines arrive in order once validation ends; an unreadable unresolved record blocks newer records; a record published into an unresolved queue after recovery ran is still adopted; a record with no routing never blocks the queue. RED on the rejected version: 3 failing expectations, including four files created inside the validating worktree; GREEN: 95 checks.

## Sixteenth independent audit repair
Audit 644e1dd7 rejected the sixteenth candidate with three high filesystem-boundary findings, all repaired:
1. When BOTH candidate queue locations lay inside the protected worktree, the rejected temporary-directory candidate was returned anyway and publication wrote inside the repository. A candidate that fails the containment check is now never returned; with nowhere provably outside, the hook writes the line only when nothing is validating and otherwise drops it rather than writing into a validating worktree.
2. A failed Git lookup removed the worktree boundary from queue selection, so the queue could move under a HOME inside the repository, and records left in a previously selected location were never recovered. The protected roots are now computed the same way whatever Git says - canonical cwd, discovered worktree when known, and the nearest ancestor holding a `.git` entry, found without Git - and recovery reconciles EVERY candidate queue location (both the canonical queue and unresolved queues) before anything newer is delivered.
3. Delivery checked the record's workspace but never the physical destination, so a symlinked `docs/` or `activity.jsonl` carried the line into another repository - even one that was validating - and the record was then deleted as delivered. The destination is now resolved through every existing symlink, including the log file itself, and must stay inside the worktree the capacity ticket protects; anything else defers the record.
New controls: HOME and TMPDIR both inside the validated worktree (with a symlinked HOME) create nothing inside it and logging resumes afterwards; a nested cwd whose Git lookup fails keeps the queue outside the repository and its record is recovered; a directory symlink and a log-file symlink pointing into another validating repository both write nothing there. RED on the rejected version: 4 failing expectations, including records written inside the validating worktree and a line delivered into the other repository; GREEN: 103 checks.

## Scope decision: no durable queue; lines are dropped during a validation
Audit 3850dfa1 rejected the seventeenth candidate with five more findings (three high), all genuine and all in the deferral machinery rather than in the property being delivered. Sixteen consecutive audits had followed the same shape: every round repaired real defects in the queue (concurrency, symlinks, cross-filesystem migration, crash recovery, canonicalization) and the next round found more, because a durable, crash-safe, symlink-proof queue is a much larger problem than the one this Lab exists to solve.
On the operator's decision the deferral is withdrawn. The hook keeps exactly the property that matters and drops the rest: a line is written ONLY while the hook holds the product's own workspace validation capacity ticket, so a validation can never overlap the write; when capacity cannot be held - a validation is running, one is arriving, a capacity record is unreadable, discovery is uncertain, or the destination escapes the worktree - the line is DROPPED. The activity log is advisory host bookkeeping (a session_brief freshness hint), so losing lines during a validation is acceptable; delaying or disturbing a validation is not. The hook is 271 lines with no queue, no spool, no adoption and no recovery paths.
Retained from the earlier rounds, because each was a real defect: Git lookups ignore inherited repository-selection variables, only git's "(or any of the parent directories)" wording proves a non-repository, the destination is resolved through every existing symlink (including a dangling log symlink) and must stay inside the ticket-protected worktree, and an unreadable or arriving capacity entry keeps the hook out.
RED against main's hook: 17 failing expectations, including two lines and three entries created inside the validating worktree; GREEN: 33 checks, including interoperability with the product's own `withWorkspaceValidationCapacity` in both acquisition orders and in a linked worktree.

Maintenance provenance: codex/lab-host-activity-log-during-validation, repair f894d14368484ae14934bd42a6bf70d5e24743e3.
Verification command (replayed before integration and on main): `["node","scripts/verify-host-activity-log-during-validation.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab inventory-guard-fixture - v0.3.418 - 2026-09-18

- Preserve a mechanical check of the real caller HEAD and working tree against the merge base with local main. Existing validation commands, argv, order, timeouts, budget limits, package scripts and runner sources remain protected. Bounded additive registrations and separately gated scope paths may change; new timeout overrides cannot shadow any original command or override.
- Keep the legacy verification slot bound to that real-caller check. Separate owned Git mutations test changes, removals, reordering, duplicates, collection shape, non-script package configuration and each 120/180/300-second timeout literal. Refusals must match the intended reason in working and committed states; restored baselines pass. Missing policy branches are explicitly seeded only in owned fixtures so controls cannot be vacuous.
- Register the actual-source regression in the existing native smoke. It proves legitimate additive registration and formatting-only changes pass, while caller timeout and appended-override shadowing fail before and after commit. The nested invocation uses the already built runtime and runs the mutation suite once; per-check reads are reused. Independent audit feedback has specific observed RED/GREEN coverage.
- Refresh only unchanged reviewed source bindings. Production validation policy and original smoke budgets are unchanged. This Lab is test maintenance, not formal B-e6d9 DONE; complete native smoke and Story lifecycle evidence remain separate requirements.

Maintenance provenance: codex/lab-inventory-guard-fixture, repair 8059632d3004637036c16f631ed6b7e1d08783bc.
Verification command (replayed before integration and on main): `["node","packages/main/tests/protected-inventory-fixture.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab causal-fixture-compat - v0.3.417 - 2026-09-18

- Restore causal receipt tests against current output-storage and bounded persistence-retry contracts without changing production authority.
- Use the real receipt store for oversized selector output and exhaust both index-write retries while proving one execution and immutable receipt recovery.
- Close the isolated acceptance fixture over registered snapshot inputs; retain complete-topology assertions and add a missing-source negative control.
- Lab RED reproduced all three original failures; GREEN replays the same three original cases with the additional negative assertions. This does not claim full causal-suite or Story DONE evidence.

Maintenance provenance: codex/lab-causal-fixture-compat, repair 99a20aa833cb2d9aaf2d45e35b3b6d43a4bf55cd.
Verification command (replayed before integration and on main): `["node","-e","const{execFileSync}=require('node:child_process');execFileSync(process.execPath,['scripts/ensure-dist.mjs'],{stdio:'inherit'});execFileSync(process.execPath,['--test','--test-name-pattern=oversized output probes|injected index-write failure|verifier-owned topology and pre-review','packages/main/tests/causal-evidence.test.mjs'],{stdio:'inherit'});"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab stale-hint-extraction - v0.3.416 - 2026-09-18

- Fix stale-evidence smoke extraction to retain the complete indented hint when stale-intent rows vary.
- Keep byte-exact cross-surface assertions and exercise one, three, and fifteen stale intents, surrounding output, and altered recovery commands.
- Lab RED reproduced truncation; GREEN replays the same built focused regression. Full native Story freshness replay remains a separate acceptance requirement.

Maintenance provenance: codex/lab-stale-hint-extraction, repair e7c80f9cc153fc5405a17e4f39a507a30040e824.
Verification command (replayed before integration and on main): `["node","-e","const{execFileSync}=require('node:child_process');execFileSync(process.execPath,['scripts/ensure-dist.mjs'],{stdio:'inherit'});execFileSync(process.execPath,['packages/main/dist/tasks/verification-freshness-smoke.js','--stale-hint-extraction-only'],{stdio:'inherit'});"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab review-run-id-guidance - v0.3.415 - 2026-09-18

Pending REVIEW guidance now explicitly tells the independent reviewer to bind its finding or pass to the run ID returned by review_run_start. Canonical dispatch, distinct child IDs, exact child waits, and reviewer ownership remain unchanged.

The regression executes the actual session handler against an isolated pending REVIEW Story and checks both the existing dispatch contract and the restored returned-ID placeholder. The original flow assertions are preserved. No signature gate or production review authority changes; this Lab does not complete Story B-e6d9.

Maintenance provenance: codex/lab-review-run-id-guidance, repair 8846628a6499974cdf5cf2ba537c59be702616f9.
Verification command (replayed before integration and on main): `["node","packages/main/tests/review-run-id-guidance.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab dirty-category-init - v0.3.414 - 2026-09-18

- Fix the existing circular initialization that prevents the flow validation entry from starting: dirty-worktree reaches its eager policy through evidence freshness and the validation executor before its category constant has initialized.
- Move the unchanged category tuple into an import-free data module. Preserve the original dirty-worktree export, all category types and blocking decisions, and both eager and per-evaluation exhaustive policy checks.
- Add a regression using two fresh Node import orders, exact policy/category coverage, and a deleted-category refusal control. Record target RED and GREEN against the current built implementation.
- This local Lab repairs module initialization only; it does not certify the complete flow suite or mark B-e6d9 DONE.

Maintenance provenance: codex/lab-dirty-category-init, repair aa636eafa0957bd64b9360176e25442f81a18b6b.
Verification command (replayed before integration and on main): `["node","packages/main/tests/dirty-category-module-init.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab validation-companion-compat - v0.3.413 - 2026-09-18

- Update the validation input companion to use the current complete-capture API and require one physical execution, exact diagnostic reason, unchanged original result, and no fabricated shared receipt when context is absent.
- Check the current bounded display contract: the truncation marker is included within the configured cap. Preserve oversize non-reuse, small-output reuse, signed-receipt diagnostic exclusion, and tamper refusal.
- Add one committed runner for all seven existing companion invocations with unchanged 120-second child limits and per-invocation timings. Current-main RED reproduced both stale expectations; GREEN passed all seven in 33.045 seconds including orchestration.
- This bounded Lab changes tests only. It makes no production gate changes or performance claim and does not mark B-e6d9 DONE.

Maintenance provenance: codex/lab-validation-companion-compat, repair 4f137a1cc48c8bb75f6b1ec6a86e48dd3d7969c0.
Verification command (replayed before integration and on main): `["node","packages/main/tests/validation-companion-compat.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab verification-enum-diagnostic - v0.3.412 - 2026-09-18

- Restore the received invalid verification type in CLI enum diagnostics, so an evidence kind such as `integration_test` produces an actionable error alongside the permitted verification types.
- Preserve the accepted canonical types and legacy blackbox aliases. Bound the displayed string to 64 characters and JSON-escape it; non-string inputs remain rejected.
- Add an actual CLI regression covering six evidence-kind mistakes, legal types, aliases, bounded escaped output, and refusal before Story metadata is created. The unchanged command recorded target RED in 13.134 seconds and GREEN in 15.377 seconds, including build preparation.
- This bounded repair addresses the unchanged validation-protocol assertion encountered during B-e6d9 acceptance. It does not claim Story DONE or a performance speedup; detailed execution records remain in the B-e6d9 timing ledger.

Maintenance provenance: codex/lab-verification-enum-diagnostic, repair 99cf3461fe78c7f728b4ec8a445df119359039ce.
Verification command (replayed before integration and on main): `["node","packages/main/tests/verification-intent-enum-diagnostic.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab dynamic-selection-cost - v0.3.411 - 2026-09-18

- Enable `validate.dynamic.mode=enforce-low-risk`. The production handler now executes the selected subset for eligible low-risk inputs; signed evidence admission, catalog risk floors, mandatory full-only policy and fail-closed full fallback remain unchanged. The user requested local integration after reviewing the measured limitations.
- Add a frozen, reproducible experiment: `node scripts/lab-dynamic-selection-cost.mjs`. The original identical-harness RED/GREEN pair was `8274105adeb70c71486d4718f1fc723597206b57` / `1b3cf3ad8778aefa371902deaba94dcff749f4b3`. After closing the independent audit findings, the strengthened harness was pinned again on observe-mode target RED at `8a59f46e27`; its GREEN and prepared release are separately recorded by the Lab tool under the unchanged acceptance contract. The historical A/B/B/A sample reduced actual launches from six to two (66.7%), while mean wall time increased from 3.964 to 5.528 seconds (39.5%). Finish separately replays and records the prepared candidate; no latency improvement is claimed.
- Preserve fault detection and evidence boundaries: both modes caught the same injected arithmetic defect; missing baseline, shared-risk inventory and unmapped source changes each triggered one full fallback. An unchanged signed PASS reused evidence without launching children in both modes. Missing signatures, altered encoded signatures and payload tampering with the original signature are refused, with authentic restoration accepted. Defect controls assert the actual selected subset and authority, preventing unnoticed full fallback from passing. Frozen acceptance, selector pinning, atomic remediation with one proof for two Findings, and shared receipt publication are covered by existing regression controls. Refresh only the 22 configuration dependency digests and two unchanged resource-policy excerpt digests affected by activation; the fixed command now also requires the static-edge verifier to pass. Main passed this verifier, activation initially invalidated those exact bindings, and the bounded refresh restores it without changing exception reasons or permissions. These bounded cases do not establish population error reduction or sequential-remediation speedup.
- Disclose experiment limits in `docs/lab/dynamic-selection-cost/CONTRACT.md`: synthetic workloads and fixture-only OS-home queue isolation use real selector/executor/signing/consumer paths but synthetic causal/PRE_CERT prerequisites, not a full Story lifecycle. The inspected real catalog had 240 commands, 117 non-local risk rows and 65 full-only rows, so its existing full-catalog risk floor still forces conservative full execution. Real-repository savings remain unproven. Mechanical workloads made no model-service calls; development token costs were unavailable, not zero.
- Preserve detailed evidence at `.git/lab-maintenance/dynamic-selection-cost-measurements/REPORT.md`, raw measurements in the same directory, and the signed local Lab record at `.git/lab-maintenance/dynamic-selection-cost.json`. Build, exact candidate replay, independent different-vendor audit and post-merge replay are required by finish. This local maintenance record does not claim formal Story DONE or independent product-release evidence. No remote push is requested.

Maintenance provenance: codex/lab-dynamic-selection-cost, repair 7c7dfc059f750b1e93e940449464065fbe6f096a.
Verification command (replayed before integration and on main): `["node","scripts/lab-dynamic-selection-cost.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab changelog-compact-history - v0.3.410 - 2026-09-18

- Compact legacy CHANGELOG entries, preserving newer releases and a Git link to the complete earlier history.
- Keep future entries to 3-5 final-change bullets; read only the current entry or relevant diff and link detailed records.
- Preserve frozen-history checks: accept only the exact compact baseline with byte-verified ancestor history, while allowing normal release prepends.
- Verification: compaction controls, static-edge validation and the process-fact contract passed. The unrelated identity scan retains its existing failures; see [verification details](docs/audits/changelog-compaction.md).

Maintenance provenance: codex/lab-changelog-compact-history, repair 62e3d3aaa5855e54f8a9cf254d25127cb9f1f150.
Verification command (replayed before integration and on main): `["node","scripts/verify-changelog-compaction.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab benchmark-native-hash-verifier - v0.3.409 - 2026-09-17

Restore execution of the existing independent exact-digest hash oracle when its production TypeScript import graph contains non-erasable syntax. The verifier now installs a process-local TypeScript compilation hook while preserving its existing source resolver; production source and global loaders remain unchanged. Original 27 golden digest expectations, publication/tamper checks and invalidation checks are preserved. Focused assertions also retain failed Git observation identity, observation lifetime and retry behavior for incomplete commands. The existing static child exception keeps the same caller, child and invocation while its source excerpt/digest is refreshed for the changed verifier. Target RED was the observed unsupported TypeScript syntax failure; the same command must pass GREEN and the exact candidate must pass an independent vendor audit before integration. This is local maintenance, not Story DONE or a benchmark speedup claim.

Maintenance provenance: codex/lab-benchmark-native-hash-verifier, repair 9241984ed3b5dbc58e95a8ea740459f5a7695eac.
Verification command (replayed before integration and on main): `["node","scripts/verify-hash-accuracy.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab benchmark-done-recovery-branch-snapshot - v0.3.408 - 2026-09-17

Restore partial-DONE recovery when the committed Story record exists only on its unmerged Story branch. The handler now resolves its integration target from the same committed branch snapshot used by discovery, with the existing local-store fallback. Recovery probes and merges use explicit local branch refs, and the checked-out branch is identified without tag-name ambiguity. Clean-worktree, merge-feasibility and local integration safeguards remain active.

The pinned artifact release suite covers branch-only legacy-main recovery, frozen non-main recovery, same-named tags, release ledgers, cleanup and runtime version/build behavior. The original failure was recorded as target RED before the repair. GREEN and independent vendor audit must be current before integration. An additional product-capability suite passed 25 checks, and recovery scanner behavior/process-budget controls passed 22 checks. Claude audit identified a detached-HEAD diagnostic regression; the candidate now preserves checkout guidance and adds a no-merge refusal test. The complete static-edge guard passed after retaining the existing runtime contract unchanged and limiting the repair to the handler, branch reader and focused tests. A separately attempted repository runtime-fact suite still reported STATIC_AST_PARSER_OBSERVER_SOURCE_DRIFT; this unrelated result is retained, not represented as a PASS. No formal Story DONE, benchmark speedup, complete token accounting or remote release is claimed.

Maintenance provenance: codex/lab-benchmark-done-recovery-branch-snapshot, repair fffff4c36d019f4b05062535b3bd21d88ed09285.
Verification command (replayed before integration and on main): `["node","packages/main/dist/tasks/artifact-release-ledger-smoke.js"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## v0.3.407 - 2026-09-17

- Allow a temporary parent directory that contains a sibling worktree; still reject a temporary parent inside a protected root.
- Keep the mutation guard strict: observed writes inside protected roots, including activity-log appends, remain mutations. The proposed log exemption was withdrawn.
- Verify the temp-parent repair with `node scripts/verify-quorum-smoke-host-activity-temp-overlap.mjs`; host-hook logging is handled separately.

## Earlier history

Earlier entries were removed from this file at the user's request on 2026-09-18.
The complete history through v0.3.407 remains in Git:

```sh
git show a8768173bc7488aa8fdc3ef45f1ed295cbd924c8:CHANGELOG.md
```
