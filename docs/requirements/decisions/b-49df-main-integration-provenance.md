# B-49df main-integration provenance boundary

Status: implementation decision pending independent final verification.

## Trigger and controlling authority

B-49df integrates main commit `69403365ae9a19422564babf93f6c10de869c81d`
into candidate `3a4f2fb9968afc1876e364503153651403d47ca7`. The user's
canonical-only identity requirement and the clean-break decision in
`proof-or-stop-identity-cutover.md` remain controlling. Integration does not
reopen compatibility or make a historical record admissible to a current gate.

Independent read-only inspection found both new active compatibility paths and
pre-existing historical bytes. These are different cases and require different
repairs. This decision authorizes no direct Story, fixture, learning-ledger, or
release-ledger rewrite and no caller-authored signature or evidence receipt.

## Frozen decisions and current instructions

The initial integration used the original candidate's pinned bytes for
`brand-rename-mapping.md`, `proof-or-stop-identity-migration.md`, and
`proof-or-stop-agent-prompt-consolidation-execution-plan.md`. Main's overlapping
changes advertise compatibility that the controlling user decision rejects.
Those overlaps were resolved to the pinned candidate versions; main's original
versions remain recoverable in the named Git commit, not silently re-approved.
For the prompt-consolidation plan, this initial treatment is superseded by
"Current contract prose is not frozen historical provenance" below: that live
plan is now current scanned authority, not a frozen-file exception.

The acceptance-topology execution plan is different: it is a current truth
source. Preserve main's valid new policy, repair its active identity spellings,
and remove its whole-file frozen classification. Current instructions must
remain subject to active scanning. Generated prompt baselines require the
independent exact-body semantic review before regeneration; their historical
bytes do not authorize historical runtime modes.

A bounded independent audit of historical commits `d6bc395aa0` and `8a3eecbedc`
could not reproduce the three old legacy-mode columns still present in main's
active approval manifest. The former lacks the required algorithm/preimage;
the latter has a reproducible snapshot but all fifteen values differ from those
old columns. These old columns are unproven, not passing historical evidence.
Remove them and their validation claims from the current active manifest, along
with unused production reconstruction of the retired mode. Keep Git history;
do not fabricate a fixture, reinterpret unavailable as pass, or re-approve old
values from current output. This follows the user's withdrawal of compatible
CHK-006 in favor of canonical-only CHK-007. All current canonical body, prefix,
triage, role-contract, and host-identity approval pins remain independently
checked and mutation-tested.

## Exact append-only release provenance

The imported root handoff, follow-up, and review notes for B-3e16, B-3f3d,
B-5a88, and B-cdf6 are historical observations, not current resume authority.
The current CLI reports each named Story as DONE. Their obsolete next actions
must not override the live Story state. The dated B-cdf6 flow views and session
analysis likewise record an earlier observation. Preserve exact historical
tokens and context from the named imported main commit, not a directory-wide
or future-edit exemption. Follow-up defect reproductions and instructions to
delete both environment spellings are negative/isolation evidence, not support
for accepting a retired identity. The imported pre-review live-proof draft
records a dated defect reproduction; its original CLI-owned bytes are not
rewritten as part of this cutover.

The two release ledgers retain their original immutable prefixes. The imported
main suffix comprises seven additional records in each ledger. Source objects:

The immediate pre-merge candidate has 70 artifact records and 60 capability
records. The imported suffixes are therefore source lines 71-77 and 61-67,
respectively; these positions describe the fixed source blobs, not a future
line-number exemption. The earlier verifier prefix pins remain unchanged.

The exact additional artifact IDs are `AR-76578f8b19eafd7f207c2655`,
`AR-c25638f7e5c16c626634d474`, `AR-0ee40055f1a56064eae569d4`,
`AR-44df2e95ab2dee605862d4cc`, `AR-cd1e3f3ff2ecd962ad694be8`,
`AR-cddf5716b6a8ac45fb7ba0ff`, and `AR-d828464f58fc8717714a0f90`.
The exact additional capability IDs are `PCR-f34879fe3d61be233f768ec6`,
`PCR-1ca191e2d6a25b296f60739b`, `PCR-c371c3b2d0e267231f40b7b0`,
`PCR-bebda7913e0a0720842b4726`, `PCR-6e2e3b8418578ac0a8d63334`,
`PCR-665600be2cc01bd5c079d7ba`, and `PCR-30edbf3f2e8e65a46dd10ac2`.

| Ledger | Main Git blob | SHA-256 |
| --- | --- | --- |
| `.proof-or-stop/artifact-releases.jsonl` | `cff44f22780d7bb87cf93aeb4cc31c0cb58564f0` | `c82439e2beb65417e515a58592a7b89b39e533a81f95fa12f9af3d3a27af6e89` |
| `.proof-or-stop/capability-releases.jsonl` | `10ed026faa44ef0c510f020128a399b311ea6740` | `879a35962741c11eca0294ad55631ecba3390cf29df8a4b79e00bb97cd40ea83` |

An additional historical scanner entry must bind one exact path, record ID,
record digest, decoded retired token and occurrence count, embedded main commit,
and the source commit above. Independent review must verify every added entry.
The existing prefix pins remain unchanged. A missing, duplicated, changed, or
unlisted record remains a failure. The historical verifier may recognize only
the exact pinned historical schema in that record; normal product readers must
continue rejecting it, and new release writes must be canonical.

This is not permission to replace the original ledger baseline with the current
whole-file hash, edit a ledger record, widen a prefix, or accept future retired
schema writes. Tests must distinguish exact historical preservation from
normal-reader acceptance and exercise altered/unlisted suffix rejection.

## New capability records and truthful path scope

The current FULL-diff writer would copy unrelated retired runtime cleanup paths
into B-49df's new capability record. Its post-append identity gate correctly
rejects that result. Do not whitelist those paths or suppress the actual
capability release. Correct the new-write contract explicitly: the full DONE
diff is classifier input; persisted `changedPaths` is the actual
capability-declaring material subset, with
`changedPathsScope: "capability-material"`. The complete Git diff remains
auditable through `mainCommit` and its parents. This is a deliberate correction
to the earlier FULL-field contract, not a claim that it already meant subset.

Preserve canonical v1 read compatibility: an existing canonical record without
the marker retains its old read-only structural interpretation and makes no
subset claim. New builder and append inputs require the exact marker. Unknown
markers fail. For marked records, the reader verifies that every path is
capability-declaring and recomputes the capability digest from the subset and
the existing artifact digest. The marker does not change content identity or
idempotency rules. Existing-record lookup does not authorize new unmarked
writes or fabricate an upgrade of an old record.

The identity verifier must require this new-write marker and subset integrity
for new canonical capability suffixes. Exact pinned retired historical records
remain a separate audit-only path; they gain neither marker nor admissibility.
Keep retired-schema rejection unchanged. Test historical canonical reads,
marked canonical writes, unknown markers, non-subset/digest tampering, unmarked
new-append rejection, and a full classifier input containing retired cleanup
paths whose output contains only the actual capability materials.

## Runtime residue and memory consumption

Imported retired host-run and memory-pack caches are local runtime residue, not
release evidence. Their source tree objects are
`fdab7fb67bb7896500432aa2b8f1c639dca03d4d` and
`023012f0c0f16c31c6ec850ef582ffdb0a280d52`. Remove only audited runtime/cache
files from the Git index, retaining working-copy bytes and Git history. Add
deny-only tracking protection; never add a normal runtime path fallback.
Protected Story artifacts are excluded from this operation. Other learning
records are not covered by a directory-wide deletion. Independent inspection
also classified the following exact derived runtime files for index-only
removal. Framework state belongs to source tree
`03e3649158b96bdeababa227260a682db3c3149b`; the four learning files belong to
source tree `34f388d547e725fe29773d0b2a2700d013285f03`. These tree IDs locate
provenance; neither is permission to remove a whole learning directory.

| Exact filename in its named source tree | Git blob | SHA-256 |
| --- | --- | --- |
| framework `state.json` | `e1604a846c4fc3858062b9bc606d8de17eb8b5d7` | `0c37e0710747e8fb6fc7e497dec03aa484dea942cf8ccf83326ea4844f21f20f` |
| learning `finding-signals.json` | `1cedae86bc03a574a35efbd54bb7588c0edbc27c` | `19d7ac40a4cb5da3c902494f1a898dfd68a7ead32f533f7d4602dcc5d1d1ba39` |
| learning `playbook-promotion-health.jsonl` | `e882f28f2fde96963e44a07c4193ba000af2f057` | `7c4c13926894d8b20b9a3c344b3949caa3ddc2a92040199a87c7f69260fbfcb9` |
| learning `playbooks.json` | `9d6cdfafd0b6a3bc32a2657329451c475ce79970` | `2b38ce314e1eba583367cf5131dde189bac9c4ac964b28ac25d52196699b0025` |
| learning `signature-registry.json` | `72d48c5ad7ea3dc215232da5d4bdcfc03ae14f72` | `574c285008e54b1d6b590160f372bfdbf7ab8b1694ee8947585230ac258f053a` |

Tracking protection must name only these exact files and the two cache trees.
It must not hide protected Story changes or restore a deprecated lookup path.
Verification must prove index absence, preservation of working-copy bytes,
unchanged protected Story files, and rejection of ordinary re-add attempts.

Two additional root files imported from the same main commit are obsolete
non-authoritative residue, independently compared byte-for-byte with that
commit. The old root configuration is not a normal configuration lookup input;
the current process-contract verifier must stop reading it before its tracking
is removed. The reviewer submission scratch is an accidental B-3f3d / RR-379
payload, not the Story's signed Finding store. Remove only these exact index
entries, retain working-copy bytes and Git provenance, and prevent ordinary
re-add with exact deny-only rules. Do not exempt arbitrary configuration,
reviewer payloads, or Story evidence.

| Root path | Main Git blob | SHA-256 |
| --- | --- | --- |
| `lattice.config.json` | `605e217c14ce451ca40d306c3128cda5f4e92dd4` | `9a4f47a975271e4d1d2a38fdf2d07f24b1fb6faa8def7b70d26fd7ac6f873a8e` |
| `.remember-scratch-readmanifest.json` | `0b1f20f0c39fcd98e9afad513bd5a108db1155dd` | `805412e06ed8f204e26ed462892cf208af1f26e651e024181a7b3d9610a1b43a` |

The current project experience ledger is consumed by prompt construction. Its
append-only history therefore cannot become safe merely through a new hash pin.
Preserve its bytes, but prove that exact retired-identity records cannot enter
normal runtime selection and that new writes cannot reintroduce active retired
identities. Audit-only access must not grant runtime admissibility. Do not
replace the memory ledger with a new permanently frozen whole-file snapshot:
its proven historical prefix must remain byte-exact while subsequent valid
canonical entries may append. The imported 76-row source is Git blob
`71d93ff1a25df23baef53206afd41f3eb344a97c`, SHA-256
`c83147c093dc1cbb2801dbc2f238494470efb8e1001287bbcda921f362bfbec3`.
It strictly extends the earlier 58-row prefix. Recognition of this source as
audit history is conditional on the normal-selection quarantine proof above;
it does not permit active consumption of its retired identities. New suffixes
must pass the memory record structure and canonical identity checks, and prefix
mutation must fail independently of normal selection.

Do not
increase persisted-schema inventory counts to hide runtime residue or freeze
an entire directory. Any remaining unclassified row remains blocked.

## Verification and closure

Identity-site coverage must be derived independently from the executable source
and machine-readable configuration/baseline inputs owned by the contract. A
nonempty site list for each file, agreement between caller-maintained site and
case lists, or a check of one selected export does not establish completeness.
Classify every discovered identity-bearing value explicitly: active protocol,
algorithm, domain, and signing identities require their own operation case;
active role and path references also require registered operation cases; exact
negative fixtures and provenance are not active acceptance paths. Include
non-versioned domains and recursively inspected JSON fields rather than using
a terminal version suffix as the identity universe. Unclassified values fail.

Historical mutation inputs must come from traceable source evidence. A value
already canonical in the imported main commit has no historical counterpart
proven by that commit; a constructed invalid-family control must be described
as constructed, not as an observed retired value. Missing sites or cases,
additional identities inside an already-owned file, typed producers, and
broadened fixture classifications must independently make verification fail.

Each distinct public operation in the mutation matrix must first succeed on its
unchanged canonical fixture. A negative result is evidence only when its
diagnostic identifies the injected boundary; an unrelated identity refusal or
an already-broken canonical operation cannot satisfy the mutation assertion.
The active prose/asset scan must discover both retired identity families across
its declared universe. Exact history and negative-input exceptions must not
exempt current schema guidance, generated ownership markers, or whole files
that also contain active producers.

The broader scan's additional repairs are identity-only: current guidance,
generated hook messages, fixture actors and runnable experiment output use the
canonical name. Existing experiment results, authorization windows, signed
receipts and historical memory rows are not rewritten or re-certified. A
historical token exception must identify the exact observed context; it cannot
authorize a new producer merely because the producer sits beside old results.
The separately recorded historical memory-supersession failure remains outside
this identity repair and is not presented as passing validation.

Register the portable `--group=identity-cutover` public-operation matrix as a
standing validation command, not only as manually invoked Story evidence.
Its configured timeout must cover measured execution without weakening any
assertion. Stale evidence refresh may share that actual execution across its
independently checked pinned selectors; it must not copy caller-authored output
or manufacture receipts. Keep Story-specific historical-evidence checks out of
the repository-wide command. Resolve fixture dependencies from the actual Git
common directory so validation works from both a Story worktree and main. New
fixture commits retain the real configured Git author; an author-policy control
may import an identified genuine historical object without forging a new author.

Complete the scoped repairs, then verify the integrated candidate before
refreshing lifecycle evidence. Required checks include public identity mutation
tests, prompt semantic tests, historical-prefix and suffix tamper checks,
runtime tracking checks, and memory-selection negative controls. Preserve
independent REVIEW, TEST, and DONE gates. This decision itself is not a passing
test, Finding resolution, runtime receipt, or human convergence acknowledgement.

### Traced witness execution prerequisite

The committed candidate `c21a945704` exceeded the registered 900-second budget
during the official identity witness. Its zero-mutation snapshots register every
tracked file with the runtime tracer, whose array-based membership lookup repeats
linear string comparisons. Live sampling matched this path; a later copy-phase
sample alone did not establish copying as the cause. Scope acknowledgement 42
bounds the prerequisite repair to tracer membership lookup and its existing
transparency smoke test. Preserve the exact recorded arrays, first-observation
order, input filtering, child inheritance, and trace sidecars. Do not disable
instrumentation, exclude snapshot inputs, or raise the timeout to claim success.
Require reference-parity and lookup-cost RED/GREEN controls, then re-execute the
unchanged pinned public witness before claiming that the timeout is resolved.

### Measured disposable-fixture cost and command budget

The subsequent official witness on `76d3adacd3` also timed out at 900 seconds;
it produced no passing receipt. Sampling now showed filesystem and hashing work,
not the former linear membership lookup. A traced disposable-clone benchmark on
2026-09-05 measured full snapshots at 3.104 and 3.262 seconds with non-throwing
missing-file lookup. The current group performs at least 432 full-clone snapshots,
so those snapshots alone exceed the original whole-command budget.

Limit fixture materialization only: do not expand the exact obsolete
`.remember/logs/autonomous/` subtree in generated public-operation clones.
The measured checkout had 22,698 such tracked logs, all sharing two blob objects;
bounded source inspection found no active consumer of that subtree. This is not
a migration or deletion of real repository history. Preserve all Git objects,
indexed paths, HEAD and main refs, all other Story data, current memory stores,
source, configuration, templates, and experiments. Snapshot every indexed and
untracked nonignored path as before, including an explicit absent marker for
each unmaterialized tracked path. Use non-throwing `lstatSync` only for absence;
retain other errors, every trace observation, and fresh byte reads of present
files. Never cache a verdict or file hash across public operations.

The sparse benchmark retained the complete index and identical nonexcluded
material. Snapshots measured 1.597 and 1.645 seconds, with repeated baselines of
1.754 and 1.732 seconds. Creating an omitted tracked file with empty or nonempty
content changed the snapshot, and restoring absence restored the baseline.
Require standing falsification controls, including a symlink at an omitted path,
so skip-worktree status cannot hide writes from the material comparison.

Even the improved snapshot measurements project approximately 690–758 seconds
for the current snapshot count alone, before CLI operations, clone setup, and
other assertions. Replace the unmeasured 900-second estimate with an explicit
2,700,000 ms whole-command ceiling in standing validation and the audited
verification invocation. This supersedes only the earlier budget assumption,
not the recorded timeout or its failed outcome. Keep the exact pinned command,
all independent selectors, canonical controls, and every mutation case. A longer
ceiling is not evidence: only a completed tool-executed run with all assertions
passing can establish GREEN. Any further failure must stop and be diagnosed,
not trigger another speculative budget increase.

### Current contract prose is not frozen historical provenance

The official scoped batch on `d2a2518b2a` stopped at the INIT group: the current
prompt-consolidation plan still described an unprefixed product INIT identity,
contradicting `REQUIRED_INIT_CHECK_AGENTS` and the existing F-003 regression.
Correcting the live role descriptions restored that focused group. The next
batch on `6c490cb9da` exposed a second part of the same boundary: the plan was
still listed as whole-file concept provenance, so release verification refused
its changed bytes. Neither failed batch is a completed verification PASS.

Remove only that current plan's exact frozen manifest entry; do not re-pin its
rewritten bytes as historical provenance. Register the plan as a current truth
source independently of navigation links, so adding it back to the frozen
manifest fails even with correct current file hashes. Preserve the former Git
objects and all other frozen entries. Scan the live plan, correct its current
lifecycle-symbol and executable-entrypoint names, and retain historical or
negative examples only through exact path/token/count/context classifications.
Require an injected active retired command in this same plan to fail the real
scanner. This closes a current acceptance and misleading-exemption defect; it
does not authorize revising unrelated claims throughout the planning document.

The release evidence command exercises the real default verifier on the
repository and again on a disposable DONE-rejection control. Each invocation
retains a runtime group with its existing 300-second ceiling, alongside the
identity-site, memory, marker, and schema checks. Use a recorded 1,800,000 ms
outer release-witness ceiling; an early structural failure is not a measurement
of that complete path. Keep all nested ceilings and assertions unchanged.

### Executable release controls and post-DONE package consistency

The official release-first batch on `f401094b63` failed with a nonzero receipt
result; the diagnostic rerun exposed both package-lock drift and an empty-output
normal control. These are failures, not a successful identity verification just
because an intermediate PASS line was printed before the final package check.

On macOS, a disposable verifier invoked through the lexical temporary-directory
alias did not satisfy the scanner's realpath-based ESM entry guard. Canonicalize
only that fixture entrypoint before executing and returning it. Keep its normal
PASS assertion and the subsequent exact duplicated-ledger rejection assertion.
A standing actual-scanner probe through a symlinked directory must return the
same nonempty schema-baseline output as the canonical entrypoint.

The lab and utils locks embedded core version 0.3.273 while the core manifest
was 0.3.276. Align only those embedded records. Independent disposable-fixture
execution additionally proved that the existing DONE bump changed core to
0.3.277 without changing either embedded record, recreating the package failure.
Include these records in the existing version transaction, structural precheck,
post-write verification, rollback and staged-file list. Retain each extension's
independent root version and all other dependency data. A present extension
requires its lock; a minimal core-only fixture need not invent extensions.
Reject malformed or stale embedded records before writing, including the
already-bumped shortcut. This is necessary for CHK-004's post-DONE acceptance,
not an unrelated versioning redesign.

After the initial lock alignment the real installed-package probe exposed
missing nested Lab aliases. Source and built alias maps both omitted them;
existing CLI smoke assertions and Lab help already required nested/flat parity.
Restore the six exact current Lab mappings, preserve unknown-command rejection
and unchanged flat commands, and verify the installed package again. No retired
product command alias is restored. These repairs do not weaken the pack checker,
skip the DONE release guard, or constitute completed REVIEW/TEST evidence.

The next diagnostic on `c9eb28cf4c` passed the repository verifier but exposed
one failing release control: the real scanner's schema inventory reads every
tracked file, including the old logs omitted from sparse public-operation
fixtures. Its ENOENT is not a permitted successful negative control. Materialize
the full disposable checkout specifically for `createIdentityVerifierClone`
before running that scanner, retaining identical HEAD/index and the existing
normal PASS assertion. Keep the sparse identity-mutation fixtures and their
complete material snapshots unchanged. Do not teach the scanner to ignore
missing tracked files or delete any actual repository history.

The release rerun on `5c3e49975a` then reached the cloned runtime suite. An
isolated execution of the original rollback test exposed two host-topology
assumptions: its matching-runtime and reviewer-write classifier controls used
the enclosing checkout instead of an explicit main/linked-worktree fixture.
A standalone clone on a Story branch has no checked-out main worktree, so the
classifier correctly refuses unresolved authority. The all-writers classifier
control also accepted that unrelated refusal as its supposed foreign-runtime
proof. Construct a disposable real main/linked-worktree pair for these controls
and assert the intended exact authority classification. Preserve the actual
public-CLI mutation tests and production fail-closed behavior. This repairs the
witness assumptions; it does not authorize inventing a main checkout or relaxing
runtime admission in a user's repository.

The next traced rollback diagnostic on `0fcb24fb69` passed the cloned runtime
checks and reached the closed-role consumer witness. Its isolated role-migration
test depended on an ambient host session: full-envelope dispatch refused the
absent provider before exercising canonical reviewer identities. Declare a
supported canonical host/session fixture only for that isolated test, with
environment restoration, and verify it with ambient host signals absent. Keep
production unsupported-host rejection unchanged. No such synthetic test context
authorizes a reviewer, host verdict, or fallback for the real B-49df Story.

The official 30-intent batch passed on `323fc0576f` and recorded metadata in
`f1bb5a5`. The remaining identity batch then failed. A traced, unchanged
`round24` diagnostic isolated the config validator identity site: replacing its
version literal makes canonical project config fail during `loadConfig`, before
the public consumer can identify the corrupted runtime. The observed error only
names the canonical input as unsupported. This is early refusal with misleading
diagnostics, not admission of retired input. Repair that error path while keeping
the exact site/value diagnostic and zero-mutation matrix assertions. The separate
traced lifecycle/release/lookalike diagnostic passed with all its prerequisites;
neither split diagnostic substitutes for the complete official intent batch.
The focused standing selector reproduced RED against the prior build and passed
with the repaired build under the actual traced executor (66.9 seconds). Its
normal/ablated public controls and invalid-user-version rejection remain intact.
The exact owned-import witness gained only the new import and guard call; the
full matrix still executes every registered mutation without filtering.

The next full identity run on `8bece3d8da` exposed eager role-policy validation:
an unknown injected policy key is rejected while the role module initializes,
before the public consumer can name its canonical source site. A diagnostic-only
in-memory runner retained every per-site assertion, restored injected bytes in
`finally`, and stopped on unsafe state. It attempted all 221 public mutations;
exactly 18 failed, all unknown role-policy keys in the same registry, with no
contamination. This diagnostic is not a verification receipt or a completeness
PASS. Derive the genuinely missing canonical keys from the independent expected
role set and include those source sites in the existing unknown-key error. Never
guess an alias from an old prefix or invent a counterpart for an extra unknown
key when no canonical policy is missing. Keep original rejection ordering and
acceptance behavior, then rerun the unchanged full matrix before official proof.

### Main-first integration at d9ad3c2b0e

At the user's request, checkpoint the pending role-policy diagnostic changes in
`32e40892e3` and merge local main at `d9ad3c2b0e` before further remediation.
This integration includes B-fe8f's ledger and runtime evidence changes. Retain
its immutable run-start Finding snapshots and ledger mutation paths, while
preserving B-49df's canonical-only CLI identity and read-only `finding_list`.
Keep both branches' current Lab/config alias controls; historical bin acceptance
is not restored. The inline process-artifact parser retains main's richer fields
and the existing artifact name. Embedded core lock versions follow the merged
core manifest, 0.3.278. These are merge resolutions, not a new scope expansion.

Integration checks: core build, CLI surface smoke, runtime-fact contract, script
syntax, and Git whitespace/conflict checks passed. The B-fe8f ledger/runtime
regression command exited 1 at `repro_probe_get` because artifact
`rp-mtifubae-dfbh4w` was not found. The exact read-only command
`node bin/proof-or-stop.js repro_probe_get --probeId=rp-mtifubae-dfbh4w`
also exits 1 with the same error from local main. This is a reproduced missing
baseline-evidence dependency, not proof of a new B-49df ledger defect. Keep it
open for TEST triage against B-fe8f's evidence ownership; do not fabricate or copy
unsigned replacement evidence, dismiss the failure, or claim the regression
passed. No deferral or gate exemption is asserted by this integration record.
All pre-merge Story verification remains subject to CLI freshness checks.

### Post-merge identity evidence and remaining dependencies (2026-09-07)

The merged main introduces two already-persisted B-212f release ledger rows
(`AR-29ab9703262efd8f69982852`, `PCR-cdd7db406d44736d26f0162b`) and the
B-212f/B-fe8f finish decisions. Preserve their bytes and bind the scanner to the
exact existing row or file digests and Git provenance. These are inert historical
records, not active-reader compatibility. No ledger, receipt, or signature is
rewritten. The additional seven retired-token contexts classify one exact
migration-tombstone matcher and six negative fixture contexts; none admits an
old current identity. Main's additional validation registrations change the
canonical config context digest, so refresh that exact six-occurrence witness
without extending the expected identity-site set.

The shared DONE predicate fixture initially expected a retired Prompt Envelope
to be trusted and lacked current prompt-contract bodies. Update its positive
fixtures from the current production contract constants, retain real production
review-run verification, and require the retired envelope to be rejected by
both raw and snapshot consumers. The standing command
`node packages/main/tests/red/red-done-shared-predicates.mjs` now passes all
20 production-consumer cases, five canonical optional-envelope controls,
malformed/tampered rejection, and inverse/skipped/discarded mutation controls.
Core build, identity-sites, scanner self-test, and the complete identity-cutover
scanner including packed clean-install boundary passed on these changes.
The packed controls verify all four canonical packages and the complete
canonical role registry without retired-scope or local-file dependencies.
These diagnostic passes do not refresh the Story's tool-owned verification
receipts by themselves.

The certification smoke first failed because its invalidation assertion invoked
the now-read-only status command without `refresh: true`. Correct that one call;
the read-only controls remain intact. Its next failure is the ambient branch
filename assertion at lines 1108-1116, introduced by B-3f3d commit
`9c03626a04e90c99c5665913a49eacae32a43c2a`. It treats every future `main...HEAD`
as the original Story and rejects matching filenames without checking whether
quorum policy weakened. Preserve that assertion and the failure, with the
CLI-created `certification-smoke-ambient-branch-scope` draft as the traceable
medium test-maintenance route. It is not directly registered in the current
validate list or root serial scripts. In particular, the migration assertions
after this failure have not run: their manifest verification commands are
expected controls, not a claim that the complete smoke passed. Reclassify if a
required command or acceptance intent makes the failure a current blocker.

The missing B-fe8f probe is different: its regression command is registered in
validate, so absence remains a real completion dependency. Exact filename/digest
searches across the canonical and old state directories and all local worktrees
found no authentic copy of `rp-mtifubae-dfbh4w` or its bound digest
`2debba0742404113a7b685e2b218f51057a8c37cfe2ad36c23bbec1404c9516c`.
`gap_log` refused the attempted record with the existing `invalid_binding_shape`
signature-chain error; no successful gap write is claimed. The CLI-created
`b-fe8f-missing-historical-probe-recovery` draft preserves the failure and the
B-fe8f evidence-owner route. Neither draft waives a gate, and the static
registration-mirror witness must not be used to bypass official worktree reads.
Recovery requires authentic original evidence, not reconstructed signed objects.

Diagnostic `acceptance_basis_generate` persisted at `47fbfa2694` reports
`unsupported` with `AT_SCOPE_BINDING_MISSING`; `pre_review_check` persisted at
`7a495b0da4` reports observe-mode `inconclusive`, `ok: false`, `blocking: false`.
These are not PASS results. Keep the existing topology/provenance follow-up and
the original findings visible. Final evidence still needs current CLI freshness,
independent REVIEW, TEST, and actual DONE; none is inferred from this note.

### Scope-binding correction and verification interruption

An independent read-only diagnosis corrected the preceding triage: the tracked
scope check was not missing. Its checkedAt was 2026-09-02T21:17:33.206Z and its
stored hash matched only the retired scope-check signing salt, not the current
canonical salt. Its old review round also differed from the current round.
The production signature verifier therefore correctly returned false and the
acceptance-basis handler supplied null. This is a current required scope-evidence
renewal, not something the optional-topology follow-up draft can resolve.

The owner took the supported DEV-to-PLAN edge. A fresh-context independent
scope reviewer then saved 69 features (64 covered, 5 excluded, zero gaps or
orphan suspects) using seven complete candidate decision reads and 141 filename
triages. Commit `f36028a792` records the genuine CLI-issued scope evidence.
The owner resolved the two OQs through `scope_question_resolve`: the three exact
historical scope-schema exceptions do not permit any general retired protocol
reader, and preserving inert historical bytes never authorizes an active retired
signing salt. Resolution commits are `d5c6f89075` and `bc5bb9ae22`.
`story_review` then passed with zero blockers and ten advisories. After the
ordinary dev-memory preflight acknowledgement (actor `codex-main-agent`, not a
human convergence acknowledgement), the normal PLAN-to-DEV gate succeeded.
Regenerate acceptance basis before pre-review; the old basis output is stale.

The attempted 30-intent refresh did not complete: the outer CLI's default
300-second no-output watchdog terminated the batch after 308.4 seconds during
the release group. Its leftover, exclusively identified test process group was
terminated; partial causal receipts are not a completed checklist refresh. A
separate diagnostic matrix was also stopped after its first failure proved that
an uncommitted-current verifier was being compared against an older Git clone.
No full matrix PASS or completed batch is claimed. Subsequent official runs
must use committed inputs and the supported bounded canonical CLI idle/max
timeouts as well as the already-audited per-command ceilings.

Additional read-only recovery found `/private/tmp/bfe8f-probe.json`, an old
`repro_probe_get` export containing the expected ID, digest, and payload, plus
`/private/tmp/bfe8f-relation.json`, an evaluation summary. Neither is a complete
original artifact-store object/ref backup. Do not reconstruct missing historical
producer/binding/creation fields, write raw evidence JSON, or treat those exports
as restored current gate evidence. The authentic-object recovery dependency
remains open; the user was asked for an available backup location.

### Current fixture proof supersedes the missing-object diagnosis

Main repair `9b8ca8879f` supplies a private fresh candidate RED/GREEN witness for
the registered B-fe8f guard. The direct post-integration command passed with
`historicalCandidateCAS=not-consumed`, `liveCandidate=fixture-only`, and
`restoredHistoricalCAS=false`. This supersedes the earlier missing-CAS recovery
diagnosis above. No historical record was reconstructed, and no historical PASS
is used as proof of the current implementation.

Main also imports the terminal B-8a40 finish-decision audit record from source
commit `f8c295046d31bd33b552386114a96eb5460e103a`. Its exact path is
`.proof-or-stop/dev-memory/finish-decisions/B-8a40.json`, Git blob is
`bb8de96b6f1425a37408849ded867c87b04c4ce8`, and byte SHA-256 is
`b0541cc7fc5ed5ac11b6fd3e650d56bee8f6db925adfd0bee37c0f07b02af4a7`.
Those original bytes remain untouched. One exact `provenance_bytes` row applies
the existing audit classification; no directory-wide or runtime exemption is
introduced, and this record is not current acceptance proof.

The current finish-decision reader now requires the byte-exact canonical schema
`proof-or-stop.dev-memory-finish-decision.v1`. Fresh generated fixtures proved
the missing reader check RED before implementation and GREEN afterward, with
canonical admission, eleven retired/missing/lookalike rejections, matching DONE
gate refusal, and byte-stable reads. Scanner self-tests additionally target the
new row's blob/digest integrity and an unlisted same-directory neighbor. These
current negative controls, rather than modification of historical originals,
define the boundary; final Story acceptance still requires fresh official
receipts, independent REVIEW, TEST, and DONE.

The direct retired-authority guard also reproduced one current B-49df regression:
`validation-runtime-tracer-transparency-smoke.ts:139` was rejected for
`node:vm.runInNewContext`. Commit `76d3adacd3` introduced this fresh test of the
actual private production kernel. It loads only the repository-local tracer
resolved from `import.meta.url`, checks the kernel anchors, and has no external
VM payload input. The existing reference, insertion-order, membership, and
zero-`includes` controls are retained without production exports or copied logic.
Independent review approved one exact whole-AST test-file pin. Its deliberate
cost is the existing whole-file early return, not a call-site-only exemption;
any executable AST drift must restore rejection through the existing per-entry
negative control. The combined finite map count is thirteen, with no pattern or
directory exemption and no change to production tracer behavior.
