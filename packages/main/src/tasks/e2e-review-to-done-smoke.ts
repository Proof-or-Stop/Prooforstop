#!/usr/bin/env node
/**
 * Local REVIEW -> TEST -> DONE regression harness for the benchmark owner flow.
 *
 * Benchmark runs take ~2 hours to reach a REVIEW/TEST/DONE gate conflict. This
 * harness reproduces the same owner command sequence in minutes against a temp
 * git repository shaped like the DeepSWE task: a small Go project (no
 * packages/main, no packages/*\/dist), a benchmark-prepared
 * proof-or-stop.config.json (validate.commands = go test, validate.env
 * CONTEXT=abs, artifactContract=none), the managed runtime .gitignore, a Story
 * worktree under .worktrees/<id> on story/<id>, and a docs file that describes
 * the behavior but is outside the scope contract.
 *
 * Every lifecycle command goes through the real CLI (dist/cli.js) from the
 * Story worktree, exactly as the owner runs it. The only simulated part is the
 * model: a fake `codex` executable on PATH replaces the provider. host_run
 * --managedReview / --managedDispatch still build the prompt, spawn the
 * detached worker, seal the terminal receipt and import the evidence; the fake
 * provider only prints the scripted final envelope (reviewer lanes, inventory
 * critic) or runs the scripted CLI command a delivery reviewer would run
 * (delivery_check_set) with the env the worker gave it.
 *
 * Scenarios:
 *   A  happy path must reach DONE and merge story/<id> into main (hard PASS).
 *   B  run-10 dead end: the delivery reviewer requires an update to a docs file
 *      outside the scope contract. Fixed by fix 28 (docs admitted by default);
 *      must now go TEST -> DEV -> REVIEW without PLAN rollback and reach DONE.
 *   C  single host: what the owner must run for the review assurance floor /
 *      review escalation before DONE (observed inside scenario A).
 *   D  run-11 dead end: REVIEW round 1 finds a verified finding -> critic ->
 *      finalize --remediation -> DEV repair by a managed finding-repair
 *      dispatch -> round 2 all pass -> direct finalize (zero-wave
 *      completeness-only receipt, refused by certification) -> cancel ->
 *      fresh saturated epoch + critic -> certification_window_begin refuses
 *      the still-open verified MEDIUM F-001 from round 1 (closure required, no
 *      round decay); DONE's review verdict and story_advance TEST refuse too ->
 *      the owner runs the hinted finding_resolve with the repair evidence ->
 *      certification_window_begin -> validate -> story_advance TEST must not
 *      refuse the managed passes with managed_review_live_head_lineage_invalid;
 *      then TEST -> DONE.
 *   D2 run-11 workaround: an unauthenticated commit breaks the live binding;
 *      TEST names the commit/rule with one Next (review_round_prepare); the
 *      owner reruns the round; the superseded older passes of the same round
 *      block neither TEST nor DONE.
 *   D3 run 13: the review assurance floor is satisfied with quorum_submit
 *      (two Codex sessions); its `quorum-submit` commit must keep the managed
 *      passes live through done_prepare and DONE.
 *   E  run-11 bare .gitignore: scenario A on a task repo whose tracked
 *      .gitignore has NO Proof-or-Stop runtime block (and no .worktrees/),
 *      with `proof-or-stop init --profile codex --asset-mode global-thin`
 *      run in the main checkout before the Story worktree exists, exactly as
 *      the bench adapter does. PoS runtime files must stay out of git status
 *      without any owner-written excludes; must reach DONE (hard PASS).
 *      Also selected by E2E_R2D_BARE_GITIGNORE=1 (runs E instead of A).
 *   N  A's and D's flows (NA, ND) from REVIEW entry driven ONLY by
 *      `proof-or-stop next --storyId=<id> --json`: the harness executes the
 *      returned command (agent kinds through the same fake-provider seams and
 *      authored values as A/D) and asserts DONE, that next is read-only, and
 *      that no proposed command is refused by its gate. Prints CLI calls and
 *      seconds against A/D when they run in the same invocation.
 *   NR the same flows (NA-run, ND-run) with `next --run`, which executes the
 *      consecutive framework steps itself through the real CLI.
 *   NF run 14: D's next-driven flow with TWO verified medium findings in round
 *      1 (Reverse("") and Upper("") untested). Since the A/B V4 adoption
 *      (remediation.grouping=single is the default) next dispatches ONE grouped
 *      managed finding-repair bound to both; it makes one commit naming each
 *      finding id. Since old-PoS run 24 (F4) next then proposes ONE batched
 *      finding_resolve (finding_resolve_batch) listing both, only after a
 *      managed finding-repair run bound to each finding id completed with a
 *      commit naming it (hard assert at every step); each finding records its
 *      own repair commit.
 *   NF2 the same, but the grouped run commits only F-001's repair: F-001 is
 *      resolved, and F-002 (bound to the group, no commit naming it) falls
 *      back to its own single managed finding-repair before it is resolved.
 *   NL run 16: D's next-driven flow plus two LOW round-1 findings; the owner
 *      repairs one anyway (managed finding-repair): next must propose its
 *      finding_resolve before REVIEW; the cosmetic one stays open; a
 *      finding_resolve after DONE refuses without dirtying the main checkout;
 *      the live-smoke capture passes only with validate.env (CONTEXT=abs).
 *   NU run 17 (Q1): D's next-driven flow where round 1 also reports a second
 *      finding with the same root cause, and the inventory critic marks it a
 *      `duplicate` of the first. After the first finding's own repair and
 *      resolve, next must propose closing the duplicate with that repair's
 *      evidence (finding_duplicate_resolve: finding_resolve with duplicateOf and a
 *      coverage command the framework runs) instead of a second repair cycle.
 *      The coverage names the test the canonical repair added (covered).
 *   NU2 the same, but the duplicate's own case is not covered by that repair:
 *      the coverage run is refused (never closed on the critic label alone),
 *      and next then dispatches the duplicate's own managed repair.
 *
 *   NC/NC2/NC3 detection A/B control D9-r1 / D2-r3: the round-1 inventory critic
 *      re-raises the lane finding as its own (verbatim copies with rows only
 *      for the lane findings / a reworded copy with a row only for itself): the
 *      import completes the other copy as a duplicate and the Story reaches
 *      DONE. NC3: the critic misfiles a genuinely new finding's row: the
 *      import refuses once, next never re-proposes it but runs a fresh critic
 *      whose prompt names the error; the new finding is repaired.
 *   NC4 run 19 (B-8166): round 1's only finding is SUSPECTED (low); the critic
 *      gives it a verified_family row. The import drops and logs that row
 *      (no refusal, no loop, no owner-written receipt); the round finalizes,
 *      the finding stays suspected and advisory, DONE.
 *   NC5 A/B V3 R2A-r2: the critic mistypes readManifest.candidateSpecSetDigest;
 *      the worker seals the launch-bound route, no refusal, DONE.
 *   NC6 the critic copies a wrong wave number: its import is refused once before
 *      anything persists (recorded), next never proposes it again but runs a
 *      fresh critic whose prompt names the refusal, DONE.
 *   NC7 the owner reroutes (candidate_spec_route) after the lanes were imported
 *      and the critic completed: refused with one Next, nothing written, DONE.
 *   NC8 the same round is invalidated by an unauthenticated owner commit: all
 *      lanes rerun, the superseded open finding is carried forward (never a
 *      dead end), its re-reported copy is repaired, it closes by coverage, DONE.
 *   NC9 old-PoS run 24 F1/F2: the first critic ends its turn with prose and no
 *      JSON envelope; its run fails with nothing produced and next relaunches
 *      the critic as a framework step (never the owner's), DONE.
 *
 *   NW3/NW4/NW5 old-PoS run 25 REVIEW livelock (scenarioNW): NW3 (F3) a framework
 *      evidence restamp after the lanes passed keeps every managed pass live;
 *      NW4 (F4) a wave-1 critic finding re-reported by every wave-2 lane is
 *      repaired in DEV after finalize, no lane relaunch, no human step; NW5
 *      (F4 stop-loss) a cancelled finalized epoch's critic pass is superseded
 *      by a fresh epoch, never a dead end; NW6 (F4 stop-loss) lane waves keep
 *      going stale on unchanged material with a verified finding open: after
 *      3 waves next repairs it instead of a 4th wave. `NW` = all four.
 *
 *   NI run 23 (request-outranks-intent D1): the implementer's final result
 *      declares an `[intent-conflict]` (the request implies one value, the
 *      intent pins another). next must block on it (story_advance PLAN, not the
 *      next item); in PLAN next proposes the audited intent revision
 *      (checklist_update verificationIntent + reason, item back to pending);
 *      after it the conflict no longer blocks and DEV re-implements the item.
 *   NIU old-PoS run 31 (CHK-006): the conflict names userSees and the
 *      verificationIntent already stated the request value at dispatch; the
 *      owner amends userSees only and the conflict clears (it stayed open in
 *      run 31: amendment detection compared only verificationIntent).
 *   NAR old-PoS run 31 (CHK-005): a PLAN intent amendment of a done item
 *      (checklist_update verificationIntent without status) resets it, and the
 *      items whose context/userSees/intent name it, to pending with a recorded
 *      reason; unrelated done items stay done.
 *   NXT old-PoS run 32 F-001: the request quotes an exact error string; the
 *      Story's added test compares it only through a prefix helper; with every
 *      item done next reopens one item (exact_text_prefix_assertion) before
 *      REVIEW, the relaunch prompt names the helper, an exact assertion clears it.
 *   NPO old-PoS run 31 pin oracle: the project declares an evaluator
 *      (proof-or-stop.config.json pinOracle); checklist_update refuses an example
 *      row whose input the Story base evaluates to a different value
 *      ([pin_oracle_mismatch], computed value shown) unless the row records that
 *      base value (baseValue, a deliberate change); a row the base cannot run is
 *      skipped; next blocks on a stored mismatch before the scope-plan reviewer.
 *   NMF/NMF2 old-PoS run 31 (10 of 13 findings were checklist text): lane
 *      findings citing only Story metadata are reclassified at import (never
 *      ledger findings, never repair work); next emits ONE owner checklist_update
 *      carrying the wrong literal, the reviewer's value and every other
 *      occurrence; an unchanged update is refused; metadata costs no round.
 *   NMO old-PoS run 33 (§3.2): with the round's inventory critic pending, next
 *      launches/imports/finalizes the critic before a metadata correction that
 *      needs PLAN (framework steps before agent steps).
 *   NMT old-PoS run 33 (§3.5): a metadata finding's copy that also cites the
 *      product file is classified by its correction target: closed by the one
 *      correction, never routed to a finding-repair run.
 *   NLI old-PoS run 34 (§4 sink 1c/1d): lanes launch slowest-first (docs,
 *      test-coverage, concept, quality) and a finished lane is imported while a
 *      slower lane still runs (the wait names the remaining lane).
 *   NAV / NAVF old-PoS run 34 (F5): after an adopted intent amendment next runs
 *      the item's pinned verifier and marks it done itself (NAV); a failing
 *      verification relaunches the implementer as a framework step (NAVF).
 *   NID old-PoS run 34 (sink 2, F6): checklist_update done + commit {files}
 *      runs diff --check, commits as the canonical implementer and marks done
 *      in one call; the prompt inlines the Story documents; no [probes]
 *      contract with implementation.probeMatrix off.
 *   NSC old-PoS run 34 (F3): a refused story_create lists every derivation
 *      problem of every item at once, stages the payload and names ONE next
 *      action (`story_create @<staged file>` after patching the rows).
 *   Q6 (old-PoS run 34 REM, every next-driven scenario): a repaired finding's
 *      finding_resolve / finding_resolve_batch is a framework step with a
 *      framework-authored resolution (never an owner placeholder); NF also
 *      checks the delivery prompt carries the delivery_context_pack output.
 *   NRI old-PoS run 31 (D3/D4): finding_resolve refuses unchanged citations
 *      (code without a test change, cited checklist text); plan acceptance
 *      refuses a batch that changes nothing.
 *   NMR old-PoS run 31 (REM2 test parsed checklist.json): REVIEW entry refuses
 *      product changes referencing the Story metadata; prompts forbid it.
 *   NLS old-PoS run 31 (D5): the intent-conflict amendment sweeps the literal.
 *   NPA old-PoS run 31 (D7): a large next step prints <= ~2k tokens (@file).
 *   NSR old-PoS run 31 (D8): a pin-audit value correction needs no rerun.
 *   NUB old-PoS run 31 (D6): duplicates close in one batch step.
 *   NPT old-PoS run 30 (F-002/F-004: the implementer probed rows its change
 *      decided but tested only some): the implementer's [probes] line lists
 *      probed-only decided rows; next reopens the item with one owner step
 *      (checklist_update in_progress + reason, not a review round), the
 *      relaunched implementer prompt names the earlier run and the rows, and
 *      a relaunch that tests them leaves no step.
 *   NIN N4 (old-PoS runs 22-24): no Story yet; `next` prints one complete
 *      story_create template, then `next --run` alone drives INIT (scope freeze
 *      check, both managed INIT reviewers launched in parallel and waited on,
 *      INIT_CHECK, PLAN) and stops at PLAN's first agent step.
 *   NQ run 23 / run 24 (D2, D3, F3): D's next-driven flow with a recorded
 *      request: every REVIEW lane prompt carries the verbatim request and the
 *      request-outranks-intent rubric, the critic prompt the no-limitation
 *      rule, and the finding-repair prompt the [intent-conflict] section and
 *      the base-behavior input-variant rule; DONE.
 *   NP run 23 at its source (D4 + pin audit): a Story in PLAN with a recorded
 *      request and a wrong pinned example that the request does not quote.
 *      next's plan_authoring lists the missing derivation; checklist_update
 *      refuses the row without one ([intent_derivation_required]) and accepts
 *      a cited, self-consistent (wrong) one; the managed scope-plan reviewer
 *      prompt carries the pin-audit rule with the derivation, the scripted
 *      reviewer records a `pin-audit` gap, and the Story cannot enter DEV
 *      (story_review names the pinned row to fix); after the owner fixes the
 *      value next relaunches the reviewer on the corrected checklist.
 *   NCV old-PoS runs 24-29 (PLAN coverage matrix, core/plan-coverage-matrix.ts): a Story
 *      in PLAN whose request has a 3-part syntax with omitted forms, a non-numeric
 *      operand and a same-semantics assignment section. next's plan_authoring
 *      lists the missing coverage rows (write mirror, omission patterns, explicit
 *      null) with the matched request sentences and a placeholder intent per rule;
 *      story_review blocks DEV on them; the owner writes the rows (one excluded
 *      with its reason) and next launches the scope-plan reviewer, whose prompt
 *      carries the coverage rule; no coverage blocker remains.
 *   NX old-PoS runs 20/25 F1: the task's Unicode test prints a CJK subtest name
 *      under go test -v; the captured output (checklist outputTail) and the
 *      observed DONE transcript carry it. The English-only gate must not refuse
 *      on captured program output; the tests reach main unchanged; DONE.
 *   NDL/NDS old-PoS run 27 (§4): the delivery reviewer launched at TEST entry
 *      saves after the N1 overlap moved HEAD by metadata-only commits
 *      (summary_set, quorum-submit): accepted, one run (NDL). A genuinely stale
 *      binding (a delivery-input commit) fails without save-repair turns and
 *      next --run relaunches the reviewer itself (NDS).
 *   NQR old-PoS run 40 (§6, the NDS flake): a concurrent framework writer appends
 *      to process-events.jsonl inside the quorum_submit --singleHost closeout
 *      window (a post-commit hook plays it); the closeout waits for that writer's
 *      commit and is redone instead of refusing the next --run step; DONE.
 *   NDG old-PoS run 27 (§2.2): managed runs record per-command wall time and
 *      host load samples (diagnostics.jsonl), host_run_status --full summarizes
 *      them, and review.laneLaunchStaggerMs spaces the lane launches.
 *   NRS old-PoS run 29 REM2: the finding-repair prompt states the allowed
 *      files; a repair commit outside them is scope-checked when the provider
 *      ends and fixed in the same (resumed) worker session; DONE without an
 *      owner scope stop.
 *   NIS old-PoS run 28 INIT: story_create lowers priority=high without risk
 *      wording to medium; a blocking INIT verdict whose judged inputs the owner
 *      changed (userSees) is relaunched by next --run as a framework step.
 *   NPX/NPXA/NPXS old-PoS run 30 (B-c201:F-005): round 1 also reports doc drift that
 *      is byte-identical on main. Out of scope (NPX): never routed to repair, closed
 *      by ONE audited disposition (finding_resolve disposition=preexisting_out_of_scope,
 *      base evidence + follow-up); NPXA: the owner's run 30 applicability record
 *      (pre_existing_unaffected, proposalRef = finding id) is accepted instead. In
 *      scope (NPXS, the request names the doc): repaired as before; a repair run
 *      without a commit is relaunched with its report in the prompt.
 *   NPXC old-PoS runs 36/37 (§5): the round-1 doc finding is a `doc-code-drift:` that also
 *      cites a code line of a file in the scope contract (unchanged at the base, only
 *      shifted); the code anchor is evidence, not a defect site, so the same ONE audited
 *      disposition closes it (before: "in scope" via the code file, a repair round).
 *   NRW old-PoS runs 35-39 (A3 probes inert): with a probeRunner declared, checklist_update
 *      reports an example row the probe cannot run where it is saved (ONE Next: the
 *      row patch rewriting it as `<input> -> <expected>`), a prose connector row
 *      (`... returns ...`) is runnable; checklist_update intentRows patches one row by
 *      ref with every intent check kept (an underived pin is refused, nothing
 *      written); an unknown ref or a whole intent plus a row patch is refused with
 *      ONE Next.
 *   NM old-PoS run 25 F2: the owner commits a test-only change during REVIEW
 *      after a clean round. next returns ONE framework step, the review reopen
 *      (story_advance DEV, reason recorded as transitionType review_reopen);
 *      DEV refreshes the stale evidence, a fresh round reviews it; DONE.
 *
 * Machine registries (provider slots, locks) use a disposable fixture machine
 * so the harness never touches the developer's ~/.proof-or-stop admission state.
 *
 *   AB detection A/B arms (core/ab-variants.ts; experimental switches default off):
 *      ND-V1..ND-V5 / NF-V1..NF-V5 run the ND / NF next-driven flow with one
 *      switch set in the prepared config (V1 review.criticOnCleanRound=skip,
 *      V2 review.round2Scope=repaired-files, V3 review.round2Lanes=resume (the
 *      rollback: fresh later-round lanes are the production default since the
 *      A/B V3 adoption), V4 remediation.grouping=per-finding (the rollback:
 *      grouped remediation is the production default since the A/B V4
 *      adoption; NF covers the grouped path), V5
 *      implementation.grouping=files on an unimplemented fixture, V6
 *      implementation.thread=fresh on an unimplemented fixture: every
 *      implementer and finding-repair run seals the arm and carries the item pack,
 *      V8 review.lanePack=shared: every lane and critic prompt carries the one
 *      round pack (Story diff, checklist digest, changed files + hashes, route),
 *      sealed in the run spec reviewBinding.lanePack; V9 review.roundDelta=pack:
 *      later-round prompts also carry the delta since the previous round's head
 *      and still review the whole Story).
 *      `AB` = ND-V1 ND-V2 ND-V3 NF-V4 ND-V5 ND-V6 ND-V8 ND-V9.
 *   DR EXPERIMENTAL review.deltaRounds=on (core/review-delta-round.ts) on the ND
 *      flow: ND-DR round 2 = the raising lane in full + ONE confirmation lane
 *      for the other lanes' concerns (resolved finding re-run by the framework,
 *      no critic on a round with no new finding); ND-DRL a large repair falls
 *      back to a full round; ND-DRG a confirmation [gap] and ND-DRV a failing
 *      re-run are not a pass and fall back to a full round; old-PoS run 52:
 *      ND-DRF / ND-DRF1 a findings verdict with complete (multi-line / one-line)
 *      coverage lines is not a gap and launches no late lane, ND-DRFG a
 *      findings verdict with a [gap] makes the NEXT round full. `DR` = all seven.
 *   LM EXPERIMENTAL review.laneMerge=on (core/review-lane-merge.ts) on the ND
 *      flow: ONE managed review session per round carries every active lane's
 *      dimension (concept carries it). NLM merged finding round + merged re-review
 *      (prints lane sessions and prompt bytes per round), NLM-OFF the same flow
 *      with the switch absent (the off arm), NLM-G an uncovered dimension of a
 *      merged pass is relaunched alone, NLM-C the carrier's own dimension
 *      uncovered = refused and every dimension separate, NLM-F findings of two
 *      dimensions route and close, NLM-FG a findings-verdict gap runs that
 *      dimension separately in the next round. Lab lane-split (depth contract
 *      for on and split; review.laneMerge=split = TWO merged sessions in
 *      parallel): NLM-D a generic-evidence dimension is relaunched alone;
 *      NLM4-OFF / NLM4 / NLM-S the 4-lane three-arm measurement (prompt bytes,
 *      sessions, round wall with scripted latency); NLM-SG a split session's
 *      generic dimension is relaunched alone; NLM-SC a split session's carrier
 *      gap sends only that session's dimensions to their own lanes. `LM` = all
 *      twelve.
 *   LN lab lean, EXPERIMENTAL pipeline.lean=on on the unimplemented ND fixture
 *      from DEV: NLN one implementer run for the Story (framework done step for
 *      the other item), one merged review session in round 1, one delta
 *      confirmation session in round 2, no critic on the clean round (prints the
 *      managed sessions); NLN-OFF the control (switch absent); NLN-E a round-2
 *      finding outside the repair delta escalates round 3 to a full round;
 *      NLN-DF a member no commit names gets its own implementer run; NLN-I the
 *      umbrella's plan.reviewMerge: INIT to PLAN with zero INIT reviewer
 *      sessions (NPM-I's flow); NLN-X (lab lean-dev, old-PoS runs 117/118) a
 *      Story-run member the exact-text gate reopens gets its implementer
 *      relaunched by next (never re-closed from the Story-run commit), and a
 *      hand host_run of the implementer for a done item is refused pre-spawn.
 *      `LN` = all six.
 *   NPXR/NPXRE/NPXRN old-PoS run 52: a re-filed pre-existing finding on a
 *      dispositioned, unchanged site closes at import with no owner turn and no
 *      extra round (NPXR); a site the Story edited (NPXRE) or a new site of the
 *      same doc (NPXRN) stays a real finding.
 *   NPP/NPM-I/NPM-P/NRB lab plan-light (EXPERIMENTAL switches, default off; each
 *      scenario also runs its switch-absent control): NPP plan.pinProbe=on, a
 *      pin of unchanged behaviour the Story base computes differently and a pin
 *      contradicting a request-literal example refuse DEV entry ([pin_probe_mismatch],
 *      observed value, one row-patch Next), corrected pins pass; NPM-I
 *      plan.reviewMerge=on, next --run reaches PLAN with zero INIT reviewer
 *      sessions; NPM-P one merged plan review (INIT + scope questions), its rerun
 *      is a confirmation re-review of the changed rows, only a real gap or an
 *      unanswered question blocks, then DEV; NRB plan.rowBudget=on, the template
 *      guidance and story_create's advisory list rows repeating an operand class
 *      with one trim command (rows before -> after printed). `PL` = all four.
 *   NCC lab sibling-gate (plan.counterpartCoverage, default on since lab run102; its
 *      switch-off control NCC-off runs first): an item adding Shelf.Put with
 *      in-range rows only, next to the base's Shelf.Get (counts a negative index
 *      from the end, base test) and Bin.Put (rejects it), refuses DEV entry
 *      ([counterpart_coverage_missing], counterpart first, sibling second, one
 *      Next with a placeholder row per class); the implementer prompt carries the
 *      `[counterpart]` probe contract (bytes printed); rows added = pass.
 *   NCD / NCE / NCS lab run102 (run100-103-analysis.md): NCD the pin-dispute remedy never
 *      removes / excludes a case the counterpart gate requires (run 102's ten-offer
 *      alternation); NCE an error row for a case the counterpart resolves is no
 *      coverage, ONE ready re-pin (run 101); NCS a pin-audit gap on a
 *      counterpart-backed row is settled, the prompt lists the row (run 101's flip).
 *   NFS / NFS-S lab run110 (run110-analysis.md): NFS the scope boundary's "changes to
 *      docs" becomes explicitExcludes, the repair prompt says docs are not admitted,
 *      and a tagged doc-code drift with an in-hunk code anchor is settled once by the
 *      framework (scope boundary > reviewer opinion), never repaired (run 110's
 *      6-round docs oscillation); NFS-S the request asks for the doc fix: repaired.
 *   NPDE / NPDE-D / NPDE-S lab plan-deadend (old-PoS run 121, run121-analysis.md):
 *      the scope-plan verdict lists a pre-existing doc/code drift sourced from an
 *      unrequested documentation file plus two coverage gaps no row template
 *      matched. RED on the base: next returned plan_review_blockers with no command
 *      and printed `Next: none runnable (see Why)` (the owner stopped). Now the
 *      drift is settled by the framework (advisory) and each coverage gap carries a
 *      ready covering row; applied, the rerun verdict re-raising only the drift
 *      leaves PLAN complete (NPDE pipeline.lean=on as in run 121, NPDE-D default
 *      flags). NPDE-S: a pin dispute decided right after a new verdict lists the
 *      CURRENT verdict's other gaps (story_review reruns first), never the stale
 *      round's.
 *
 *   NRG old-PoS runs 46/47 (resolved-finding regression guard + finding conflict):
 *      round 1's finding F-001 is repaired with a test and resolved; round 2's
 *      F-002 is "repaired" by reversing F-001's behaviour and rewriting F-001's
 *      test to match. The framework re-runs F-001's covering test as recorded at
 *      its resolution, rejects F-002's repair (not resolved; the framework
 *      finding_resolve still exits 0), opens `[regression-of F-001]` F-003, and
 *      `next` sends the F-002/F-001 conflict to the owner's PLAN pin (one Next)
 *      instead of another repair. RED on the base: F-002's reversing repair was
 *      resolved and DONE shipped it.
 *   NGS old-PoS run 58 (guard cascade, run58-analysis.md §4): round 1's F-001
 *      (Repro `Reverse("")`) is repaired with a table test that also holds a row
 *      of ANOTHER case (`Reverse("ab\n")`, correct then); round 2's F-002 changes
 *      that case legitimately and updates the row. The guard runs only F-001's
 *      own repro row, F-002 is resolved, round 3 is clean, DONE. RED on the
 *      base: F-001's whole snapshot test failed on the stale row, F-002's repair
 *      was rejected, `[regression-of F-001]` opened and next asked for a pin.
 *   NGF old-PoS run 58 (F-004): round 1 reports a verified finding and a
 *      SUSPECTED `[precedent-conflict]` finding; next (DEV) sends the conflict to
 *      ONE PLAN pin step before any repair (it does not wait a round for a
 *      verified re-filing). RED on the base: the suspected conflict was ignored
 *      and the verified finding went to repair.
 *   NMW old-PoS run 68 R2: a lane wave whose only report is an intent-row
 *      Story-metadata finding (no product finding). The wave's lanes finish, the
 *      round's critic and finalize run as framework steps, then ONE framework hop
 *      REVIEW->DEV->PLAN reaches the PLAN correction: one lane wave, no epoch
 *      cancel, no guard step, no read-only status pointer. RED on the base: the
 *      [review_metadata_correction_open] verdict went through the stale-wave
 *      stop-loss (epoch cancelled, all lanes relaunched).
 *   NRV old-PoS run 68 R1->R2: a verified finding's repair changes the expected
 *      value of a table-test row a checklist intent row also pins. Once resolved,
 *      the framework hops to PLAN and applies the derived row patch itself
 *      (re-pin stated) before the next round (stops at PLAN's scope-plan rerun). RED on the base:
 *      the stale row survived to DONE (a real reviewer re-reports it as metadata).
 *
 *
 * Usage: node packages/main/dist/tasks/e2e-review-to-done-smoke.js [A|B|C|D|D2|E|N|NR|NF|NF2|NL|NU|NU2|NC|NC2|NC3|NC4|NC5|NC6|NC7|NC8|NC9|NW|NW3|NW4|NW5|NW6|NI|NIU|NAR|NPO|NMF|NMF2|NMO|NMT|NLI|NAV|NAVF|NID|NSC|NRI|NMR|NLS|NPA|NSR|NUB|NRP|NRQ|NXT|NIN|NIP|NIP-M|NIS|NQ|NP|NPT|NCV|NX|NM|NDL|NDS|NQR|NDG|NRS|NPX|NPXA|NPXS|NPXC|NPXR|NPXRE|NPXRN|NRW|NRG|AB|ND-V1..NF-V9|DR|ND-DR|ND-DRL|ND-DRG|ND-DRV|ND-DRF|ND-DRF1|ND-DRFG|NPP|NPM-I|NPM-P|NRB|PL|NGS|NGF|NMW|NRV|LM|NLM|NLM-OFF|NLM-G|NLM-C|NLM-F|NLM-FG|LN|NLN|NLN-OFF|NLN-E|NLN-DF|NLN-I|NLN-X|NPDE|NPDE-D|NPDE-S|NSG|NSG-X|NIO|NFC|NPV|NMC|NDI|NSL|NUA|NAB|NBP|NIC|NIC-F|NIC-OFF|NRR|NRR-OFF|NCK|NCP|NCP-F|NCP-X|NCP-P|NGX|NCL|NCL-OFF]...
 *        E2E_R2D_VERBOSE=1 prints every command's output.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StoryStore } from '../core/store.js';
import { loadConfig, resetConfigCache } from '../core/config.js';
import { mergeRuntimeGitignore } from '../core/managed-assets.js';
import { QUALIFIED_MANAGED_REVIEWER_DEFAULTS } from '../core/managed-reviewer-qualification.js';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { classifierOptionsForCheck, classifyGitStatusRows, isBlockingDirty, readGitStatusLines } from '../core/dirty-worktree-gate.js';
import { MANAGED_INVENTORY_CRITIC_LANE } from '../core/managed-inventory-critic.js';
import { recurringPreexistingOf } from '../core/finding-preexisting.js';
import { managedInventoryCriticCoverage } from '../core/managed-review-evidence.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import { writeStoryRequest } from '../core/story-request.js';
import { buildScopeBoundary } from '../core/scope-anti-expansion.js';
import { FINDING_RESOLUTION_PLACEHOLDER } from '../core/finding-closure-hint.js';
import { sanitizedFixtureChildEnvironment } from './fixture-environment.js';
import { createFixtureMachineEnvironment } from './helpers/fixture-machine-environment.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const MODEL = QUALIFIED_MANAGED_REVIEWER_DEFAULTS.codex;
const FINAL_SCHEMA = 'lattice.managed_review_final_proposal.v1';
const DELIVERY = 'proof-or-stop-review-delivery';
const INIT_REVIEWERS: readonly string[] = ['proof-or-stop-review-story-init', 'proof-or-stop-product-reviewer'];
/** Files whose uncommitted change makes validate / done_prepare refuse (VALIDATION_PUBLICATION_NOT_READY). */
const PUBLICATION_SET = ['test-evidence.json', 'process-events.jsonl', 'closeout-write-receipts.jsonl'];
/** Steps that refuse when the publication set is dirty. */
const PUBLICATION_SENSITIVE = /^(validate \(routine\)|done_prepare|story_advance (TEST|DONE))/;

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

interface Step { scenario: string; label: string; ms: number; exit: number; result: string; dirty: string }
interface CliResult { status: number; stdout: string; stderr: string; out: string }

const DOC_V1 = '# String type\n\n`Upper` returns the upper-case form of a string.\n`Reverse` returns the string reversed by rune.\n';
const IMPL = [
  'package strs', '', 'import "strings"', '',
  '// Upper returns the upper-case form of s.',
  'func Upper(s string) string { return strings.ToUpper(s) }', '',
  '// Reverse returns s reversed by rune.',
  'func Reverse(s string) string {',
  '\tr := []rune(s)',
  '\tfor i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {',
  '\t\tr[i], r[j] = r[j], r[i]',
  '\t}',
  '\treturn string(r)',
  '}', '',
].join('\n');
const TESTS = [
  'package strs', '', 'import "testing"', '',
  'func TestBaseline(t *testing.T) {}', '',
  'func TestUpper(t *testing.T) {', '\tif Upper("ab") != "AB" {', '\t\tt.Fatal("upper")', '\t}', '}', '',
  'func TestReverse(t *testing.T) {', '\tif Reverse("héllo") != "olléh" {', '\t\tt.Fatal("reverse")', '\t}', '}', '',
].join('\n');

/** CJK built from code points (no literal CJK in this file): U+65E5 U+672C U+8A9E and its rune reversal. */
const CJK_WORD = String.fromCodePoint(0x65e5, 0x672c, 0x8a9e);
const CJK_WORD_REVERSED = String.fromCodePoint(0x8a9e, 0x672c, 0x65e5);
/** Old-PoS run 25: the task's own Unicode tests print CJK subtest names under go test -v. */
const UNICODE_TESTS = TESTS.replace('\tif Reverse("h\u00e9llo") != "oll\u00e9h" {',
  `\tt.Run("${CJK_WORD}", func(t *testing.T) {\n\t\tif Reverse("${CJK_WORD}") != "${CJK_WORD_REVERSED}" {\n\t\t\tt.Fatal("reverse runes")\n\t\t}\n\t})\n\tif Reverse("h\u00e9llo") != "oll\u00e9h" {`);

/** NX: extra items (each pinned to TestReverse) so the Story takes the normal channel. */
const UNICODE_EXTRA_ITEMS: ReadonlyArray<readonly [string, string]> = [
  ['CHK-003', 'Reverse keeps two-byte runes intact'], ['CHK-004', 'Reverse keeps three-byte runes intact'],
  ['CHK-005', 'Reverse keeps a one-rune string unchanged'], ['CHK-006', 'Reverse of a palindrome is the same string'],
];

export class Owner {
  readonly root: string;
  get worktree(): string { return join(this.root, '.worktrees', this.storyId); }
  readonly store: StoryStore;
  private readonly providerBin: string;
  private get installedCliBin(): string { return `${this.root}-installed-cli`; }
  private readonly scripts: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(readonly scenario: string, public storyId: string, machineEnv: NodeJS.ProcessEnv, readonly steps: Step[], readonly bareGitignore = false,
    private readonly fixtureOpts: { trackedGateFailureCounts?: boolean;
      /** Detection A/B switches merged into the prepared proof-or-stop.config.json (scenario AB). */
      config?: Record<string, unknown>;
      /** The Story branch has no implementation commit yet: DEV implementer runs write it (scenario AB V5). */
      unimplemented?: boolean;
      /** The verbatim request recorded at INIT (request.md + request.json), as story_create stores it (scenarios NI, NQ). */
      request?: string;
      /** NIN: no Story yet; the owner creates it with story_create from the main checkout (INIT driven by next). */
      fromScratch?: boolean;
      /** NX (old-PoS runs 20/25): TestReverse has a CJK subtest, so `go test -v` output (captured evidence) and the observed transcript carry CJK. */
      unicodeOutput?: boolean;
      /** NRS (old-PoS run 29): CODEX_HOME is a fixture directory, so a scripted run can be resumed (exec resume) by the managed worker. */
      codexHome?: boolean;
      /** NPX (old-PoS run 30): main already carries docs/types/array.md with wrong range examples (pre-existing doc drift, unrelated to the Story). */
      preexistingDoc?: boolean;
      /** NPO (old-PoS run 31): extra project files committed in the task baseline (e.g. the project's own evaluator a pin oracle runs). */
      baseFiles?: Record<string, string>;
      /** NLM4* / NLM-S* (lab lane-split): understanding.touchpoints name docs/types/string.md, so the docs lane is active (4 lanes). */
      docsTouchpoint?: boolean;
      /** NFS* (old-PoS run 110): the user-confirmed scope boundary story_create records (scope-boundary.json). */
      scopeBoundary?: { allowed: string[]; excluded: string[] } } = {}) {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), `e2e-r2d-${scenario}-`)));
    this.store = new StoryStore(this.root);
    this.providerBin = `${this.root}-provider`;
    this.scripts = join(this.providerBin, 'scripts');
    mkdirSync(this.scripts, { recursive: true });
    writeFakeCodex(this.providerBin, this.scripts);
    // The benchmark host has the installed `proof-or-stop` on PATH for the whole
    // run; a shim for this checkout's dist CLI stands in, on PATH from the first
    // call as on the host. Since the v2 environment identity (0ea79fb) receipts
    // bind only declared validate.env, variables named in the command, resolved
    // toolchain binaries (by realpath) and behavior-affecting families (locale,
    // TZ, GO*, NODE_*, ...); unrelated PATH entries and shell bookkeeping
    // (SHLVL, _, OLDPWD) no longer stale receipts. The shim still replays the
    // owner env exactly so a pasted hint runs with the same env the owner's
    // direct CLI calls use.
    mkdirSync(this.installedCliBin, { recursive: true });
    writeFileSync(join(this.installedCliBin, 'proof-or-stop'), [
      `#!${process.execPath}`,
      `const { spawnSync } = require('child_process'); const env = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(this.installedCliBin, 'env.json'))}, 'utf8'));`,
      `const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { stdio: 'inherit', env });`,
      'process.exit(r.status ?? 1);', '',
    ].join('\n'), { mode: 0o755 });
    this.env = {
      ...sanitizedFixtureChildEnvironment(machineEnv),
      PATH: `${this.providerBin}:${this.installedCliBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      PROOF_OR_STOP_AGENT: 'main',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: `e2e-review-to-done-owner-${scenario}`,
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: 'main',
      PROOF_OR_STOP_USAGE_LEDGER: '0',
      ...(this.fixtureOpts.codexHome ? { CODEX_HOME: join(this.providerBin, 'codex-home') } : {}),
    };
    writeFileSync(join(this.installedCliBin, 'env.json'), JSON.stringify(this.env));
    this.buildFixture();
  }

  cleanup(): void {
    rmSync(this.providerBin, { recursive: true, force: true });
    rmSync(this.installedCliBin, { recursive: true, force: true });
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Benchmark-shaped Go repo; Story in DEV with the implementation committed on story/<id>. */
  private buildFixture(): void {
    const { root, worktree, storyId } = this;
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Bench Owner']);
    git(root, ['config', 'user.email', 'owner@bench.invalid']);
    write(root, 'go.mod', 'module example.com/strs\n\ngo 1.21\n');
    write(root, 'strs/strs.go', 'package strs\n\n// Upper returns s unchanged (baseline bug).\nfunc Upper(s string) string { return s }\n');
    write(root, 'strs/strs_test.go', 'package strs\n\nimport "testing"\n\nfunc TestBaseline(t *testing.T) {}\n');
    write(root, 'docs/types/string.md', DOC_V1);
    if (this.fixtureOpts.preexistingDoc) write(root, PX_DOC_PATH, PX_DOC);
    for (const [rel, text] of Object.entries(this.fixtureOpts.baseFiles ?? {})) write(root, rel, text);
    // Scenario E: the task's own .gitignore, without PoS's runtime block or .worktrees/.
    // Run 11's task repo tracked the convergence-breaker gate counter (commit 6
    // of that run committed gate-failure-counts.json); D2 reproduces that.
    write(root, '.gitignore', this.bareGitignore ? 'bin/\n' : `.worktrees/\n${mergeRuntimeGitignore('')}${this.fixtureOpts.trackedGateFailureCounts ? '!**/gate-failure-counts.json\n' : ''}`);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'task baseline']);
    // Same shape as the bench adapter's prepare_workflow.py.
    write(root, 'proof-or-stop.config.json', `${JSON.stringify({
      artifactContract: 'none',
      validate: {
        commands: [{ id: 'benchmark-go-strs', command: 'go', args: ['test', '-v', './strs'], env: { CONTEXT: 'abs' }, focus: ['fast'], timeoutMs: 270000 }],
        env: { CONTEXT: 'abs' },
      },
      ...(this.fixtureOpts.config ?? {}),
      // Old-PoS runs 28/29: the production default staggers lane launches by 8 s
      // (2-CPU container throttling). The fixture has no CPU quota, so it launches
      // them at once unless a scenario sets the knob (NDG).
      review: { laneLaunchStaggerMs: 0, ...((this.fixtureOpts.config?.review as Record<string, unknown> | undefined) ?? {}) },
    }, null, 2)}\n`);
    git(root, ['add', 'proof-or-stop.config.json']);
    git(root, ['commit', '-qm', 'benchmark: configure PoS Go validation before Story']);
    if (this.fixtureOpts.fromScratch) return;

    const now = new Date().toISOString();
    const intent = (id: string, desc: string) => ({
      happy: [{ id, desc, type: 'logic' as const, priority: 'must' as const, scope: 'focused' as const, expectation: 'absolute_pass' as const, requirementSource: 'story' as const }],
      edge: [], adversarial: [],
    });
    // docs/types/string.md is deliberately in no item's files, so it is outside the scope contract.
    const files = { modify: ['strs/strs.go'], create: [], test: ['strs/strs_test.go'] };
    // Metadata as the INIT_CHECK commit leaves it on main; the phase is DEV.
    this.store.writeStory(storyId, {
      storyId, name: 'strs-upper-reverse', title: 'Implement Upper and Reverse string helpers',
      description: 'Implement strs.Upper and strs.Reverse as documented in docs/types/string.md.',
      type: 'bug', phase: 'DEV', priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
      worktree: { path: worktree, branch: `story/${storyId}`, createdAt: now },
      events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
    });
    this.store.writeChecklist(storyId, { items: [
      { id: 'CHK-001', title: 'Upper returns the upper-case form', context: 'strs.Upper returns its input unchanged; docs/types/string.md promises upper-casing.',
        userSees: 'go test -v ./strs -run TestUpper prints --- PASS: TestUpper', status: 'in_progress', startTime: now, endTime: null,
        files, verificationIntent: intent('CHK-001:happy:0', 'TestUpper passes') },
      { id: 'CHK-002', title: 'Reverse returns the rune-reversed string', context: 'strs.Reverse does not exist; docs/types/string.md promises rune reversal.',
        userSees: 'go test -v ./strs -run TestReverse prints --- PASS: TestReverse', status: 'in_progress', startTime: now, endTime: null,
        files, verificationIntent: intent('CHK-002:happy:0', 'TestReverse passes') },
      // NX: run 25 had 9 items. More than five puts the Story on the normal channel,
      // where the REVIEW→TEST preflight runs the English-only artifact gate (the
      // express channel skips it).
      ...(this.fixtureOpts.unicodeOutput ? UNICODE_EXTRA_ITEMS.map(([id, title]) => ({ id, title, context: 'strs.Reverse must reverse by rune, not by byte.',
        userSees: 'go test -v ./strs -run TestReverse prints --- PASS: TestReverse', status: 'in_progress' as const, startTime: now, endTime: null,
        files, verificationIntent: intent(`${id}:happy:0`, 'TestReverse passes') })) : []),
    ] });
    if (this.fixtureOpts.request) writeStoryRequest(this.store, { storyId, phase: 'INIT', request: this.fixtureOpts.request, source: 'harness' });
    if (this.fixtureOpts.scopeBoundary) {
      this.store.writeScopeBoundary(storyId, buildScopeBoundary({ storyId, mode: 'custom', allowed: this.fixtureOpts.scopeBoundary.allowed,
        excluded: this.fixtureOpts.scopeBoundary.excluded, confirmedBy: 'story_create' }));
    }
    if (this.fixtureOpts.docsTouchpoint) {
      this.store.writeUnderstanding(storyId, { task: 'Implement strs.Upper and strs.Reverse as documented.', outcome: 'Upper upper-cases and Reverse reverses by rune.',
        facts: [], constraints: [], unknowns: [], touchpoints: ['strs/strs.go', 'docs/types/string.md'], timestamp: now });
    }
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', `proof-or-stop: INIT_CHECK metadata ${storyId}`]);
    if (this.bareGitignore) {
      // Bench adapter: `proof-or-stop init --profile codex --asset-mode global-thin .`
      // in the main checkout. Its .gitignore merge stays an uncommitted main-checkout
      // edit (a frozen control file), so the Story branch never carries the block.
      const init = spawnSync(process.execPath, [CLI, 'init', '--profile', 'codex', '--asset-mode', 'global-thin', '.'], {
        cwd: root, encoding: 'utf8', env: this.env,
      });
      assert.equal(init.status, 0, `[${this.scenario}] init failed:\n${init.stdout}${init.stderr}`);
    }
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', '-q', worktree, `story/${storyId}`]);
    if (this.fixtureOpts.unimplemented) return;
    write(worktree, 'strs/strs.go', IMPL);
    write(worktree, 'strs/strs_test.go', this.fixtureOpts.unicodeOutput ? UNICODE_TESTS : TESTS);
    git(worktree, ['add', '-A']);
    git(worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'implement Upper and Reverse']);
  }

  /** One real CLI call from the Story worktree (the owner's cwd), timed and dirty-checked. */
  /** Owner-driver lab (NOD-W): set one variable of the env every CLI call of this owner gets. */
  setEnv(name: string, value: string): void { this.env[name] = value; }

  cli(command: string, payload: Record<string, unknown>, opts: { label?: string } = {}): CliResult {
    const label = opts.label ?? command;
    const cwd = existsSync(this.worktree) ? this.worktree : this.root;
    const before = this.publicationDirt();
    const started = Date.now();
    const run = spawnSync(process.execPath, [CLI, command, JSON.stringify(payload)], {
      cwd, encoding: 'utf8', env: this.env, maxBuffer: 64 * 1024 * 1024,
    });
    const ms = Date.now() - started;
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const exit = run.status ?? -1;
    const result = exit === 0 ? summarize(command, run.stdout ?? '') : firstError({ status: exit, stdout: run.stdout ?? '', stderr: run.stderr ?? '', out });
    const dirty = this.dirtyNote(label, before);
    this.steps.push({ scenario: this.scenario, label, ms, exit, result, dirty });
    if (process.env.E2E_R2D_VERBOSE) console.log(`--- ${label} exit=${exit} ${ms}ms\n${out.slice(0, 4000)}`);
    return { status: exit, stdout: run.stdout ?? '', stderr: run.stderr ?? '', out };
  }

  /**
   * Run a hinted command line literally through /bin/sh, as an owner pasting it
   * would, with the same env (including the installed-CLI shim on PATH).
   */
  shell(label: string, commandLine: string): CliResult {
    const before = this.publicationDirt();
    const started = Date.now();
    const run = spawnSync('/bin/sh', ['-c', commandLine], {
      cwd: this.worktree, encoding: 'utf8', env: this.env, maxBuffer: 64 * 1024 * 1024,
    });
    const ms = Date.now() - started;
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const exit = run.status ?? -1;
    const result = exit === 0 ? summarize(label, run.stdout ?? '') : firstError({ status: exit, stdout: run.stdout ?? '', stderr: run.stderr ?? '', out });
    this.steps.push({ scenario: this.scenario, label, ms, exit, result, dirty: this.dirtyNote(label, before) });
    if (process.env.E2E_R2D_VERBOSE) console.log(`--- ${label} exit=${exit} ${ms}ms\n${out.slice(0, 4000)}`);
    return { status: exit, stdout: run.stdout ?? '', stderr: run.stderr ?? '', out };
  }

  /** A node script from the Story worktree with the owner env (untimed; not an owner step). */
  node(args: string[]): CliResult {
    const run = spawnSync(process.execPath, args, { cwd: existsSync(this.worktree) ? this.worktree : this.root, encoding: 'utf8', env: this.env, maxBuffer: 64 * 1024 * 1024 });
    return { status: run.status ?? -1, stdout: run.stdout ?? '', stderr: run.stderr ?? '', out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
  }

  mustCli(command: string, payload: Record<string, unknown>, opts: { label?: string } = {}): CliResult {
    const run = this.cli(command, payload, opts);
    assert.equal(run.status, 0, `[${this.scenario}] ${opts.label ?? command} failed:\n${run.out.slice(-3000)}`);
    return run;
  }

  /** A managed implementer or finding-repair run of this Story that is not terminal yet. */
  private managedWriterInFlight(): boolean {
    const runsRoot = join(this.root, '.proof-or-stop', 'runtime', 'host-runs');
    if (!existsSync(runsRoot)) return false;
    return readdirSync(runsRoot).some(runId => {
      try {
        const spec = JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as { agentType?: string; storyId?: string };
        return spec.storyId === this.storyId && (spec.agentType === 'proof-or-stop-implementer' || spec.agentType === 'proof-or-stop-finding-repair')
          && !existsSync(join(runsRoot, runId, 'terminal.json'));
      } catch { return false; }
    });
  }

  /** Publication-set files of this Story that are dirty now (they make validate/done_prepare refuse). */
  private publicationDirt(): string[] {
    if (!existsSync(this.worktree)) return [];
    const storyRel = `.proof-or-stop/story/actives/${this.storyId}/`;
    // Untrimmed: git()'s trim() would eat the first row's leading status space
    // (" M path"), so slice(3) mangled exactly the first dirty path.
    return execFileSync('git', ['status', '--porcelain'], { cwd: this.worktree, encoding: 'utf8' }).split('\n')
      .filter(Boolean).map(line => line.slice(3))
      .filter(path => path.startsWith(storyRel) && PUBLICATION_SET.includes(path.slice(storyRel.length)));
  }

  /**
   * After every command: material (non-metadata) dirt blocks review_run_start,
   * PRE_CERT and DONE, so it must never appear (hard assert, real classifier).
   * Dirty publication-set metadata is recorded, and flagged WOULD-BLOCK when
   * it was already dirty before a step that refuses it.
   */
  private dirtyNote(label: string, dirtyBefore: string[]): string {
    if (!existsSync(this.worktree)) return 'worktree removed';
    resetConfigCache();
    const status = readGitStatusLines(this.worktree);
    assert.ok(status.ok, 'git status readable');
    const classification = classifyGitStatusRows(status.ok ? status.lines : [],
      classifierOptionsForCheck(loadConfig(this.worktree), this.storyId, new StoryStore(this.worktree), this.worktree));
    const blocking = isBlockingDirty(classification);
    // A detached managed implementer/finding-repair writes this worktree until
    // it commits; a call made meanwhile (ND-V5: `next` right after the grouped
    // implementer launch) sees its work in progress, not dirt the call left.
    if (blocking.blocked && this.managedWriterInFlight()) return `writer in flight: ${blocking.blockingPaths.join(',')}`;
    assert.equal(blocking.blocked, false, `[${this.scenario}] ${label} left blocking dirt: ${blocking.blockingPaths.join(', ')}`);
    const pub = this.publicationDirt();
    const notes: string[] = [];
    if (PUBLICATION_SENSITIVE.test(label) && dirtyBefore.length) notes.push(`WOULD-BLOCK(dirty before): ${dirtyBefore.map(base).join(',')}`);
    if (pub.length) notes.push(`dirty after: ${pub.map(base).join(',')}`);
    return notes.join('; ') || 'clean';
  }

  script(key: string, script: { final: string; commands?: string[][]; resume?: { final: string; commands?: string[][] }; fail?: string }): void {
    writeFileSync(join(this.scripts, `${key}.json`), JSON.stringify(script));
  }

  unscript(key: string): void {
    const path = join(this.scripts, `${key}.json`);
    if (existsSync(path)) unlinkSync(path);
  }

  providerCommandLog(): string {
    const path = join(this.scripts, 'commands.log');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  readEvidence(): Record<string, unknown> {
    return readEvidenceFor(this.worktree, this.storyId);
  }

  /** Scripts directory of the fake provider (run mode: per-run scripts and the resolver live here). */
  get scriptsDir(): string { return this.scripts; }

  /** NX: the fixture's go test -v output carries CJK subtest names. */
  get unicodeOutput(): boolean { return this.fixtureOpts.unicodeOutput === true; }

  phase(): string {
    return new StoryStore(existsSync(this.worktree) ? this.worktree : this.root).readStory(this.storyId).phase;
  }
}

/** The reviewer read manifest/log a managed review final proposal carries (bound to the persisted candidate route). */
function readEvidenceFor(worktree: string, storyId: string): Record<string, unknown> {
  const candidate = new StoryStore(worktree).readCandidateSpecSet(storyId);
  assert.ok(candidate, 'review_round_prepare persisted the candidate route');
  const filesReadFully = [...new Set(['strs/strs.go', 'strs/strs_test.go', 'docs/types/string.md', ...candidate.candidateSpecSet])].sort();
  return {
    readManifest: { filesReadFully, filesTriagedByName: [], scanEscalationReason: candidate.scanEscalationReason ?? null,
      candidateSpecSetDigest: candidate.artifactDigest, corpusDigest: candidate.corpusDigest },
    readLog: { filesReadFully, filesTriagedByName: [], summary: { readCount: filesReadFully.length, tokenCount: null }, digest: 'a'.repeat(64) },
  };
}

function base(path: string): string { return path.split('/').pop() ?? path; }

function summarize(command: string, stdout: string): string {
  const json = parseJson(stdout);
  if (json) {
    const run = json.run as Record<string, unknown> | undefined;
    const terminal = run?.terminal as Record<string, unknown> | null | undefined;
    if (run?.state) return `run ${String(run.state)}${terminal?.reason ? ` (${String(terminal.reason)})` : ''}`;
    if (json.status) return `status=${String(json.status)}${json.blockedAt ? ` blockedAt=${String(json.blockedAt)}` : ''}`;
    if (json.canAttemptDone !== undefined) return `canAttemptDone=${String(json.canAttemptDone)}`;
    if (json.reviewRuns) return `lanes=${Object.keys(json.reviewRuns as object).length}`;
  }
  const line = stdout.split('\n').find(l => /State: |advanced to|imported|saved|recorded|Critic receipt|^Checklist|Scope contract|Delivery check|Blockers: /.test(l));
  return line ?? `${command} ok`;
}

function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)) as Record<string, unknown>; } catch { return null; }
}

function firstError(run: CliResult): string {
  const line = run.out.split('\n').find(l => /^Error: |Cannot |refused|not allowed|\[[a-z_]+\]/.test(l)) ?? run.out.trim().split('\n').at(-1) ?? '';
  return line.replace(/^Error: /, '').slice(0, 260);
}

/**
 * The provider seam. host_run starts the `codex` CLI in JSON mode with the
 * prompt on stdin and `-C <cwd>`. This stand-in finds the script whose key (a
 * reviewRunId, or the delivery role name) occurs in the prompt, runs the
 * script's commands with the environment the managed worker gave it (a real
 * reviewer runs them as tool calls), and prints the final message as the Codex
 * JSON event stream.
 */
function writeFakeCodex(bin: string, scripts: string): void {
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
const dir = ${JSON.stringify(scripts)};
let input = ''; process.stdin.on('data', d => { input += d; }); process.stdin.on('end', () => {
  const emit = e => process.stdout.write(JSON.stringify(e) + '\\n');
  // Old-PoS run 29 (NRS): a run with a byrun/<runId>.resume.json script is resumable
  // (Codex exec resume <thread>): it gets a UUID thread and a session file in CODEX_HOME.
  const resume = process.argv[2] === 'exec' && process.argv[3] === 'resume';
  const announceThread = () => {
    const runIdForThread = process.env.LATTICE_MANAGED_HOST_RUN_ID || '';
    const resumable = !!runIdForThread && fs.existsSync(path.join(dir, 'byrun', runIdForThread + '.resume.json')) && !!process.env.CODEX_HOME;
    const thread = resumable ? '019a0000-0000-7000-8000-' + require('crypto').createHash('sha256').update(runIdForThread).digest('hex').slice(0, 12) : 'fake-codex-' + process.pid;
    if (resumable) {
      const sessions = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '09');
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, 'rollout-2026-10-09T00-00-00-' + thread + '.jsonl'), '{}\\n');
    }
    emit({ type: 'thread.started', thread_id: thread });
  };
  // Every provider prompt, by managed run id (A/B scenarios assert what the sealed prompt said).
  if (process.env.LATTICE_MANAGED_HOST_RUN_ID) {
    fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompts', process.env.LATTICE_MANAGED_HOST_RUN_ID + (resume ? '.resume.txt' : '.txt')), input);
  }
  emit({ type: 'turn.started' });
  // Run mode (next --run launches managed runs itself, resolver.json present):
  // the script for this exact run id (byrun/<runId>.json), written by the
  // harness resolver from the run's spec and the Story state; a static key only
  // when that fails (a critic prompt names the lane ReviewRun ids, so a static
  // lane key would match it). Otherwise the static key whose name occurs in the prompt.
  const runId = process.env.LATTICE_MANAGED_HOST_RUN_ID || '';
  const byRun = runId ? path.join(dir, 'byrun', runId + (resume ? '.resume.json' : '.json')) : '';
  let file = byRun && fs.existsSync(byRun) ? byRun : '';
  if (!file && byRun && fs.existsSync(path.join(dir, 'resolver.json'))) {
    const resolver = JSON.parse(fs.readFileSync(path.join(dir, 'resolver.json'), 'utf8'));
    const r = spawnSync(resolver.argv[0], [...resolver.argv.slice(1), runId], { encoding: 'utf8', env: process.env });
    if (r.status === 0 && fs.existsSync(byRun)) file = byRun;
    else fs.writeFileSync(path.join(dir, 'resolver-failed-' + process.pid + '.txt'), (r.stdout || '') + (r.stderr || ''));
  }
  const key = file ? undefined : fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'resolver.json').find(f => input.includes(f.slice(0, -5)));
  if (key) file = path.join(dir, key);
  if (!file) { fs.writeFileSync(path.join(dir, 'unmatched-' + process.pid + '.txt'), input); process.exit(3); }
  const script = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Lab run89 (NFR / NRX): a key script with a \`resume\` turn makes this run resumable; the managed worker's
  // report follow-up (exec resume) then plays that turn.
  if (!resume && script.resume && runId) {
    fs.mkdirSync(path.join(dir, 'byrun'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'byrun', runId + '.resume.json'), JSON.stringify(script.resume));
  }
  announceThread();
  // Lab run131 (NSL): a provider stall before any item (thread.started printed, then nothing).
  if (script.stallMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, script.stallMs);
  // EXPERIMENTAL A/B review.deltaRounds (ND-DR*): a confirmation lane answers the
  // check items its sealed prompt lists, as a reviewer reading the prompt would.
  if (script.delta && input.includes('--- BEGIN DELTA ROUND CONFIRMATION')) {
    const block = input.slice(input.indexOf('--- BEGIN DELTA ROUND CONFIRMATION'), input.indexOf('--- END DELTA ROUND CONFIRMATION'));
    const listAfter = header => { const at = block.indexOf(header); if (at < 0) return []; const out = []; for (const line of block.slice(at).split('\\n').slice(1)) { if (!line.startsWith('- ')) { if (line.startsWith('  ')) continue; break; } out.push(line.slice(2).split(/\\s/)[0]); } return out; };
    const items = listAfter('Check items');
    const resolved = listAfter('Resolved findings to re-verify');
    const selector = script.delta.mode === 'bad-rerun' ? '--- PASS: TestNoSuchCase' : script.delta.selector;
    // Old-PoS run 52 (ND-DRF*): a confirmation lane that FINDS something answers with a findings verdict and the
    // same coverage lines; 'findings-flat' writes them on one line (run 52 RR-012), 'findings-gap' also leaves one item unchecked.
    const findings = script.delta.findings || null;
    const gapped = script.delta.mode === 'gap' || (script.delta.mode === 'findings-gap' && findings);
    const lines = [...items.map(item => '[checked] ' + item + ' :: scripted check of the delta'),
      ...resolved.map(id => '[reverified] ' + id + ' :: ' + script.delta.command + ' :: ' + selector),
      ...(gapped ? ['[gap] ' + items[0] + ' :: scripted gap: not checked'] : [])];
    const final = JSON.parse(script.final);
    if (findings) {
      final.conclusion = 'findings';
      final.findings = findings;
      final.note = 'Scripted confirmation lane: one new finding on the delta. ' + lines.join(script.delta.mode === 'findings-flat' ? ' ' : '\\n');
    } else {
      final.note = final.note + '\\n' + lines.join('\\n');
    }
    script.final = JSON.stringify(final);
    fs.appendFileSync(path.join(dir, 'delta-notes.log'), JSON.stringify({ runId: process.env.LATTICE_MANAGED_HOST_RUN_ID || '', mode: script.delta.mode, items, resolved }) + '\\n');
  }
  // EXPERIMENTAL A/B review.laneMerge (NLM*): the merged session answers the checkpoints its sealed prompt lists
  // (specific evidence + one [read] line per dimension), leaving out one dimension ('<dimension>'), marking one
  // checkpoint [gap] ('gap:<dimension>'), writing generic evidence ('generic:<dimension>', old-PoS run 64 R1) or no
  // [read] line ('unread:<dimension>') for it when scripted so. Lab lane-split: a session reports only the findings
  // tagged with one of ITS dimensions (two sessions run per round under review.laneMerge=split).
  const merged = input.includes('--- BEGIN MERGED REVIEW DIMENSIONS');
  if (script.merge && merged) {
    const block = input.slice(input.indexOf('--- BEGIN MERGED REVIEW DIMENSIONS'), input.indexOf('--- END MERGED REVIEW DIMENSIONS'));
    const items = [...block.matchAll(/^- ([a-z-]+:[a-z-]+) — /gm)].map(match => match[1]);
    const dims = [...new Set(items.map(item => item.split(':')[0]))];
    const uncovered = (script.merge.uncovered || []).concat([]).filter(row => dims.includes(row.split(':').pop()));
    const modeOf = dim => { const row = uncovered.find(entry => entry.split(':').pop() === dim); return !row ? '' : row.includes(':') ? row.split(':')[0] : 'omit'; };
    const lines = items.filter(item => modeOf(item.split(':')[0]) !== 'omit').map(item => modeOf(item.split(':')[0]) === 'generic'
      ? '[checked] ' + item + ' :: scripted: mapped every intent, all exercised and pass'
      : '[checked] ' + item + ' :: scripted: strs/strs.go:3 read; \`go test ./strs\` -> ok strs');
    for (const dim of dims) {
      if (modeOf(dim) === 'gap') lines.push('[gap] ' + items.find(item => item.startsWith(dim + ':')) + ' :: scripted gap: not checked');
      if (modeOf(dim) !== 'unread' && modeOf(dim) !== 'omit') lines.push('[read] ' + dim + ' :: strs/strs.go, strs/strs_test.go');
    }
    const own = (script.merge.findings || []).filter(finding => { const tag = /^\\[dimension:([a-z-]+)\\]/.exec(String(finding.desc)); return !tag || dims.includes(tag[1]); });
    const final = JSON.parse(script.final);
    if (own.length) {
      final.conclusion = 'findings';
      final.findings = own;
      final.note = 'Scripted merged session: findings of its dimensions.\\n' + lines.join('\\n');
    } else {
      final.note = final.note + '\\n' + lines.join('\\n');
    }
    script.final = JSON.stringify(final);
    fs.appendFileSync(path.join(dir, 'merge-notes.log'), JSON.stringify({ runId, items, uncovered }) + '\\n');
  }
  // Lab lane-split (NLM4*, NLM-S): scripted model latency of a review session, base + per dimension it carries
  // (a merged session: its '### Dimension' sections; an ordinary lane: 1), so a round's wall shows whether
  // the sessions of a round overlap (parallel) or queue (serial).
  if (script.latency) {
    if (script.latency.itemFirst) emit({ type: 'item.completed', item: { id: 'reasoning_0', type: 'reasoning', text: 'Reading the diff.' } });
    const sections = merged ? (input.slice(input.indexOf('--- BEGIN MERGED REVIEW DIMENSIONS')).match(/^### Dimension \\d+\\/\\d+: /gm) || []).length : 1;
    const ms = script.latency.baseMs + script.latency.perDimensionMs * Math.max(1, sections);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    fs.appendFileSync(path.join(dir, 'latency.log'), JSON.stringify({ runId, sections, ms }) + '\\n');
  }
  const c = process.argv.indexOf('-C'); const cwd = c > 0 ? process.argv[c + 1] : process.cwd();
  (script.commands || []).forEach((argv, index) => {
    // Codex exec --json announces each command (item.started) before it runs (old-PoS run 27: per-command wall time).
    emit({ type: 'item.started', item: { id: 'cmd_' + index, type: 'command_execution', command: argv.slice(2, 3).join(' '), status: 'in_progress' } });
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', env: process.env });
    const out = (r.stdout || '') + (r.stderr || '');
    fs.appendFileSync(path.join(dir, 'commands.log'), JSON.stringify({ argv: argv.slice(2, 3), status: r.status, out: out.slice(-1500) }) + '\\n');
    emit({ type: 'item.completed', item: { id: 'cmd_' + index, type: 'command_execution', command: argv.slice(2, 3).join(' '), aggregated_output: out.slice(-2000), exit_code: r.status } });
  });
  // Lab run137 (NGX): a provider turn that dies (run 137 2373e8ff: an upstream error after 311 s, exit 1, no commit).
  if (script.fail) {
    emit({ type: 'error', message: script.fail });
    emit({ type: 'turn.failed', error: { message: script.fail } });
    process.exit(1);
  }
  emit({ type: 'item.completed', item: { type: 'agent_message', text: script.final } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 } });
});
`, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Owner flow segments, in the order the benchmark owner follows them

function devToReview(o: Owner): void {
  const id = o.storyId;
  o.mustCli('dev_memory_preflight_ack', { storyId: id });
  o.mustCli('scope_contract_init_from_plan', { storyId: id });
  o.mustCli('verification_evidence_add', { storyId: id, itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'logic_test',
    command: 'go test -v ./strs -run TestUpper', selector: '--- PASS: TestUpper', note: 'Pinned focused go test proves Upper upper-cases its input.' }, { label: 'verification_evidence_add CHK-001' });
  o.mustCli('verification_evidence_add', { storyId: id, itemId: 'CHK-002', intentRef: 'CHK-002:happy:0', kind: 'logic_test',
    command: 'go test -v ./strs -run TestReverse', selector: '--- PASS: TestReverse', note: 'Pinned focused go test proves Reverse reverses by rune.' }, { label: 'verification_evidence_add CHK-002' });
  o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-001', status: 'done' }, { label: 'checklist_update CHK-001 done' });
  o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-002', status: 'done' }, { label: 'checklist_update CHK-002 done' });
  o.mustCli('story_advance', { storyId: id, phase: 'REVIEW' }, { label: 'story_advance REVIEW' });
  assert.equal(o.phase(), 'REVIEW');
}

function short(lane: string): string { return lane.replace('proof-or-stop-review-', ''); }

function launchManagedReview(o: Owner, lane: string, reviewRunId: string, envelope: Record<string, unknown>): string {
  o.script(reviewRunId, { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId: o.storyId, providerAgent: lane, lane, reviewRunId, ...envelope, ...o.readEvidence() }) });
  const launched = o.mustCli('host_run', { host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort, storyId: o.storyId,
    agentType: lane, reviewRunId, lane, managedReview: true, detach: true, json: true }, { label: `host_run --managedReview ${short(lane)}` });
  return String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
}

function waitTerminal(o: Owner, label: string, runId: string): { state: string; reason: string; receiptId: string } {
  const status = o.mustCli('host_run_status', { runId, untilTerminal: true, json: true }, { label: `host_run_status ${label}` });
  const json = parseJson(status.stdout)!;
  const run = json.run as Record<string, unknown>;
  const terminal = run.terminal as Record<string, unknown> | null;
  return { state: String(run.state), reason: String(terminal?.reason ?? ''), receiptId: String((json.receipt as Record<string, unknown> | undefined)?.receiptId ?? '') };
}

type LaneEnvelope = (lane: string) => Record<string, unknown>;
const PASS_ENVELOPE: LaneEnvelope = lane => ({ conclusion: 'pass', note: `Scripted ${lane} pass: reviewed strs.go Upper/Reverse and their focused tests; no blocking issue.` });

function reviewRound(o: Owner, envelopeFor: LaneEnvelope = PASS_ENVELOPE): void {
  const id = o.storyId;
  // The Go task repo has no requirements corpus: the framework routes with an
  // automatic full-scan reason, so one call suffices (round-prepare-no-corpus).
  const prepared = o.mustCli('review_round_prepare', { storyId: id, json: true });
  assert.match(new StoryStore(o.worktree).readCandidateSpecSet(id)?.scanEscalationReason ?? '', /^automatic: no requirements corpus in project /,
    'no-corpus route records the automatic full-scan reason');
  const reviewRuns = parseJson(prepared.stdout)!.reviewRuns as Record<string, string>;
  assert.ok(Object.keys(reviewRuns).length >= 1, 'at least one launchable lane');
  // Controller order: launch every lane, then wait for all, then import.
  const launched = Object.entries(reviewRuns).map(([lane, reviewRunId]) => ({ lane, reviewRunId, receiptId: '',
    runId: launchManagedReview(o, lane, reviewRunId, envelopeFor(lane)) }));
  for (const run of launched) {
    const terminal = waitTerminal(o, short(run.lane), run.runId);
    assert.equal(terminal.state, 'completed', `${run.lane} managed review terminal ${terminal.state} (${terminal.reason})`);
    run.receiptId = terminal.receiptId;
  }
  for (const run of launched) {
    o.mustCli('managed_review_evidence_import', { runId: run.runId, receiptId: run.receiptId }, { label: `managed_review_evidence_import ${short(run.lane)}` });
    o.unscript(run.reviewRunId);
  }
}

interface InventoryOpts {
  /** Critic dispositions (default: none, i.e. a zero-finding wave). */
  dispositions?: Record<string, unknown>[];
  /** Label suffix for the timeline. */
  tag?: string;
}

/** begin -> critic (managed) -> returns the epoch id; finalize is the caller's. */
function inventoryCritic(o: Owner, opts: InventoryOpts = {}): string {
  const id = o.storyId;
  const tag = opts.tag ? ` ${opts.tag}` : '';
  const begun = o.mustCli('review_inventory_begin', { storyId: id }, { label: `review_inventory_begin${tag}` });
  const epochId = begun.stdout.match(/Review inventory epoch: (\S+)/)?.[1];
  assert.ok(epochId, `inventory epoch id printed:\n${begun.out.slice(-1500)}`);
  const status = o.mustCli('review_inventory_status', { storyId: id }, { label: `review_inventory_status${tag}` });
  assert.match(status.stdout, /REVIEW_INVENTORY_CRITIC_INCOMPLETE/, 'lanes complete, critic pending');
  const critic = MANAGED_INVENTORY_CRITIC_LANE;
  o.mustCli('dispatch', { storyId: id, agentType: critic, reviewPurpose: 'inventory-completeness', inventoryEpochId: epochId, summary: true }, { label: `dispatch critic${tag}` });
  o.mustCli('review_run_start', { storyId: id, agent: critic, lane: critic, reviewPurpose: 'inventory-completeness', inventoryEpochId: epochId, summary: true }, { label: `review_run_start critic${tag}` });
  const criticRun = new StoryStore(o.worktree).readReviewRuns(id).runs.at(-1)!.reviewRunId;
  const dispositions = opts.dispositions ?? [];
  const runId = launchManagedReview(o, critic, criticRun, { conclusion: 'pass',
    note: dispositions.length ? 'Scripted inventory critic: dispositioned every verified finding of this wave.' : 'Scripted inventory critic: every required lane passed with zero findings; nothing to disposition.',
    inventoryCritic: { epochId, wave: 1, findingDispositions: dispositions } });
  const terminal = waitTerminal(o, `critic${tag}`, runId);
  assert.equal(terminal.state, 'completed', `critic terminal ${terminal.state} (${terminal.reason})`);
  o.mustCli('managed_review_evidence_import', { runId, receiptId: terminal.receiptId }, { label: `managed_review_evidence_import critic${tag}` });
  o.unscript(criticRun);
  return epochId!;
}

function inventory(o: Owner): void {
  inventoryCritic(o);
  const finalized = o.mustCli('review_inventory_finalize', { storyId: o.storyId });
  assert.match(finalized.stdout, /State: FINALIZED/);
}

function precertToTest(o: Owner): void {
  const id = o.storyId;
  o.mustCli('validate', { story: id, focus: 'fast', json: true }, { label: 'validate --focus=fast' });
  const begin = o.mustCli('certification_window_begin', { storyId: id });
  assert.match(begin.stdout, /State: ADMITTED/, begin.out);
  o.mustCli('validate', { story: id, json: true }, { label: 'validate (routine)' });
  const status = o.mustCli('certification_window_status', { storyId: id });
  assert.match(status.stdout, /Next: proof-or-stop story_advance --storyId=\S+ --phase=TEST/, status.out);
  o.mustCli('story_advance', { storyId: id, phase: 'TEST' }, { label: 'story_advance TEST' });
  assert.equal(o.phase(), 'TEST');
}

function liveSmoke(o: Owner): void {
  const run = o.mustCli('live_smoke_transcript', { storyId: o.storyId, capture: 'go test -v ./strs', write: true });
  assert.match(run.stdout, /\[PASS\] done\.live-smoke-transcript/, `live smoke did not pass:\n${run.out.slice(0, 1500)}`);
}

function deliveryReview(o: Owner, docsPromises: Record<string, unknown>[], opts: { probeFirst?: boolean } = {}): { state: string; reason: string; commandLog: string } {
  // Run 14: the delivery reviewer first sent waiverReason:null (refused), then
  // "probed" with a junk minimal payload that consumed its one-shot invocation
  // and moved HEAD by a metadata commit, so the real seal was refused. With
  // probeFirst the scripted reviewer repeats that sequence; the real write
  // must re-seal (same live run) and become the delivery-check.
  const probe = {
    storyId: o.storyId,
    docsPromises: [{ docPath: 'a#b', promise: 'p', verifiedBy: 'diff', evidence: 'e', waiverReason: null }],
    realMachineTests: [{ featureId: 'CHK-001', transcript: 't', waiverReason: null }],
    closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'minimal smoke test of payload shape' },
  };
  const payload = {
    storyId: o.storyId, docsPromises,
    realMachineTests: [
      { featureId: 'CHK-001', transcript: 'go test -v ./strs -run TestUpper -> --- PASS: TestUpper' },
      { featureId: 'CHK-002', transcript: 'go test -v ./strs -run TestReverse -> --- PASS: TestReverse' },
    ],
    closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'Both string helpers are implemented and verified by focused go tests.' },
    agentId: DELIVERY,
  };
  o.script(DELIVERY, { commands: [
    ...(opts.probeFirst ? [[process.execPath, CLI, 'delivery_check_set', JSON.stringify(probe)]] : []),
    [process.execPath, CLI, 'delivery_check_set', JSON.stringify(payload)],
  ], final: 'Delivery review complete; delivery_check_set recorded.' });
  const launched = o.mustCli('host_run', { host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort, storyId: o.storyId,
    agentType: DELIVERY, managedDispatch: true, detach: true, json: true }, { label: 'host_run --managedDispatch delivery' });
  const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
  const terminal = waitTerminal(o, 'delivery', runId);
  o.unscript(DELIVERY);
  if (opts.probeFirst) {
    const statuses = o.providerCommandLog().trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as { status: number | null }).status).slice(-2);
    assert.deepEqual(statuses, [0, 0], `delivery probe-then-seal: both delivery_check_set calls of the same run must succeed (re-seal):\n${o.providerCommandLog().slice(-3000)}`);
    const sealed = new StoryStore(o.worktree).readDeliveryCheck(o.storyId);
    assert.equal(sealed?.docsPromises.length, docsPromises.length, 'the real (second) delivery_check_set re-sealed the delivery-check');
  }
  return { state: terminal.state, reason: terminal.reason, commandLog: o.providerCommandLog() };
}

function authoredCloseout(o: Owner): void {
  const id = o.storyId;
  o.mustCli('dev_memory_finish_decision', { storyId: id, decision: 'no-reusable-lesson', reason: 'Harness fixture: trivial string helpers, no reusable lesson.' });
  o.mustCli('summary_set', { storyId: id, changes: 'strs/strs.go: Upper now upper-cases; new Reverse reverses by rune.', usage: 'strs.Upper("ab") == "AB"; strs.Reverse("héllo") == "olléh"',
    expectedOutcome: 'go test -v ./strs prints --- PASS: TestUpper and --- PASS: TestReverse', actualTranscript: 'go test -v ./strs: --- PASS: TestUpper, --- PASS: TestReverse, ok',
    outcomeDiff: 'no difference', acceptanceVerdict: 'accepted', outcomeKind: 'success', limitations: 'none — fully covered',
    pitfalls: 'Harness fixture; no retries were needed.' });
}

function closureRow(o: Owner, label: string, rowId: string): Record<string, unknown> | undefined {
  const closure = o.mustCli('done_closure', { storyId: o.storyId, json: true }, { label });
  const rows = (parseJson(closure.stdout)?.blockers ?? []) as Record<string, unknown>[];
  return rows.find(row => row.id === rowId);
}

// ---------------------------------------------------------------------------
// Scenarios

interface Outcome { name: string; status: 'PASS' | 'FAIL' | 'OBSERVED'; lines: string[] }

function scenarioA(machineEnv: NodeJS.ProcessEnv, steps: Step[], bare = false): { a: Outcome; c: Outcome } {
  const aName = bare ? 'E bare task .gitignore (no runtime block): REVIEW -> TEST -> DONE' : 'A happy path REVIEW -> TEST -> DONE';
  const o = new Owner(bare ? 'E' : 'A', bare ? 'B-e2e4' : 'B-e2e0', machineEnv, steps, bare);
  const c: Outcome = { name: 'C single host: one framework step (next -> quorum_submit singleHost) satisfies the review assurance floor before DONE', status: 'OBSERVED', lines: [] };
  try {
    devToReview(o);
    reviewRound(o);
    inventory(o);
    precertToTest(o);
    liveSmoke(o);
    const delivery = deliveryReview(o, [
      { docPath: 'docs/types/string.md', promise: 'Upper returns the upper-case form of a string.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestUpper', evidence: '--- PASS: TestUpper' },
      { docPath: 'docs/types/string.md', promise: 'Reverse returns the string reversed by rune.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestReverse', evidence: '--- PASS: TestReverse' },
    ], { probeFirst: !bare });
    assert.equal(delivery.state, 'completed', `delivery reviewer terminal ${delivery.state} (${delivery.reason})\n${delivery.commandLog}`);
    if (!bare) c.lines.push('delivery reviewer probe-then-seal (run 14): junk probe write, then the real write re-sealed by the same live run -> completed');
    authoredCloseout(o);

    // --- Scenario C: what a single-host owner must still produce before DONE.
    const floor = closureRow(o, 'done_closure (before host verdict)', 'review-assurance-floor');
    const escalation = closureRow(o, 'done_closure (escalation row)', 'review-escalation');
    const floorReason = String(floor?.reason ?? '');
    const hinted = floorReason.match(/(proof-or-stop autopilot_review_submit [^#\n]*?--storyFilesHash=\S+)/)?.[1] ?? '';
    assert.ok(hinted, `C: the floor names no runnable proof-or-stop autopilot_review_submit writer:\n${floorReason.slice(0, 2000)}`);
    assert.doesNotMatch(floorReason, /bin\/proof-or-stop\.js/, 'C: floor hints must not point at a checkout-relative bin/ wrapper');
    c.lines.push(`done_closure review-assurance-floor: status=${String(floor?.status)} blocking=${String(floor?.blocking)} code=${floorReason.match(/\[(review_assurance_floor_[a-z_]+)\]/)?.[1] ?? 'n/a'}`);
    c.lines.push(`  "${floorReason.match(/local rounds: [0-9/]+ with [0-9]+ PASS host/)?.[0] ?? '?'}" although 3 managed lanes + critic passed: only autopilot_review_submit host verdicts count (core/review-assurance-floor.ts:912-917)`);
    c.lines.push(`done_closure review-escalation: status=${String(escalation?.status)} "${String(escalation?.reason ?? '').slice(0, 80)}"`);
    c.lines.push(`  hinted writer: ${hinted.slice(0, 110)}...`);
    assert.ok(hinted.includes(`--materialDigest=${currentMaterialHash(o.worktree, 'HEAD', o.worktree)}`), 'C: hint carries the current materialDigest');
    assert.ok(hinted.includes(`--storyFilesHash=${currentStoryFilesHash(o.worktree, 'HEAD', o.worktree)}`), 'C: hint carries the current storyFilesHash');
    o.mustCli('review_escalation_status', { storyId: o.storyId });
    // Run 14: no discovery dance. The guidance leads with the one-step single-host
    // writer and next names it as a framework step, filled in.
    assert.match(floorReason, /proof-or-stop quorum_submit '\{"storyId":"[^"]+","singleHost":true\}'/, 'C: the floor guidance names the one-step single-host writer');
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label: 'next (single host)' });
    const named = parseJson(asked.stdout) as { kind?: string; reason?: string; cli?: { command: string; payload: Record<string, unknown> } } | null;
    assert.equal(named?.kind, 'framework', `C: next names the single-host step as a framework step:\n${asked.out.slice(-1500)}`);
    assert.equal(named?.cli?.command, 'quorum_submit', `C: next names quorum_submit singleHost: ${String(named?.reason)}`);
    assert.equal(named?.cli?.payload.singleHost, true, 'C: next fills singleHost:true');
    const submit = o.cli('quorum_submit', { ...named!.cli!.payload, json: true }, { label: 'quorum_submit singleHost (next)' });
    assert.equal(submit.status, 0, `C: quorum_submit singleHost failed:\n${submit.out.slice(-2000)}`);
    const single = parseJson(submit.stdout) as { roundsRecorded?: number; satisfied?: boolean; probeId?: string | null; fallbackId?: string | null } | null;
    c.lines.push(`next -> framework quorum_submit {singleHost:true}: rounds=${String(single?.roundsRecorded)} probe=${String(single?.probeId)} fallback=${String(single?.fallbackId)} satisfied=${String(single?.satisfied)}`);
    assert.equal(single?.satisfied, true, 'C: one step satisfies the single-host review assurance');
    assert.equal(single?.roundsRecorded, 1, 'C: the one-local-round floor records exactly one round (the rule is not weakened or inflated)');
    assert.equal(single?.fallbackId ?? null, null, 'C: no degraded fallback is recorded when no rule needs it');
    const floorAfter = closureRow(o, 'done_closure (after host verdict)', 'review-assurance-floor');
    c.lines.push(`done_closure review-assurance-floor after the single-host step: status=${String(floorAfter?.status)}`);
    assert.notEqual(floorAfter?.blocking, true, 'one local host verdict satisfies the one-local-round floor');
    const again = o.cli('quorum_submit', { storyId: o.storyId, singleHost: true, json: true }, { label: 'quorum_submit singleHost (again)' });
    assert.equal(again.status, 0, `C: a repeated single-host step is a no-op:\n${again.out.slice(-1500)}`);
    assert.equal((parseJson(again.stdout) as { roundsRecorded?: number } | null)?.roundsRecorded, 0, 'C: nothing missing -> nothing recorded');
    if (!bare) c.status = 'PASS';
    const eventsDirty = git(o.worktree, ['status', '--porcelain', '--', `.proof-or-stop/story/actives/${o.storyId}/process-events.jsonl`]) !== '';
    c.lines.push(`single-host step leaves process-events.jsonl uncommitted: ${eventsDirty ? 'yes' : 'no'}`);
    assert.equal(eventsDirty, false, 'C: the single-host step must commit its host_verdict events (else done_prepare refuses VALIDATION_PUBLICATION_NOT_READY)');

    // done_prepare, as the floor guidance says to rerun it after the writer ran.
    const prepare = o.cli('done_prepare', { storyId: o.storyId, json: true });
    const prepared = parseJson(prepare.stdout);
    c.lines.push(`done_prepare after the host verdict: exit ${prepare.status} status=${String(prepared?.status)} blockedAt=${String(prepared?.blockedAt ?? '-')}`);
    if (prepared?.blockedAt) c.lines.push(`  ${String(prepared.reason).slice(0, 230)} (handlers/verifier.ts:2214-2239)`);
    assert.doesNotMatch(prepare.out, /VALIDATION_PUBLICATION_NOT_READY/, 'C: done_prepare after the host verdict must not refuse on unpublished metadata');
    // E: projected controller hooks and PoS runtime files are framework-owned, never dirt for done_prepare.
    if (bare) assert.notEqual(prepared?.blockedAt, 'cleanTree', `E: done_prepare refused cleanTree on framework-owned files:\n${prepare.out.slice(-2000)}`);

    const done = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE' });
    assert.equal(done.status, 0, `A: story_advance DONE refused:\n${done.out.slice(-3000)}`);
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE', 'main store records DONE');
    assert.match(git(o.root, ['log', '--format=%s', '-3', 'main']), new RegExp(`merge: ${o.storyId} `), 'story branch merged into main');
    assert.match(readFileSync(join(o.root, 'strs/strs.go'), 'utf8'), /func Reverse/, 'story code is on main');
    assert.equal(existsSync(o.worktree), false, 'story worktree removed');
    assert.equal(git(o.root, ['branch', '--list', `story/${o.storyId}`]), '', 'story branch deleted');
    const a: Outcome = { name: aName, status: 'PASS', lines: [
      `DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`,
      ...(bare ? [`main checkout status after DONE: ${JSON.stringify(git(o.root, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean))}`] : []),
      ...(prepared?.blockedAt ? [`note: done_prepare BLOCKED at ${String(prepared.blockedAt)}, story_advance DONE still passed (see C)`] : []),
      ...(prepared?.blockedAt ? [`  done_prepare reason: ${String(prepared.reason).slice(0, 200)} files=${JSON.stringify(prepared.files ?? [])}`] : []),
    ] };
    o.cleanup();
    return { a, c };
  } catch (error) {
    console.log(`${o.scenario} fixture retained for diagnosis: ${o.root}`);
    return { a: { name: aName, status: 'FAIL', lines: [error instanceof Error ? error.message : String(error)] }, c };
  }
}

function scenarioB(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  // Run 10 dead end, fixed on bench/speed-int by fix 28 (classifyScopePath
  // admits .md/.mdx/.rst/.adoc docs by default unless protected/excluded).
  // Expected now: the reviewer-required docs update goes TEST -> DEV -> REVIEW
  // with no PLAN rollback, and the Story reaches DONE.
  const name = 'B delivery reviewer requires a docs update outside the scope contract (run 10)';
  const o = new Owner('B', 'B-e2e1', machineEnv, steps);
  const lines: string[] = [];
  const verifiedPromises = [
    { docPath: 'docs/types/string.md', promise: 'Upper returns the Unicode upper-case form of a string (strings.ToUpper).', status: 'verified', verifiedBy: 'go test -v ./strs -run TestUpper', evidence: '--- PASS: TestUpper' },
    { docPath: 'docs/types/string.md', promise: 'Reverse returns the string reversed by rune.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestReverse', evidence: '--- PASS: TestReverse' },
  ];
  try {
    devToReview(o);
    reviewRound(o);
    inventory(o);
    precertToTest(o);
    liveSmoke(o);
    // The reviewer finds the docs promise stale: the code maps Unicode letters, the doc must say so.
    const delivery = deliveryReview(o, [
      // status=unverified may carry no evidence/verifiedBy (core/delivery-promise-outcome.ts:103-126).
      { docPath: 'docs/types/string.md', promise: 'Upper returns the upper-case form of a string; the doc must state that strings.ToUpper also maps Unicode letters.', status: 'unverified' },
      verifiedPromises[1]!,
    ]);
    assert.equal(delivery.state, 'completed', `delivery reviewer terminal ${delivery.state} (${delivery.reason})\n${delivery.commandLog}`);
    authoredCloseout(o);
    const refused = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE (unverified promise)' });
    assert.notEqual(refused.status, 0, 'an unverified docs promise must block DONE');
    assert.match(refused.out, /\[unverified_promise\]/);
    lines.push(`story_advance DONE with the unverified docs promise: refused [unverified_promise] (core/machine.ts:1077), as expected`);
    const waiver = o.cli('delivery_waiver_add', { storyId: o.storyId, promiseId: 'docs/types/string.md',
      waiverReason: 'Attempting the hinted waiver path on a managed, terminal-sealed delivery check.' });
    lines.push(`delivery_waiver_add (hinted by the refusal): exit ${waiver.status}: ${waiver.status === 0 ? 'accepted' : firstError(waiver)} (handlers/delivery-check.ts:69)`);

    // Recovery: rework in DEV, update the doc, re-earn evidence, return to REVIEW.
    o.mustCli('story_advance', { storyId: o.storyId, phase: 'DEV' }, { label: 'story_advance DEV (TEST->DEV)' });
    write(o.worktree, 'docs/types/string.md', DOC_V1.replace('upper-case form of a string.', 'Unicode upper-case form of a string (strings.ToUpper).'));
    git(o.worktree, ['add', 'docs/types/string.md']);
    git(o.worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'docs: Upper maps Unicode letters']);
    // The docs commit moves material, so the pinned evidence must be re-earned first.
    for (const [itemId, test] of [['CHK-001', 'TestUpper'], ['CHK-002', 'TestReverse']] as const) {
      o.mustCli('verification_evidence_add', { storyId: o.storyId, itemId, intentRef: `${itemId}:happy:0`, kind: 'logic_test',
        command: `go test -v ./strs -run ${test}`, selector: `--- PASS: ${test}`, note: `Re-earned pinned evidence for ${test} after the docs commit.` }, { label: `verification_evidence_add ${itemId} (re-earn)` });
    }
    const check = o.cli('scope_contract_check', { storyId: o.storyId, json: true });
    lines.push(`scope_contract_check after the docs commit: status=${String(parseJson(check.stdout)?.status ?? firstError(check))}`);
    const review = o.cli('story_advance', { storyId: o.storyId, phase: 'REVIEW' }, { label: 'story_advance REVIEW (docs change)' });
    assert.equal(review.status, 0, `B: docs update cannot re-enter REVIEW without a PLAN rollback (run-10 dead end is back):\n${firstError(review)}`);
    lines.push('story_advance REVIEW with the docs change: ok (no PLAN rollback)');

    // Second review round over the new material, then PRE_CERT and TEST again.
    reviewRound(o);
    inventory(o);
    precertToTest(o);
    liveSmoke(o);
    const second = deliveryReview(o, verifiedPromises);
    assert.equal(second.state, 'completed', `second delivery review terminal ${second.state} (${second.reason})`);
    authoredCloseout(o);
    // Single host: after a rework the floor asks for more degraded host rounds; submit until it passes.
    const floor = closureRow(o, 'done_closure (floor after rework)', 'review-assurance-floor');
    const floorReason = String(floor?.reason ?? '');
    lines.push(`review-assurance-floor after the rework: ${floorReason.match(/required assurance: [a-z-]+/)?.[0] ?? '?'}; ${floorReason.match(/failure signals: (.*?) - (?:high-risk|review assurance)/)?.[1] ?? '?'}`);
    let rounds = 0;
    for (let round = 1; round <= 3; round += 1) {
      o.mustCli('autopilot_review_submit', { storyId: o.storyId, runId: `${o.storyId}-degraded-r${round}`, hostId: 'e2e-single-host', provider: 'local',
        sessionId: `local-reviewer-r${round}`, decision: 'pass', deriveBindings: true,
        materialDigest: currentMaterialHash(o.worktree, 'HEAD', o.worktree), storyFilesHash: currentStoryFilesHash(o.worktree, 'HEAD', o.worktree) }, { label: `autopilot_review_submit r${round}` });
      rounds = round;
      if (closureRow(o, `done_closure (after host verdict r${round})`, 'review-assurance-floor')?.blocking !== true) break;
    }
    lines.push(`owner had to submit ${rounds} single-host autopilot_review_submit round(s) before DONE (REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS=3, core/review-assurance-floor.ts:33,899-903)`);
    const done = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE' });
    assert.equal(done.status, 0, `B: story_advance DONE refused after the docs rework:\n${done.out.slice(-3000)}`);
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE');
    assert.match(readFileSync(join(o.root, 'docs/types/string.md'), 'utf8'), /Unicode upper-case/, 'docs update merged into main');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}; docs update merged`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`B fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

// MEDIUM (its original severity) under the default balanced profile: the
// closure rule (core/finding-closure-severities.ts) requires verified
// critical/high/medium findings to be closed in every profile.
const D_FINDING = {
  desc: 'Reverse has no focused test for an empty string: Reverse("") must return "" without indexing r[-1].',
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};

/** A material commit makes the pinned focused evidence stale; the owner re-earns it. */
function reEarnEvidence(o: Owner, why: string): void {
  for (const [itemId, test] of [['CHK-001', 'TestUpper'], ['CHK-002', 'TestReverse']] as const) {
    o.mustCli('verification_evidence_add', { storyId: o.storyId, itemId, intentRef: `${itemId}:happy:0`, kind: 'logic_test',
      command: `go test -v ./strs -run ${test}`, selector: `--- PASS: ${test}`, note: `Re-earned pinned evidence for ${test} ${why}.` }, { label: `verification_evidence_add ${itemId} (re-earn)` });
  }
}

/** Scenario NF's second round-1 finding (a different defect than D_FINDING). */
const NF_FINDING = {
  desc: 'Upper has no focused test for an empty string: Upper("") must return "".',
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};

/**
 * Scenario NL (run 16): two LOW round-1 findings beside the medium D_FINDING.
 * The first is a real gap the owner repairs anyway through a managed
 * finding-repair (repairFor: Upper -> TestUpperEmpty); the second is cosmetic
 * and stays open (advisory) through DONE.
 */
const NL_LOW_REPAIRED = { ...NF_FINDING, severity: 'low' };
const NL_LOW_COSMETIC = {
  desc: 'Comment wording: the strs.go doc comment of Reverse could say "rune by rune" (cosmetic, no behavior change).',
  severity: 'low', category: 'edge', files: ['strs/strs.go'], evidenceState: 'verified',
};

/**
 * Scenarios NU/NU2 (run 17 Q1): a second round-1 finding with the SAME root
 * cause as D_FINDING; the inventory critic dispositions it `duplicate` of it.
 */
const NU_DUP_FINDING = {
  desc: 'Reverse of an empty string reads r[len(r)-1]: Reverse("") must return "" (same root cause as the untested empty-string edge).',
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};
/** NUB (old-PoS run 31 D6): a second duplicate of D_FINDING in the same round. */
const NU_DUP_FINDING2 = {
  desc: 'Reverse("") reads past the end of an empty rune slice: an empty input must return "" (same root cause as the untested empty-string edge).',
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};
const NU_DUP_REPAIR_TEST = '\nfunc TestReverseEmptyDup(t *testing.T) {\n\tif got := Reverse(""); got != "" {\n\t\tt.Fatalf("got %q", got)\n\t}\n}\n';

const FINDING_REPAIR = 'proof-or-stop-finding-repair';
/** NRS (old-PoS run 29 REM2): the new test file a repair worker creates outside its declared files. */
const NRS_OUT_OF_SCOPE_TEST = 'strs/reverse_empty_regression_test.go';
/** NIS (old-PoS run 28 INIT): the story-init reviewer's blocking issue on a judged field (userSees), not on title/context. */
const NIS_BLOCKING_ISSUE = 'CHK-001 userSees names only the test selector; it must state the observable result (Upper("ab") returns "AB").';
const REPAIR_TEST = '\nfunc TestReverseEmpty(t *testing.T) {\n\tif Reverse("") != "" {\n\t\tt.Fatal("empty")\n\t}\n}\n';
const NF_REPAIR_TEST = '\nfunc TestUpperEmpty(t *testing.T) {\n\tif Upper("") != "" {\n\t\tt.Fatal("empty")\n\t}\n}\n';

/** NRG (old-PoS run 46): a round-2 finding whose first repair reverses round 1's fix and rewrites its test. */
const NRG_FINDING = {
  desc: 'Reverse of an empty string returns "", which callers cannot tell from a missing value: return the marker "-" instead.',
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};
const NRG_IMPL_LINE = 'func Reverse(s string) string {\n';
const NRG_MARKER = '\tif s == "" {\n\t\treturn "-"\n\t}\n';
const NRG_TEST_FIXED = 'if Reverse("") != "" {';
const NRG_TEST_REVERSED = 'if Reverse("") != "-" {';

/**
 * NRF (old-PoS run 73): round 2 re-finds round 1's defect through two other call shapes (`[regression-of F-001]`, the critic marks them
 * duplicates of F-001) and also reports one distinct finding. Each regression finding has its own regression test (a copy of one test would not compile).
 */
const NRF_REG1 = {
  desc: '[regression-of F-001] Reverse of an empty string reached through a computed argument still reads r[len(r)-1]: Reverse("") must return "" for this call shape too (same root cause as the untested empty-string edge).',
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};
const NRF_REG2 = {
  desc: '[regression-of F-001] Reverse of an empty string reached through a nested call still reads past the end of the rune slice: Reverse("") must return "" for this call shape as well (same root cause as the untested empty-string edge).',
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};
const NRF_REPAIR_TEST1 = '\nfunc TestReverseEmptyFamilyA(t *testing.T) {\n\tif got := Reverse(""); got != "" {\n\t\tt.Fatalf("got %q", got)\n\t}\n}\n';
const NRF_REPAIR_TEST2 = '\nfunc TestReverseEmptyFamilyB(t *testing.T) {\n\tif got := Reverse(""); got != "" {\n\t\tt.Fatalf("got %q", got)\n\t}\n}\n';

/** NRG: the repair of NRG_FINDING reverses F-001's behaviour and rewrites F-001's test to match (the run-46 F-011 / run-47 F-022 repair). */
function nrgRepairScript(storyId: string, findingId: string): ProviderScript {
  const short = findingId.startsWith(`${storyId}:`) ? findingId.slice(storyId.length + 1) : findingId;
  const edit = `const fs=require('fs');fs.writeFileSync('strs/strs.go',fs.readFileSync('strs/strs.go','utf8').replace(${JSON.stringify(NRG_IMPL_LINE)},${JSON.stringify(NRG_IMPL_LINE + NRG_MARKER)}));fs.writeFileSync('strs/strs_test.go',fs.readFileSync('strs/strs_test.go','utf8').replace(${JSON.stringify(NRG_TEST_FIXED)},${JSON.stringify(NRG_TEST_REVERSED)}));`;
  return { commands: [[process.execPath, '-e', edit],
    ['/bin/sh', '-c', `git add strs && git -c user.name=${FINDING_REPAIR} commit -qm '${storyId} ${short}: resolve finding (Reverse("") returns the marker)' && git log --format=%h -1`]],
  final: 'Reverse("") now returns "-"; updated TestReverseEmpty; committed.' };
}

/** NGS (old-PoS run 58): round 1's finding states its repro; its repair test also holds a row of another case. */
const NGS_FINDING1 = {
  desc: 'Reverse has no focused test for an empty string. Repro: `Reverse("")`',
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};
/** NGS round 2: a later, legitimate change of another case that F-001's repair test pinned as it was then. */
const NGS_FINDING2 = {
  desc: 'Reverse moves a trailing newline to the front: keep a trailing newline at the end. Repro: `Reverse("ab\\n")`',
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};
const NGS_REPAIR_TEST = '\nfunc TestReverseEdges(t *testing.T) {\n\ttests := []struct {\n\t\tname string\n\t\tgot  string\n\t\twant string\n\t}{\n'
  + '\t\t{"empty", Reverse(""), ""},\n\t\t{"trailing newline", Reverse("ab\\n"), "\\nba"},\n\t}\n\tfor _, tt := range tests {\n\t\tif tt.got != tt.want {\n'
  + '\t\t\tt.Errorf("%s: got %q, want %q", tt.name, tt.got, tt.want)\n\t\t}\n\t}\n}\n';
const NGS_NEWLINE = '\tif strings.HasSuffix(s, "\\n") {\n\t\treturn Reverse(strings.TrimSuffix(s, "\\n")) + "\\n"\n\t}\n';
/** NGS: F-002's repair keeps a trailing newline in place and updates F-001's table row of that case. */
function ngsRepairScript(storyId: string, findingId: string): ProviderScript {
  const short = findingId.startsWith(`${storyId}:`) ? findingId.slice(storyId.length + 1) : findingId;
  const edit = `const fs=require('fs');fs.writeFileSync('strs/strs.go',fs.readFileSync('strs/strs.go','utf8').replace(${JSON.stringify(NRG_IMPL_LINE)},${JSON.stringify(NRG_IMPL_LINE + NGS_NEWLINE)}));`
    + `fs.writeFileSync('strs/strs_test.go',fs.readFileSync('strs/strs_test.go','utf8').replace(${JSON.stringify('Reverse("ab\\n"), "\\nba"}')},${JSON.stringify('Reverse("ab\\n"), "ba\\n"}')}));`;
  return { commands: [[process.execPath, '-e', edit],
    ['/bin/sh', '-c', `git add strs && git -c user.name=${FINDING_REPAIR} commit -qm '${storyId} ${short}: resolve finding (Reverse keeps a trailing newline)' && git log --format=%h -1`]],
  final: 'Reverse keeps a trailing newline at the end; updated the TestReverseEdges row; committed.' };
}
/** NGF (old-PoS run 58 F-004): a SUSPECTED precedent-conflict finding beside the verified D_FINDING. */
const NGF_SUSPECTED_CONFLICT = {
  desc: '[precedent-conflict] Reverse of a string with a trailing space: TrimSpace drops it, a rune reversal moves it to the front; nothing pins which applies. Repro: `Reverse("ab ")`',
  severity: 'medium', category: 'edge', files: ['strs/strs.go'], evidenceState: 'suspected', uncertaintyReason: 'The request does not say which precedent applies.',
};

/**
 * NPX (old-PoS run 30, B-c201:F-005): docs/types/array.md is on main before the
 * Story starts and its range examples are wrong (end-exclusive ranges shown as
 * inclusive). The Story never touches it; the docs reviewer still reports it as
 * doc-code drift, citing the doc lines and the changed code file.
 */
const PX_DOC_PATH = 'docs/types/array.md';
const PX_DOC = '# Array type\n\n`[0, 1, 2, 3][0:2]` returns `[0, 1, 2]`.\n`[0, 1, 2, 3][:2]` returns `[0, 1, 2]`.\n';
const PX_DOC_FIXED = '# Array type\n\n`[0, 1, 2, 3][0:2]` returns `[0, 1]`.\n`[0, 1, 2, 3][:2]` returns `[0, 1]`.\n';
const PX_FINDING_DOC_ONLY = 'doc-code-drift: docs/types/array.md:3 and :4 show [0, 1, 2, 3][0:2] and [0, 1, 2, 3][:2] returning [0, 1, 2], but range ends are exclusive; the documented array range results are wrong.';
/** NPXC (old-PoS runs 36/37): the same drift, also citing a code line (unchanged at the base) of a file in the scope contract. */
const PX_FINDING_CODE_ANCHOR = 'doc-code-drift: docs/types/array.md:3 and :4 show [0, 1, 2, 3][0:2] and [0, 1, 2, 3][:2] returning [0, 1, 2], but strs/strs.go:1 is the package the range helpers live in and range ends are exclusive; the documented array range results are wrong.';
/**
 * NFS (old-PoS run 110): the drift as run 110's lanes filed it: a leading lane tag, and a code anchor inside the
 * Story's own hunk (strs/strs.go:6, the rewritten Upper) as the contrast.
 */
const PX_FINDING_RUN110 = '[docs-lane] doc-code-drift: docs/types/array.md:3 and :4 show [0, 1, 2, 3][0:2] and [0, 1, 2, 3][:2] returning [0, 1, 2], but strs/strs.go:6 (rewritten by this Story) keeps range ends exclusive; the documented array range results are wrong.';
const PX_FINDING = {
  desc: PX_FINDING_DOC_ONLY,
  severity: 'medium', category: 'missing', files: [PX_DOC_PATH, 'strs/strs.go'], evidenceState: 'verified',
};
/** The run 30 repair worker's report: it stopped before editing a file outside the allowed list it was given. */
const PX_BLOCKED = 'Blocked: the array doc finding requires a documentation change, but docs/types/array.md is outside the enforced allowed-file list; no edit, no commit.';
const PX_REPAIR_SUBJECT = 'docs: array range examples are end-exclusive';
/** NPX: the verbatim request (run 30 had one); it does not mention the array doc. NPXS: it asks to correct that doc. */
const PX_REQUEST_OUT = 'Implement `strs.Upper(s)` and `strs.Reverse(s)` as documented in docs/types/string.md.';
const PX_REQUEST_IN = `${PX_REQUEST_OUT} Also correct the range examples in docs/types/array.md.`;

/** The scripted PX repair: the doc fix, one commit naming the finding id. */
function pxRepairCommand(storyId: string, findingId: string): string[] {
  const short = findingId.startsWith(`${storyId}:`) ? findingId.slice(storyId.length + 1) : findingId;
  return ['/bin/sh', '-c', `printf '%s' '${PX_DOC_FIXED}' > ${PX_DOC_PATH} && git add ${PX_DOC_PATH} && git -c user.name=${FINDING_REPAIR} commit -qm '${storyId} ${short}: resolve finding (${PX_REPAIR_SUBJECT})' && git log --format=%h -1`];
}

/**
 * NPXR* (old-PoS run 52: 12 of 17 findings were ONE pre-existing docs defect re-filed every round): a guide on main
 * documents the string helpers wrongly before the Story starts; the Story never asks for it (no request).
 */
const RX_DOC_PATH = 'docs/guide/text.md';
const RX_DOC = '# Text helpers\n\nUpper returns its input with every letter lower-cased.\nReverse returns its input unchanged.\nBoth helpers accept any UTF-8 string.\n';
/** NPXRE: the round-1 repair rewrites line 3 (still wrong): the Story changed the dispositioned site. */
const RX_DOC_EDITED = RX_DOC.replace('lower-cased.', 'lower-cased, rune by rune.');
const RX_DOC_FIXED = RX_DOC.replace('lower-cased.', 'upper-cased.');
const RX_FINDING = {
  desc: `doc-code-drift: ${RX_DOC_PATH}:3 says Upper lower-cases every letter, but strs.Upper upper-cases its input; the guide documents the opposite behavior.`,
  severity: 'medium', category: 'missing', files: [RX_DOC_PATH, 'strs/strs.go'], evidenceState: 'verified',
};
/** Round 2 re-files the same site in other words (another lane, run 52 F-008/F-012 shape). */
const RX_REFILED = {
  desc: `${RX_DOC_PATH}:3 still documents Upper as lower-casing every letter; a reader of the guide expects the opposite of what strs.Upper returns.`,
  severity: 'medium', category: 'missing', files: [RX_DOC_PATH], evidenceState: 'verified',
};
/** NPXRN: another pre-existing line of the same doc that nobody dispositioned: a new finding, never auto-closed. */
const RX_NEW_SITE = {
  desc: `${RX_DOC_PATH}:4 says Reverse returns its input unchanged, but strs.Reverse reverses it by rune.`,
  severity: 'medium', category: 'missing', files: [RX_DOC_PATH], evidenceState: 'verified',
};
/** NPXRE: the repair of the re-filed (now Story-owned) site corrects the guide, one commit naming the finding id. */
function rxRepairCommand(storyId: string, findingId: string): string[] {
  const short = findingId.startsWith(`${storyId}:`) ? findingId.slice(storyId.length + 1) : findingId;
  return ['/bin/sh', '-c', `printf '%s' '${RX_DOC_FIXED}' > ${RX_DOC_PATH} && git add ${RX_DOC_PATH} && git -c user.name=${FINDING_REPAIR} commit -qm '${storyId} ${short}: resolve finding (docs: Upper upper-cases)' && git log --format=%h -1`];
}

/** The scripted repair commit for one finding (by its description): test text, commit subject, test name. */
/** EXPERIMENTAL A/B review.laneMerge (NLM*): a merged finding's desc without its leading `[dimension:<name>]` tag. */
function untagged(desc: string): string {
  return desc.replace(/^\[dimension:[a-z-]+\]\s*/, '');
}

function repairFor(tagged: string): { test: string; subject: string; name: string } {
  const desc = untagged(tagged);
  if (desc === PX_FINDING.desc) return { test: '', subject: `test: ${PX_REPAIR_SUBJECT}`, name: PX_DOC_PATH };
  if (desc === NRF_REG1.desc) return { test: NRF_REPAIR_TEST1, subject: 'test: Reverse empty family A', name: 'TestReverseEmptyFamilyA' };
  if (desc === NRF_REG2.desc) return { test: NRF_REPAIR_TEST2, subject: 'test: Reverse empty family B', name: 'TestReverseEmptyFamilyB' };
  if (desc === NU_DUP_FINDING.desc) return { test: NU_DUP_REPAIR_TEST, subject: 'test: Reverse empty duplicate case', name: 'TestReverseEmptyDup' };
  if (desc === NGS_FINDING1.desc) return { test: NGS_REPAIR_TEST, subject: 'test: Reverse edge table', name: 'TestReverseEdges' };
  return desc.startsWith('Upper ')
    ? { test: NF_REPAIR_TEST, subject: 'test: Upper of the empty string', name: 'TestUpperEmpty' }
    : { test: REPAIR_TEST, subject: 'test: Reverse of the empty string', name: 'TestReverseEmpty' };
}

/** The owner dispatches the implementer (managed, fake codex); it edits the test and commits, as a real implementer does. */
function devRepairViaManagedDispatch(o: Owner, findingId: string): string {
  const commands = [
    ['/bin/sh', '-c', `printf '%s' '${REPAIR_TEST.replace(/'/g, "'\\''")}' >> strs/strs_test.go && git add strs/strs_test.go && git -c user.name=${FINDING_REPAIR} commit -qm 'test: Reverse of the empty string' && git log --format=%h -1`],
  ];
  o.script(FINDING_REPAIR, { commands, final: 'Added TestReverseEmpty covering Reverse(""); committed.' });
  const launched = o.mustCli('host_run', { host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort, storyId: o.storyId,
    agentType: FINDING_REPAIR, findingId, managedDispatch: true, detach: true, json: true }, { label: 'host_run --managedDispatch finding-repair' });
  const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
  const terminal = waitTerminal(o, 'finding-repair', runId);
  o.unscript(FINDING_REPAIR);
  assert.equal(terminal.state, 'completed', `finding-repair terminal ${terminal.state} (${terminal.reason})\n${o.providerCommandLog()}`);
  return `${terminal.state}; story HEAD ${git(o.worktree, ['log', '--format=%h %s', '-1'])}`;
}

/**
 * Closure rule (core/finding-closure.ts): a verified blocking finding stays open
 * across rounds until the owner closes it. Before the resolve, the DONE oracle's
 * review-verdict row and REVIEW->TEST both refuse, naming the id; the owner then
 * runs exactly the hinted finding_resolve with the repair evidence.
 */
function resolveAsHinted(o: Owner, findingId: string, repairEvidence: string, lines: string[]): void {
  const verdict = closureRow(o, 'done_closure (before finding_resolve)', 'review-verdict');
  assert.equal(verdict?.blocking, true, `DONE must refuse the open verified finding ${findingId}:\n${JSON.stringify(verdict)}`);
  assert.ok(String(verdict?.reason ?? '').includes(findingId), `DONE refusal names ${findingId}: ${JSON.stringify(verdict)}`);
  const test = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: 'story_advance TEST (finding open)' });
  assert.notEqual(test.status, 0, 'REVIEW->TEST must refuse while the verified finding is open');
  const hint = nextOf(test.out);
  const expected = `Next: proof-or-stop finding_resolve --storyId=${o.storyId} --findingId=${findingId} --resolution="${FINDING_RESOLUTION_PLACEHOLDER}"`;
  assert.ok(hint.startsWith(expected), `TEST refusal must print the exact resolve command:\n${test.out.slice(-2000)}`);
  lines.push(`before finding_resolve: DONE review-verdict blocking=${String(verdict?.blocking)}; story_advance TEST refused; ${hint.slice(0, 160)}`);
  const command = expected.slice('Next: '.length).replace(FINDING_RESOLUTION_PLACEHOLDER, repairEvidence);
  const resolved = o.shell('finding_resolve (as hinted)', command);
  assert.equal(resolved.status, 0, `hinted finding_resolve failed:\n${resolved.out.slice(-2000)}`);
  lines.push(`owner ran the hinted finding_resolve: ${resolved.stdout.split('\n')[0]}`);
}

function nextOf(out: string): string {
  return out.split('\n').find(line => line.startsWith('Next: ')) ?? '(no Next)';
}

/** Head bound by the current round's managed review passes. */
function reviewedHead(o: Owner): string {
  const store = new StoryStore(o.worktree);
  const round = store.readStory(o.storyId).currentReviewRound;
  const pass = store.readReviewPasses(o.storyId).passes.filter(row => row.reviewRound === round && row.managedEvidenceBinding
    && row.agent !== MANAGED_INVENTORY_CRITIC_LANE).at(-1) as unknown as { managedEvidenceBinding?: { headHash?: string } } | undefined;
  return pass?.managedEvidenceBinding?.headHash ?? 'HEAD';
}

function scenarioD(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const name = 'D run 11: review finding -> DEV repair -> all-pass round -> finding_resolve -> PRE_CERT -> TEST -> DONE';
  // Runs 11 and 12: the task repo tracked the convergence-breaker gate counter.
  const o = new Owner('D', 'B-e2e3', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  try {
    devToReview(o);
    reviewRound(o, lane => lane === 'proof-or-stop-review-test-coverage'
      ? { conclusion: 'findings', note: 'Scripted behavior finding: empty-string edge case is untested.', findings: [D_FINDING] }
      : PASS_ENVELOPE(lane));
    const findingId = `${o.storyId}:F-001`;
    inventoryCritic(o, { tag: 'r1', dispositions: [{ finding: { findingId }, disposition: 'verified_family', familyKey: 'reverse-empty-string', reason: 'The empty-string edge of Reverse is untested; one verified family.' }] });
    const refusedFinalize = o.cli('review_inventory_finalize', { storyId: o.storyId }, { label: 'review_inventory_finalize r1' });
    assert.match(refusedFinalize.out, /REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE/);
    const st = o.mustCli('review_inventory_status', { storyId: o.storyId }, { label: 'review_inventory_status r1 (after critic)' });
    assert.match(st.stdout, /Next: proof-or-stop review_inventory_finalize --storyId=\S+ --remediation/);
    const rem = o.mustCli('review_inventory_finalize', { storyId: o.storyId, remediation: true }, { label: 'review_inventory_finalize --remediation r1' });
    assert.match(rem.stdout, /Next: proof-or-stop story_advance --storyId=\S+ --phase=DEV/);
    o.mustCli('story_advance', { storyId: o.storyId, phase: 'DEV' }, { label: 'story_advance DEV (REVIEW->DEV)' });
    const repair = devRepairViaManagedDispatch(o, findingId);
    lines.push(`DEV repair via managed dispatch: ${repair}`);
    reEarnEvidence(o, 'after repair');
    o.mustCli('story_advance', { storyId: o.storyId, phase: 'REVIEW' }, { label: 'story_advance REVIEW (after repair)' });
    reviewRound(o);
    // Round 2 is all-pass with no OPEN epoch, so every import committed. The
    // run-11 owner then finalized directly (commit 5 "review epoch": the
    // prompt bodies/envelopes/runs of this round + a zero-wave receipt).
    const direct = o.mustCli('review_inventory_finalize', { storyId: o.storyId }, { label: 'review_inventory_finalize (direct, no OPEN epoch)' });
    assert.match(direct.stdout, /Authority: inventory-completeness-only/);
    lines.push(`round 2 all-pass; direct review_inventory_finalize -> zero-wave inventory-completeness-only receipt; ${nextOf(direct.out)}`);
    o.mustCli('validate', { story: o.storyId, focus: 'fast', json: true }, { label: 'validate --focus=fast' });
    let begin = o.cli('certification_window_begin', { storyId: o.storyId }, { label: 'certification_window_begin (completeness-only)' });
    lines.push(`certification_window_begin: exit ${begin.status} ${begin.status ? firstError(begin) : 'ADMITTED'}; ${nextOf(begin.out)}`);
    let recovered = false;
    if (begin.status !== 0) {
      // Run 11 retried once (commit 7), then took the printed recovery: cancel
      // the completeness-only receipt (commit 8) and open a fresh saturated
      // zero-new epoch with its critic (commit 9 at finalize).
      begin = o.cli('certification_window_begin', { storyId: o.storyId }, { label: 'certification_window_begin (retry)' });
      lines.push(`certification_window_begin retry: exit ${begin.status} ${begin.status ? firstError(begin) : 'ADMITTED'}`);
    }
    if (begin.status !== 0) {
      const status = o.mustCli('review_inventory_status', { storyId: o.storyId }, { label: 'review_inventory_status (recovery)' });
      assert.match(status.stdout, /Recovery for genuine late evidence: proof-or-stop review_inventory_cancel/, status.out);
      o.mustCli('review_inventory_cancel', { storyId: o.storyId, reason: 'completeness-only receipt refused by certification; open a saturated epoch' }, { label: 'review_inventory_cancel (completeness-only)' });
      inventoryCritic(o, { tag: 'r2' });
      const fin = o.mustCli('review_inventory_finalize', { storyId: o.storyId }, { label: 'review_inventory_finalize r2 (saturated)' });
      assert.match(fin.stdout, /State: FINALIZED/);
      o.mustCli('validate', { story: o.storyId, focus: 'fast', json: true }, { label: 'validate --focus=fast' });
      // Run 12: the owner probed TEST before PRE_CERT. The refused
      // story_advance bumps the (tracked) gate-failure-counts.json, and the
      // admitting certification_window_begin commit then sweeps it in next to
      // its certification-window/review-inventory-epochs publication.
      const premature = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: 'story_advance TEST (premature)' });
      assert.notEqual(premature.status, 0, 'TEST before certification must be refused');
      lines.push(`premature story_advance TEST: refused ${firstError(premature).slice(0, 90)}`);
      begin = o.cli('certification_window_begin', { storyId: o.storyId }, { label: 'certification_window_begin (saturated)' });
      lines.push(`fresh saturated epoch + critic, then certification_window_begin: exit ${begin.status} ${begin.status ? firstError(begin) : 'ADMITTED'}`);
      recovered = true;
    }
    // F-001 is verified MEDIUM from round 1 and still open after the all-pass
    // round 2: PRE_CERT refuses it (no round decay) and hints finding_resolve.
    assert.notEqual(begin.status, 0, `D: PRE_CERT must refuse while ${findingId} is open:\n${begin.out.slice(-2000)}`);
    assert.match(begin.out, /pre_cert_blocking_findings_open/, begin.out.slice(-2000));
    assert.ok(nextOf(begin.out).includes(`finding_resolve --storyId=${o.storyId} --findingId=${findingId}`), `PRE_CERT hint: ${nextOf(begin.out)}`);
    resolveAsHinted(o, findingId, `repair ${git(o.worktree, ['log', '--format=%h', '-1', '--grep=Reverse of the empty string'])} adds TestReverseEmpty; go test ./strs -run TestReverseEmpty passes`, lines);
    begin = o.cli('certification_window_begin', { storyId: o.storyId }, { label: 'certification_window_begin (after resolve)' });
    lines.push(`certification_window_begin after finding_resolve: exit ${begin.status} ${begin.status ? firstError(begin) : 'ADMITTED'}`);
    assert.equal(begin.status, 0, `D: certification never admitted:\n${begin.out.slice(-2000)}`);
    lines.push(`fresh saturated epoch needed: ${recovered ? 'yes' : 'no'}`);
    o.mustCli('validate', { story: o.storyId, json: true }, { label: 'validate (routine)' });
    const cws = o.mustCli('certification_window_status', { storyId: o.storyId });
    lines.push(`certification_window_status: ${nextOf(cws.out)}`);
    const lineage = git(o.worktree, ['log', '--format=%h %s', `${reviewedHead(o)}..HEAD`]).split('\n').reverse();
    lines.push(`commits since the reviewed head ${reviewedHead(o).slice(0, 7)}:`, ...lineage.map(row => `  ${row}`));
    const test = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: 'story_advance TEST' });
    lines.push(`story_advance TEST: exit ${test.status} ${test.status ? firstError(test) : 'ok'}`);
    assert.equal(test.status, 0, `D: story_advance TEST refused:\n${test.out.slice(-3000)}`);
    liveSmoke(o);
    const delivery = deliveryReview(o, [
      { docPath: 'docs/types/string.md', promise: 'Upper returns the upper-case form of a string.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestUpper', evidence: '--- PASS: TestUpper' },
      { docPath: 'docs/types/string.md', promise: 'Reverse returns the string reversed by rune.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestReverse', evidence: '--- PASS: TestReverse' },
    ]);
    assert.equal(delivery.state, 'completed', `delivery reviewer terminal ${delivery.state} (${delivery.reason})\n${delivery.commandLog}`);
    authoredCloseout(o);
    // Single host: submit the hinted local host verdicts until the floor passes.
    let rounds = 0;
    for (let round = 1; round <= 3; round += 1) {
      if (closureRow(o, `done_closure (floor r${round})`, 'review-assurance-floor')?.blocking !== true) break;
      o.mustCli('autopilot_review_submit', { storyId: o.storyId, runId: `${o.storyId}-degraded-r${round}`, hostId: 'e2e-single-host', provider: 'local',
        sessionId: `local-reviewer-r${round}`, decision: 'pass', deriveBindings: true,
        materialDigest: currentMaterialHash(o.worktree, 'HEAD', o.worktree), storyFilesHash: currentStoryFilesHash(o.worktree, 'HEAD', o.worktree) }, { label: `autopilot_review_submit r${round}` });
      rounds = round;
    }
    lines.push(`single-host autopilot_review_submit rounds before DONE: ${rounds}`);
    const done = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE' });
    assert.equal(done.status, 0, `D: story_advance DONE refused:\n${done.out.slice(-3000)}`);
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE');
    assert.match(readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8'), /TestReverseEmpty/, 'repair merged into main');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`D fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

function scenarioD2(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  // Run 11 continuation: the owner worked around the TEST refusal with a
  // further review round bound to the live head. The older passes of the same
  // round stayed in review-passes.json; TEST admitted the newer ones, but DONE
  // re-validated the superseded passes and sent the owner back to REVIEW.
  // An unauthenticated empty owner checkpoint commit stands in for the
  // lineage break the fixed framework no longer produces itself.
  const name = 'D2 run 11 workaround: rerun round after a lineage break; superseded passes must not block TEST/DONE';
  const o = new Owner('D2', 'B-e2e4', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  try {
    devToReview(o);
    reviewRound(o);
    // Run 11 order: the break lands after the lane imports and before the
    // inventory critic, so only the lane passes are bound to the older head.
    // (An empty owner checkpoint commit: no material, scope or metadata change.)
    git(o.worktree, ['commit', '-q', '--allow-empty', '-m', 'owner: checkpoint review status']);
    lines.push(`owner hand commit: ${git(o.worktree, ['log', '--format=%h %s', '-1'])}`);
    inventory(o);
    o.mustCli('validate', { story: o.storyId, focus: 'fast', json: true }, { label: 'validate --focus=fast' });
    o.mustCli('certification_window_begin', { storyId: o.storyId });
    o.mustCli('validate', { story: o.storyId, json: true }, { label: 'validate (routine)' });
    const refused = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: 'story_advance TEST (lineage break)' });
    assert.notEqual(refused.status, 0, 'an unauthenticated commit must break the managed live binding');
    assert.match(refused.out, /managed_review_live_head_lineage_invalid/);
    const detail = refused.out.match(/\(unauthenticated commit ([0-9a-f]{12}) "([^"]*)": (.*?); (Next: proof-or-stop [^)]*)\)/);
    assert.ok(detail, `TEST refusal names the unauthenticated commit, rule and one Next:\n${refused.out.slice(-1500)}`);
    lines.push(`story_advance TEST refused; diagnostic: commit ${detail[1]} "${detail[2]}": ${detail[3].slice(0, 90)}; ${detail[4]}`);
    assert.equal(detail[4], `Next: proof-or-stop review_round_prepare --storyId=${o.storyId}`);
    // Workaround as the owner ran it: a fresh round of every lane on the live head.
    reviewRound(o);
    const passes = new StoryStore(o.worktree).readReviewPasses(o.storyId).passes;
    lines.push(`review-passes.json now holds ${passes.length} passes (older same-round passes are superseded, not removed)`);
    let test = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: 'story_advance TEST (after rerun)' });
    lines.push(`story_advance TEST after the rerun: exit ${test.status} ${test.status ? firstError(test) : 'ok'}`);
    for (let attempt = 0; attempt < 4 && test.status !== 0; attempt += 1) {
      // Follow the printed Next, as the owner does.
      const next = nextOf(test.out).replace(/^Next: /, '') || nextOf(o.cli('certification_window_status', { storyId: o.storyId }).out).replace(/^Next: /, '');
      lines.push(`  owner follows: ${next}`);
      if (/review_inventory_begin|review_inventory_status|review_inventory_finalize/.test(next)) {
        inventory(o);
      } else if (/validate --story=\S+ --focus=fast/.test(next)) {
        o.mustCli('validate', { story: o.storyId, focus: 'fast', json: true }, { label: 'validate --focus=fast' });
      } else if (/certification_window_begin/.test(next)) {
        o.mustCli('certification_window_begin', { storyId: o.storyId });
      } else if (/validate --story=\S+ --json/.test(next)) {
        o.mustCli('validate', { story: o.storyId, json: true }, { label: 'validate (routine)' });
      } else {
        break;
      }
      test = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: `story_advance TEST (attempt ${attempt + 3})` });
    }
    assert.equal(test.status, 0, `D2: story_advance TEST refused after the workaround round:\n${test.out.slice(-3000)}`);
    liveSmoke(o);
    const delivery = deliveryReview(o, [
      { docPath: 'docs/types/string.md', promise: 'Upper returns the upper-case form of a string.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestUpper', evidence: '--- PASS: TestUpper' },
      { docPath: 'docs/types/string.md', promise: 'Reverse returns the string reversed by rune.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestReverse', evidence: '--- PASS: TestReverse' },
    ]);
    assert.equal(delivery.state, 'completed', `delivery reviewer terminal ${delivery.state} (${delivery.reason})\n${delivery.commandLog}`);
    authoredCloseout(o);
    for (let round = 1; round <= 3; round += 1) {
      if (closureRow(o, `done_closure (floor r${round})`, 'review-assurance-floor')?.blocking !== true) break;
      o.mustCli('autopilot_review_submit', { storyId: o.storyId, runId: `${o.storyId}-degraded-r${round}`, hostId: 'e2e-single-host', provider: 'local',
        sessionId: `local-reviewer-r${round}`, decision: 'pass', deriveBindings: true,
        materialDigest: currentMaterialHash(o.worktree, 'HEAD', o.worktree), storyFilesHash: currentStoryFilesHash(o.worktree, 'HEAD', o.worktree) }, { label: `autopilot_review_submit r${round}` });
    }
    const done = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE' });
    lines.push(`story_advance DONE: exit ${done.status} ${done.status ? firstError(done) : 'ok'}`);
    assert.equal(done.status, 0, `D2: story_advance DONE refused on superseded passes:\n${done.out.slice(-3000)}`);
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`D2 fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** DEV work the owner does before REVIEW entry (devToReview without story_advance REVIEW). */
const DEV_SETUP_CALLS = 6;

export function devSetup(o: Owner, implemented = true): void {
  const id = o.storyId;
  o.mustCli('dev_memory_preflight_ack', { storyId: id });
  o.mustCli('scope_contract_init_from_plan', { storyId: id });
  // Unimplemented fixture (A/B V5): the implementer run writes the code; evidence follows it (addItemEvidence).
  if (!implemented) return;
  addItemEvidence(o);
  o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-001', status: 'done' }, { label: 'checklist_update CHK-001 done' });
  o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-002', status: 'done' }, { label: 'checklist_update CHK-002 done' });
  if (o.unicodeOutput) {
    for (const [itemId] of UNICODE_EXTRA_ITEMS) o.mustCli('checklist_update', { storyId: id, itemId, status: 'done' }, { label: `checklist_update ${itemId} done` });
  }
}

/** The pinned focused evidence of both items (the framework runs each command). */
function addItemEvidence(o: Owner): void {
  const items: ReadonlyArray<readonly [string, string, string]> = [['CHK-001', 'TestUpper', 'Upper upper-cases its input'], ['CHK-002', 'TestReverse', 'Reverse reverses by rune'],
    ...(o.unicodeOutput ? UNICODE_EXTRA_ITEMS.map(([itemId]) => [itemId, 'TestReverse', 'Reverse reverses by rune'] as const) : [])];
  for (const [itemId, test, proves] of items) {
    o.mustCli('verification_evidence_add', { storyId: o.storyId, itemId, intentRef: `${itemId}:happy:0`, kind: 'logic_test',
      command: `go test -v ./strs -run ${test}`, selector: `--- PASS: ${test}`, note: `Pinned focused go test proves ${proves}.` }, { label: `verification_evidence_add ${itemId}` });
  }
}

export interface NextStepCallJson {
  reason: string; command: string; cli: { command: string; payload: Record<string, unknown> };
  placeholders?: string[]; placeholderHints?: Record<string, string>;
}

export interface NextStepJson {
  phase: string; kind: 'agent' | 'framework' | 'human'; reason: string; command: string | null; why: string;
  cli: { command: string; payload: Record<string, unknown> } | null; placeholders?: string[]; done?: boolean; wait?: boolean;
  /** One-line description of each placeholder's expected content (Q6 (c)). */
  placeholderHints?: Record<string, string>;
  /** Several authoring commands the owner runs in one turn (Q6 (b), TEST). */
  batch?: NextStepCallJson[];
  /** N2: independent launches run concurrently in one step (the first is also cli). */
  parallel?: NextStepCallJson[];
}

const VERIFIED_PROMISES = [
  { docPath: 'docs/types/string.md', promise: 'Upper returns the upper-case form of a string.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestUpper', evidence: '--- PASS: TestUpper' },
  { docPath: 'docs/types/string.md', promise: 'Reverse returns the string reversed by rune.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestReverse', evidence: '--- PASS: TestReverse' },
];

/** Which scripted findings round 1 reports (shared by the inline harness and the run-mode resolver). */
interface ScriptMode { findingRound1: boolean; twoFindings?: boolean; lowFindings?: boolean; duplicate?: 'covered' | 'uncovered' | 'covered2';
  /** Old-PoS run 46 (NRG): round 2's test-coverage lane reports NRG_FINDING. */
  reversing?: boolean;
  /** Old-PoS run 73 (NRF): round 1 reports D_FINDING; round 2 reports NRF_REG1, NRF_REG2 (regressions of F-001) and NF_FINDING. */
  regFamily?: boolean;
  /** Old-PoS run 58 (NGS): round 1 reports NGS_FINDING1, round 2 NGS_FINDING2 (test-coverage lane). */
  staleRow?: boolean;
  /** Old-PoS run 58 (NGF): round 1 reports D_FINDING and the suspected NGF_SUSPECTED_CONFLICT. */
  suspectedConflict?: boolean;
  /**
   * Old-PoS run 68 (NRV): round 1's test-coverage lane reports NGS_FINDING2 (a trailing newline moves to the front);
   * its repair (ngsRepairScript) changes the expected value of a table row a checklist intent row also pins.
   */
  repin?: boolean;
  /**
   * Lab round-cut (run74-75-analysis.md §7): 'dup' = round 1 reports D_FINDING and NRD_DUP_FINDING (the critic marks the
   * latter a duplicate whose repro the canonical repair test states, N3); 'matrix' = round 1 reports NRM_FINDING, located
   * in a helper that branches on two operands (N2).
   */
  roundCut?: 'dup' | 'matrix';
  /** Lab initplan (NIP): the scope-plan reviewer saves a clean verdict covering every checklist item. */
  scopePlanPass?: boolean;

  /** Detection A/B control D9-r1 / D2-r3 / refused critic: how the FIRST round-1 critic restates or omits findings (scenarios NC, NC2, NC3). */
  criticRestate?: CriticRestateMode;
  /** Run 19 (NC4): round 1's only finding is a SUSPECTED low one; the (ordinary) critic gives it a verified_family row. */
  suspectedOnly?: boolean;
  /** Old-PoS run 25 (NW4): the round-1 wave-1 critic reports D_FINDING as its own new finding (every lane passed). */
  criticNewFinding?: boolean;
  /** Old-PoS run 25 (NW4): every round-1 lane run started after a critic run (wave 2) re-reports D_FINDING. */
  restateAfterCritic?: boolean;
  /** Old-PoS run 27 (NDL/NDS): the FIRST delivery reviewer run saves only after the owner's TEST overlap commits (summary_set, quorum-submit); 'stale' also commits a delivery-input change first. */
  delivery?: DeliveryFault;
  /** Old-PoS run 29 (NRS): the first finding-repair run writes its regression test into a NEW file outside the declared files; its resumed turn moves it. */
  repairOutOfScope?: boolean;
  /** Old-PoS run 28 (NIS): the first story-init INIT reviewer run records a blocking issue about CHK-001's userSees. */
  initBlocking?: boolean;
  /**
   * Old-PoS run 30 (NPX): round 1 also reports PX_FINDING, doc drift that already exists at the Story base.
   * 'out': nothing in the request or scope contract covers the doc (every repair worker reports it blocked, no commit);
   * 'in': the request asks to correct that doc (the first repair attempt reports blocked, the next one commits the doc fix).
   */
  preexisting?: 'out' | 'in';
  /**
   * Old-PoS run 31 (NMF/NMF2): round 1 also reports Story-metadata findings (CHK-001 userSees pins
   * `Upper("ab") == "ab"`): the test-coverage lane cites only checklist.json, the quality lane restates it citing
   * checklist.json:<line> and the passing test. 'with-product' keeps D_FINDING beside them; 'only' reports no product finding.
   * Old-PoS run 33: 'with-product-copy' = 'with-product' plus a third copy (quality lane) that also cites the product file
   * and its test (run 33 F-003, docs lane); 'intent-rows' = D_FINDING plus a metadata finding on CHK-001's intent row
   * (a verificationIntent correction, which needs PLAN).
   * Old-PoS run 44: 'short-literal' = D_FINDING plus a metadata finding citing only a short quoted literal of CHK-001's
   * userSees (no corrected value extractable; run 44 R2), copied in CHK-002's userSees (the sweep).
   */
  metadata?: 'with-product' | 'only' | 'with-product-copy' | 'intent-rows' | 'short-literal' | 'intent-only' | 'intent-literal';
  /**
   * EXPERIMENTAL A/B review.deltaRounds (ND-DR*): later-round lanes answer a delta-round
   * confirmation block from their prompt: 'full' checks every item and names the re-run of
   * each resolved finding; 'gap' also reports one [gap]; 'bad-rerun' names a selector the
   * re-run never prints (the framework re-run fails).
   * Old-PoS run 52 (ND-DRF*): 'findings' = in round 2 the confirmation lane reports NF_FINDING with a complete
   * multi-line note; 'findings-flat' = the same note flattened onto one line; 'findings-gap' = it also names a [gap].
   */
  deltaNote?: DeltaNoteMode;
  /** ND-DRL: the finding repair also commits a large block, so the repair exceeds the delta-round threshold. */
  largeRepair?: boolean;
  /**
   * Old-PoS run 52 (NPXR*, recurring pre-existing finding): round 1 also reports RX_FINDING (a doc drift on main,
   * outside the Story); in round 2 the quality lane re-files it (RX_REFILED). 'edited' = the round-1 repair also
   * edits that doc line (the Story changed the site); 'new-site' = round 2 also files RX_NEW_SITE (another
   * pre-existing line of the same doc, never dispositioned).
   */
  recurring?: RecurringMode;
  /** EXPERIMENTAL A/B review.laneMerge (NLM*): what the merged session of each round reports (LaneMergeMode). */
  laneMerge?: LaneMergeMode;
  /** Lab lane-split (NLM4*, NLM-S): every code-review lane session sleeps this scripted latency. */
  laneLatency?: LaneLatency;
  /** Lab run131 (NDI, NSL): per-lane scripted latency (short lane name), from review round `fromRound` (1-based) on. */
  laneLatencyFor?: Record<string, LaneLatency & { fromRound: number }>;
  /** Lab run131 (NSL): the first run of this lane (short name) prints thread.started and then nothing for `ms` (a provider stall before any item). */
  laneStall?: { lane: string; ms: number };
  /** Lab lean (NLN*): the merged session of round 1 reports D_FINDING; a later round's delta confirmation passes, or (escalate) reports LN_ESC_FINDING outside the delta. */
  lean?: LeanScriptMode }
/** Lab lean (NLN*): what the review sessions of a pipeline.lean run report (LN_ESC_FINDING in round 2 when `escalate`). */
interface LeanScriptMode { escalate?: boolean }
/**
 * EXPERIMENTAL A/B review.laneMerge (NLM*): per round (index = review round), the merged session's findings and
 * which dimensions' coverage lines its note leaves out ('<dimension>'), marks [gap] ('gap:<dimension>'), answers
 * with generic evidence ('generic:<dimension>') or without a [read] line ('unread:<dimension>'). Under
 * review.laneMerge=split each session reports only the findings and faults of its own dimensions.
 */
interface LaneMergeMode { rounds: Array<{ findings: Array<Record<string, unknown>>; uncovered?: string[] }> }
/** Lab lane-split: scripted model latency of one review session (fake provider sleeps base + per dimension). */
interface LaneLatency { baseMs: number; perDimensionMs: number;
  /** Lab run131 (NSL): print one reasoning item before the latency (a real session's first item arrives in seconds). */
  itemFirst?: boolean }
type DeltaNoteMode = 'full' | 'gap' | 'bad-rerun' | 'findings' | 'findings-flat' | 'findings-gap';
type RecurringMode = 'site' | 'edited' | 'new-site';
/** Old-PoS run 27 delivery overlap faults (scenarioNDL). */
type DeliveryFault = 'overlap' | 'stale';
type CriticRestateMode = 'copies' | 'reworded' | 'new-misfiled';

/** Run 19 shape (B-8166 F-001): a suspected low lane finding, the round's only one. */
const NC4_SUSPECTED = {
  desc: 'Upper of a string with a non-letter rune may change it: the intended behavior for digits is not specified (suspected).',
  severity: 'low', category: 'edge', files: ['strs/strs.go'], evidenceState: 'suspected', uncertaintyReason: 'The request does not specify the intended wording for non-letter runes.',
};

/** D2-r3 shape: the critic's own reworded restatement of D_FINDING (same files, same claim). */
const NC_REWORDED_DESC = 'Base-to-head gap: Reverse has no focused empty-string test; Reverse("") must return "" and never index r[-1] on an empty string.';

type ProviderScript = { final: string; commands?: string[][];
  /** Lab run131 (NSL): sleep this long after thread.started, before any item (a provider stall). */
  stallMs?: number;
  /** NLM*: the fake provider appends the merged-session coverage lines its prompt asks for, minus `uncovered` (LaneMergeMode). */
  merge?: { uncovered?: string[]; findings?: Array<Record<string, unknown>> };
  /** NLM4* / NLM-S (lab lane-split): scripted session latency, baseMs + perDimensionMs per dimension the session carries. */
  latency?: LaneLatency;
  /** ND-DR*: the fake provider appends the delta-round confirmation lines its prompt asks for (ND-DRF*: and reports `findings`). */
  delta?: { mode: DeltaNoteMode; command: string; selector: string; findings?: Array<Record<string, unknown>> } };
/** ND-DR*: the test D_FINDING's repair adds, which a confirmation lane re-runs. */
const DELTA_REVERIFY = { command: 'go test -v ./strs -run TestReverseEmpty', selector: '--- PASS: TestReverseEmpty' };

/** 0-based index of a lane run's review round among the Story's code-review rounds (old-PoS run 52 scenarios). */
function reviewRoundIndex(worktree: string, storyId: string, reviewRunId: string): number {
  const runs = new StoryStore(worktree).readReviewRuns(storyId).runs.filter(row => row.reviewPurpose !== 'inventory-completeness');
  const rounds = [...new Set(runs.map(row => row.reviewRound))];
  return rounds.indexOf(runs.find(row => row.reviewRunId === reviewRunId)?.reviewRound ?? '');
}

/** A REVIEW lane's scripted final proposal: round 1 test-coverage reports the mode's findings, every other lane passes. */
function laneScript(worktree: string, storyId: string, lane: string, reviewRunId: string, firstRound: boolean, mode: ScriptMode): ProviderScript {
  if (mode.repin && lane === 'proof-or-stop-review-test-coverage') {
    // Old-PoS run 68 (NRV): round 1 reports the trailing-newline defect; later rounds pass.
    const index = reviewRoundIndex(worktree, storyId, reviewRunId);
    const envelope = index === 0 ? { conclusion: 'findings', note: 'Scripted run 68 lane.', findings: [NGS_FINDING2] } : PASS_ENVELOPE(lane);
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, ...envelope, ...readEvidenceFor(worktree, storyId) }) };
  }
  if (mode.roundCut && lane === 'proof-or-stop-review-test-coverage') {
    // Lab round-cut: round 1 reports the mode's findings; later rounds pass.
    const index = reviewRoundIndex(worktree, storyId, reviewRunId);
    const findings = index !== 0 ? [] : mode.roundCut === 'dup' ? [D_FINDING, NRD_DUP_FINDING] : [NRM_FINDING];
    const envelope = findings.length ? { conclusion: 'findings', note: 'Scripted round-cut lane.', findings } : PASS_ENVELOPE(lane);
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, ...envelope, ...readEvidenceFor(worktree, storyId) }) };
  }
  if (mode.regFamily && lane === 'proof-or-stop-review-test-coverage') {
    // Old-PoS run 73 (NRF): round 1 reports D_FINDING; round 2 re-finds it through two other call shapes and adds one distinct finding.
    const index = reviewRoundIndex(worktree, storyId, reviewRunId);
    const findings = index === 0 ? [D_FINDING] : index === 1 ? [NRF_REG1, NRF_REG2, NF_FINDING] : [];
    const envelope = findings.length ? { conclusion: 'findings', note: 'Scripted run 73 lane.', findings } : PASS_ENVELOPE(lane);
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, ...envelope, ...readEvidenceFor(worktree, storyId) }) };
  }
  if ((mode.staleRow || mode.suspectedConflict) && lane === 'proof-or-stop-review-test-coverage') {
    // Old-PoS run 58 (NGS / NGF).
    const index = reviewRoundIndex(worktree, storyId, reviewRunId);
    const findings = mode.staleRow ? (index === 0 ? [NGS_FINDING1] : index === 1 ? [NGS_FINDING2] : []) : (index === 0 ? [D_FINDING, NGF_SUSPECTED_CONFLICT] : []);
    const envelope = findings.length ? { conclusion: 'findings', note: 'Scripted run 58 lane.', findings } : PASS_ENVELOPE(lane);
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, ...envelope, ...readEvidenceFor(worktree, storyId) }) };
  }
  if (mode.reversing && lane === 'proof-or-stop-review-test-coverage') {
    const runs = new StoryStore(worktree).readReviewRuns(storyId).runs.filter(row => row.reviewPurpose !== 'inventory-completeness');
    const rounds = [...new Set(runs.map(row => row.reviewRound))];
    if (rounds.indexOf(runs.find(row => row.reviewRunId === reviewRunId)?.reviewRound ?? "") === 1) {
      return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, conclusion: 'findings',
        note: 'Scripted run 46 lane: an unstated empty-string marker.', findings: [NRG_FINDING], ...readEvidenceFor(worktree, storyId) }) };
    }
  }
  if (mode.restateAfterCritic && firstRound) {
    // Run 25 (NW4): a lane run of round 1 that starts after an inventory critic (wave 2) re-reports the critic's defect.
    const runs = new StoryStore(worktree).readReviewRuns(storyId).runs;
    const index = runs.findIndex(row => row.reviewRunId === reviewRunId);
    const round = runs[index]?.reviewRound;
    if (runs.slice(0, index).some(row => row.reviewRound === round && row.reviewPurpose === 'inventory-completeness')) {
      return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, conclusion: 'findings',
        note: 'Scripted wave-2 lane: re-reports the critic\'s empty-string defect.', findings: [D_FINDING], ...readEvidenceFor(worktree, storyId) }) };
    }
  }
  // A real reviewer re-reports the text only while the checklist still states it.
  if (mode.metadata === 'intent-rows' && firstRound && lane === 'proof-or-stop-review-test-coverage') {
    // Old-PoS run 33 (F-003 / trip 5): a lane cites an intent row that contradicts the request (a PLAN correction).
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, conclusion: 'findings',
      note: 'Scripted run 33 lane: an untested edge and a checklist intent row that contradicts the request.', findings: [D_FINDING, metadataFindings(worktree, storyId).intentRow], ...readEvidenceFor(worktree, storyId) }) };
  }
  if (mode.metadata === 'intent-literal' && firstRound && lane === 'proof-or-stop-review-test-coverage') {
    // Lab run131 (NMC, run 131 PLAN-B): the lane cites the wrong statement an intent row states and the reviewer's value.
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, conclusion: 'findings',
      note: 'Scripted run 131 lane: an untested edge and an intent row stating a wrong value.', findings: [D_FINDING, metadataFindings(worktree, storyId).intentLiteral], ...readEvidenceFor(worktree, storyId) }) };
  }
  if (mode.metadata === 'intent-only' && firstRound && lane === 'proof-or-stop-review-test-coverage') {
    // Old-PoS run 68 R2: the only report of the wave is an intent row the request contradicts (no product finding).
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, conclusion: 'findings',
      note: 'Scripted run 68 lane: a checklist intent row that contradicts the request; the code is right.', findings: [metadataFindings(worktree, storyId).intentRow], ...readEvidenceFor(worktree, storyId) }) };
  }
  const currentUserSees = mode.metadata ? new StoryStore(worktree).readChecklist(storyId).items.find(item => item.id === 'CHK-001')?.userSees : undefined;
  if (mode.metadata === 'short-literal' && firstRound && currentUserSees === META_SHORT_STALE_USER_SEES['CHK-001'] && lane === 'proof-or-stop-review-test-coverage') {
    // Old-PoS run 44 R2: the lane cites a short quoted literal of the userSees, with no corrected value to extract.
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, conclusion: 'findings',
      note: 'Scripted run 44 lane: an untested edge and a short quoted literal the request renders bare.', findings: [D_FINDING, metadataFindings(worktree, storyId).short], ...readEvidenceFor(worktree, storyId) }) };
  }
  const staleText = currentUserSees === META_STALE_USER_SEES['CHK-001'];
  if (mode.metadata && mode.metadata !== 'intent-rows' && mode.metadata !== 'short-literal' && firstRound && staleText && (lane === 'proof-or-stop-review-test-coverage' || lane === 'proof-or-stop-review-quality')) {
    // Old-PoS run 31 (F-001/F-002/F-005): lanes restate one wrong userSees literal as findings.
    const meta = metadataFindings(worktree, storyId);
    const findings = lane === 'proof-or-stop-review-quality' ? [meta.restated, ...(mode.metadata === 'with-product-copy' ? [meta.productCopy] : [])]
      : mode.metadata === 'with-product' || mode.metadata === 'with-product-copy' ? [D_FINDING, meta.cited] : [meta.cited];
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, conclusion: 'findings',
      note: 'Scripted run 31 lane: the checklist userSees pins a value the request contradicts.', findings, ...readEvidenceFor(worktree, storyId) }) };
  }
  if (mode.recurring) {
    // Old-PoS run 52 (NPXR*): round 1 files the doc drift beside D_FINDING; round 2's quality lane re-files it.
    const index = reviewRoundIndex(worktree, storyId, reviewRunId);
    const findings = index === 0 && lane === 'proof-or-stop-review-test-coverage' ? [D_FINDING, RX_FINDING]
      : index === 1 && lane === 'proof-or-stop-review-quality' ? (mode.recurring === 'new-site' ? [RX_REFILED, RX_NEW_SITE] : [RX_REFILED]) : [];
    const envelope = findings.length ? { conclusion: 'findings', note: 'Scripted run 52 lane: documentation drift in the guide.', findings } : PASS_ENVELOPE(lane);
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, ...envelope, ...readEvidenceFor(worktree, storyId) }) };
  }
  if (mode.lean) {
    // Lab lean (NLN*): round 1's merged session reports D_FINDING tagged [dimension:test-coverage]; a later round runs the
    // delta confirmation (pass, or with `escalate` LN_ESC_FINDING, which cites a line outside the delta) or a full merged
    // session (pass); a dimension relaunched as its own lane passes.
    const index = reviewRoundIndex(worktree, storyId, reviewRunId);
    const findings = index === 0 ? [lmTagged('test-coverage', D_FINDING)] : [];
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, ...PASS_ENVELOPE(lane), ...readEvidenceFor(worktree, storyId) }),
      merge: findings.length ? { findings } : {},
      delta: { mode: 'full', ...DELTA_REVERIFY, ...(mode.lean.escalate && index === 1 ? { findings: [LN_ESC_FINDING] } : {}) } };
  }
  if (mode.laneMerge) {
    // EXPERIMENTAL A/B review.laneMerge (NLM*): the merged session (whichever lane carries the block) reports the round's
    // findings; a dimension relaunched as its own lane, or any lane outside the block, passes.
    const index = reviewRoundIndex(worktree, storyId, reviewRunId);
    const round = mode.laneMerge.rounds[Math.min(Math.max(index, 0), mode.laneMerge.rounds.length - 1)] ?? { findings: [] };
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, ...PASS_ENVELOPE(lane), ...readEvidenceFor(worktree, storyId) }),
      merge: { ...(round.uncovered ? { uncovered: round.uncovered } : {}), ...(round.findings.length ? { findings: round.findings } : {}) } };
  }
  if (mode.deltaNote && !firstRound) {
    // Old-PoS run 52 (ND-DRF*): in round 2 the confirmation lane (whichever lane carries the block) reports NF_FINDING.
    const findingsMode = mode.deltaNote.startsWith('findings') && reviewRoundIndex(worktree, storyId, reviewRunId) === 1;
    return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, ...PASS_ENVELOPE(lane), ...readEvidenceFor(worktree, storyId) }),
      delta: { mode: mode.deltaNote, ...DELTA_REVERIFY, ...(findingsMode ? { findings: [NF_FINDING] } : {}) } };
  }
  const envelope = mode.findingRound1 && firstRound && lane === 'proof-or-stop-review-test-coverage'
    ? { conclusion: 'findings', note: 'Scripted behavior finding: empty-string edge case is untested.',
      findings: mode.preexisting ? [D_FINDING, PX_FINDING] : mode.suspectedOnly ? [NC4_SUSPECTED] : mode.lowFindings ? [D_FINDING, NL_LOW_REPAIRED, NL_LOW_COSMETIC] : mode.twoFindings ? [D_FINDING, NF_FINDING]
        : mode.duplicate === 'covered2' ? [D_FINDING, NU_DUP_FINDING, NU_DUP_FINDING2] : mode.duplicate ? [D_FINDING, NU_DUP_FINDING] : [D_FINDING] }
    : PASS_ENVELOPE(lane);
  return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, ...envelope, ...readEvidenceFor(worktree, storyId) }) };
}

/** The inventory critic: dispositions every finding of the current epoch's round as one verified family (the NU duplicate as `duplicate`). */
/** A/B V3 R2A-r2: the 64-hex value the round-2 critic wrote instead of the artifactDigest it had just read. */
const NC5_MISTYPED_DIGEST = '8577ba20d1ad8034c589b5029a816ba50a510dbd56fd83f7d4d40589f582f78a';

/** NC5: the first critic's read manifest carries a mistyped candidateSpecSetDigest (everything else exact). */
function mistypedDigestCriticScript(script: ProviderScript): ProviderScript {
  const value = JSON.parse(script.final) as { readManifest: Record<string, unknown> };
  value.readManifest.candidateSpecSetDigest = NC5_MISTYPED_DIGEST;
  return { ...script, final: JSON.stringify(value) };
}

/** NC6: the first critic copies a wrong wave number into its block (a transcription error the importer refuses before persisting). */
function wrongWaveCriticScript(script: ProviderScript): ProviderScript {
  const value = JSON.parse(script.final) as { inventoryCritic: { wave: number } };
  value.inventoryCritic.wave += 1;
  return { ...script, final: JSON.stringify(value) };
}

function criticScript(worktree: string, storyId: string, reviewRunId: string, restate?: CriticRestateMode, newFinding = false): ProviderScript {
  const store = new StoryStore(worktree);
  const epoch = store.readReviewInventoryEpochs(storyId).epochs.at(-1)!;
  const raw = store.readFindings(storyId).findings.filter(f => f.reviewRound === epoch.reviewRound);
  const runs = store.readReviewRuns(storyId).runs;
  const firstRound = runs.find(row => row.reviewPurpose !== 'inventory-completeness')?.reviewRound;
  const firstCritic = runs.find(row => row.reviewPurpose === 'inventory-completeness')?.reviewRunId === reviewRunId;
  if (restate && firstCritic && epoch.reviewRound === firstRound) return restatingCriticScript(worktree, storyId, reviewRunId, epoch, raw, restate);
  if (newFinding && epoch.reviewRound === firstRound) return waveCriticScript(worktree, storyId, reviewRunId, epoch, firstCritic);
  // Run 17 Q1: the NU duplicate is dispositioned `duplicate` of D_FINDING (same root cause).
  const canonical = raw.find(f => f.desc === D_FINDING.desc);
  const dispositions = raw.map(f => (f.desc === NU_DUP_FINDING.desc || f.desc === NU_DUP_FINDING2.desc || f.desc === NRD_DUP_FINDING.desc) && canonical
    ? { finding: { findingId: f.id }, disposition: 'duplicate', familyKey: 'reverse-empty-string', canonicalFinding: { findingId: canonical.id },
      reason: 'Same root cause as the canonical finding: Reverse indexes the last rune of an empty string.' }
    : f.desc === NRM_FINDING.desc
    ? { finding: { findingId: f.id }, disposition: 'verified_family', familyKey: 'window-bounds', reason: 'Window clamps its bounds; one verified family.' }
    : f.desc === PX_FINDING.desc
    ? { finding: { findingId: f.id }, disposition: 'verified_family', familyKey: 'array-doc-range-drift', reason: 'The array doc shows end-inclusive range results; one verified family.' }
    : untagged(f.desc).startsWith('Upper ')
    ? { finding: { findingId: f.id }, disposition: 'verified_family', familyKey: 'upper-empty-string', reason: 'The empty-string edge of Upper is untested; one verified family.' }
    : f.desc === META_PRODUCT_COPY_DESC
    ? { finding: { findingId: f.id }, disposition: 'verified_family', familyKey: 'upper-user-sees', reason: 'CHK-001 userSees contradicts the request; one verified family.' }
    : f.desc.startsWith('Comment ')
      ? { finding: { findingId: f.id }, disposition: 'verified_family', familyKey: 'reverse-comment-wording', reason: 'Cosmetic doc-comment wording of Reverse; one verified family.' }
    : { finding: { findingId: f.id }, disposition: 'verified_family', familyKey: 'reverse-empty-string', reason: 'The empty-string edge of Reverse is untested; one verified family.' });
  return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: MANAGED_INVENTORY_CRITIC_LANE, lane: MANAGED_INVENTORY_CRITIC_LANE,
    reviewRunId, conclusion: 'pass', note: dispositions.length ? 'Scripted inventory critic: dispositioned every verified finding of this wave.' : 'Scripted inventory critic: every required lane passed with zero findings; nothing to disposition.',
    inventoryCritic: { epochId: epoch.epochId, wave: epoch.waves.length + 1, findingDispositions: dispositions }, ...readEvidenceFor(worktree, storyId) }) };
}

/**
 * Detection A/B control (efc375c): the first round-1 critic re-raises findings.
 * copies (D9-r1): its findings are verbatim copies of the lane findings, only the lane findings get rows.
 * reworded (D2-r3): its finding rewords D_FINDING, only its own copy gets a row (familyKey = the lane id).
 * new-misfiled: a genuinely new finding (NF_FINDING) filed as a `duplicate` of D_FINDING's lane finding under a
 *   different family: the worker's coverage check passes (every finding has a row) but the import refuses it
 *   REVIEW_INVENTORY_FINDING_DISPOSITION_INVALID once (never reconciled away). (A missing row is repaired by the
 *   worker on the same session before sealing: critic-coverage-repair-smoke.)
 */
function restatingCriticScript(worktree: string, storyId: string, reviewRunId: string, epoch: { epochId: string; waves: unknown[] },
  raw: ReadonlyArray<{ id: string; desc: string; severity?: string; category?: string; files?: string[] }>, restate: CriticRestateMode): ProviderScript {
  const laneRows = raw.map(f => ({ finding: { findingId: f.id }, disposition: 'verified_family', familyKey: 'reverse-empty-string', reason: 'The empty-string edge of Reverse is untested; one verified family.' }));
  const lane = raw.find(f => f.desc === D_FINDING.desc)!;
  const findings = restate === 'copies' ? raw.map(f => ({ desc: f.desc, severity: f.severity, category: f.category, files: f.files, evidenceState: 'verified' }))
    : restate === 'reworded' ? [{ ...D_FINDING, desc: NC_REWORDED_DESC }] : [NF_FINDING];
  const findingDispositions = restate === 'reworded'
    ? [{ finding: { proposalFindingIndex: 0 }, disposition: 'verified_family', familyKey: lane.id, reason: `Independently confirmed ${lane.id}: Reverse("") has no focused test and indexes r[-1].` }]
    : restate === 'new-misfiled'
      ? [...laneRows, { finding: { proposalFindingIndex: 0 }, disposition: 'duplicate', familyKey: 'upper-empty-string', canonicalFinding: { findingId: lane.id },
        reason: 'Filed against the Reverse finding although it is a different function (scripted contract error).' }]
      : laneRows;
  return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: MANAGED_INVENTORY_CRITIC_LANE, lane: MANAGED_INVENTORY_CRITIC_LANE,
    reviewRunId, conclusion: 'findings', note: `Scripted restating inventory critic (${restate}).`, findings,
    inventoryCritic: { epochId: epoch.epochId, wave: epoch.waves.length + 1, findingDispositions }, ...readEvidenceFor(worktree, storyId) }) };
}

/**
 * Old-PoS run 25 (NW4): the round-1 inventory critic per wave. Wave 1 (every
 * lane passed): it reports the empty-string defect as its own new verified
 * finding (B-2b04:F-002). Wave 2: it gives the first lane restatement a
 * verified_family row in the same family (not new: the wave saturates) and
 * marks the other copies `duplicate` of it (B-2b04 RR-020).
 */
function waveCriticScript(worktree: string, storyId: string, reviewRunId: string, epoch: { epochId: string; waves: unknown[] }, firstCritic: boolean): ProviderScript {
  const run = new StoryStore(worktree).readReviewRuns(storyId).runs.find(row => row.reviewRunId === reviewRunId)!;
  const required = managedInventoryCriticCoverage(worktree, run)?.requiredFindingIds ?? [];
  const family = 'reverse-empty-string';
  const own = firstCritic && required.length === 0;
  const findingDispositions = own
    ? [{ finding: { proposalFindingIndex: 0 }, disposition: 'verified_family', familyKey: family, reason: 'Critic-only catch: Reverse("") is untested and indexes r[-1].' }]
    : required.map((findingId, index) => index === 0
      ? { finding: { findingId }, disposition: 'verified_family', familyKey: family, reason: 'The empty-string edge of Reverse is untested; the family the earlier wave found.' }
      : { finding: { findingId }, disposition: 'duplicate', familyKey: family, canonicalFinding: { findingId: required[0] }, reason: 'Same defect as the first lane copy of this wave.' });
  return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: MANAGED_INVENTORY_CRITIC_LANE, lane: MANAGED_INVENTORY_CRITIC_LANE,
    reviewRunId, conclusion: own ? 'findings' : 'pass', note: own ? 'Scripted critic: a new verified finding no lane reported.' : 'Scripted critic: dispositioned every lane finding of this wave.',
    ...(own ? { findings: [D_FINDING] } : {}),
    inventoryCritic: { epochId: epoch.epochId, wave: epoch.waves.length + 1, findingDispositions }, ...readEvidenceFor(worktree, storyId) }) };
}

/**
 * The scripted delivery reviewer. Old-PoS run 27 faults (first delivery run only):
 * 'overlap' saves only after the owner's N1 overlap steps moved HEAD by
 * metadata-only commits (summary_set, then quorum-submit); 'stale' then also
 * commits a change to a delivery input (a delivery_context_pack publication)
 * before it saves, so its dispatch binding is genuinely stale.
 */
function deliveryScript(storyId: string, fault?: DeliveryFault, storyDir?: string): ProviderScript {
  const waitForOverlap = ['/bin/sh', '-c', "i=0; until git log --format=%s -30 | grep -q 'quorum-submit metadata'; do i=$((i+1)); [ $i -gt 600 ] && exit 9; sleep 0.2; done"];
  const staleCommit = ['/bin/sh', '-c', `printf '%s\\n' '{"type":"harness_delivery_input_change","at":"${new Date().toISOString()}"}' >> '${storyDir}/process-events.jsonl' && git add -A '${storyDir}' && git commit -qm 'proof-or-stop: record ${storyId} delivery_context_pack metadata'`];
  const prefix = fault === 'overlap' ? [waitForOverlap] : fault === 'stale' ? [waitForOverlap, staleCommit] : [];
  const deliveryPayload = { storyId, docsPromises: VERIFIED_PROMISES,
    realMachineTests: [
      { featureId: 'CHK-001', transcript: 'go test -v ./strs -run TestUpper -> --- PASS: TestUpper' },
      { featureId: 'CHK-002', transcript: 'go test -v ./strs -run TestReverse -> --- PASS: TestReverse' },
    ],
    closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'Both string helpers are implemented and verified by focused go tests.' },
    agentId: DELIVERY };
  return { commands: [...prefix, [process.execPath, CLI, 'delivery_check_set', JSON.stringify(deliveryPayload)]], final: 'Delivery review complete; delivery_check_set recorded.' };
}

/** ND-DRL: a large regression block (comment lines) the repair commits with its test. */
const LARGE_REPAIR_PAD = Array.from({ length: 60 }, (_, index) => `// regression note ${index + 1}: empty and one-rune inputs keep their rune order`).join('\n') + '\n';
function repairScript(desc: string, px?: { storyId: string; findingId: string; commit: boolean }, large = false, docEdit = false): ProviderScript {
  if (desc === PX_FINDING.desc) {
    // NPX (old-PoS run 30): the worker either reports the doc blocked (no commit) or commits the doc fix.
    return px?.commit ? { commands: [pxRepairCommand(px.storyId, px.findingId)], final: `Corrected the range examples in ${PX_DOC_PATH}; committed.` }
      : { commands: [], final: PX_BLOCKED };
  }
  // NPXRE (old-PoS run 52): the re-filed site the Story edited is the Story's own defect: repaired, not dispositioned.
  if (desc === RX_REFILED.desc && px) return { commands: [rxRepairCommand(px.storyId, px.findingId)], final: `Corrected ${RX_DOC_PATH}:3; committed.` };
  const repair = repairFor(desc);
  const text = large ? `${repair.test}${LARGE_REPAIR_PAD}` : repair.test;
  // NPXRE: this repair also rewrites the dispositioned guide line (still wrong), so the Story changed that site.
  const edit = docEdit ? `printf '%s' '${RX_DOC_EDITED}' > ${RX_DOC_PATH} && git add ${RX_DOC_PATH} && ` : '';
  return { commands: [['/bin/sh', '-c', `${edit}printf '%s' '${text.replace(/'/g, "'\\''")}' >> strs/strs_test.go && git add strs/strs_test.go && git -c user.name=${FINDING_REPAIR} commit -qm '${repair.subject}' && git log --format=%h -1`]],
    final: `Added ${repair.name}; committed.` };
}

/**
 * remediation.grouping=single (the default): one run, one regression test and
 * one commit naming its id per finding. `firstOnly` (NF2): the run repairs and
 * commits only the bound finding and leaves the others untouched.
 */
function groupedRepairScript(storyId: string, findings: ReadonlyArray<{ id: string; desc: string }>, firstOnly = false): ProviderScript {
  if (firstOnly) findings = findings.slice(0, 1);
  // NPX (old-PoS run 30): a grouped run leaves the pre-existing doc finding without a commit and reports it blocked.
  const blocked = findings.filter(finding => finding.desc === PX_FINDING.desc);
  findings = findings.filter(finding => finding.desc !== PX_FINDING.desc);
  if (blocked.length) {
    const inner = groupedRepairScript(storyId, findings);
    return { commands: inner.commands, final: `${inner.final} ${blocked.map(finding => finding.id).join(', ')}: ${PX_BLOCKED}` };
  }
  // Two members with the same defect share one regression test (a second copy would not compile): the later commit only names its id.
  const written = new Set<string>();
  return { commands: findings.map(finding => {
    const repair = repairFor(finding.desc);
    const short = finding.id.startsWith(`${storyId}:`) ? finding.id.slice(storyId.length + 1) : finding.id;
    const first = !written.has(repair.name);
    written.add(repair.name);
    const change = first ? `printf '%s' '${repair.test.replace(/'/g, "'\\''")}' >> strs/strs_test.go && git add strs/strs_test.go && ` : '';
    return ['/bin/sh', '-c', `${change}git -c user.name=${FINDING_REPAIR} commit -q${first ? '' : ' --allow-empty'} -m '${storyId} ${short}: resolve finding (${repair.subject})' && git log --format=%h -1`];
  }), final: `Added ${[...written].join(', ')}; one commit per finding.` };
}

const IMPLEMENTER = 'proof-or-stop-implementer';

/** A/B implementation.grouping=files: the implementer writes both helpers and marks only its bound item done. */
function implementerScript(storyId: string, itemId: string): ProviderScript {
  const writeFiles = `const fs=require('fs');fs.writeFileSync('strs/strs.go',${JSON.stringify(IMPL)});fs.writeFileSync('strs/strs_test.go',${JSON.stringify(TESTS)});`;
  return { commands: [
    [process.execPath, '-e', writeFiles],
    ['/bin/sh', '-c', `git add strs && git -c user.name=${IMPLEMENTER} commit -qm '${storyId} CHK-001 CHK-002: implement Upper and Reverse' && git log --format=%h -1`],
    [process.execPath, CLI, 'checklist_update', JSON.stringify({ storyId, itemId, status: 'done' })],
  ], final: `Implemented Upper and Reverse; ${itemId} marked done.` };
}

/**
 * Run mode: `next --run` launches fully bound managed runs itself, so the
 * harness cannot script the fake provider before the launch. The fake codex
 * calls this (through resolver.json) with the run id it serves; the script is
 * derived from the run's immutable spec and the Story state exactly as the
 * inline harness derives it from the step `next` returned.
 */
function provideScript(root: string, storyId: string, scriptsDir: string, modeJson: string, runId: string): void {
  const mode = JSON.parse(modeJson) as ScriptMode;
  const spec = JSON.parse(readFileSync(join(root, '.proof-or-stop', 'runtime', 'host-runs', runId, 'spec.json'), 'utf8')) as
    { agentType: string; reviewRunId?: string | null; managedDispatchTarget?: { findingId?: string; groupFindingIds?: string[] } | null };
  const worktree = join(root, '.worktrees', storyId);
  let script: ProviderScript;
  if (INIT_REVIEWERS.includes(spec.agentType)) {
    // NIN: an INIT reviewer records a clean verdict with init_check_set (the managed worker's env binds it).
    // NIS (old-PoS run 28): the FIRST story-init run blocks on CHK-001's userSees (a judged field outside title/context).
    const runsRoot = join(root, '.proof-or-stop', 'runtime', 'host-runs');
    const storyInitRuns = readdirSync(runsRoot).filter(id => { try { return (JSON.parse(readFileSync(join(runsRoot, id, 'spec.json'), 'utf8')) as { agentType?: string }).agentType === 'proof-or-stop-review-story-init'; } catch { return false; } });
    const issues = mode.initBlocking && spec.agentType === 'proof-or-stop-review-story-init' && storyInitRuns.length <= 1
      ? [{ severity: 'high', kind: 'initial_checklist_invalid', requirementRef: 'checklist:CHK-001', desc: NIS_BLOCKING_ISSUE }] : [];
    mkdirSync(join(scriptsDir, 'byrun'), { recursive: true });
    writeFileSync(join(scriptsDir, 'byrun', `${runId}.json`), JSON.stringify({ final: 'INIT review complete; init_check_set recorded.',
      commands: [[process.execPath, CLI, 'init_check_set', JSON.stringify({ storyId, issues })]] }));
    return;
  }
  const store = new StoryStore(worktree);
  if (mode.scopePlanPass && spec.agentType === 'proof-or-stop-review-scope-plan') {
    // Lab initplan (NIP): a clean scope-plan verdict, one covered feature per item.
    const features = store.readChecklist(storyId).items.map(item => ({ feature: item.title, covered_by: item.id, status: 'covered', excluded_by: null, source: 'request.md' }));
    mkdirSync(join(scriptsDir, 'byrun'), { recursive: true });
    writeFileSync(join(scriptsDir, 'byrun', `${runId}.json`), JSON.stringify({ final: 'Scope review saved.', commands: [[process.execPath, CLI, 'scope_check_save', JSON.stringify({ storyId, features,
      summary: { total: features.length, covered: features.length, excluded: 0, gaps: 0 }, readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null }, openQuestions: [] })]] }));
    return;
  }
  if (spec.agentType === DELIVERY) {
    // Run 27 (NDL/NDS): only the first delivery run carries the fault.
    const runsRoot = join(root, '.proof-or-stop', 'runtime', 'host-runs');
    const deliveryRuns = readdirSync(runsRoot).filter(id => { try { return (JSON.parse(readFileSync(join(runsRoot, id, 'spec.json'), 'utf8')) as { agentType?: string }).agentType === DELIVERY; } catch { return false; } });
    script = deliveryScript(storyId, deliveryRuns.length <= 1 ? mode.delivery : undefined, store.storyDirPath(storyId));
  }
  else if (spec.agentType === FINDING_REPAIR) {
    const findingId = spec.managedDispatchTarget?.findingId ?? '';
    const descOf = (id: string) => store.readFindings(storyId).findings.find(f => f.id === id)?.desc ?? '';
    const group = spec.managedDispatchTarget?.groupFindingIds;
    script = Array.isArray(group) ? groupedRepairScript(storyId, group.map(id => ({ id, desc: descOf(id) }))) : repairScript(descOf(findingId));
    if (mode.repairOutOfScope) {
      // NRS (old-PoS run 29 REM2): the worker puts its regression test in a NEW file
      // outside the declared files (allowedCreate is empty); its resumed turn
      // (the framework's scope repair) moves it into the declared test file.
      const repair = repairFor(descOf(findingId));
      script = { commands: [['/bin/sh', '-c', `printf 'package strs\\n\\nimport "testing"\\n%s' '${repair.test.replace(/'/g, "'\\''")}' > ${NRS_OUT_OF_SCOPE_TEST} && git add ${NRS_OUT_OF_SCOPE_TEST} && git -c user.name=${FINDING_REPAIR} commit -qm '${repair.subject}' && git log --format=%h -1`]],
        final: `Added ${repair.name} in ${NRS_OUT_OF_SCOPE_TEST}; committed.` };
      mkdirSync(join(scriptsDir, 'byrun'), { recursive: true });
      writeFileSync(join(scriptsDir, 'byrun', `${runId}.resume.json`), JSON.stringify({
        commands: [['/bin/sh', '-c', `git rm -q ${NRS_OUT_OF_SCOPE_TEST} && printf '%s' '${repair.test.replace(/'/g, "'\\''")}' >> strs/strs_test.go && git add strs/strs_test.go && git -c user.name=${FINDING_REPAIR} commit -qm 'test: move ${repair.name} into the declared test file' && git log --format=%h -1`]],
        final: `Moved ${repair.name} into strs/strs_test.go and removed ${NRS_OUT_OF_SCOPE_TEST}; committed.` }));
    }
  } else if (spec.agentType === MANAGED_INVENTORY_CRITIC_LANE) script = criticScript(worktree, storyId, String(spec.reviewRunId));
  else {
    const runs = store.readReviewRuns(storyId).runs;
    const run = runs.find(row => row.reviewRunId === spec.reviewRunId);
    assert.ok(run, `resolver: ReviewRun ${String(spec.reviewRunId)} of run ${runId} not found`);
    const firstRound = runs.find(row => row.reviewPurpose !== 'inventory-completeness')?.reviewRound;
    script = laneScript(worktree, storyId, spec.agentType, run.reviewRunId, run.reviewRound === firstRound, mode);
  }
  mkdirSync(join(scriptsDir, 'byrun'), { recursive: true });
  writeFileSync(join(scriptsDir, 'byrun', `${runId}.json`), JSON.stringify(script));
}

/** Managed finding-repair runs per finding id, from the immutable run specs (covers runs `next --run` launched). */
function repairRunsOnDisk(runsRoot: string): Map<string, string[]> {
  const byFinding = new Map<string, string[]>();
  if (!existsSync(runsRoot)) return byFinding;
  for (const runId of readdirSync(runsRoot)) {
    try {
      const spec = JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as { agentType?: string; managedDispatchTarget?: { findingId?: string; groupFindingIds?: string[] } | null };
      const findingId = spec.agentType === FINDING_REPAIR ? spec.managedDispatchTarget?.findingId : undefined;
      // remediation.grouping=single (the default): a grouped run is bound to every member.
      for (const id of findingId ? spec.managedDispatchTarget?.groupFindingIds ?? [findingId] : []) byFinding.set(id, [...(byFinding.get(id) ?? []), runId]);
    } catch { /* not a managed run directory */ }
  }
  return byFinding;
}

/** The finding a step is about: findingId, or the first entry of a resolutions[] call (old-PoS run 34 framework resolve). */
function stepFindingId(next: NextStepJson): string | undefined {
  const payload = next.cli?.payload ?? {};
  const id = payload.findingId ?? (payload.resolutions as Array<{ findingId: string }> | undefined)?.[0]?.findingId;
  return id === undefined ? undefined : String(id);
}

/** Steps that launch or wait on a managed run (Q6: `next --run` executes these once the selection is bound). */
const MANAGED_LAUNCH_REASONS = new Set(['review_lane_launch', 'inventory_critic_launch', 'delivery_review_launch', 'finding_repair', 'implement_item', 'scope_plan_review_launch']);

/** The owner's authored values for the TEST/DEV authoring commands next proposes with placeholders. */
function authorPayload(o: Owner, reason: string, payload: Record<string, unknown>, findingDesc: (findingId: string) => string): void {
  switch (reason) {
    case 'finding_resolve': {
      // Old-PoS run 34: a framework-authored resolution is kept as next wrote it.
      if (typeof payload.resolution === 'string' && !/^<[\s\S]*>$/.test(payload.resolution)) break;
      const repair = repairFor(findingDesc(String(payload.findingId)));
      if (findingDesc(String(payload.findingId)) === META_PRODUCT_COPY_DESC) {
        payload.resolution = 'CHK-001 userSees now states Upper("ab") == "AB" (metadata correction); strs/strs.go was already correct, no code change.';
        break;
      }
      if (findingDesc(String(payload.findingId)) === PX_FINDING.desc) {
        payload.resolution = `repair ${git(o.worktree, ['log', '--format=%h', '-1', `--grep=${PX_REPAIR_SUBJECT}`])} corrects the range examples in ${PX_DOC_PATH} (end-exclusive)`;
        break;
      }
      payload.resolution = `repair ${git(o.worktree, ['log', '--format=%h', '-1', `--grep=${repair.subject.slice('test: '.length)}`])} adds ${repair.name}; go test ./strs -run ${repair.name} passes`;
      break;
    }
    case 'finding_resolve_batch':
      for (const entry of (payload.resolutions ?? []) as Array<{ findingId: string; resolution: string }>) {
        if (typeof entry.resolution === 'string' && !/^<[\s\S]*>$/.test(entry.resolution)) continue;
        const repair = repairFor(findingDesc(entry.findingId));
        entry.resolution = `repair ${git(o.worktree, ['log', '--format=%h', '-1', `--grep=${repair.subject.slice('test: '.length)}`])} adds ${repair.name}; go test ./strs -run ${repair.name} passes`;
      }
      break;
    case 'metadata_correction':
    case 'intent_conflict_amend':
      // Old-PoS run 31: the owner corrects the cited literal (and every other occurrence next listed).
      if (typeof payload.userSees === 'string' && /^<.*>$/.test(payload.userSees)) {
        // Old-PoS run 44: the short-literal fixture's text gets its own correction.
        const current = new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === String(payload.itemId))?.userSees;
        payload.userSees = (current === META_SHORT_STALE_USER_SEES[String(payload.itemId)] ? META_SHORT_FIXED_USER_SEES : META_FIXED_USER_SEES)[String(payload.itemId)] ?? payload.userSees;
      }
      if (typeof payload.reason === 'string' && /^<.*>$/.test(payload.reason)) payload.reason = 'The request says Upper returns the upper-case form, so Upper("ab") == "AB"; the checklist text now states it.';
      break;
    case 'finding_duplicate_resolve':
      if (typeof payload.resolution === 'string' && /^<.*>$/.test(payload.resolution)) {
        payload.coverage = { command: 'go test -v ./strs -run TestReverseEmpty', selector: '--- PASS: TestReverseEmpty' };
        payload.resolution = `duplicate of ${String(payload.duplicateOf)}: its repair adds TestReverseEmpty, which exercises Reverse("") (this finding's case)`;
      }
      break;
    case 'dev_memory_finish_decision':
      Object.assign(payload, { decision: 'no-reusable-lesson', reason: 'Harness fixture: trivial string helpers, no reusable lesson.' });
      break;
    case 'summary_set':
      Object.assign(payload, { changes: 'strs/strs.go: Upper now upper-cases; new Reverse reverses by rune.', usage: 'strs.Upper("ab") == "AB"; strs.Reverse("héllo") == "olléh"',
        expectedOutcome: 'go test -v ./strs prints --- PASS: TestUpper and --- PASS: TestReverse',
        // NX (run 20): the observed transcript quotes the program output verbatim, CJK subtest name included.
        actualTranscript: o.unicodeOutput ? `go test -v ./strs: --- PASS: TestUpper, --- PASS: TestReverse/${CJK_WORD}, --- PASS: TestReverse, ok` : 'go test -v ./strs: --- PASS: TestUpper, --- PASS: TestReverse, ok',
        outcomeDiff: 'no difference', limitations: 'none — fully covered', pitfalls: 'Harness fixture; no retries were needed.' });
      break;
    default:
      break;
  }
}

/** Q6 (c): every placeholder of a step (or of a batch command) carries a one-line description of its expected content. */
function placeholderHintViolations(call: { reason: string; placeholders?: string[]; placeholderHints?: Record<string, string> }): string[] {
  return (call.placeholders ?? []).filter(path => !(call.placeholderHints?.[path] ?? '').trim())
    .map(path => `${call.reason}: placeholder ${path} has no one-line description (placeholderHints)`);
}

/**
 * Scenario N: from REVIEW entry the owner runs ONLY `proof-or-stop next
 * --storyId=<id> --json` and executes the returned command. Agent-kind steps go
 * through the same fake-provider seams as A/D (the scripted reviewer envelope,
 * critic dispositions, delivery reviewer, finding repair) and the same authored
 * values (resolution, summary, finish decision). Every proposed command must
 * succeed: next must never propose a command its gate then refuses.
 *
 * Run mode (Q6, run 17): `next --run` also executes waits and every fully bound
 * managed launch (host/model/effort of the owner's own earlier run, no
 * placeholders), so after the first managed launch no launch or wait step may
 * reach the owner; the fake provider then scripts each run from its spec
 * (provideScript). TEST authoring (finish decision + summary) arrives as ONE
 * step whose batch lists each exact command (Q6 (b)).
 */
export interface DriveStats {
  /** Owner turns as counted for this mode (llm: every next call + every owner-executed step; framework: every owner-executed step). */
  ownerTurns: number;
  /** The steps the owner executed itself, in order (reason; batch = one entry). */
  ownerSteps: string[];
  /** `next` calls the harness made (llm: next/next --run; framework: next --untilAgent). */
  nextCalls: number;
  /** Framework mode: `next --run` calls the driver made inside those calls. */
  driverRunCalls: number;
  /** Framework mode: watchdog kills the driver reported. */
  watchdogKills: Array<{ reason: string; silentMs: number }>;
}

export function driveWithNext(o: Owner, mode: { findingRound1: boolean; run: boolean; twoFindings?: boolean;
  /** Old-PoS run 46 (NRG): round 2 reports NRG_FINDING, whose first repair reverses round 1's fix. */
  reversing?: boolean;
  /** Old-PoS run 73 (NRF): see ScriptMode.regFamily. */
  regFamily?: boolean;
  /** Old-PoS run 58 (NGS / NGF): see ScriptMode.staleRow / suspectedConflict. */
  staleRow?: boolean;
  suspectedConflict?: boolean;
  /** Old-PoS run 68 (NRV): see ScriptMode.repin. */
  repin?: boolean;
  /** Lab round-cut (NRM / NRD): see ScriptMode.roundCut. */
  roundCut?: 'dup' | 'matrix';
  /** Lab round-cut (NRC): the scripted implementer of a relaunch (default implementerScript). */
  implementerScript?: (itemId: string) => ProviderScript;
  /** Owner-driver lab (owner.driver=framework): drive with `next --untilAgent` (implies run); the owner only gets agent steps. */
  drive?: boolean;
  /** Run 16: round 1 also reports two LOW findings; the owner repairs the first itself (managed finding-repair) when next says enter_review. */
  lowFindings?: boolean;
  /** Run 16: the live-smoke capture needs the project validate.env (CONTEXT=abs) to pass. */
  contextSmoke?: boolean;
  /** Run 17 Q1: round 1 also reports NU_DUP_FINDING, which the critic marks a duplicate of D_FINDING; 'covered' = the canonical repair's test covers it, 'uncovered' = it does not. */
  duplicate?: 'covered' | 'uncovered' | 'covered2';
  /** Old-PoS run 31 (NMF/NMF2): round 1 also reports Story-metadata findings (ScriptMode.metadata). */
  metadata?: 'with-product' | 'only' | 'with-product-copy' | 'intent-rows' | 'short-literal' | 'intent-only' | 'intent-literal';
  /** Soft checks (NL): each violation is recorded and the flow continues, so one run reports every defect. */
  violations?: string[];
  /** Scenarios NC/NC2/NC3: the first round-1 critic restates (or leaves a new finding without a row). */
  criticRestate?: CriticRestateMode;
  /** Run 19 (NC4): round 1's only finding is suspected. */
  suspectedOnly?: boolean;
  /** NC3: critic imports refused with DISPOSITION_INCOMPLETE/INVALID (at most one is tolerated; next must then change course). */
  refusedCriticImports?: string[];
  /** NC5 (A/B V3 R2A-r2): the first critic mistypes readManifest.candidateSpecSetDigest. */
  criticMistypedDigest?: boolean;
  /** NC6: the first critic copies a wrong inventory wave number (refused at import before anything persists); the runIds whose import was refused. */
  refusedBeforePersist?: string[];
  /** NF2: a grouped finding-repair run commits only its bound finding's repair. */
  groupedFirstOnly?: boolean;
  /** NC9 (old-PoS run 24 F1/F2): the first critic ends its turn with prose and no JSON envelope (its run fails). */
  criticProseFirst?: boolean;
  /** NW4 (old-PoS run 25 F4): the wave-1 critic reports a new finding; wave-2 lanes re-report it. */
  criticNewFinding?: boolean;
  restateAfterCritic?: boolean;
  /** Old-PoS run 27 (NDL/NDS, run mode only): the first delivery reviewer run's fault. */
  delivery?: DeliveryFault;
  /** Old-PoS run 29 (NRS, run mode only): the finding-repair run creates its test outside the declared files. */
  repairOutOfScope?: boolean;
  /** Old-PoS run 30 (NPX/NPXA/NPXS): round 1 also reports the pre-existing array doc finding (ScriptMode.preexisting). */
  preexisting?: 'out' | 'in';
  /** NC7: an owner action taken instead of the step next returned; true = the step is not executed and next is asked again. */
  interject?: (next: NextStepJson) => boolean;
  /** EXPERIMENTAL A/B review.deltaRounds (ND-DR*): see ScriptMode.deltaNote / largeRepair. */
  deltaNote?: DeltaNoteMode;
  largeRepair?: boolean;
  /** EXPERIMENTAL A/B review.laneMerge (NLM*): see ScriptMode.laneMerge. */
  laneMerge?: LaneMergeMode;
  /** Lab lane-split: see ScriptMode.laneLatency. */
  laneLatency?: LaneLatency;
  /** Lab run131: see ScriptMode.laneLatencyFor / laneStall. */
  laneLatencyFor?: Record<string, LaneLatency & { fromRound: number }>;
  laneStall?: { lane: string; ms: number };
  /** Old-PoS run 52 (NPXR*): see ScriptMode.recurring. */
  recurring?: RecurringMode;
  /** Lab lean (NLN*): see ScriptMode.lean. */
  lean?: LeanScriptMode; }, lines: string[],
  /** Called with each step `next` returned, before the harness executes it; quiet = no detached managed run in flight. */
  onStep?: (next: NextStepJson, quiet: boolean) => void): DriveStats {
  const id = o.storyId;
  // Framework owner driver: the same flow, `next --untilAgent` in place of the owner's `next --run` loop.
  const runLike = mode.run || mode.drive === true;
  let nextCalls = 0;
  let driverRunCalls = 0;
  const watchdogKills: DriveStats['watchdogKills'] = [];
  const scriptKeyByRun = new Map<string, string>();
  let firstRound: string | undefined;
  const stalledLanes = new Set<string>();
  const reasons: string[] = [];
  const statusOf = () => existsSync(o.worktree) ? execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: o.worktree, encoding: 'utf8' }) : '';
  let internalCalls = 0;
  let internalMs = 0;
  /** Wall ms per framework step reason inside next --run (a concurrent `parallel` step counted once). */
  const stepMs = new Map<string, { n: number; ms: number }>();
  // Owner turns: one per `next` call plus one per step the owner executes itself.
  let ownerTurns = 0;
  // Q6 contract violations (hard-asserted at the end; every one is reported).
  const q6: string[] = [];
  // finding id -> managed finding-repair runs launched for it (as next proposed them).
  const repairRunsByFinding = new Map<string, string[]>();
  // Old-PoS run 30 (NPX): finding-repair proposals per pre-existing finding id.
  const pxRepairAttempts = new Map<string, number>();
  const findingDesc = (findingId: string): string => new StoryStore(o.worktree).readFindings(id).findings.find(f => f.id === findingId)?.desc ?? '';
  // A fake provider picks the first script whose key occurs in its prompt, and a
  // critic prompt names the lane ReviewRuns: retire each script once its run is terminal.
  const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
  const managedRunCount = (): number => existsSync(runsRoot) ? readdirSync(runsRoot).filter(runId => existsSync(join(runsRoot, runId, 'spec.json'))).length : 0;
  const retireTerminalScripts = (): void => {
    for (const [runId, key] of scriptKeyByRun) {
      if (existsSync(join(runsRoot, runId, 'terminal.json'))) { o.unscript(key); scriptKeyByRun.delete(runId); }
    }
  };
  if (runLike) {
    writeFileSync(join(o.scriptsDir, 'resolver.json'), JSON.stringify({ argv: [process.execPath, SELF, '--provide-script', o.root, id, o.scriptsDir,
      JSON.stringify({ findingRound1: mode.findingRound1, twoFindings: mode.twoFindings ?? false, lowFindings: mode.lowFindings ?? false, ...(mode.delivery ? { delivery: mode.delivery } : {}),
        ...(mode.repairOutOfScope ? { repairOutOfScope: true } : {}), ...(mode.preexisting ? { preexisting: mode.preexisting } : {}) })] }));
  }
  let liveSmokeProposals = 0;
  for (let iteration = 0; iteration < 160; iteration += 1) {
    retireTerminalScripts();
    // A detached managed worker still running may commit its own metadata
    // meanwhile; the read-only check applies when nothing else is running.
    const quiet = scriptKeyByRun.size === 0;
    const before = statusOf();
    const asked = o.cli('next', { storyId: id, json: true, ...(mode.drive ? { untilAgent: true } : mode.run ? { run: true } : {}) }, { label: mode.drive ? 'next --untilAgent' : mode.run ? 'next --run' : 'next' });
    nextCalls += 1;
    // Framework mode: the driver's next --run calls are not owner turns; only the step handed back is.
    if (!mode.drive) ownerTurns += 1;
    const parsed = asked.status === 0 ? parseJson(asked.stdout) : null;
    const next = (runLike ? parsed?.next : parsed) as NextStepJson | undefined;
    assert.ok(next && typeof next.kind === 'string', `[${o.scenario}] next --storyId=${id} --json did not return a step:\n${asked.out.slice(-2000)}`);
    if (mode.drive) {
      driverRunCalls += Array.isArray(parsed!.calls) ? (parsed!.calls as unknown[]).length : 0;
      for (const kill of (parsed!.watchdog ?? []) as Array<{ reason: string; silentMs: number }>) watchdogKills.push({ reason: kill.reason, silentMs: kill.silentMs });
      assert.ok(['agent', 'done'].includes(String(parsed!.outcome)), `[${o.scenario}] next --untilAgent ended with outcome ${String(parsed!.outcome)} (stopped: ${String(parsed!.stopped)}):\n${String(parsed!.rendered ?? asked.out).slice(-2000)}`);
      // Never a framework step handed to the owner, never a judgment step run by the driver.
      assert.notEqual(next.kind, 'framework', `[${o.scenario}] next --untilAgent handed a framework step to the owner: ${next.reason}`);
    }
    if (runLike) {
      const executed = (parsed!.executed ?? []) as Array<{ command: string; reason?: string; exit: number; ms: number; tail: string }>;
      executed.forEach((row, index) => {
        const previous = executed[index - 1];
        if (previous && previous.reason === row.reason && previous.ms === row.ms) return; // same concurrent step
        const entry = stepMs.get(row.reason ?? '?') ?? { n: 0, ms: 0 };
        entry.n += 1; entry.ms += row.ms;
        stepMs.set(row.reason ?? '?', entry);
      });
      for (const row of executed) {
        internalCalls += 1; internalMs += row.ms;
        reasons.push(`run:${row.command.split(' ')[1]}`);
        assert.equal(row.exit, 0, `[${o.scenario}] next --run executed a framework step its gate refused: ${row.command}\n${row.tail}`);
      }
      assert.equal(parsed!.stopped ?? null, null, `[${o.scenario}] next --run stopped: ${String(parsed!.stopped)}`);
      // Q6 (a): once the owner launched one managed run (its host/model/effort is
      // bound), every further launch and every wait is run by next --run itself.
      if (next.wait) q6.push(`next --run returned the wait ${next.reason} to the owner (${next.why.slice(0, 120)})`);
      if (MANAGED_LAUNCH_REASONS.has(next.reason) && managedRunCount() > 0) {
        q6.push(`next --run returned the fully bound managed launch ${next.reason} to the owner after a managed run already bound the selection`);
      }
    } else if (quiet) {
      assert.equal(statusOf(), before, `[${o.scenario}] next must be read-only; git status changed:\n${before}\n---\n${statusOf()}`);
    }
    q6.push(...placeholderHintViolations(next), ...(next.batch ?? []).flatMap(call => placeholderHintViolations(call)));
    // Lab driver-done (old-PoS run 65): under owner.driver=framework no step text the driver hands back
    // tells the owner to run `next --run` / `next --untilAgent`; it ends with "end your turn".
    if (mode.drive) {
      if (/proof-or-stop next\b|`next --(?:run|untilAgent)`/.test(next.why)) q6.push(`framework-driven step ${next.reason} tells the owner to run next: ${next.why.slice(0, 300)}`);
      if (next.kind === 'agent' && !/end your turn/i.test(String(parsed!.rendered ?? ''))) q6.push(`framework-driven step ${next.reason} does not end with "end your turn"`);
    }
    if (next.reason === 'dev_memory_finish_decision' || next.reason === 'summary_set') {
      q6.push(`TEST authoring ${next.reason} surfaced as its own step; the finish decision and the summary must arrive as one step listing each command (Q6 (b))`);
    }
    // Old-PoS run 34 (REM, sink 1a): a finding a managed repair run repaired (its own commit,
    // fresh pinned evidence) is resolved by the framework with the same per-finding checks;
    // the owner never re-reads the repair diff to author the resolution.
    if ((next.reason === 'finding_resolve' || next.reason === 'finding_resolve_batch') && !/Story-metadata finding/.test(next.why)
      && (next.kind !== 'framework' || (next.placeholders?.length ?? 0) > 0)) {
      q6.push(`${next.reason} of a repaired finding reached the owner as ${next.kind} with placeholders [${(next.placeholders ?? []).join(', ')}]; the framework resolves it (old-PoS run 34 REM)`);
    }
    onStep?.(next, quiet);
    // Old-PoS run 27 (row 7): the DONE step is an explicit terminal statement, so the owner stops there.
    if (next.done) assert.match(next.why, /DONE — stop; no further commands/, `[${o.scenario}] the DONE step must say to stop: ${next.why}`);
    if (next.done) break;
    if (mode.interject?.(next)) { ownerTurns += 1; reasons.push('owner_interjection'); continue; }
    assert.notEqual(next.kind, 'human', `[${o.scenario}] next asked for a human decision: ${next.reason}: ${next.why}`);
    assert.ok(next.cli, `[${o.scenario}] next returned no runnable command: ${next.reason}: ${next.why}`);
    const payload = { ...next.cli.payload };
    const round = new StoryStore(o.worktree).readStory(id).currentReviewRound;
    reasons.push(next.reason);
    // A critic import its gate refused must never be proposed again unchanged (A/B control D2-r3/D9-r1 looped forever).
    if (next.reason === 'review_evidence_import' && mode.refusedCriticImports?.includes(JSON.stringify(payload))) {
      assert.fail(`[${o.scenario}] next re-proposed the refused critic import ${JSON.stringify(payload)}; why: ${next.why}`);
    }
    // NC6: an import refused for good (receipt-level) is never proposed again, alone or in a batch.
    const proposedRunIds = next.reason === 'review_evidence_import'
      ? (Array.isArray(payload.imports) ? (payload.imports as Array<{ runId: string }>).map(row => row.runId) : [String(payload.runId)]) : [];
    const repeated = proposedRunIds.filter(runId => mode.refusedBeforePersist?.includes(runId));
    if (repeated.length) assert.fail(`[${o.scenario}] next re-proposed the refused import of ${repeated.join(', ')}; why: ${next.why}`);
    // Fake-provider seams and authored values for agent-kind steps.
    switch (next.reason) {
      case 'review_lane_launch': {
        firstRound ??= round;
        for (const lanePayload of next.parallel?.length ? next.parallel.map(call => call.cli.payload) : [payload]) {
          const lane = String(lanePayload.lane);
          const reviewRunId = String(lanePayload.reviewRunId);
          const script = laneScript(o.worktree, id, lane, reviewRunId, round === firstRound, mode);
          const roundIndex = [...new Set(new StoryStore(o.worktree).readReviewRuns(id).runs.map(row => row.reviewRound))].indexOf(round ?? '') + 1;
          const own = mode.laneLatencyFor?.[short(lane)];
          const latency = own && roundIndex >= own.fromRound ? { baseMs: own.baseMs, perDimensionMs: own.perDimensionMs, ...(own.itemFirst ? { itemFirst: true } : {}) } : mode.laneLatency;
          // Lab run131 (NSL): the lane's first run stalls before any item.
          const stall = mode.laneStall && short(lane) === mode.laneStall.lane && !stalledLanes.has(lane) ? mode.laneStall.ms : 0;
          if (stall) stalledLanes.add(lane);
          o.script(reviewRunId, { ...script, ...(latency ? { latency } : {}), ...(stall ? { stallMs: stall } : {}) });
        }
        break;
      }
      case 'inventory_critic_launch': {
        const script = criticScript(o.worktree, id, String(payload.reviewRunId), mode.criticRestate, mode.criticNewFinding);
        const firstCritic = new StoryStore(o.worktree).readReviewRuns(id).runs.find(row => row.reviewPurpose === 'inventory-completeness')?.reviewRunId === String(payload.reviewRunId);
        o.script(String(payload.reviewRunId), mode.criticProseFirst && firstCritic ? { final: NC9_PROSE_FINAL }
          : mode.criticMistypedDigest && firstCritic ? mistypedDigestCriticScript(script)
          : mode.refusedBeforePersist && firstCritic ? wrongWaveCriticScript(script) : script);
        break;
      }
      case 'delivery_review_launch':
        o.script(DELIVERY, deliveryScript(id));
        break;
      case 'finding_repair': {
        const bound = Array.isArray(payload.groupFindingIds) ? payload.groupFindingIds as string[] : [String(payload.findingId)];
        const px = bound.find(findingId => findingDesc(findingId) === PX_FINDING.desc);
        if (px) {
          // Old-PoS run 30: the pre-existing doc finding. Every attempt is counted; a
          // third repair proposal after two attempts without a commit is the run 30 dead end.
          const attempts = (pxRepairAttempts.get(px) ?? 0) + 1;
          pxRepairAttempts.set(px, attempts);
          if (attempts >= 3) {
            assert.fail(`[${o.scenario}] dead end (old-PoS run 30): next proposed repair #${attempts} of the pre-existing finding ${px} after ${attempts - 1} managed repair run(s) ended without a commit; why: ${next.why}`);
          }
        }
        if (mode.reversing && !Array.isArray(payload.groupFindingIds) && findingDesc(String(payload.findingId)) === NRG_FINDING.desc) {
          o.script(FINDING_REPAIR, nrgRepairScript(id, String(payload.findingId)));
          break;
        }
        if (mode.roundCut === 'matrix' && !Array.isArray(payload.groupFindingIds) && findingDesc(String(payload.findingId)) === NRM_FINDING.desc) {
          // Lab round-cut (NRM): the first repair reports only the finding's own branch (lab run89: accepted; the miss is journaled).
          const attempt = (repairRunsByFinding.get(String(payload.findingId)) ?? []).length + 1;
          // The earlier run is terminal: retire its script key now, not after this run reads its script.
          retireTerminalScripts();
          o.script(FINDING_REPAIR, nrmRepairScript(id, attempt));
          break;
        }
        if ((mode.staleRow || mode.repin) && !Array.isArray(payload.groupFindingIds) && findingDesc(String(payload.findingId)) === NGS_FINDING2.desc) {
          o.script(FINDING_REPAIR, ngsRepairScript(id, String(payload.findingId)));
          break;
        }
        o.script(FINDING_REPAIR, Array.isArray(payload.groupFindingIds)
          ? groupedRepairScript(id, (payload.groupFindingIds as string[]).map(findingId => ({ id: findingId, desc: findingDesc(findingId) })), mode.groupedFirstOnly)
          // NPXS: the first PX attempt reports blocked; a later one (with the earlier report in its prompt) commits the doc fix.
          : repairScript(findingDesc(String(payload.findingId)), { storyId: id, findingId: String(payload.findingId), commit: mode.preexisting === 'in' && (pxRepairAttempts.get(String(payload.findingId)) ?? 0) > 1 }, mode.largeRepair === true, mode.recurring === 'edited'));
        break;
      }
      case 'implement_item':
        if (mode.implementerScript) retireTerminalScripts();
        o.script(IMPLEMENTER, mode.implementerScript?.(String(payload.itemId)) ?? implementerScript(id, String(payload.itemId)));
        break;
      case 'enter_review': {
        // Run 16: next proposed enter_review with a verified LOW finding open
        // (advisory); the owner repaired it anyway with a managed finding-repair.
        const lowOpen = mode.lowFindings && next.phase === 'DEV'
          ? new StoryStore(o.worktree).readFindings(id).findings.find(f => f.status === 'open' && f.severity === 'low' && f.desc.startsWith('Upper '))
          : undefined;
        const repairedLowOpen = mode.lowFindings && next.phase === 'DEV'
          ? new StoryStore(o.worktree).readFindings(id).findings.find(f => f.status === 'open' && repairRunsByFinding.has(f.id))
          : undefined;
        if (repairedLowOpen && !mode.violations?.some(v => v.startsWith(`enter_review with repaired ${repairedLowOpen.id}`))) {
          mode.violations?.push(`enter_review with repaired ${repairedLowOpen.id} (${repairedLowOpen.severity}) still open: next must propose its finding_resolve first`);
        }
        if (lowOpen && !repairRunsByFinding.has(lowOpen.id)) {
          o.script(FINDING_REPAIR, repairScript(lowOpen.desc));
          const launched = o.mustCli('host_run', { host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort, storyId: id,
            agentType: FINDING_REPAIR, findingId: lowOpen.id, managedDispatch: true, detach: true, json: true }, { label: 'host_run finding-repair (owner, low)' });
          const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
          const terminal = waitTerminal(o, 'finding-repair (low)', runId);
          o.unscript(FINDING_REPAIR);
          assert.equal(terminal.state, 'completed', `[${o.scenario}] owner low finding-repair ${terminal.state} (${terminal.reason})`);
          repairRunsByFinding.set(lowOpen.id, [runId]);
          reasons.push(`owner_repair_low:${lowOpen.id}`);
          ownerTurns += 2;
          continue;
        }
        break;
      }
      case 'live_smoke':
        liveSmokeProposals += 1;
        if (mode.contextSmoke) {
          // Passes only with the project validate.env applied (CONTEXT=abs, run 16 §2e).
          payload.capture = 'test "$CONTEXT" = abs && go test -v ./strs';
          if (liveSmokeProposals > 1) {
            mode.violations?.push(`live_smoke proposed again: the capture without an exported CONTEXT did not pass (validate.env not applied); why: ${next.why.slice(0, 160)}`);
            // The owner's run-16 workaround: export it.
            payload.capture = 'export CONTEXT=abs; test "$CONTEXT" = abs && go test -v ./strs';
          }
        }
        break;
      case 'finding_resolve': {
        // Old-PoS run 34: the framework form carries resolutions[] (one entry); the owner form findingId.
        const findingId = String(payload.findingId ?? (payload.resolutions as Array<{ findingId: string }> | undefined)?.[0]?.findingId);
        // Run 14: next must never propose closing a finding no repair bound to it produced.
        const runIds = [...new Set([...(repairRunsByFinding.get(findingId) ?? []), ...(repairRunsOnDisk(runsRoot).get(findingId) ?? [])])];
        const repaired = runIds.some(runId => {
          const terminal = join(runsRoot, runId, 'terminal.json');
          return existsSync(terminal) && (JSON.parse(readFileSync(terminal, 'utf8')) as { state?: string }).state === 'completed';
        });
        // Old-PoS runs 31/33: a Story-metadata finding (by correction target) closes by its corrected text, never by a repair.
        const metadataClose = /is a Story-metadata finding/.test(next.why) && findingDesc(findingId) === META_PRODUCT_COPY_DESC;
        assert.ok(repaired || metadataClose, `[${o.scenario}] next proposed finding_resolve for ${findingId} although no managed finding-repair run bound to it completed (runs per finding: ${JSON.stringify([...repairRunsByFinding])}); why: ${next.why}`);
        authorPayload(o, next.reason, payload, findingDesc);
        break;
      }
      case 'finding_resolve_batch': {
        // Old-PoS run 24 F4: one call closes every finding a repair run repaired; each still needs its own completed bound repair.
        const onDisk = repairRunsOnDisk(runsRoot);
        for (const entry of (payload.resolutions ?? []) as Array<{ findingId: string }>) {
          const runIds = [...new Set([...(repairRunsByFinding.get(entry.findingId) ?? []), ...(onDisk.get(entry.findingId) ?? [])])];
          assert.ok(runIds.some(runId => existsSync(join(runsRoot, runId, 'terminal.json'))
            && (JSON.parse(readFileSync(join(runsRoot, runId, 'terminal.json'), 'utf8')) as { state?: string }).state === 'completed'),
          `[${o.scenario}] next batched finding_resolve for ${entry.findingId} although no managed finding-repair run bound to it completed; why: ${next.why}`);
        }
        authorPayload(o, next.reason, payload, findingDesc);
        break;
      }
      case 'finding_duplicate_resolve': {
        // Run 17 Q1: close the critic-marked duplicate with the canonical repair's
        // evidence only through a coverage run of the duplicate's own case.
        const findingId = String(payload.findingId);
        const canonicalId = String(payload.duplicateOf);
        assert.ok(!repairRunsByFinding.has(findingId), `[${o.scenario}] next proposed the duplicate resolve for ${findingId} after a repair of its own was launched`);
        // Lab round-cut (N3): the framework authored the coverage itself; run it as proposed.
        if (next.kind === 'framework') break;
        payload.coverage = mode.duplicate === 'uncovered'
          ? { command: 'go test -v ./strs -run TestReverseEmptyDup', selector: '--- PASS: TestReverseEmptyDup' }
          : { command: 'go test -v ./strs -run TestReverseEmpty', selector: '--- PASS: TestReverseEmpty' };
        payload.resolution = `duplicate of ${canonicalId}: its repair adds TestReverseEmpty, which exercises Reverse("") (this finding's case)`;
        if (mode.duplicate === 'uncovered') {
          // The duplicate's own case has no passing test: the framework must refuse
          // (never close on the critic label alone) and name the next step.
          const refused = o.cli(next.cli.command, payload, { label: '  a:finding_duplicate_resolve (uncovered)' });
          assert.notEqual(refused.status, 0, `[${o.scenario}] finding_resolve closed duplicate ${findingId} although its coverage command has no passing selector:\n${refused.out.slice(-1500)}`);
          assert.match(refused.out, /duplicate_coverage_(?:failed|lacks_repro)/, `[${o.scenario}] refusal names the failed coverage:\n${refused.out.slice(-1500)}`);
          assert.match(refused.out, /Next: /, `[${o.scenario}] refusal carries one Next line:\n${refused.out.slice(-1500)}`);
          assert.equal(new StoryStore(o.worktree).readFindings(id).findings.find(f => f.id === findingId)?.status, 'open', `[${o.scenario}] refused duplicate stays open`);
          reasons.push('duplicate_coverage_refused');
          continue;
        }
        break;
      }
      default:
        authorPayload(o, next.reason, payload, findingDesc);
        break;
    }
    // Q6 (b): a batch is the owner's one turn of authoring commands, run in order.
    const calls = next.batch?.length
      ? next.batch.map(call => { const filled = { ...call.cli.payload }; authorPayload(o, call.reason, filled, findingDesc); return { reason: call.reason, command: call.cli.command, payload: filled, line: call.command }; })
      : next.parallel?.length
      ? next.parallel.map(call => ({ reason: call.reason, command: call.cli.command, payload: { ...call.cli.payload }, line: call.command }))
      : [{ reason: next.reason, command: next.cli.command, payload, line: next.command ?? '' }];
    ownerTurns += 1;
    for (const call of calls) {
      const unfilled = Object.entries(call.payload).filter(([, value]) => typeof value === 'string' && /^<.*>$/.test(value)).map(([key]) => key);
      assert.deepEqual(unfilled, [], `[${o.scenario}] ${call.reason}: harness has no value for placeholder(s) ${unfilled.join(', ')}`);
      // NC6: the first critic's import is refused before anything persists (wrong wave copied into its block).
      const criticImportRunId = call.reason === 'review_evidence_import' && typeof call.payload.runId === 'string'
        && (JSON.parse(readFileSync(join(runsRoot, call.payload.runId, 'spec.json'), 'utf8')) as { agentType?: string }).agentType === MANAGED_INVENTORY_CRITIC_LANE
        ? call.payload.runId : null;
      const refuseOnce = mode.refusedBeforePersist && mode.refusedBeforePersist.length === 0 && criticImportRunId !== null;
      const ran = o.cli(call.command, call.payload, { label: `  ${next.kind[0]}:${call.reason}`.slice(0, 44) });
      if (refuseOnce) {
        assert.notEqual(ran.status, 0, `[${o.scenario}] the critic import with a wrong wave must be refused`);
        assert.match(ran.out, /invalid inventory critic purpose or wave/, `[${o.scenario}] refusal: ${ran.out.slice(-800)}`);
        mode.refusedBeforePersist!.push(criticImportRunId!);
        reasons.push('critic_import_refused_before_persist');
        continue;
      }
      if (ran.status !== 0 && mode.criticRestate === 'new-misfiled' && call.reason === 'review_evidence_import'
        && /REVIEW_INVENTORY_FINDING_DISPOSITION_(?:INCOMPLETE|INVALID)/.test(ran.out) && (mode.refusedCriticImports?.length ?? 0) === 0) {
        // NC3: the critic misfiled its own new finding; this one refusal is the scripted fault.
        mode.refusedCriticImports?.push(JSON.stringify(call.payload));
        reasons.push('critic_import_refused');
        continue;
      }
      assert.equal(ran.status, 0, `[${o.scenario}] next proposed ${call.line} (${call.reason}) and its gate refused it:\n${ran.out.slice(-2500)}`);
      const launched = parseJson(ran.stdout)?.run as Record<string, unknown> | undefined;
      if (call.command === 'host_run' && launched?.runId) {
        scriptKeyByRun.set(String(launched.runId), call.reason === 'delivery_review_launch' ? DELIVERY : call.reason === 'finding_repair' ? FINDING_REPAIR
          : call.reason === 'implement_item' ? IMPLEMENTER : String(call.payload.reviewRunId));
        if (call.reason === 'finding_repair') {
          for (const findingId of Array.isArray(call.payload.groupFindingIds) ? call.payload.groupFindingIds as string[] : [String(call.payload.findingId)]) {
            repairRunsByFinding.set(findingId, [...(repairRunsByFinding.get(findingId) ?? []), String(launched.runId)]);
          }
        }
      }
    }
  }
  assert.equal(new StoryStore(o.root).readStory(id).phase, 'DONE', `[${o.scenario}] next never reached DONE; steps: ${reasons.join(' > ')}`);
  lines.push(`next-driven steps (${reasons.length}): ${reasons.join(' > ')}`);
  const ownerSteps = reasons.filter(row => !row.startsWith('run:'));
  lines.push(`owner turns from REVIEW entry: ${ownerTurns} (${ownerSteps.length} owner-executed steps)`);
  if (mode.drive) lines.push(`framework driver: ${nextCalls} next --untilAgent call(s), ${driverRunCalls} next --run call(s) inside them${watchdogKills.length ? `, ${watchdogKills.length} watchdog kill(s)` : ''}`);
  if (runLike) lines.push(`framework steps executed inside next --run: ${internalCalls} (${(internalMs / 1000).toFixed(1)} s, included in the next --run call times)`);
  if (runLike) lines.push(`framework step wall by reason: ${[...stepMs].map(([reason, row]) => `${reason} ${row.n}x ${(row.ms / 1000).toFixed(1)} s`).join(', ')}`);
  const unique = [...new Set(q6)];
  if (mode.violations) mode.violations.push(...unique);
  else assert.deepEqual(unique, [], `[${o.scenario}] Q6 next-driver contract violations:\n- ${unique.join('\n- ')}`);
  return { ownerTurns, ownerSteps, nextCalls, driverRunCalls, watchdogKills };
}

/**
 * Run 16 (§2c, §2e): round 1 reports a medium finding plus two LOW findings.
 * next repairs and resolves the medium one; at enter_review the owner repairs
 * the first LOW finding anyway (managed finding-repair bound to it). next must
 * then propose finding_resolve for it (same per-finding rule as medium) before
 * REVIEW, so DONE does not leave a repaired finding open. The cosmetic LOW
 * finding stays open (advisory) through DONE; finding_resolve after DONE must
 * refuse with a clear next action instead of leaving uncommitted metadata in the
 * integration checkout. The live-smoke capture needs validate.env (CONTEXT=abs).
 */
function scenarioNL(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const name = 'NL run 16: repaired LOW finding resolved before DONE; post-DONE resolve refused clean; live smoke uses validate.env';
  const o = new Owner('NL', 'B-e2eb', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const reasons: string[] = [];
  const violations: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, lowFindings: true, contextSmoke: true, violations }, lines, next => {
      if (next.reason === 'finding_repair' || next.reason === 'finding_resolve' || next.reason === 'enter_review') {
        reasons.push(`${next.reason}${stepFindingId(next) ? `:${stepFindingId(next)}` : ''}`);
      }
    });
    const order = reasons.filter((row, index) => row !== reasons[index - 1]);
    lines.push(`finding steps: ${order.join(' > ')}`);
    const findings = new StoryStore(o.root).readFindings(o.storyId).findings;
    const byDesc = (prefix: string) => findings.find(f => f.desc.startsWith(prefix));
    const repairedLow = byDesc('Upper ');
    const cosmetic = byDesc('Comment ');
    assert.ok(repairedLow && cosmetic, `NL: both low findings recorded: ${JSON.stringify(findings.map(f => [f.id, f.severity, f.status]))}`);
    if (repairedLow.status !== 'resolved') violations.push(`DONE left the repaired LOW finding ${repairedLow.id} ${repairedLow.status} (steps: ${order.join(' > ')})`);
    assert.equal(cosmetic.status, 'open', 'NL: the unrepaired cosmetic LOW finding stays open (advisory)');
    assert.match(readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8'), /TestUpperEmpty/, 'low repair merged into main');
    // Post-DONE resolve from the integration checkout (run 16: owner in /app).
    const before = git(o.root, ['status', '--porcelain', '--untracked-files=all']);
    const late = o.cli('finding_resolve', { storyId: o.storyId, findingId: cosmetic.id, resolution: 'post-DONE: comment wording changed in a follow-up commit' }, { label: 'finding_resolve after DONE' });
    const after = git(o.root, ['status', '--porcelain', '--untracked-files=all']);
    lines.push(`finding_resolve after DONE: exit ${late.status}: ${late.out.split('\n').filter(Boolean).slice(0, 2).join(' | ').slice(0, 220)}`);
    if (after !== before) violations.push(`finding_resolve after DONE left uncommitted metadata in the integration checkout: ${after.replace(/\n/g, '; ')}`);
    if (late.status === 0) violations.push('finding_resolve after DONE was accepted (must refuse: the DONE record is merged)');
    else if (!/DONE/.test(late.out) || !/Next:/.test(late.out)) violations.push(`finding_resolve after DONE refusal must name DONE and one Next action: ${late.out.slice(-400)}`);
    assert.deepEqual(violations, [], `NL violations:\n- ${violations.join('\n- ')}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`NL fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Run 17 Q1: the inventory critic marks a second round-1 finding a duplicate of
 * the first (same root cause). NU: after the canonical repair + resolve, next
 * proposes closing the duplicate with that repair's evidence through a coverage
 * run of the duplicate's own case (a passing test the canonical repair added),
 * with no second repair cycle. NU2: the duplicate's case is not covered; the
 * coverage run is refused and next dispatches the duplicate's own repair.
 */
function scenarioNU(machineEnv: NodeJS.ProcessEnv, steps: Step[], covered: boolean): Outcome {
  const tag = covered ? 'NU' : 'NU2';
  const name = covered
    ? 'NU run 17: critic duplicate closed with the canonical repair after a passing coverage run (no second repair)'
    : 'NU2 run 17: critic duplicate whose own case is not covered still gets its own repair';
  const o = new Owner(tag, covered ? 'B-e2ec' : 'B-e2ed', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const reasons: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, duplicate: covered ? 'covered' : 'uncovered' }, lines, next => {
      if (['finding_repair', 'finding_resolve', 'finding_duplicate_resolve'].includes(next.reason)) {
        reasons.push(`${next.reason}:${String(stepFindingId(next) ?? '').split(':').pop()}`);
      }
    });
    const order = reasons.filter((row, index) => row !== reasons[index - 1]);
    lines.push(`finding steps: ${order.join(' > ')}`);
    const expected = covered
      ? ['finding_repair:F-001', 'finding_resolve:F-001', 'finding_duplicate_resolve:F-002']
      : ['finding_repair:F-001', 'finding_resolve:F-001', 'finding_duplicate_resolve:F-002', 'finding_repair:F-002', 'finding_resolve:F-002'];
    assert.deepEqual(order, expected, `${tag}: finding steps ${order.join(' > ')}`);
    const findings = new StoryStore(o.root).readFindings(o.storyId).findings;
    const dup = findings.find(f => f.desc === NU_DUP_FINDING.desc);
    assert.equal(dup?.status, 'resolved', `${tag}: the duplicate finding is closed at DONE`);
    if (covered) {
      assert.equal(dup?.resolutionType, 'duplicate', `${tag}: resolved as a duplicate`);
      assert.match(dup?.resolvedReason ?? '', /TestReverseEmpty/, `${tag}: the resolution records the coverage receipt`);
      assert.doesNotMatch(readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8'), /TestReverseEmptyDup/, `${tag}: no second repair ran`);
    } else {
      assert.match(readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8'), /TestReverseEmptyDup/, `${tag}: the duplicate's own repair merged into main`);
    }
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Detection A/B control D9-r1 (NC), D2-r3 (NC2): the round-1 inventory critic
 * re-raises the lane finding as its own finding and gives only one of the two
 * copies a row. The import must complete the other copy as a duplicate (same
 * file + same claim) instead of refusing the critic; the copy is then closed by
 * the duplicate-coverage path with the canonical repair, and the Story reaches DONE.
 * NC3: the critic reports a genuinely NEW finding and misfiles its row (a
 * duplicate of a different family). The import refuses it once (never reconciled away); next must not propose that import
 * again but run a fresh critic whose prompt names the refusal; that critic
 * dispositions the new finding, which is then repaired like any other.
 */
function scenarioNC(machineEnv: NodeJS.ProcessEnv, steps: Step[], restate: CriticRestateMode): Outcome {
  const tag = restate === 'copies' ? 'NC' : restate === 'reworded' ? 'NC2' : 'NC3';
  const name = `${tag} A/B control: critic ${restate === 'new-misfiled' ? 'misfiles a new finding (import refused); next runs a fresh critic, never the refused import' : `restates the lane finding (${restate}); import completes it as a duplicate`}`;
  const o = new Owner(tag, restate === 'copies' ? 'B-e2f1' : restate === 'reworded' ? 'B-e2f2' : 'B-e2f3', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const refused: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, criticRestate: restate, refusedCriticImports: refused }, lines);
    const store = new StoryStore(o.root);
    const findings = store.readFindings(o.storyId).findings;
    const receipts = store.readReviewInventoryEpochs(o.storyId).criticReceipts;
    const firstReceiptRows = receipts[0]?.findingDispositions ?? [];
    if (restate === 'new-misfiled') {
      assert.equal(refused.length, 1, `${tag}: the critic with a misfiled new finding is refused exactly once`);
      const upper = findings.find(f => f.desc === NF_FINDING.desc);
      assert.equal(upper?.status, 'resolved', `${tag}: the critic's new finding is kept and closed by its own repair`);
      const criticRuns = readdirSync(join(o.root, '.proof-or-stop', 'runtime', 'host-runs')).filter(runId => {
        try { return (JSON.parse(readFileSync(join(o.root, '.proof-or-stop', 'runtime', 'host-runs', runId, 'spec.json'), 'utf8')) as { agentType?: string }).agentType === MANAGED_INVENTORY_CRITIC_LANE; } catch { return false; }
      });
      const prompts = criticRuns.map(runId => join(o.scriptsDir, 'prompts', `${runId}.txt`)).filter(existsSync).map(path => readFileSync(path, 'utf8'));
      assert.ok(prompts.some(text => /was refused at import: .*REVIEW_INVENTORY_FINDING_DISPOSITION_INVALID/.test(text) && text.includes(upper!.id)),
        `${tag}: the fresh critic's prompt names the refused import's exact error and finding id`);
    } else {
      assert.deepEqual(refused, [], `${tag}: no critic import refused`);
      const copy = findings.find(f => f.agent === MANAGED_INVENTORY_CRITIC_LANE);
      assert.ok(copy, `${tag}: the critic's restated finding is recorded, not dropped`);
      const row = firstReceiptRows.find(r => r.findingId === copy!.id);
      assert.equal(row?.disposition, 'duplicate', `${tag}: the restated copy is a duplicate of the lane finding: ${JSON.stringify(firstReceiptRows)}`);
      assert.equal(copy!.status, 'resolved', `${tag}: the copy is closed at DONE`);
    }
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** Run 19 (B-8166): a critic row for the round's only (suspected) finding is dropped and logged, never a refused import. */
function scenarioNC4(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const name = 'NC4 run 19: critic row for a suspected finding is dropped and logged, the round finalizes, DONE';
  const o = new Owner('NC4', 'B-e2f4', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const refused: string[] = [];
  try {
    devSetup(o);
    let ownerReceipt: { status: number; out: string } | undefined;
    driveWithNext(o, { findingRound1: true, run: false, suspectedOnly: true, refusedCriticImports: refused }, lines, next => {
      if (ownerReceipt || next.reason !== 'inventory_status_next') return;
      // Run 19: the owner wrote the managed critic's receipt itself (empty list, critic identity). F5: refused.
      const store = new StoryStore(o.worktree);
      const epoch = store.readReviewInventoryEpochs(o.storyId).epochs.at(-1)!;
      const critic = store.readReviewRuns(o.storyId).runs.filter(run => run.reviewPurpose === 'inventory-completeness').at(-1)!;
      const ran = o.cli('review_inventory_critic_set', { storyId: o.storyId, epochId: epoch.epochId, reviewRunId: critic.reviewRunId,
        agent: MANAGED_INVENTORY_CRITIC_LANE, findingDispositions: [] }, { label: 'owner review_inventory_critic_set (refused)' });
      ownerReceipt = { status: ran.status ?? 1, out: ran.out };
    });
    assert.deepEqual(refused, [], 'NC4: no critic import refused');
    assert.ok(ownerReceipt && ownerReceipt.status !== 0 && /REVIEW_INVENTORY_CRITIC_MANAGED_RECEIPT_ONLY/.test(ownerReceipt.out),
      `NC4: an owner-written receipt for the managed critic run is refused: ${ownerReceipt?.out.slice(-600)}`);
    const store = new StoryStore(o.root);
    const suspected = store.readFindings(o.storyId).findings.find(f => f.desc === NC4_SUSPECTED.desc);
    assert.equal(suspected?.evidenceState, 'suspected', 'NC4: the finding stays suspected (no promotion by the critic)');
    const dropped = store.readProcessEvents(o.storyId).filter(e => e.type === 'inventory_critic_disposition_dropped');
    assert.ok(dropped.some(e => (e.droppedFindingIds as string[] | undefined)?.includes(suspected!.id)), `NC4: the dropped row is logged: ${JSON.stringify(dropped)}`);
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`NC4 fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** Old-PoS run 24 (B-c9ea:RR-005): the critic's last agent_message, byte-exact (no JSON envelope followed). */
const NC9_PROSE_FINAL = "The proposal validates. I'll now emit the single required JSON object as my final result.";

/**
 * NC9, old-PoS run 24 F1/F2: the first round-1 critic validated its proposal
 * and ended its turn with prose and no JSON envelope. Its run fails (this fake
 * provider has no resumable session, so the same-session format repair cannot
 * run) with nothing produced; next must relaunch the critic itself (a framework
 * step under the per-target relaunch rule), never hand it to the owner.
 */
function scenarioNC9(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NC9';
  const name = 'NC9 run 24: the first critic ends with prose and no JSON envelope; next relaunches the critic as a framework step, DONE';
  const o = new Owner(tag, 'B-e2f9', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const launches: Array<{ kind: string; failedCritics: number }> = [];
  const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
  const failedCriticReasons = (): string[] => existsSync(runsRoot) ? readdirSync(runsRoot).flatMap(runId => {
    try {
      if ((JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as { agentType?: string }).agentType !== MANAGED_INVENTORY_CRITIC_LANE) return [];
      const terminal = JSON.parse(readFileSync(join(runsRoot, runId, 'terminal.json'), 'utf8')) as { state?: string; reason?: string };
      return terminal.state === 'failed' ? [String(terminal.reason)] : [];
    } catch { return []; }
  }) : [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, criticProseFirst: true }, lines, next => {
      if (next.reason === 'inventory_critic_launch') launches.push({ kind: next.kind, failedCritics: failedCriticReasons().length });
    });
    const failed = failedCriticReasons();
    assert.equal(failed.length, 1, `${tag}: exactly the first critic run failed (${failed.join(' | ')})`);
    assert.match(failed[0]!, /^managed_review_final_result_invalid:managed_review_final_result_missing/, `${tag}: the prose-only final is a missing envelope`);
    const relaunch = launches.find(row => row.failedCritics > 0);
    assert.ok(relaunch, `${tag}: next relaunched the critic after its failed run (launches ${JSON.stringify(launches)})`);
    assert.equal(relaunch!.kind, 'framework', `${tag}: the replacement critic launch is a framework step, not the owner's (launches ${JSON.stringify(launches)})`);
    lines.push(`critic launches: ${launches.map(row => `${row.kind}${row.failedCritics ? ' (after failed critic)' : ''}`).join(' > ')}`);
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NC5, A/B V3 R2A-r2 (de80753): the critic read candidate-spec-set.json and
 * still wrote a mistyped candidateSpecSetDigest; the import was refused before
 * anything was recorded and next proposed it forever. The worker now seals the
 * launch-bound route into the proposal: no refusal, the round finalizes, DONE.
 * NC6: the same refusal KIND as de80753 (refused before any evidence persists,
 * which the 9471bb7 rule did not cover), produced by another transcription
 * error the worker cannot seal away: the critic copies a wrong wave number into
 * its block. The import is refused once and recorded
 * (managed_review_import_refused); next never proposes it again but runs a
 * fresh critic whose prompt names the refusal, and the Story reaches DONE.
 */
function scenarioNC5(machineEnv: NodeJS.ProcessEnv, steps: Step[], refusal: boolean): Outcome {
  const tag = refusal ? 'NC6' : 'NC5';
  const name = refusal
    ? 'NC6 critic import refused before anything persists (wrong wave): recorded once, next relaunches the critic, DONE'
    : 'NC5 A/B V3 R2A-r2: critic mistypes candidateSpecSetDigest; worker seals the launch-bound route, no refusal, DONE';
  const o = new Owner(tag, refusal ? 'B-e2f6' : 'B-e2f5', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const refused: string[] = [];
  const refusedRuns: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, refusedCriticImports: refused,
      ...(refusal ? { refusedBeforePersist: refusedRuns } : { criticMistypedDigest: true }) }, lines);
    const store = new StoryStore(o.root);
    const events = store.readProcessEvents(o.storyId).filter(e => e.type === 'managed_review_import_refused');
    const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
    const criticRuns = readdirSync(runsRoot).filter(runId => {
      try { return (JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as { agentType?: string }).agentType === MANAGED_INVENTORY_CRITIC_LANE; } catch { return false; }
    });
    if (refusal) {
      assert.equal(refusedRuns.length, 1, `${tag}: exactly one critic import was refused`);
      assert.equal(events.filter(e => e.managedRunId === refusedRuns[0]).length, 1, `${tag}: the refusal is recorded once: ${JSON.stringify(events)}`);
      const prompts = criticRuns.map(runId => join(o.scriptsDir, 'prompts', `${runId}.txt`)).filter(existsSync).map(path => readFileSync(path, 'utf8'));
      assert.ok(prompts.some(text => /refused at import before anything was recorded: /.test(text)),
        `${tag}: the fresh critic's prompt names the refusal`);
    } else {
      assert.deepEqual(events, [], `${tag}: no import refused`);
      const sealed = criticRuns.map(runId => readFileSync(join(runsRoot, runId, 'events.jsonl'), 'utf8')).join('\n');
      assert.match(sealed, /read_manifest_routing_sealed/, `${tag}: the worker journaled the sealed route`);
      assert.match(sealed, new RegExp(NC5_MISTYPED_DIGEST), `${tag}: the journal keeps the provider's mistyped value`);
    }
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NC7: the owner runs `candidate_spec_route` by hand after the round-1 lanes
 * were imported and the inventory critic completed, just before the critic's
 * import (found while building NC6). On base the reroute went through and
 * invalidated the round: the critic import was refused for a stale cutoff,
 * review_round_prepare relaunched every lane, and the verdict dead-ended
 * review_evidence_invalid (F-001 still bound to the superseded lane run) with
 * no runnable Next. Now the reroute of a current route is refused with one
 * Next, nothing is written, and the round continues to DONE.
 * NC8: the same round is invalidated another way (an unauthenticated owner
 * commit breaks the managed live binding, as in D2), so every lane reruns and
 * the test-coverage lane re-reports the defect as F-002 while F-001 stays
 * open on the superseded run. next never dead-ends: F-001 is carried forward
 * (it keeps blocking), F-002 is repaired, and F-001 closes only through the
 * duplicate-coverage run of its own case; DONE.
 */
function scenarioNC7(machineEnv: NodeJS.ProcessEnv, steps: Step[], variant: 'reroute' | 'lineage'): Outcome {
  const tag = variant === 'reroute' ? 'NC7' : 'NC8';
  const name = variant === 'reroute'
    ? 'NC7 owner reroute mid-inventory (lanes imported, critic completed): refused with one Next, nothing written, DONE'
    : 'NC8 round invalidated mid-inventory (live binding broken): lanes rerun, superseded open finding carried forward and closed by coverage, DONE';
  const o = new Owner(tag, variant === 'reroute' ? 'B-e2f7' : 'B-e2f8', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
  let interjected = false;
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, interject: next => {
      if (interjected || next.reason !== 'review_evidence_import' || typeof next.cli?.payload.runId !== 'string') return false;
      const spec = JSON.parse(readFileSync(join(runsRoot, next.cli.payload.runId, 'spec.json'), 'utf8')) as { agentType?: string };
      if (spec.agentType !== MANAGED_INVENTORY_CRITIC_LANE) return false;
      interjected = true;
      if (variant === 'lineage') {
        git(o.worktree, ['commit', '-q', '--allow-empty', '-m', 'owner: checkpoint review status']);
        lines.push('owner checkpoint commit mid-inventory (breaks the managed live binding)');
        return true;
      }
      const story = (): string => readFileSync(join(new StoryStore(o.worktree).storyDirPath(o.storyId), 'candidate-spec-set.json'), 'utf8');
      const before = { head: git(o.worktree, ['rev-parse', 'HEAD']), route: story() };
      const ran = o.cli('candidate_spec_route', { storyId: o.storyId, hosts: false }, { label: 'owner candidate_spec_route (mid-inventory)' });
      assert.notEqual(ran.status, 0, `${tag}: a reroute of the current route mid-inventory must be refused:\n${ran.out.slice(-1500)}`);
      assert.match(ran.out, /candidate_route_current_in_review/, `${tag}: refusal code:\n${ran.out.slice(-1500)}`);
      const nextLines = ran.out.split('\n').filter(line => line.includes('Next: '));
      assert.equal(new Set(nextLines.map(line => line.slice(line.indexOf('Next: ')))).size, 1, `${tag}: exactly one Next:\n${ran.out.slice(-1500)}`);
      assert.match(nextLines[0]!, new RegExp(`Next: proof-or-stop next --storyId=${o.storyId}`), `${tag}: Next names next`);
      assert.equal(git(o.worktree, ['rev-parse', 'HEAD']), before.head, `${tag}: a refused reroute commits nothing`);
      assert.equal(story(), before.route, `${tag}: a refused reroute leaves the route unchanged`);
      lines.push(`owner reroute mid-inventory refused: ${nextLines[0]!.trim()}`);
      return true;
    } }, lines);
    assert.ok(interjected, `${tag}: the harness interjected before the critic import`);
    const findings = new StoryStore(o.root).readFindings(o.storyId).findings;
    if (variant === 'lineage') {
      const reported = findings.filter(f => f.desc === findings[0]?.desc);
      assert.ok(reported.length >= 2, `${tag}: the rerun lane re-reported the defect: ${JSON.stringify(findings.map(f => [f.id, f.status, f.reviewRunId]))}`);
      assert.ok(reported.every(f => f.status === 'resolved'), `${tag}: both copies closed, none dropped: ${JSON.stringify(reported.map(f => [f.id, f.status, f.resolutionType]))}`);
      assert.ok(reported.some(f => f.resolutionType === 'duplicate'), `${tag}: the superseded copy closed as a duplicate with coverage`);
      lines.push(`findings: ${reported.map(f => `${f.id} ${f.status}`).join(', ')}`);
    }
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Old-PoS run 25 (B-2b04, 20261008T103232Z-oldpos-fresh-36142): the REVIEW livelock.
 * NW3 (F3): with a verified finding open, the owner commits a test edit in
 *   REVIEW (e8d6360 / 11d3924), so the pinned evidence is stale for the material
 *   the rerun lanes review (no reopen: the remediation path applies); the lanes
 *   pass; then the framework's own `verification_evidence_refresh_stale`
 *   restamps that evidence (1faa99b: checklist.json + its closeout receipt,
 *   no material, no intent, no result change). That metadata-only commit must
 *   keep every managed pass live (it staled RP-011 and forced a lane rerun on
 *   unchanged material), and the round finishes with no lineage-driven rerun.
 * NW4 (F4): every lane passes, the wave-1 critic reports a new verified
 *   finding (F-002), the wave-2 lanes all re-report it (F-003..F-005: one
 *   verified_family copy, two duplicates) and the epoch finalizes. next must
 *   route the open findings to DEV (repair the canonical once, close the
 *   copies by coverage) and never relaunch lanes of the finalized round
 *   (RR-021..023 re-reported it again, so every finalize changed the live
 *   aggregate) or end in `human — none runnable`. No verified finding is dropped.
 * NW5 (F4 stop-loss): the owner cancels the finalized epoch before
 *   certification (item 186, "late evidence invalidated finalized receipt").
 *   The cancelled epoch's critic pass must not become permanently invalid
 *   (RP-011 "has an invalid current inventory subject" = `human — none
 *   runnable`): next opens a fresh epoch, its critic supersedes the old pass, DONE.
 */
function scenarioNW(machineEnv: NodeJS.ProcessEnv, steps: Step[], tag: 'NW3' | 'NW4' | 'NW5' | 'NW6'): Outcome {
  const name = tag === 'NW6'
    ? 'NW6 run 25 F4 stop-loss: lanes keep going stale on unchanged material with a verified finding open; after 3 lane waves next repairs it instead of a 4th wave, DONE'
    : tag === 'NW3'
    ? 'NW3 run 25 F3: framework evidence restamp (verification_evidence_refresh_stale) after the rerun lanes passed keeps every managed pass live; no lineage-driven rerun, DONE'
    : tag === 'NW4'
      ? 'NW4 run 25 F4: wave-1 critic finding re-reported by every wave-2 lane; after finalize next repairs it in DEV (no lane relaunch, no human), copies closed, DONE'
      : 'NW5 run 25 F4: owner cancels the finalized epoch; the cancelled critic pass is superseded by a fresh epoch, never a dead end, DONE';
  const o = new Owner(tag, tag === 'NW3' ? 'B-e2a3' : tag === 'NW4' ? 'B-e2a4' : tag === 'NW5' ? 'B-e2a5' : 'B-e2a6', machineEnv, steps, false, { trackedGateFailureCounts: true });
  let staleWaves = 0;
  const lines: string[] = [];
  const kinds: string[] = [];
  let edited = false;
  let refreshed = false;
  let cancelled = false;
  let waveAdvanced = false;
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: tag === 'NW6' || tag === 'NW3', run: false, ...(tag === 'NW4' ? { criticNewFinding: true, restateAfterCritic: true } : {}), interject: next => {
      kinds.push(`${next.kind}:${next.reason}`);
      if (tag === 'NW3' && !edited && next.phase === 'REVIEW' && /^inventory_/.test(next.reason)
        && new StoryStore(o.worktree).readFindings(o.storyId).findings.some(f => f.status === 'open')) {
        // e8d6360 / 11d3924: a test-only owner commit in REVIEW. A verified finding is open, so the
        // round is not reopened (the remediation path applies); the lanes rerun on the edited material
        // while the pinned evidence is still bound to the old material.
        writeFileSync(join(o.worktree, 'strs/strs_test.go'), `${readFileSync(join(o.worktree, 'strs/strs_test.go'), 'utf8')}\n// Latin multibyte fixtures only (owner edit in REVIEW).\n`);
        git(o.worktree, ['add', 'strs/strs_test.go']);
        git(o.worktree, ['commit', '-qm', `${o.storyId}: use Latin Unicode fixtures in slice tests`]);
        edited = true;
        lines.push('owner test-only commit in REVIEW with F-001 open (pinned evidence now stale; lanes rerun on the new material)');
        return true;
      }
      if (tag === 'NW3' && edited && !refreshed && next.phase === 'REVIEW' && /^inventory_/.test(next.reason)) {
        // 1faa99b: the framework restamps the stale pinned evidence after the lanes were imported.
        const store = new StoryStore(o.worktree);
        const passes = store.readReviewPasses(o.storyId).passes.map(pass => pass.id);
        assert.ok(passes.length >= 2, `NW3: the rerun lanes were imported before the refresh (${passes.join(', ')})`);
        o.mustCli('verification_evidence_refresh_stale', { storyId: o.storyId }, { label: 'verification_evidence_refresh_stale (framework restamp)' });
        assert.match(git(o.worktree, ['log', '-1', '--format=%s']), /record \S+ verification_evidence_refresh_stale metadata$/, 'NW3: the restamp committed its own metadata');
        const invalid = collectReviewerEvidenceState(new StoryStore(o.worktree), o.storyId, o.worktree).invalid.filter(issue => issue.kind === 'pass');
        assert.deepEqual(invalid.map(issue => `${issue.evidenceId}: ${issue.code}: ${issue.message.slice(0, 400)}`), [],
          'NW3: the framework evidence restamp must leave every managed pass live (run 25 F3)');
        refreshed = true;
        lines.push('verification_evidence_refresh_stale restamped the evidence; every managed pass stays live');
        return true;
      }
      if (tag === 'NW4' && !waveAdvanced && next.phase === 'REVIEW' && next.reason === 'inventory_status_next') {
        // Run 25 items 201-202: the owner finalized the epoch plainly; the critic's new
        // finding requires the next wave, so the owner advanced it (wave-2 lanes rerun).
        const finalize = o.cli('review_inventory_finalize', { storyId: o.storyId }, { label: 'owner review_inventory_finalize (run 25 item 201)' });
        assert.notEqual(finalize.status, 0, `NW4: a plain finalize with a new critic finding must require the next wave:\n${finalize.out.slice(-1200)}`);
        assert.match(finalize.out, /REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE/, `NW4: refusal code:\n${finalize.out.slice(-1200)}`);
        o.mustCli('review_inventory_wave_advance', { storyId: o.storyId }, { label: 'owner review_inventory_wave_advance (run 25 item 202)' });
        waveAdvanced = true;
        lines.push('owner finalize refused (new finding requires next wave) -> owner wave_advance');
        return true;
      }
      if (tag === 'NW6' && staleWaves < 3 && next.phase === 'REVIEW' && /^inventory_/.test(next.reason)
        && new StoryStore(o.worktree).readFindings(o.storyId).findings.every(f => f.status === 'open')) {
        // Run 25 waves 2-6: every lane wave of the round went stale on unchanged material (here an
        // unauthenticated checkpoint commit breaks the managed live binding) while F-001 stays open.
        git(o.worktree, ['commit', '-q', '--allow-empty', '-m', `owner: checkpoint review status ${staleWaves + 1}`]);
        staleWaves += 1;
        lines.push(`owner checkpoint commit ${staleWaves} after the lanes (breaks the managed live binding)`);
        return true;
      }
      if (tag === 'NW5' && !cancelled && next.reason === 'certification_begin') {
        o.mustCli('review_inventory_cancel', { storyId: o.storyId, reason: 'late evidence invalidated finalized receipt' }, { label: 'owner review_inventory_cancel (run 25 item 186)' });
        cancelled = true;
        lines.push('owner cancelled the finalized epoch before certification');
        return true;
      }
      return false;
    } }, lines);
    const store = new StoryStore(o.root);
    const runs = store.readReviewRuns(o.storyId).runs;
    const firstRound = runs.find(run => run.reviewPurpose !== 'inventory-completeness')?.reviewRound;
    const roundOneLanes = runs.filter(run => run.reviewRound === firstRound && run.reviewPurpose !== 'inventory-completeness');
    const findings = store.readFindings(o.storyId).findings;
    if (tag === 'NW3') {
      assert.ok(edited && refreshed, 'NW3: the owner edit and the framework restamp both happened');
      assert.equal(roundOneLanes.length, 6, `NW3: two lane waves in round 1 (old and edited material), no lineage-driven rerun after the restamp (${roundOneLanes.map(run => run.reviewRunId).join(', ')})`);
    }
    if (tag === 'NW4') {
      assert.ok(waveAdvanced, 'NW4: the owner advanced the epoch to wave 2');
      const epochs = store.readReviewInventoryEpochs(o.storyId).epochs.filter(epoch => epoch.reviewRound === firstRound);
      const finalized = epochs.find(epoch => epoch.state === 'FINALIZED' && epoch.waves.length >= 2);
      assert.ok(finalized, `NW4: the round-1 epoch finalized after its second wave: ${JSON.stringify(epochs.map(e => [e.epochId, e.state, e.waves.length]))}`);
      const after = roundOneLanes.filter(run => (run.startedAt ?? '') > (finalized!.updatedAt ?? ''));
      assert.deepEqual(after.map(run => run.reviewRunId), [], 'NW4: no lane of round 1 relaunched after its epoch finalized (run 25 RR-021..023)');
      assert.equal(roundOneLanes.length, 6, `NW4: exactly two lane waves in round 1 (${roundOneLanes.map(run => run.reviewRunId).join(', ')})`);
      const copies = findings.filter(f => f.desc === D_FINDING.desc && f.reviewRound === firstRound);
      assert.equal(copies.length, 4, `NW4: the critic finding and its three wave-2 copies are all recorded: ${JSON.stringify(copies.map(f => [f.id, f.agent]))}`);
      assert.ok(copies.every(f => f.status === 'resolved'), `NW4: every copy closed, none dropped: ${JSON.stringify(copies.map(f => [f.id, f.status, f.resolutionType]))}`);
      const repairs = repairRunsOnDisk(join(o.root, '.proof-or-stop', 'runtime', 'host-runs'));
      lines.push(`findings: ${copies.map(f => `${f.id.split(':').pop()} ${f.status}${f.resolutionType ? `/${f.resolutionType}` : ''}`).join(', ')}; repair runs per finding: ${JSON.stringify([...repairs].map(([id, ids]) => [id.split(':').pop(), ids.length]))}`);
    }
    if (tag === 'NW6') {
      const perLane = new Map<string, number>();
      for (const run of roundOneLanes) perLane.set(run.lane, (perLane.get(run.lane) ?? 0) + 1);
      assert.ok(staleWaves >= 2, `NW6: at least two stale lane waves happened (${staleWaves})`);
      assert.ok(Math.max(...perLane.values()) <= 3, `NW6: no 4th lane wave on unchanged material (${JSON.stringify([...perLane])})`);
      assert.ok(findings.filter(f => f.reviewRound === firstRound).every(f => f.status === 'resolved'), `NW6: every round-1 finding closed, none dropped: ${JSON.stringify(findings.map(f => [f.id, f.status]))}`);
      const stopLoss = store.readProcessEvents(o.storyId).filter(e => e.type === 'phase_transition' && (e as { transitionType?: string }).transitionType === 'review_stop_loss');
      assert.equal(stopLoss.length, 1, `NW6: REVIEW->DEV took the recorded stale-wave stop-loss once: ${JSON.stringify(stopLoss)}`);
      lines.push(`round-1 lane runs per lane: ${JSON.stringify([...perLane].map(([lane, n]) => [lane.replace('proof-or-stop-review-', ''), n]))}; stop-loss: ${String((stopLoss[0] as { reason?: string }).reason).slice(0, 160)}`);
    }
    if (tag === 'NW5') {
      assert.ok(cancelled, 'NW5: the owner cancelled the finalized epoch');
      const epochs = store.readReviewInventoryEpochs(o.storyId).epochs.filter(epoch => epoch.reviewRound === firstRound);
      assert.ok(epochs.some(epoch => epoch.state === 'CANCELLED') && epochs.some(epoch => epoch.state === 'FINALIZED'),
        `NW5: a fresh epoch finalized after the cancel: ${JSON.stringify(epochs.map(e => [e.epochId, e.state]))}`);
      assert.equal(roundOneLanes.length, 3, `NW5: the lanes were not rerun (${roundOneLanes.map(run => run.reviewRunId).join(', ')})`);
    }
    assert.ok(!kinds.some(kind => kind.startsWith('human:')), `${tag}: next never asked a human: ${kinds.filter(kind => kind.startsWith('human:')).join(', ')}`);
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

function scenarioN(machineEnv: NodeJS.ProcessEnv, steps: Step[], flow: 'A' | 'D', run: boolean): Outcome {
  const tag = `N${flow}${run ? '-run' : ''}`;
  const name = `${tag} ${flow}'s flow from REVIEW entry driven only by proof-or-stop next${run ? ' --run' : ''}`;
  const o = new Owner(tag, flow === 'A' ? (run ? 'B-e2e7' : 'B-e2e5') : (run ? 'B-e2e8' : 'B-e2e6'), machineEnv, steps, false, flow === 'D' ? { trackedGateFailureCounts: true } : {});
  const lines: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: flow === 'D', run }, lines);
    assert.match(git(o.root, ['log', '--format=%s', '-3', 'main']), new RegExp(`merge: ${o.storyId} `), 'story branch merged into main');
    // Old-PoS run 27 (row 7): the text the owner reads after DONE ends the session explicitly.
    const after = o.cli('next', { storyId: o.storyId }, { label: 'next (after DONE)' });
    assert.match(after.stdout, /^Next: DONE — stop; no further commands\b/m, `${tag}: next after DONE prints the terminal statement:\n${after.out.slice(-800)}`);
    if (flow === 'D') assert.match(readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8'), /TestReverseEmpty/, 'repair merged into main');
    if (run) {
      // Lab framework-perf: next --run writes one diagnostics row per decision and per step.
      const rows = readFileSync(join(o.root, '.proof-or-stop', 'runtime', 'next-run', 'diagnostics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
        type: string; reason: string; wallMs: number; gitSpawns?: number; gitCacheHits?: number;
        children?: Array<{ command: string; bootMs: number; wallMs: number; gitSpawns: number; gitCacheHits: number }> });
      const decides = rows.filter(row => row.type === 'decide');
      const stepRows = rows.filter(row => row.type === 'step');
      assert.ok(decides.length > 0 && stepRows.length > 0, `${tag}: next --run diagnostics have decide and step rows`);
      assert.ok(stepRows.every(row => typeof row.wallMs === 'number' && Array.isArray(row.children)), `${tag}: every step row has a wall time and its child counters`);
      const children = stepRows.flatMap(row => row.children ?? []);
      assert.ok(children.length > 0 && children.every(child => typeof child.bootMs === 'number' && typeof child.gitSpawns === 'number'), `${tag}: step children report boot ms and git spawns`);
      const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
      lines.push(`next --run diagnostics: ${decides.length} decisions ${(sum(decides.map(row => row.wallMs)) / 1000).toFixed(1)} s (git ${sum(decides.map(row => row.gitSpawns ?? 0))} spawns, ${sum(decides.map(row => row.gitCacheHits ?? 0))} cached), `
        + `${stepRows.length} steps ${(sum(stepRows.map(row => row.wallMs)) / 1000).toFixed(1)} s (children: boot ${(sum(children.map(child => child.bootMs)) / 1000).toFixed(1)} s, git ${sum(children.map(child => child.gitSpawns))} spawns, ${sum(children.map(child => child.gitCacheHits))} cached)`);
      const byReason = new Map<string, { n: number; ms: number; max: number }>();
      for (const row of decides) {
        const entry = byReason.get(row.reason) ?? { n: 0, ms: 0, max: 0 };
        byReason.set(row.reason, { n: entry.n + 1, ms: entry.ms + row.wallMs, max: Math.max(entry.max, row.wallMs) });
      }
      lines.push(`decision wall by next step: ${[...byReason].sort((a, b) => b[1].ms - a[1].ms).map(([reason, row]) => `${reason} ${row.n}x ${(row.ms / 1000).toFixed(1)} s (max ${(row.max / 1000).toFixed(1)})`).join(', ')}`);
    }
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Run 14: two verified findings in round 1. next drives the whole flow; the
 * finding_resolve assertion in driveWithNext fails the first time next proposes
 * closing a finding whose own managed repair has not completed. Since the A/B
 * V4 adoption the repair is ONE grouped run (remediation.grouping=single, the
 * default) with one commit naming each finding; both are then resolved in ONE
 * batched finding_resolve (old-PoS run 24 F4), each with its own commit. NF2 (`firstOnly`): the grouped run commits only F-001's repair,
 * so F-002 falls back to its own single repair.
 */
function scenarioNF(machineEnv: NodeJS.ProcessEnv, steps: Step[], firstOnly = false): Outcome {
  const tag = firstOnly ? 'NF2' : 'NF';
  const name = firstOnly
    ? 'NF2: the default grouped finding-repair commits only F-001; F-002 falls back to its own repair before it is resolved'
    : 'NF run 14: two round-1 findings; next repairs both in ONE grouped managed finding-repair (default), then resolves both in ONE batched finding_resolve';
  const o = new Owner(tag, firstOnly ? 'B-e2ef' : 'B-e2ea', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const reasons: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, twoFindings: true, groupedFirstOnly: firstOnly }, lines, next => {
      if (next.reason === 'finding_repair' || next.reason === 'finding_resolve' || next.reason === 'finding_resolve_batch') {
        const group = next.cli?.payload.groupFindingIds;
        const batch = next.cli?.payload.resolutions;
        const ids = Array.isArray(group) ? (group as string[]).map(row => row.split(':').pop()).join('+')
          : Array.isArray(batch) ? (batch as Array<{ findingId: string }>).map(row => row.findingId.split(':').pop()).join('+')
          : String(next.cli?.payload.findingId ?? '').split(':').pop();
        reasons.push(`${next.reason}:${ids}`);
      }
    });
    const order = reasons.filter((row, index) => row !== reasons[index - 1]);
    lines.push(`finding steps: ${order.join(' > ')}`);
    const repairs = managedPrompts(o, FINDING_REPAIR);
    if (firstOnly) {
      assert.deepEqual(order, ['finding_repair:F-001+F-002', 'finding_resolve:F-001', 'finding_repair:F-002', 'finding_resolve:F-002'],
        `NF2: the grouped run repaired only F-001, so F-002 gets its own repair before its resolve: ${order.join(' > ')}`);
      assert.equal(repairs.length, 2, `NF2: one grouped run + one single fallback run (got ${repairs.length})`);
      assert.equal(repairs[1]!.target?.groupFindingIds, undefined, 'NF2: the fallback is a single-target repair');
      assert.match(String(repairs[1]!.target?.findingId), /F-002$/, 'NF2: the fallback is bound to F-002');
    } else {
      // Old-PoS run 24 F4: one batched finding_resolve closes both, each with its own commit.
      assert.deepEqual(order, ['finding_repair:F-001+F-002', 'finding_resolve_batch:F-001+F-002'],
        `NF: one grouped repair, then ONE batched resolve of both findings: ${order.join(' > ')}`);
      const resolved = new StoryStore(o.root).readFindings(o.storyId).findings.filter(f => f.reviewRound === 'R1' || /F-00[12]$/.test(f.id));
      for (const finding of resolved.filter(f => /F-00[12]$/.test(f.id))) {
        assert.equal(finding.status, 'resolved', `NF: ${finding.id} resolved`);
        assert.match(String(finding.resolvedReason), /\[repair commit [0-9a-f]{7,} of managed finding-repair run /, `NF: ${finding.id} names its own repair commit: ${finding.resolvedReason}`);
      }
      const commits = resolved.filter(f => /F-00[12]$/.test(f.id)).map(f => String(f.resolvedReason).match(/\[repair commit ([0-9a-f]+)/)?.[1]);
      assert.equal(new Set(commits).size, 2, `NF: each finding cites its own commit (${commits.join(', ')})`);
      assert.equal(repairs.length, 1, `NF: one grouped finding-repair run (got ${repairs.length})`);
    }
    assert.equal((repairs[0]!.target?.groupFindingIds as string[] | undefined)?.length, 2, `${tag}: the grouped run binds both findings`);
    assert.equal(repairs[0]!.target?.abVariant, undefined, `${tag}: the production group records no A/B evidence`);
    assert.doesNotMatch(repairs[0]!.prompt, /experimental/i, `${tag}: the grouped repair prompt is not labelled experimental`);
    // Old-PoS run 34 (F8, TEST): the delivery reviewer gets the delivery context pack in its prompt
    // instead of exploring framework state (status, dispatch_status, host_run_status on its own run).
    const delivery = managedPrompts(o, DELIVERY).at(-1);
    assert.ok(delivery, `${tag}: a managed delivery reviewer ran`);
    assert.match(delivery!.prompt, /Delivery context pack \(/, `${tag}: the delivery prompt carries the delivery_context_pack output`);
    assert.match(delivery!.prompt, /Diff vs main \(/, `${tag}: the pack lists the delivery diff`);
    assert.match(delivery!.prompt, /do not (?:run|explore)[^\n]*host_run_status/i, `${tag}: the prompt says not to explore framework state`);
    // Old-PoS run 40 (sink 5): the delivery_check_set skeleton and the canonical report commands come with it.
    assert.match(delivery!.prompt, new RegExp(`proof-or-stop delivery_check_set '\\{"storyId":"${o.storyId}"`), `${tag}: the delivery prompt carries the delivery_check_set skeleton`);
    assert.match(delivery!.prompt, /"featureId":"CHK-001"/, `${tag}: one realMachineTests row per item`);
    assert.match(delivery!.prompt, new RegExp(`proof-or-stop acceptance_topology_check --storyId=${o.storyId}`), `${tag}: the canonical reports are named as commands`);
    const tests = readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8');
    assert.match(tests, /TestReverseEmpty/, 'F-001 repair merged into main');
    assert.match(tests, /TestUpperEmpty/, 'F-002 repair merged into main');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** The detection A/B switch each AB scenario sets (core/ab-variants.ts): V1/V2/V5/V6 experimental (default off); V3 = round2Lanes rollback `resume`; V4 = remediation.grouping rollback `per-finding`. */
export const AB_SCENARIO_VARIANTS = {
  V1: { review: { criticOnCleanRound: 'skip' } },
  V2: { review: { round2Scope: 'repaired-files' } },
  V3: { review: { round2Lanes: 'resume' } },
  V4: { remediation: { grouping: 'per-finding' } },
  V5: { implementation: { grouping: 'files' } },
  V6: { implementation: { thread: 'fresh' } },
  V8: { review: { lanePack: 'shared' } },
  V9: { review: { roundDelta: 'pack' } },
} as const;

/** Every managed provider prompt of an agent type, oldest first. */
function managedPrompts(o: Owner, agentType?: string): Array<{ runId: string; agentType: string; prompt: string; target: Record<string, unknown> | null; reviewBinding: Record<string, unknown> | null }> {
  const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot).flatMap(runId => {
    try {
      const spec = JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as { agentType: string; createdAt?: string; managedDispatchTarget?: Record<string, unknown> | null; reviewBinding?: Record<string, unknown> | null };
      if (agentType && spec.agentType !== agentType) return [];
      const promptFile = join(o.scriptsDir, 'prompts', `${runId}.txt`);
      return [{ runId, agentType: spec.agentType, createdAt: spec.createdAt ?? '', prompt: existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '', target: spec.managedDispatchTarget ?? null, reviewBinding: spec.reviewBinding ?? null }];
    } catch { return []; }
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
}

/**
 * Detection A/B arms (bench-staging/oldpos/run17-cost-analysis.md §3): the ND
 * (one round-1 finding) or NF (two) next-driven flow with ONE experimental
 * switch on, set in the prepared config exactly as the bench adapter's
 * POS_AB_FLAGS hook writes it. Each must reach DONE through `next` alone
 * (every proposed command accepted by its gate) and show the variant's effect:
 *   V1 the clean later round finalizes without an inventory critic (signed criticSkip);
 *   V2 later-round lane prompts restrict review to the repaired files + direct callers;
 *   V3 the rollback review.round2Lanes=resume (fresh lanes are the default since
 *      the A/B V3 adoption): later-round lane prompts keep the resume wording;
 *   V4 the rollback remediation.grouping=per-finding (grouped remediation is the
 *      default since the A/B V4 adoption, covered by NF/NF2): each finding
 *      gets its own single-target repair run, then is resolved;
 *   V5 (unimplemented fixture) one implementer run for both items sharing files,
 *      the second item marked done separately (grouped_item_done);
 *   V6 (unimplemented fixture) implementation.thread=fresh: every implementer
 *      and finding-repair run seals `implementation.thread=fresh` on its target
 *      (so the worker never resumes a code-writer thread) and its prompt carries
 *      the bounded item pack (request, Story history, diff, declared files);
 *   V8 review.lanePack=shared: every code-review lane and inventory critic prompt
 *      carries the round's REVIEW LANE PACK (one runtime file per round), the run
 *      spec seals reviewBinding.lanePack with the A/B evidence;
 *   V9 review.roundDelta=pack: round-1 prompts carry no pack; later-round lane
 *      and critic prompts carry the delta (repair commits + diff, F-001 and its
 *      resolution) and are told to start there but review the whole Story.
 */
function scenarioAB(machineEnv: NodeJS.ProcessEnv, steps: Step[], flow: 'D' | 'F', variant: keyof typeof AB_SCENARIO_VARIANTS): Outcome {
  const tag = `N${flow}-${variant}`;
  const name = `${tag} A/B ${JSON.stringify(AB_SCENARIO_VARIANTS[variant])} on the N${flow} flow reaches DONE`;
  const ids: Record<string, string> = { 'D-V1': 'B-ab11', 'D-V2': 'B-ab12', 'D-V3': 'B-ab13', 'D-V4': 'B-ab14', 'D-V5': 'B-ab15', 'D-V6': 'B-ab16',
    'F-V1': 'B-ab21', 'F-V2': 'B-ab22', 'F-V3': 'B-ab23', 'F-V4': 'B-ab24', 'F-V5': 'B-ab25', 'F-V6': 'B-ab26',
    'D-V8': 'B-ab18', 'D-V9': 'B-ab19', 'F-V8': 'B-ab28', 'F-V9': 'B-ab29' };
  const o = new Owner(tag, ids[`${flow}-${variant}`]!, machineEnv, steps, false,
    { trackedGateFailureCounts: true, config: AB_SCENARIO_VARIANTS[variant] as unknown as Record<string, unknown>, unimplemented: variant === 'V5' || variant === 'V6', ...(variant === 'V6' ? { request: NIQ_REQUEST } : {}) });
  const lines: string[] = [];
  const reasons: string[] = [];
  try {
    devSetup(o, variant !== 'V5' && variant !== 'V6');
    // V6: per-item implementer runs on the unimplemented fixture; the owner records the pinned focused evidence once the code exists.
    let evidenceAdded = false;
    const interject = variant === 'V6' ? (next: NextStepJson) => {
      if (next.reason !== 'evidence_chain' || evidenceAdded) return false;
      addItemEvidence(o);
      evidenceAdded = true;
      return true;
    } : undefined;
    driveWithNext(o, { findingRound1: true, run: false, twoFindings: flow === 'F', ...(interject ? { interject } : {}) }, lines, next => {
      reasons.push(next.reason);
      // V5: the owner verifies the grouped run's items by their own pinned focused evidence before marking the next one done.
      if (next.reason === 'grouped_item_done') addItemEvidence(o);
    });
    const tests = readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8');
    assert.match(tests, /TestReverseEmpty/, 'F-001 repair merged into main');
    if (flow === 'F') assert.match(tests, /TestUpperEmpty/, 'F-002 repair merged into main');
    const count = (reason: string) => reasons.filter(row => row === reason).length;
    const epochs = new StoryStore(o.root).readReviewInventoryEpochs(o.storyId).epochs;
    const lanePrompts = managedPrompts(o).filter(row => row.agentType.startsWith('proof-or-stop-review-') && row.agentType !== DELIVERY && row.agentType !== MANAGED_INVENTORY_CRITIC_LANE);
    const rereview = lanePrompts.filter(row => row.prompt.includes('MANAGED RE-REVIEW SINCE PREVIOUS CANDIDATE'));
    switch (variant) {
      case 'V1': {
        const skipped = epochs.filter(epoch => epoch.waves.some(wave => wave.criticSkip));
        assert.ok(skipped.length >= 1, `${tag}: a clean round finalized with a signed criticSkip`);
        assert.equal(skipped[0]!.waves.at(-1)!.criticSkip!.abVariant.flags['review.criticOnCleanRound'], 'skip', `${tag}: criticSkip records the A/B flag`);
        assert.ok(epochs.filter(epoch => epoch.state === 'FINALIZED' && epoch.waves.some(wave => !wave.criticSkip && wave.newVerifiedFindingCount)).length >= 1, `${tag}: the round with findings still ran the critic`);
        lines.push(`critic launches: ${count('inventory_critic_launch')}; epochs finalized with criticSkip: ${skipped.length}`);
        break;
      }
      case 'V2':
        assert.ok(rereview.length >= 1, `${tag}: later-round lanes got a re-review prompt`);
        for (const row of rereview) {
          assert.match(row.prompt, /This is a FRESH session/, `${tag}: ${row.runId} default later-round lane is a fresh session`);
          assert.match(row.prompt, /review\.round2Scope=repaired-files/, `${tag}: ${row.runId} prompt states the repaired-files scope`);
          assert.match(row.prompt, /Files changed by the repair \(\d+\): [^\n]*strs\/strs_test\.go/, `${tag}: ${row.runId} prompt lists the repaired file`);
        }
        lines.push(`later-round lane prompts with repaired-files scope: ${rereview.length}; e.g. ${(rereview[0]!.prompt.match(/Direct callers[^\n]*/) ?? [''])[0].slice(0, 160)}`);
        break;
      case 'V3':
        assert.ok(rereview.length >= 1, `${tag}: later-round lanes got a re-review prompt`);
        for (const row of rereview) {
          assert.match(row.prompt, /If this session already holds your earlier review/, `${tag}: ${row.runId} rollback prompt keeps the resume wording`);
          assert.doesNotMatch(row.prompt, /This is a FRESH session/, `${tag}: ${row.runId} rollback prompt has no fresh-session line`);
        }
        lines.push(`later-round lane prompts in resume (rollback) mode: ${rereview.length}`);
        break;
      case 'V4': {
        const repairs = managedPrompts(o, FINDING_REPAIR);
        if (flow === 'F') {
          assert.equal(repairs.length, 2, `${tag}: rollback = one finding-repair run per finding (got ${repairs.length})`);
          for (const repair of repairs) assert.equal(repair.target?.groupFindingIds, undefined, `${tag}: ${repair.runId} is a single-target repair`);
          assert.deepEqual(repairs.map(repair => String(repair.target?.findingId).split(':').pop()), ['F-001', 'F-002'], `${tag}: each finding has its own repair`);
          assert.equal(count('finding_resolve'), 2, `${tag}: each finding resolved separately`);
        } else {
          assert.equal(repairs.length, 1, `${tag}: a single finding keeps the ordinary single-target repair`);
          assert.equal(repairs[0]!.target?.groupFindingIds, undefined, `${tag}: no group for one finding`);
        }
        lines.push(`finding-repair runs: ${repairs.length}; finding_resolve steps: ${count('finding_resolve')}`);
        break;
      }
      case 'V5': {
        const implementers = managedPrompts(o, IMPLEMENTER);
        assert.equal(implementers.length, 1, `${tag}: one implementer run for both items sharing files (got ${implementers.length})`);
        assert.deepEqual(implementers[0]!.target?.groupItemIds, ['CHK-001', 'CHK-002'], `${tag}: the run binds both items`);
        assert.equal(count('grouped_item_done'), 1, `${tag}: CHK-002 marked done separately after verification`);
        lines.push(`implementer runs: ${implementers.length}; grouped_item_done steps: ${count('grouped_item_done')}`);
        break;
      }
      case 'V6': {
        const writers = [...managedPrompts(o, IMPLEMENTER), ...managedPrompts(o, FINDING_REPAIR)];
        assert.ok(managedPrompts(o, IMPLEMENTER).length >= 1 && managedPrompts(o, FINDING_REPAIR).length >= 1, `${tag}: implementer and finding-repair runs launched`);
        const sizes: number[] = [];
        for (const row of writers) {
          assert.equal((row.target?.abVariant as { flags?: Record<string, string> } | undefined)?.flags?.['implementation.thread'], 'fresh', `${tag}: ${row.runId} seals implementation.thread=fresh (fresh Codex thread)`);
          const pack = row.prompt.slice(row.prompt.indexOf('--- BEGIN ITEM PACK'));
          assert.match(pack, /^--- BEGIN ITEM PACK[^\n]*\n[\s\S]*This is a FRESH session[\s\S]*--- END ITEM PACK ---/, `${tag}: ${row.runId} prompt carries the item pack`);
          assert.match(pack, /## request\.md/, `${tag}: ${row.runId} pack carries request.md`);
          assert.match(pack, /## Declared\/cited files at HEAD/, `${tag}: ${row.runId} pack carries the declared files`);
          sizes.push(Buffer.byteLength(pack, 'utf8'));
        }
        const repair = managedPrompts(o, FINDING_REPAIR).at(-1)!.prompt;
        assert.match(repair, /## Findings this repair is bound to/, `${tag}: repair pack carries the finding and its evidence`);
        assert.match(repair, /## Story diff so far: hunks/, `${tag}: repair pack carries the repair diff context`);
        lines.push(`code-writer runs with a fresh thread + item pack: ${writers.length}; pack bytes: ${sizes.join(', ')}`);
        break;
      }
      case 'V8':
      case 'V9': {
        const reviewers = managedPrompts(o).filter(row => row.agentType.startsWith('proof-or-stop-review-') && row.agentType !== DELIVERY);
        const critics = reviewers.filter(row => row.agentType === MANAGED_INVENTORY_CRITIC_LANE);
        assert.ok(critics.length >= 1 && reviewers.length > critics.length, `${tag}: lanes and the inventory critic launched`);
        const packOf = (prompt: string) => { const at = prompt.indexOf('--- BEGIN REVIEW LANE PACK'); return at < 0 ? '' : prompt.slice(at, prompt.indexOf('--- END REVIEW LANE PACK ---', at) + '--- END REVIEW LANE PACK ---'.length); };
        const flag = variant === 'V8' ? 'review.lanePack' : 'review.roundDelta';
        const value = variant === 'V8' ? 'shared' : 'pack';
        const packed = reviewers.filter(row => packOf(row.prompt));
        const sizes = new Map<string, number>();
        for (const row of packed) {
          const binding = row.reviewBinding?.lanePack as { abVariant?: { flags?: Record<string, string> }; path?: string; bytes?: number } | undefined;
          assert.equal(binding?.abVariant?.flags?.[flag], value, `${tag}: ${row.runId} seals ${flag}=${value} in its run spec`);
          assert.ok(binding?.path && existsSync(binding.path), `${tag}: ${row.runId} names the round's pack file`);
          assert.equal(readFileSync(binding!.path!, 'utf8'), packOf(row.prompt), `${tag}: ${row.runId} prompt inlines exactly the pack file`);
          sizes.set(binding!.path!, Buffer.byteLength(packOf(row.prompt), 'utf8'));
        }
        if (variant === 'V8') {
          assert.equal(packed.length, reviewers.length, `${tag}: every lane and critic prompt carries the lane pack`);
          for (const row of packed) {
            const pack = packOf(row.prompt);
            assert.match(pack, /authoritative/, `${tag}: ${row.runId} pack is authoritative for its facts`);
            assert.match(pack, /## Story diff/, `${tag}: ${row.runId} pack carries the Story diff`);
            assert.match(pack, /strs\/strs\.go \[M\] sha256=[0-9a-f]{64}/, `${tag}: ${row.runId} pack lists the changed file with its hash`);
            assert.match(pack, /## Checklist intents and verification evidence/, `${tag}: ${row.runId} pack carries the checklist digest`);
            assert.match(pack, /candidateSpecSetDigest=/, `${tag}: ${row.runId} pack carries the candidate route`);
          }
          const rounds = new Set(packed.map(row => (row.reviewBinding?.lanePack as { path: string }).path));
          assert.ok(rounds.size >= 2 && rounds.size < packed.length, `${tag}: one pack file per round shared by its lanes (${rounds.size} files for ${packed.length} runs)`);
        } else {
          const later = packed;
          assert.ok(later.length >= 1, `${tag}: later-round reviewers carry the delta pack`);
          assert.ok(packed.length < reviewers.length, `${tag}: round-1 reviewers carry no pack`);
          for (const row of later) {
            const pack = packOf(row.prompt);
            assert.match(pack, /## Delta since the previous round/, `${tag}: ${row.runId} pack carries the delta`);
            assert.match(pack, /strs\/strs_test\.go/, `${tag}: ${row.runId} delta names the repaired file`);
            assert.match(pack, /F-001 \[severity=/, `${tag}: ${row.runId} delta carries the earlier finding`);
            assert.match(pack, /resolution: /, `${tag}: ${row.runId} delta carries its resolution`);
            assert.match(pack, /whole Story/, `${tag}: ${row.runId} still reviews the whole Story`);
            assert.doesNotMatch(pack, /## Story diff/, `${tag}: ${row.runId} lanePack off: no shared sections`);
            if (row.agentType !== MANAGED_INVENTORY_CRITIC_LANE) assert.doesNotMatch(row.prompt, /Do not re-review the whole Story/, `${tag}: ${row.runId} re-review block does not narrow the review`);
          }
        }
        lines.push(`reviewer prompts with the pack: ${packed.length}/${reviewers.length}; pack files: ${sizes.size}; pack bytes: ${[...sizes.values()].join(', ')}; prompt bytes: ${packed.map(row => Buffer.byteLength(row.prompt, 'utf8')).join(', ')}`);
        break;
      }
    }
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** The immutable evidence proposal a managed review run sealed (old-PoS run 52: does a findings proposal keep its note?). */
function carrierProposal(o: Owner, reviewRunId: string): Record<string, unknown> | null {
  const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
  if (!existsSync(runsRoot)) return null;
  for (const runId of readdirSync(runsRoot)) {
    const file = join(runsRoot, runId, 'evidence-proposal.json');
    if (!existsSync(file)) continue;
    const proposal = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (proposal.reviewRunId === reviewRunId) return proposal;
  }
  return null;
}

/**
 * EXPERIMENTAL A/B review.deltaRounds=on (core/review-delta-round.ts; the new
 * PoS's ADR-039/043/054 ported): the ND flow (round 1: test-coverage reports
 * D_FINDING; repair; round 2) with the switch set in the prepared config.
 *   DR  round 2 is a delta round: test-coverage (raised F-001) re-reviews in
 *       full, concept/quality are replaced by ONE confirmation lane
 *       (concept carries it) whose prompt lists their concerns, the repair scope
 *       and F-001 to re-verify; the framework re-runs the named test (passes);
 *       no new finding, so the round closes without an inventory critic; DONE.
 *   DRL the repair is larger than half the Story diff: round 2 is a full round
 *       (all 3 lanes, no confirmation block, critic runs); DONE.
 *   DRG the confirmation lane reports a [gap]: not a pass (nothing imported,
 *       the gap and the refusal are recorded), the round falls back to a full
 *       round (the replaced lanes and the carrier run in full), critic; DONE.
 *   DRV the confirmation lane names a re-run whose selector never prints: the
 *       framework re-run fails, so it is not a pass; full round; DONE.
 * Old-PoS run 52 (bench-staging/oldpos/run52-analysis.md §3 D1: 3 of 3
 * findings-verdict confirmation lanes gapped because the findings proposal
 * dropped the note, and each gap launched the replaced lanes late, serially):
 *   DRF  in round 2 the confirmation lane reports a finding (NF_FINDING) with a
 *        complete multi-line note: NOT a gap, no late lane (round 2 stays at 2
 *        lanes), the finding imports, the framework still re-runs the resolved
 *        finding's test; round 3 is a delta round again; DONE.
 *   DRF1 the same note flattened onto one line (run 52 RR-012): still no gap.
 *   DRFG the findings verdict leaves a check item as [gap]: the gap is recorded
 *        (conclusion findings), the findings import, round 2 launches no late
 *        lane; the NEXT round is a full round (PREVIOUS_CONFIRMATION_GAP); DONE.
 */
function scenarioDR(machineEnv: NodeJS.ProcessEnv, steps: Step[], variant: 'DR' | 'DRL' | 'DRG' | 'DRV' | 'DRF' | 'DRF1' | 'DRFG'): Outcome {
  const tag = `ND-${variant}`;
  const name = `${tag} A/B {"review":{"deltaRounds":"on"}} on the ND flow reaches DONE`;
  const ids = { DR: 'B-ad31', DRL: 'B-ad32', DRG: 'B-ad33', DRV: 'B-ad34', DRF: 'B-ad35', DRF1: 'B-ad36', DRFG: 'B-ad37' } as const;
  const noteMode: DeltaNoteMode = variant === 'DRG' ? 'gap' : variant === 'DRV' ? 'bad-rerun' : variant === 'DRF' ? 'findings'
    : variant === 'DRF1' ? 'findings-flat' : variant === 'DRFG' ? 'findings-gap' : 'full';
  const o = new Owner(tag, ids[variant], machineEnv, steps, false, { trackedGateFailureCounts: true, config: { review: { deltaRounds: 'on' } } });
  const lines: string[] = [];
  const reasons: string[] = [];
  const selections: Array<{ round: string; selection: Record<string, unknown> }> = [];
  try {
    devSetup(o, true);
    driveWithNext(o, { findingRound1: true, run: false, deltaNote: noteMode, largeRepair: variant === 'DRL' }, lines, next => {
      reasons.push(next.reason);
      if (next.reason !== 'review_lane_launch') return;
      const round = new StoryStore(o.worktree).readStory(o.storyId).currentReviewRound ?? '';
      if (selections.some(row => row.round === round)) return;
      const listed = parseJson(o.mustCli('reviewer_list', { storyId: o.storyId, json: true }, { label: 'reviewer_list (roster)' }).stdout);
      selections.push({ round, selection: ((listed?.finalReview as Record<string, unknown> | undefined)?.selection ?? {}) as Record<string, unknown> });
    });
    const store = new StoryStore(o.root);
    const allRuns = store.readReviewRuns(o.storyId).runs;
    const rounds = [...new Set(allRuns.map(run => run.reviewRound))];
    assert.ok(rounds.length >= 2, `${tag}: at least two review rounds (got ${rounds.length})`);
    const laneRunsOf = (round: string) => allRuns.filter(run => run.reviewRound === round && run.reviewPurpose !== 'inventory-completeness');
    const short = (lane: string) => lane.replace('proof-or-stop-review-', '');
    const round1 = laneRunsOf(rounds[0]!).map(run => short(run.lane));
    const round2 = laneRunsOf(rounds[1]!).map(run => short(run.lane));
    const prompts = managedPrompts(o).filter(row => row.agentType.startsWith('proof-or-stop-review-') && row.agentType !== DELIVERY && row.agentType !== MANAGED_INVENTORY_CRITIC_LANE);
    const promptOf = (reviewRunId: string) => prompts.find(row => (row.reviewBinding as { headHash?: string } | null) && row.prompt.includes(reviewRunId)) ?? null;
    const round2Prompts = laneRunsOf(rounds[1]!).map(run => ({ run, prompt: promptOf(run.reviewRunId) }));
    const events = store.readProcessEvents(o.storyId);
    const criticLaunches = reasons.filter(row => row === 'inventory_critic_launch').length;
    const epochs = store.readReviewInventoryEpochs(o.storyId).epochs;
    const bytes = (rows: Array<{ prompt: { prompt: string } | null }>) => rows.map(row => Buffer.byteLength(row.prompt?.prompt ?? '', 'utf8'));
    const round1Prompts = laneRunsOf(rounds[0]!).map(run => ({ run, prompt: promptOf(run.reviewRunId) }));
    lines.push(`round 1 lanes: ${round1.join(', ')} (prompt bytes ${bytes(round1Prompts).join(', ')}); round 2 lanes: ${round2.join(', ')} (prompt bytes ${bytes(round2Prompts).join(', ')}); critic launches: ${criticLaunches}`);
    lines.push(`round-2 roster selection: ${String(selections[1]?.selection.selection ?? '?')} / delta ${String((selections[1]?.selection.deltaRound as { reason?: string } | undefined)?.reason ?? 'none')}`);
    assert.equal(round1.length, 3, `${tag}: round 1 runs the 3 active lanes (${round1.join(', ')})`);
    const gapEvents = events.filter(event => String(event.type) === 'delta_round_confirmation_gap');
    const reverified = events.filter(event => String(event.type) === 'delta_round_reverified');
    if (variant === 'DRF' || variant === 'DRF1' || variant === 'DRFG') {
      // Old-PoS run 52 D1: a findings verdict of the confirmation lane never launches the replaced lanes late.
      assert.deepEqual([...round2].sort(), ['concept', 'test-coverage'], `${tag}: round 2 stays the raising lane + ONE confirmation lane, no late lane (got ${round2.join(', ')})`);
      const findings = store.readFindings(o.storyId).findings;
      const nf = findings.find(f => f.desc === NF_FINDING.desc);
      assert.ok(nf, `${tag}: the confirmation lane's finding was imported`);
      assert.equal(nf!.reviewRound, rounds[1], `${tag}: it belongs to round 2`);
      assert.equal(nf!.agent, 'proof-or-stop-review-concept', `${tag}: raised by the confirmation lane`);
      assert.equal(nf!.status, 'resolved', `${tag}: closed before DONE`);
      const carrier = round2Prompts.find(row => short(row.run.lane) === 'concept')!;
      const proposal = carrierProposal(o, carrier.run.reviewRunId);
      assert.match(String(proposal?.note ?? ''), /\[checked\] concern:quality/, `${tag}: the findings proposal keeps the lane's note (${JSON.stringify(proposal && Object.keys(proposal))})`);
      const round2Reverified = reverified.filter(event => (event as { reviewRound?: string }).reviewRound === rounds[1]);
      assert.ok(round2Reverified.length >= 1 && round2Reverified.every(event => (event as { passed?: boolean }).passed === true),
        `${tag}: the framework re-ran the resolved finding's test for the findings verdict too (${JSON.stringify(round2Reverified)})`);
      assert.equal(events.filter(event => event.type === 'managed_review_import_refused').length, 0, `${tag}: nothing refused`);
      assert.ok(rounds.length >= 3, `${tag}: round 2's finding was repaired and re-reviewed (rounds ${rounds.length})`);
      const round3 = laneRunsOf(rounds[2]!).map(run => short(run.lane));
      if (variant === 'DRFG') {
        assert.equal(gapEvents.length, 1, `${tag}: the findings-verdict gap is recorded once (${JSON.stringify(gapEvents)})`);
        assert.equal((gapEvents[0] as { conclusion?: string }).conclusion, 'findings', `${tag}: recorded as a findings-verdict gap`);
        assert.equal((gapEvents[0] as { reviewRound?: string }).reviewRound, rounds[1], `${tag}: the gap belongs to round 2`);
        assert.deepEqual([...new Set(round3)].sort(), ['concept', 'quality', 'test-coverage'], `${tag}: the next round is a full round (got ${round3.join(', ')})`);
        assert.equal((selections[2]?.selection.deltaRound as { reason?: string } | undefined)?.reason, 'PREVIOUS_CONFIRMATION_GAP', `${tag}: fallback reason recorded`);
      } else {
        assert.equal(gapEvents.length, 0, `${tag}: a findings verdict with complete coverage lines is not a gap (${JSON.stringify(gapEvents)})`);
        assert.equal(round3.length, 2, `${tag}: round 3 is a delta round again (got ${round3.join(', ')})`);
      }
    } else if (variant === 'DR') {
      assert.deepEqual([...round2].sort(), ['concept', 'test-coverage'], `${tag}: round 2 = the raising lane + ONE confirmation lane (got ${round2.join(', ')})`);
      const carrier = round2Prompts.find(row => short(row.run.lane) === 'concept')!;
      const full = round2Prompts.find(row => short(row.run.lane) === 'test-coverage')!;
      assert.ok(carrier.prompt && full.prompt, `${tag}: both round-2 prompts captured`);
      assert.match(carrier.prompt!.prompt, /--- BEGIN DELTA ROUND CONFIRMATION/, `${tag}: the confirmation lane's prompt carries the block`);
      for (const concern of ['concern:concept', 'concern:quality']) assert.match(carrier.prompt!.prompt, new RegExp(concern), `${tag}: confirmation lists ${concern}`);
      assert.match(carrier.prompt!.prompt, /file:strs\/strs_test\.go/, `${tag}: confirmation scope names the repaired file`);
      assert.match(carrier.prompt!.prompt, /Resolved findings to re-verify[^\n]*\n- F-001/, `${tag}: F-001 is to be re-verified`);
      assert.doesNotMatch(carrier.prompt!.prompt, /MANAGED RE-REVIEW SINCE PREVIOUS CANDIDATE/, `${tag}: the confirmation block replaces the ordinary re-review block`);
      assert.doesNotMatch(full.prompt!.prompt, /BEGIN DELTA ROUND CONFIRMATION/, `${tag}: the full lane has no confirmation block`);
      assert.match(full.prompt!.prompt, /review\.deltaRounds=on[^\n]*re-review the WHOLE Story/, `${tag}: the raising lane re-reviews in full`);
      assert.doesNotMatch(full.prompt!.prompt, /Do not re-review the whole Story/, `${tag}: no narrowing for the full lane`);
      const binding = (row: typeof carrier) => (row.prompt!.reviewBinding as { deltaRound?: { role?: string; abVariant?: { flags?: Record<string, string> } } }).deltaRound;
      assert.equal(binding(carrier)?.role, 'confirmation', `${tag}: run spec seals role=confirmation`);
      assert.equal(binding(full)?.role, 'full', `${tag}: run spec seals role=full`);
      assert.equal(binding(carrier)?.abVariant?.flags?.['review.deltaRounds'], 'on', `${tag}: the arm is recorded`);
      assert.equal(reverified.length, 1, `${tag}: the framework re-ran F-001's test once (${JSON.stringify(reverified)})`);
      assert.equal((reverified[0] as { passed?: boolean }).passed, true, `${tag}: the re-run passed`);
      assert.equal(gapEvents.length, 0, `${tag}: no gap`);
      assert.equal(criticLaunches, 1, `${tag}: the critic ran only in round 1 (round 2 raised no finding)`);
      const round2Epoch = epochs.filter(epoch => epoch.reviewRound === rounds[1] && epoch.state === 'FINALIZED').at(-1);
      assert.match(String(round2Epoch?.waves.at(-1)?.criticSkip?.reason ?? ''), /review\.deltaRounds=on/, `${tag}: round 2 finalized with a signed delta-round critic skip`);
      assert.equal(selections[1]?.selection.selection, 'delta-round', `${tag}: roster selection is delta-round`);
    } else {
      assert.deepEqual([...new Set(round2)].sort(), ['concept', 'quality', 'test-coverage'], `${tag}: round 2 is a full round (got ${round2.join(', ')})`);
      assert.ok(criticLaunches >= 2, `${tag}: the critic runs in the full round 2 (got ${criticLaunches})`);
      if (variant === 'DRL') {
        assert.equal((selections[1]?.selection.deltaRound as { reason?: string } | undefined)?.reason, 'REPAIR_DIFF_LARGE', `${tag}: fallback reason recorded`);
        for (const row of round2Prompts) assert.doesNotMatch(row.prompt?.prompt ?? '', /BEGIN DELTA ROUND CONFIRMATION/, `${tag}: no confirmation block in a full round`);
      } else {
        assert.equal(gapEvents.length, 1, `${tag}: one gap recorded (${JSON.stringify(gapEvents)})`);
        assert.equal((gapEvents[0] as { reviewRound?: string }).reviewRound, rounds[1], `${tag}: the gap belongs to round 2`);
        const refused = events.filter(event => event.type === 'managed_review_import_refused' && /delta_confirmation_gap/.test(String(event.reason)));
        assert.equal(refused.length, 1, `${tag}: the gap run's import is recorded as refused (never proposed again)`);
        const gapRun = String((refused[0] as { reviewRunId?: string }).reviewRunId);
        assert.ok(!store.readReviewPasses(o.storyId).passes.some(pass => pass.reviewRunId === gapRun), `${tag}: no pass recorded for the gap run`);
        assert.equal(round2.filter(lane => lane === 'concept').length, 2, `${tag}: the carrier lane reran in full (got ${round2.join(', ')})`);
        if (variant === 'DRV') {
          assert.equal(reverified.length, 1, `${tag}: the framework re-ran the named test`);
          assert.equal((reverified[0] as { passed?: boolean }).passed, false, `${tag}: the re-run failed (selector never printed)`);
          assert.match(String((gapEvents[0] as { reason?: string }).reason), /re-run/, `${tag}: gap names the failed re-run`);
        } else {
          assert.match(String((gapEvents[0] as { reason?: string }).reason), /\[gap\]/, `${tag}: gap names the reported [gap]`);
        }
        const fallbackPrompts = round2Prompts.filter(row => row.run.reviewRunId !== gapRun);
        for (const row of fallbackPrompts) assert.doesNotMatch(row.prompt?.prompt ?? '', /BEGIN DELTA ROUND CONFIRMATION/, `${tag}: fallback lanes run as a full round`);
      }
    }
    const tests = readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8');
    assert.match(tests, /TestReverseEmpty/, 'F-001 repair merged into main');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** EXPERIMENTAL A/B review.laneMerge (NLM*): a merged-session finding, tagged with the dimension that raised it. */
const lmTagged = (dimension: string, finding: Record<string, unknown>): Record<string, unknown> => ({ ...finding, desc: `[dimension:${dimension}] ${String(finding.desc)}` });

/**
 * Lab lane-split: scripted review-session latency, LM_SECONDS_PER_MODEL_MINUTE s per model minute, calibrated on
 * old-PoS runs 63/64 round 1 (run62-64-analysis.md §4.4): one ordinary lane about 4.0 min (3.5-4.5), the
 * 4-dimension merged session 7.8 min, so a session costs 2.73 min + 1.27 min per dimension it carries (a
 * 2-dimension split session: 5.27 min). The scale keeps the harness's own launch cost (about 2 s per host_run)
 * small against the scripted minutes.
 */
const LM_SECONDS_PER_MODEL_MINUTE = 4;
const LM_LATENCY: LaneLatency = { baseMs: 2730 * LM_SECONDS_PER_MODEL_MINUTE, perDimensionMs: 1270 * LM_SECONDS_PER_MODEL_MINUTE };

type LaneMergeVariant = 'LM' | 'LM-OFF' | 'LM-G' | 'LM-C' | 'LM-F' | 'LM-FG' | 'LM-D' | 'LM4-OFF' | 'LM4' | 'LM-S' | 'LM-SG' | 'LM-SC';

/**
 * EXPERIMENTAL A/B review.laneMerge=on|split (core/review-lane-merge.ts; the new
 * PoS's ADR-064 ported as an idea): ONE managed review session per round (on), or
 * TWO run in parallel (split: concept + quality | test-coverage + docs), carries
 * the dimensions of every active lane. Fixture: concept, quality, test-coverage
 * (NLM, NLM-G, NLM-C, NLM-F, NLM-FG, NLM-D; concept is the carrier); the `4`
 * and split scenarios also activate docs (understanding.touchpoints names a .md).
 * Each scenario reaches DONE through `next` alone.
 *   NLM     round 1: the merged session reports D_FINDING tagged
 *           [dimension:test-coverage]; it imports on the carrier lane with its
 *           tag, is repaired and closed; round 2: the merged session passes with
 *           every coverage line; the critic runs in both rounds; one lane session
 *           per round. Prints lane sessions and prompt bytes per round.
 *   NLM-OFF the same flow with the switch absent (the ND flow): three lane sessions
 *           per round, no merged block; the off arm of the measurement.
 *   NLM-G   round 1's merged PASS leaves the quality dimension without coverage
 *           lines: the pass is imported (concept and test-coverage covered), the
 *           gap is recorded, and ONLY quality is relaunched as its own lane (no
 *           merged block); test-coverage is never launched separately.
 *   NLM-C   the merged PASS marks a checkpoint of its OWN dimension (concept)
 *           [gap]: nothing is imported (refused), every dimension runs as its own
 *           lane in that round (concept again, plain prompt).
 *   NLM-F   findings of two dimensions (test-coverage D_FINDING, quality
 *           NF_FINDING) in one merged proposal: both import on the carrier with
 *           their tags, both are repaired (grouped remediation) and closed,
 *           round 2's merged session passes.
 *   NLM-FG  round 1's merged FINDINGS verdict leaves quality uncovered: the
 *           finding imports, no late lane in round 1; round 2 runs the merged
 *           session for concept + test-coverage and quality as its own lane.
 *   NLM-D   lab lane-split depth contract (old-PoS run 64 R1 shape): the merged
 *           PASS answers the test-coverage checkpoints with generic evidence (no
 *           file:line, no command output): test-coverage is NOT covered and is
 *           relaunched as its own lane in the same round.
 *   NLM4-OFF / NLM4 / NLM-S  the three-arm measurement (4 lanes, the NLM flow,
 *           scripted session latency LM_LATENCY): off = four lane sessions per
 *           round, on = one, split = two in parallel (concept carries concept +
 *           quality, test-coverage carries test-coverage + docs; D_FINDING comes
 *           from the test-coverage session only). Prints lane sessions, prompt
 *           bytes and the round wall (first lane spec -> last lane terminal).
 *   NLM-SG  split: session A answers quality with generic evidence: only quality
 *           is relaunched as its own lane; session B (test-coverage + docs) is
 *           untouched.
 *   NLM-SC  split: session B's carrier (test-coverage) lists no file it read in
 *           full for its own dimension: B's pass is refused, test-coverage and
 *           docs run as their own lanes in that round; session A's pass stands.
 */
function scenarioLM(machineEnv: NodeJS.ProcessEnv, steps: Step[], variant: LaneMergeVariant): Outcome {
  const tag = `N${variant}`;
  const off = variant === 'LM-OFF' || variant === 'LM4-OFF';
  const split = variant === 'LM-S' || variant === 'LM-SG' || variant === 'LM-SC';
  const fourLanes = variant.startsWith('LM4') || split;
  const measured = variant === 'LM4-OFF' || variant === 'LM4' || variant === 'LM-S';
  const switchValue = off ? null : split ? 'split' : 'on';
  const name = `${tag} A/B ${switchValue ? `{"review":{"laneMerge":"${switchValue}"}}` : '(laneMerge absent: control)'}${fourLanes ? ' (4 lanes)' : ''} reaches DONE`;
  const ids: Record<LaneMergeVariant, string> = { LM: 'B-ae41', 'LM-OFF': 'B-ae42', 'LM-G': 'B-ae43', 'LM-C': 'B-ae44', 'LM-F': 'B-ae45', 'LM-FG': 'B-ae46',
    'LM-D': 'B-ae47', 'LM4-OFF': 'B-ae48', LM4: 'B-ae49', 'LM-S': 'B-ae4a', 'LM-SG': 'B-ae4b', 'LM-SC': 'B-ae4c' };
  const D_TC = lmTagged('test-coverage', D_FINDING);
  const NF_Q = lmTagged('quality', NF_FINDING);
  const rounds: LaneMergeMode['rounds'] = variant === 'LM' || variant === 'LM4' || variant === 'LM-S' ? [{ findings: [D_TC] }, { findings: [] }]
    : variant === 'LM-G' ? [{ findings: [], uncovered: ['quality'] }]
    : variant === 'LM-C' ? [{ findings: [], uncovered: ['gap:concept'] }]
    : variant === 'LM-F' ? [{ findings: [D_TC, NF_Q] }, { findings: [] }]
    : variant === 'LM-FG' ? [{ findings: [D_TC], uncovered: ['quality'] }, { findings: [] }]
    : variant === 'LM-D' ? [{ findings: [], uncovered: ['generic:test-coverage'] }]
    : variant === 'LM-SG' ? [{ findings: [], uncovered: ['generic:quality'] }]
    : variant === 'LM-SC' ? [{ findings: [], uncovered: ['unread:test-coverage'] }]
    : [];
  const o = new Owner(tag, ids[variant], machineEnv, steps, false, { trackedGateFailureCounts: true, ...(fourLanes ? { docsTouchpoint: true } : {}),
    ...(switchValue ? { config: { review: { laneMerge: switchValue } } } : {}) });
  const lines: string[] = [];
  const reasons: string[] = [];
  const selections: Array<{ round: string; selection: Record<string, unknown> }> = [];
  const lanesAll = fourLanes ? ['concept', 'docs', 'quality', 'test-coverage'] : ['concept', 'quality', 'test-coverage'];
  try {
    devSetup(o, true);
    const findingRound1 = variant === 'LM' || off || variant === 'LM-F' || variant === 'LM-FG' || variant === 'LM4' || variant === 'LM-S';
    driveWithNext(o, { findingRound1, run: false, ...(switchValue ? { laneMerge: { rounds } } : {}), ...(measured ? { laneLatency: LM_LATENCY } : {}) }, lines, next => {
      reasons.push(next.reason);
      if (next.reason !== 'review_lane_launch') return;
      const round = new StoryStore(o.worktree).readStory(o.storyId).currentReviewRound ?? '';
      if (selections.some(row => row.round === round)) return;
      const listed = parseJson(o.mustCli('reviewer_list', { storyId: o.storyId, json: true }, { label: 'reviewer_list (roster)' }).stdout);
      selections.push({ round, selection: ((listed?.finalReview as Record<string, unknown> | undefined)?.selection ?? {}) as Record<string, unknown> });
    });
    const store = new StoryStore(o.root);
    const allRuns = store.readReviewRuns(o.storyId).runs;
    const roundIds = [...new Set(allRuns.filter(run => run.reviewPurpose !== 'inventory-completeness').map(run => run.reviewRound))];
    const short = (lane: string) => lane.replace('proof-or-stop-review-', '');
    const laneRunsOf = (round: string) => allRuns.filter(run => run.reviewRound === round && run.reviewPurpose !== 'inventory-completeness');
    const prompts = managedPrompts(o).filter(row => row.agentType.startsWith('proof-or-stop-review-') && row.agentType !== DELIVERY && row.agentType !== MANAGED_INVENTORY_CRITIC_LANE);
    const criticPrompts = managedPrompts(o, MANAGED_INVENTORY_CRITIC_LANE);
    const promptOf = (reviewRunId: string) => prompts.find(row => row.prompt.includes(reviewRunId)) ?? null;
    const bytes = (text: string | undefined) => Buffer.byteLength(text ?? '', 'utf8');
    const criticLaunches = reasons.filter(row => row === 'inventory_critic_launch').length;
    const events = store.readProcessEvents(o.storyId);
    const coverage = events.filter(event => String(event.type) === 'review_lane_merge_coverage') as Array<Record<string, unknown>>;
    const hostRuns = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
    const runTimes = (runId: string): { start: number; end: number } | null => {
      try {
        const spec = JSON.parse(readFileSync(join(hostRuns, runId, 'spec.json'), 'utf8')) as { createdAt?: string };
        const terminal = JSON.parse(readFileSync(join(hostRuns, runId, 'terminal.json'), 'utf8')) as { terminalAt?: string };
        return spec.createdAt && terminal.terminalAt ? { start: Date.parse(spec.createdAt), end: Date.parse(terminal.terminalAt) } : null;
      } catch { return null; }
    };
    const perRound = roundIds.map((round, index) => {
      const runs = laneRunsOf(round);
      const laneBytes = runs.map(run => bytes(promptOf(run.reviewRunId)?.prompt));
      const critic = criticPrompts.filter(row => allRuns.some(run => run.reviewRound === round && run.reviewPurpose === 'inventory-completeness' && row.prompt.includes(run.reviewRunId)));
      const times = runs.map(run => { const host = promptOf(run.reviewRunId); return host ? runTimes(host.runId) : null; }).filter((row): row is { start: number; end: number } => row !== null);
      const wall = times.length === runs.length && times.length > 0 ? (Math.max(...times.map(row => row.end)) - Math.min(...times.map(row => row.start))) / 1000 : null;
      const sessionSum = times.reduce((sum, row) => sum + (row.end - row.start) / 1000, 0);
      return { index: index + 1, lanes: runs.map(run => short(run.lane)), laneBytes, criticBytes: critic.map(row => bytes(row.prompt)), wall, sessionSum };
    });
    for (const row of perRound) {
      lines.push(`round ${row.index}: lane sessions ${row.lanes.length} (${row.lanes.join(', ')}), lane prompt bytes ${row.laneBytes.reduce((a, b) => a + b, 0)} [${row.laneBytes.join(', ')}], critic prompt bytes ${row.criticBytes.reduce((a, b) => a + b, 0)}`
        + (measured && row.wall !== null ? `, round wall ${row.wall.toFixed(1)} s = ${(row.wall / LM_SECONDS_PER_MODEL_MINUTE).toFixed(2)} model-min (sessions summed ${row.sessionSum.toFixed(1)} s; scripted ${LM_SECONDS_PER_MODEL_MINUTE} s = 1 model-minute)` : ''));
    }
    lines.push(`critic launches ${criticLaunches}; roster selections: ${selections.map(row => String(row.selection.selection ?? '?')).join(', ')}`);
    const findings = store.readFindings(o.storyId).findings;
    for (const finding of findings) assert.equal(finding.status === 'open' && finding.severity !== 'low', false, `${tag}: ${finding.id} closed before DONE (${finding.status})`);
    if (off) {
      // Off arm: unchanged production flow (the ND golden).
      assert.ok(perRound.length >= 2, `${tag}: two review rounds`);
      for (const row of perRound) assert.deepEqual([...row.lanes].sort(), lanesAll, `${tag}: round ${row.index} runs every lane separately (${row.lanes.join(', ')})`);
      for (const row of prompts) assert.doesNotMatch(row.prompt, /BEGIN MERGED REVIEW DIMENSIONS/, `${tag}: no merged block with the switch absent`);
      assert.equal(coverage.length, 0, `${tag}: no lane-merge events`);
      assert.ok(selections.every(row => row.selection.selection !== 'lane-merge'), `${tag}: no lane-merge selection`);
    } else {
      // One roster source of truth: each round's finalized inventory epoch requires exactly the lanes that ran.
      const epochs = store.readReviewInventoryEpochs(o.storyId).epochs;
      roundIds.forEach((round, index) => {
        const finalized = epochs.filter(epoch => epoch.reviewRound === round && epoch.state === 'FINALIZED').at(-1);
        const ran = [...new Set(laneRunsOf(round).map(run => run.lane))].sort();
        assert.deepEqual([...(finalized?.requiredLanes ?? [])].sort(), ran, `${tag}: round ${index + 1}'s epoch requiredLanes = the lanes that ran (${JSON.stringify(finalized?.requiredLanes)})`);
      });
      const carrierPrompts = prompts.filter(row => /BEGIN MERGED REVIEW DIMENSIONS/.test(row.prompt));
      assert.ok(carrierPrompts.length >= 1, `${tag}: a merged session ran`);
      const carriers = split ? ['proof-or-stop-review-concept', 'proof-or-stop-review-test-coverage'] : ['proof-or-stop-review-concept'];
      for (const row of carrierPrompts) {
        assert.ok(carriers.includes(row.agentType), `${tag}: ${row.agentType} carries a merged session`);
        const binding = (row.reviewBinding as { laneMerge?: { role?: string; abVariant?: { flags?: Record<string, string> }; checkItems?: string[] } } | null)?.laneMerge;
        assert.equal(binding?.role, 'merged', `${tag}: run spec seals role=merged`);
        assert.equal(binding?.abVariant?.flags?.['review.laneMerge'], switchValue, `${tag}: the arm is recorded`);
        assert.match(row.prompt, /\[read\] <dimension> :: /, `${tag}: the depth contract (read list) is in the merged prompt`);
      }
      const first = carrierPrompts[0]!;
      assert.equal(selections[0]?.selection.selection, 'lane-merge', `${tag}: round 1 roster selection is lane-merge`);
      const round1 = perRound[0]!.lanes;
      if (split) {
        const sessionOf = (lane: string) => carrierPrompts.find(row => row.agentType === `proof-or-stop-review-${lane}`)?.prompt ?? '';
        assert.match(sessionOf('concept'), /### Dimension 2\/2: quality/, `${tag}: session A = concept + quality`);
        assert.doesNotMatch(sessionOf('concept'), /### Dimension \d\/\d: (test-coverage|docs)/, `${tag}: session A carries no B dimension`);
        assert.match(sessionOf('concept'), /<<<ROLE quality/, `${tag}: the quality role prompt is carried`);
        if (variant !== 'LM-SC') {
          assert.match(sessionOf('test-coverage'), /### Dimension 2\/2: docs/, `${tag}: session B = test-coverage + docs`);
          assert.match(sessionOf('test-coverage'), /<<<ROLE docs/, `${tag}: the docs role prompt is carried`);
        }
      } else {
        const dims = lanesAll.length;
        for (const dimension of lanesAll) assert.match(first.prompt, new RegExp(`### Dimension \\d/${dims}: ${dimension}`), `${tag}: ${dimension} section in the merged prompt`);
        assert.match(first.prompt, /<<<ROLE quality/, `${tag}: the quality role prompt is carried`);
        assert.match(first.prompt, /<<<ROLE test-coverage/, `${tag}: the test-coverage role prompt is carried`);
      }
      if (variant === 'LM' || variant === 'LM-F' || variant === 'LM4' || variant === 'LM-S') {
        assert.ok(perRound.length >= 2, `${tag}: the finding round is followed by a re-review`);
        const expectedLanes = split ? ['concept', 'test-coverage'] : ['concept'];
        for (const row of perRound) assert.deepEqual([...row.lanes].sort(), expectedLanes, `${tag}: round ${row.index} is ${expectedLanes.length} lane session(s) (${row.lanes.join(', ')})`);
        assert.equal(criticLaunches, perRound.length, `${tag}: the inventory critic runs in every round as before`);
        const tagged = variant === 'LM-F' ? [D_TC, NF_Q] : [D_TC];
        const raiser = split ? 'proof-or-stop-review-test-coverage' : 'proof-or-stop-review-concept';
        for (const expected of tagged) {
          const finding = findings.find(f => f.desc === expected.desc);
          assert.ok(finding, `${tag}: "${String(expected.desc).slice(0, 40)}" imported with its dimension tag`);
          assert.equal(finding!.agent, raiser, `${tag}: attributed to the carrier lane of the session that raised it`);
          assert.equal(finding!.reviewRound, roundIds[0], `${tag}: in round 1`);
          assert.equal(finding!.status, 'resolved', `${tag}: repaired and closed`);
        }
        assert.equal(findings.filter(f => f.desc === D_TC.desc).length, 1, `${tag}: the finding is reported once (by its own session)`);
        assert.ok(coverage.length >= 2 * expectedLanes.length && coverage.every(event => (event.missingLanes as unknown[] | undefined)?.length === 0), `${tag}: every merged import covered every dimension (${JSON.stringify(coverage.map(event => event.missingLanes))})`);
        const tests = readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8');
        assert.match(tests, /TestReverseEmpty/, `${tag}: D_FINDING's repair merged`);
        if (variant === 'LM-F') assert.match(tests, /TestUpperEmpty/, `${tag}: NF_FINDING's repair merged`);
        if (measured) {
          const r1 = perRound[0]!;
          assert.ok(r1.wall !== null, `${tag}: round wall measured`);
          if (split) assert.ok(r1.wall! < r1.sessionSum - 2, `${tag}: the two sessions overlap (round wall ${r1.wall} s < summed ${r1.sessionSum.toFixed(1)} s)`);
        }
      } else if (variant === 'LM-G' || variant === 'LM-D' || variant === 'LM-SG') {
        const relaunched = variant === 'LM-D' ? 'test-coverage' : 'quality';
        const expected = variant === 'LM-SG' ? ['concept', 'quality', 'test-coverage'] : ['concept', relaunched].sort();
        assert.deepEqual([...round1].sort(), expected, `${tag}: only the uncovered dimension was relaunched (${round1.join(', ')})`);
        const gapEvents = coverage.filter(event => (event.missingLanes as unknown[]).length > 0);
        assert.equal(gapEvents.length, 1, `${tag}: one gap coverage event`);
        assert.deepEqual(gapEvents[0]!.missingLanes, [`proof-or-stop-review-${relaunched}`], `${tag}: ${relaunched} uncovered`);
        if (variant !== 'LM-G') assert.ok((gapEvents[0]!.genericItems as string[]).every(item => item.startsWith(`${relaunched}:`)) && (gapEvents[0]!.genericItems as string[]).length === 2, `${tag}: generic evidence recorded (${JSON.stringify(gapEvents[0]!.genericItems)})`);
        const carrierRun = laneRunsOf(roundIds[0]!).find(run => run.lane === 'proof-or-stop-review-concept')!;
        assert.ok(store.readReviewPasses(o.storyId).passes.some(pass => pass.reviewRunId === carrierRun.reviewRunId), `${tag}: the merged pass (the covered dimensions) was imported`);
        const lateRun = laneRunsOf(roundIds[0]!).find(run => run.lane === `proof-or-stop-review-${relaunched}` && !/BEGIN MERGED/.test(promptOf(run.reviewRunId)?.prompt ?? ''))!;
        assert.ok(lateRun, `${tag}: ${relaunched} ran as its own lane`);
        assert.ok(store.readReviewPasses(o.storyId).passes.some(pass => pass.reviewRunId === lateRun.reviewRunId), `${tag}: ${relaunched} reviewed on its own`);
        assert.equal(events.filter(event => event.type === 'managed_review_import_refused').length, 0, `${tag}: nothing refused`);
      } else if (variant === 'LM-C' || variant === 'LM-SC') {
        const expected = variant === 'LM-C' ? ['concept', 'concept', 'quality', 'test-coverage'] : ['concept', 'docs', 'test-coverage', 'test-coverage'];
        assert.deepEqual([...round1].sort(), expected, `${tag}: the refused carrier reran and its session's dimensions ran as their own lanes (${round1.join(', ')})`);
        const refused = events.filter(event => event.type === 'managed_review_import_refused' && /lane_merge/.test(String(event.reason)));
        assert.equal(refused.length, 1, `${tag}: the merged pass is refused once (never proposed again)`);
        const refusedRun = String((refused[0] as { reviewRunId?: string }).reviewRunId);
        assert.ok(!store.readReviewPasses(o.storyId).passes.some(pass => pass.reviewRunId === refusedRun), `${tag}: no pass recorded for the refused merged run`);
        assert.equal(coverage.find(event => event.carrierMissing === true)?.carrier, variant === 'LM-C' ? 'proof-or-stop-review-concept' : 'proof-or-stop-review-test-coverage', `${tag}: recorded as the carrier's own gap`);
        const later = laneRunsOf(roundIds[0]!).filter(run => run.reviewRunId !== refusedRun && (variant === 'LM-C' || run.lane !== 'proof-or-stop-review-concept'));
        for (const run of later) assert.doesNotMatch(promptOf(run.reviewRunId)?.prompt ?? '', /BEGIN MERGED REVIEW DIMENSIONS/, `${tag}: the fallback lanes run their ordinary prompts`);
        if (variant === 'LM-SC') {
          const a = laneRunsOf(roundIds[0]!).find(run => run.lane === 'proof-or-stop-review-concept')!;
          assert.ok(store.readReviewPasses(o.storyId).passes.some(pass => pass.reviewRunId === a.reviewRunId), `${tag}: session A's merged pass stands`);
        }
      } else if (variant === 'LM-FG') {
        assert.deepEqual(round1, ['concept'], `${tag}: a findings verdict with a gap launches no late lane (${round1.join(', ')})`);
        assert.equal(coverage[0]?.conclusion, 'findings', `${tag}: the gap is a findings-verdict gap`);
        assert.deepEqual(coverage[0]?.missingLanes, ['proof-or-stop-review-quality'], `${tag}: quality uncovered`);
        const round2 = perRound[1]?.lanes ?? [];
        assert.deepEqual([...round2].sort(), ['concept', 'quality'], `${tag}: round 2 = the merged session + quality on its own (${round2.join(', ')})`);
        const merged2 = laneRunsOf(roundIds[1]!).find(run => run.lane === 'proof-or-stop-review-concept')!;
        const prompt2 = promptOf(merged2.reviewRunId)?.prompt ?? '';
        assert.match(prompt2, /### Dimension \d\/2: test-coverage/, `${tag}: round 2's merged session covers concept + test-coverage`);
        assert.doesNotMatch(prompt2, /### Dimension \d\/\d: quality/, `${tag}: quality is not in round 2's merged session`);
        const finding = findings.find(f => f.desc === D_TC.desc);
        assert.equal(finding?.status, 'resolved', `${tag}: the round-1 finding was repaired and closed`);
      }
    }
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** Lab lean (NLN-E): a round-2 confirmation finding citing a line outside the repair delta (the repair touched only the test file). */
const LN_ESC_FINDING = {
  desc: 'Upper has no focused test for an empty string (strs/strs.go:6): Upper("") must return "" and nothing asserts it.',
  severity: 'medium', category: 'edge', files: ['strs/strs.go'], evidenceState: 'verified',
};

type LeanVariant = 'LN' | 'LN-OFF' | 'LN-E' | 'LN-DF';

/** Lab lean (NLN-DF): the Story run commits under its bound item's id only, so the other item is not counted as implemented. */
function leanBoundOnlyImplementerScript(storyId: string, itemId: string): ProviderScript {
  const writeFiles = `const fs=require('fs');fs.writeFileSync('strs/strs.go',${JSON.stringify(IMPL)});fs.writeFileSync('strs/strs_test.go',${JSON.stringify(TESTS)});`;
  return { commands: [
    [process.execPath, '-e', writeFiles],
    ['/bin/sh', '-c', `git add strs && (git -c user.name=${IMPLEMENTER} commit -qm '${storyId} ${itemId}: implement' || true) && git log --format=%h -1`],
    [process.execPath, CLI, 'checklist_update', JSON.stringify({ storyId, itemId, status: 'done' })],
  ], final: `Implemented ${itemId}; marked done.` };
}

/**
 * Lab lean (bench-staging/oldpos/lean-pipeline.md): the EXPERIMENTAL umbrella switch `pipeline.lean=on` on the
 * unimplemented ND fixture (two items), driven by `next` alone from DEV to DONE:
 *   NLN     DEV = ONE managed implementer run for both items (groupItemIds = every open item; the other item is
 *           marked done by a framework step `story_item_done` after the run's commit names it); round 1 = ONE merged
 *           review session (it reports D_FINDING) + the critic; round 2 = ONE delta confirmation session over the
 *           repair (no lane re-reviews the whole Story), the framework re-runs the repaired finding's test, no critic
 *           (clean). Prints the managed sessions per phase.
 *   NLN-OFF the same fixture and flow with the switch absent (the control): one implementer run per item, three lane
 *           sessions per round, the critic every round. Prints the same counts.
 *   NLN-E   round 2's confirmation session reports LN_ESC_FINDING, which cites a line outside the repair delta: the
 *           escalation is recorded (delta_round_escalated) and round 3 is a FULL (merged) round
 *           (PREVIOUS_ESCALATION), not another delta round.
 *   NLN-DF  the Story run's commit names only its bound item: the other item is not counted as implemented by it and
 *           gets its own implementer run (no framework done step).
 */
function scenarioLN(machineEnv: NodeJS.ProcessEnv, steps: Step[], variant: LeanVariant): Outcome {
  const tag = `N${variant}`;
  const lean = variant !== 'LN-OFF';
  const name = `${tag} ${lean ? 'A/B {"pipeline":{"lean":"on"}}' : '(pipeline.lean absent: control)'} on the unimplemented ND fixture reaches DONE`;
  const ids: Record<LeanVariant, string> = { LN: 'B-ln11', 'LN-OFF': 'B-ln12', 'LN-E': 'B-ln13', 'LN-DF': 'B-ln14' };
  const o = new Owner(tag, ids[variant], machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, ...(lean ? { config: { pipeline: { lean: 'on' } } } : {}) });
  const lines: string[] = [];
  const reasons: Array<{ reason: string; kind: string }> = [];
  const selections: Array<{ round: string; selection: Record<string, unknown> }> = [];
  let evidenceAdded = false;
  try {
    devSetup(o, false);
    driveWithNext(o, {
      findingRound1: true, run: false, ...(lean ? { lean: { escalate: variant === 'LN-E' } } : {}),
      ...(variant === 'LN-DF' ? { implementerScript: (itemId: string) => leanBoundOnlyImplementerScript(o.storyId, itemId) } : {}),
      // The fixture's intents are not pinned: the owner records the focused evidence once the code exists (as AB V6).
      interject: next => {
        if (next.reason !== 'evidence_chain' || evidenceAdded) return false;
        addItemEvidence(o);
        evidenceAdded = true;
        return true;
      },
    }, lines, next => {
      reasons.push({ reason: next.reason, kind: next.kind });
      if (next.reason !== 'review_lane_launch') return;
      const round = new StoryStore(o.worktree).readStory(o.storyId).currentReviewRound ?? '';
      if (selections.some(row => row.round === round)) return;
      const listed = parseJson(o.mustCli('reviewer_list', { storyId: o.storyId, json: true }, { label: 'reviewer_list (roster)' }).stdout);
      selections.push({ round, selection: ((listed?.finalReview as Record<string, unknown> | undefined)?.selection ?? {}) as Record<string, unknown> });
    });
    const store = new StoryStore(o.root);
    const allRuns = store.readReviewRuns(o.storyId).runs;
    const roundIds = [...new Set(allRuns.filter(run => run.reviewPurpose !== 'inventory-completeness').map(run => run.reviewRound))];
    const short = (lane: string) => lane.replace('proof-or-stop-review-', '');
    const laneRunsOf = (round: string) => allRuns.filter(run => run.reviewRound === round && run.reviewPurpose !== 'inventory-completeness');
    const prompts = managedPrompts(o);
    const lanePrompts = prompts.filter(row => row.agentType.startsWith('proof-or-stop-review-') && row.agentType !== DELIVERY && row.agentType !== MANAGED_INVENTORY_CRITIC_LANE);
    const promptOf = (reviewRunId: string) => lanePrompts.find(row => row.prompt.includes(reviewRunId)) ?? null;
    const implementers = prompts.filter(row => row.agentType === IMPLEMENTER);
    const critics = prompts.filter(row => row.agentType === MANAGED_INVENTORY_CRITIC_LANE);
    const repairs = prompts.filter(row => row.agentType === FINDING_REPAIR);
    const deliveries = prompts.filter(row => row.agentType === DELIVERY);
    const perRound = roundIds.map(round => laneRunsOf(round).map(run => short(run.lane)));
    const events = store.readProcessEvents(o.storyId);
    lines.push(`managed sessions: ${prompts.length} = implementer ${implementers.length}, review lanes ${lanePrompts.length} (per round: ${perRound.map(row => `${row.length} [${row.join(', ')}]`).join(' | ')}), critic ${critics.length}, finding-repair ${repairs.length}, delivery ${deliveries.length}`);
    lines.push(`roster selections: ${selections.map(row => `${String(row.selection.selection ?? '?')}${(row.selection.deltaRound as { reason?: string } | undefined)?.reason ? `/${String((row.selection.deltaRound as { reason?: string }).reason)}` : ''}`).join(', ')}`);
    lines.push(`owner-visible steps: ${reasons.filter(row => row.kind !== 'framework').map(row => row.reason).join(', ') || '(none)'}`);
    const findings = store.readFindings(o.storyId).findings;
    for (const finding of findings) assert.equal(finding.status === 'open' && finding.severity !== 'low', false, `${tag}: ${finding.id} closed before DONE (${finding.status})`);
    const storyDone = reasons.filter(row => row.reason === 'story_item_done');
    if (!lean) {
      assert.equal(implementers.length, 2, `${tag}: control = one implementer run per item (got ${implementers.length})`);
      assert.ok(perRound.every(row => row.length === 3), `${tag}: control = three lane sessions per round`);
      assert.equal(critics.length, perRound.length, `${tag}: control = the critic every round`);
      assert.equal(storyDone.length, 0, `${tag}: no framework member done step in the control`);
    } else if (variant === 'LN-DF') {
      assert.equal(implementers.length, 2, `${tag}: the item no commit names gets its own run (got ${implementers.length})`);
      assert.deepEqual(implementers[0]!.target?.groupItemIds, ['CHK-001', 'CHK-002'], `${tag}: the first run is the Story run`);
      assert.equal(implementers[1]!.target?.itemId, 'CHK-002', `${tag}: the second run is bound to CHK-002`);
      assert.equal(implementers[1]!.target?.groupItemIds, undefined, `${tag}: alone`);
      assert.equal(storyDone.length, 0, `${tag}: no framework done step without a commit naming the item`);
    } else {
      // DEV: one Story run.
      assert.equal(implementers.length, 1, `${tag}: ONE implementer run for the Story (got ${implementers.length})`);
      assert.deepEqual(implementers[0]!.target?.groupItemIds, ['CHK-001', 'CHK-002'], `${tag}: the run binds every open item`);
      assert.equal((implementers[0]!.target?.abVariant as { flags?: Record<string, string> } | undefined)?.flags?.['implementation.grouping'], 'story', `${tag}: the arm is sealed on the target`);
      assert.match(implementers[0]!.prompt, /--- BEGIN STORY RUN/, `${tag}: the Story-run brief`);
      assert.match(implementers[0]!.prompt, /### CHK-002: /, `${tag}: CHK-002 has its own section`);
      assert.equal(storyDone.length, 1, `${tag}: CHK-002 is marked done by ONE framework step (got ${JSON.stringify(storyDone)})`);
      assert.equal(storyDone[0]!.kind, 'framework', `${tag}: a framework step, not an owner turn`);
      const items = store.readChecklist(o.storyId).items;
      assert.ok(items.every(item => item.status === 'done'), `${tag}: every item done`);
      // REVIEW round 1: one merged session.
      assert.equal(selections[0]?.selection.selection, 'lane-merge', `${tag}: round 1 is a merged round`);
      assert.deepEqual(perRound[0], ['concept'], `${tag}: round 1 = ONE review session (${perRound[0]!.join(', ')})`);
      assert.match(promptOf(laneRunsOf(roundIds[0]!)[0]!.reviewRunId)?.prompt ?? '', /BEGIN MERGED REVIEW DIMENSIONS/, `${tag}: round 1 carries the merged block`);
      // Round 2: one delta confirmation session, nobody in full.
      assert.ok(roundIds.length >= 2, `${tag}: the finding round is followed by a re-review`);
      assert.equal(selections[1]?.selection.selection, 'delta-round', `${tag}: round 2 is a delta round`);
      assert.deepEqual(perRound[1], ['concept'], `${tag}: round 2 = ONE confirmation session (${perRound[1]!.join(', ')})`);
      const round2Prompt = promptOf(laneRunsOf(roundIds[1]!)[0]!.reviewRunId);
      assert.match(round2Prompt?.prompt ?? '', /--- BEGIN DELTA ROUND CONFIRMATION/, `${tag}: the confirmation block`);
      assert.match(round2Prompt?.prompt ?? '', /No lane re-reviews the whole Story/, `${tag}: no full raiser`);
      assert.equal((round2Prompt?.reviewBinding as { deltaRound?: { mode?: string } } | null)?.deltaRound?.mode, 'confirm', `${tag}: the binding seals confirm mode`);
      const reverified = events.filter(event => String(event.type) === 'delta_round_reverified');
      assert.ok(reverified.length >= 1 && reverified.every(event => (event as { passed?: boolean }).passed === true), `${tag}: the framework re-ran the repaired finding's test`);
      if (variant === 'LN') {
        assert.equal(roundIds.length, 2, `${tag}: two rounds`);
        assert.equal(critics.length, 1, `${tag}: the critic ran only in the finding round (got ${critics.length})`);
      } else {
        const escalated = events.filter(event => String(event.type) === 'delta_round_escalated');
        assert.equal(escalated.length, 1, `${tag}: the escalation is recorded once (${JSON.stringify(escalated)})`);
        assert.equal((escalated[0] as { reviewRound?: string }).reviewRound, roundIds[1], `${tag}: it belongs to round 2`);
        assert.ok(roundIds.length >= 3, `${tag}: round 2's finding was repaired and re-reviewed (rounds ${roundIds.length})`);
        assert.equal((selections[2]?.selection.deltaRound as { reason?: string } | undefined)?.reason, 'PREVIOUS_ESCALATION', `${tag}: round 3's delta fallback reason`);
        assert.equal(selections[2]?.selection.selection, 'lane-merge', `${tag}: round 3 is a full merged round`);
        const round3Prompt = promptOf(laneRunsOf(roundIds[2]!)[0]!.reviewRunId)?.prompt ?? '';
        assert.match(round3Prompt, /BEGIN MERGED REVIEW DIMENSIONS/, `${tag}: round 3 is a merged full round`);
        assert.match(round3Prompt, /review\.deltaRounds=confirm[^\n]*FULL review: re-review the WHOLE Story/, `${tag}: round 3's prompt says to review the whole Story`);
        assert.doesNotMatch(round3Prompt, /Do not re-review the whole Story/, `${tag}: no narrowing after an escalation`);
        const esc = findings.find(f => f.desc === LN_ESC_FINDING.desc);
        assert.equal(esc?.status, 'resolved', `${tag}: the escalated finding was repaired and closed`);
      }
    }
    const tests = readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8');
    assert.match(tests, /TestReverseEmpty/, 'the round-1 repair merged into main');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Lab lean-dev (old-PoS runs 117 / 118, bench-staging/oldpos/run114-120-analysis.md): pipeline.lean=on, the request
 * quotes an exact error string (NXT_REQUEST) and the Story run's added test compares it only through a prefix helper.
 * The Story run commits under a message naming both items and marks its bound CHK-001 done; `next --run` marks the
 * member CHK-002 done (story_item_done), the exact-text gate then reopens CHK-002. Runs 117 / 118 looped here:
 * story_item_done re-closed the reopened item from the same Story-run commit, the gate reopened it again, 40 steps per
 * `next --run`, no implementer launch; the owner hand-launched `host_run itemId=CHK-002` while the item was done and
 * both runs ended managed_dispatch_output_missing (a done->done completion binds nothing). Here:
 *   (b) a hand `host_run` of the implementer for the done member is refused before any provider spawn, naming
 *       managed_dispatch_target_already_done and one Next (`next`);
 *   (a) `next --run` reopens CHK-002 and then launches its implementer itself (implement_item bound to CHK-002, a
 *       framework step), never story_item_done again; the relaunch completes with a sealed output (state completed),
 *       and afterwards next neither reopens nor re-closes the item.
 */
function scenarioNLNX(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NLN-X';
  const name = 'NLN-X lab lean-dev (runs 117/118): a Story-run member the exact-text gate reopens gets its implementer relaunched by next, never re-closed; a hand launch on the done member is refused pre-spawn';
  const o = new Owner(tag, 'B-ln15', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NXT_REQUEST, config: { pipeline: { lean: 'on' } } });
  const lines: string[] = [];
  const problems: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[${tag}] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  const runNext = (label: string, maxSteps: number): string[] => {
    const ran = o.cli('next', { storyId: o.storyId, run: true, json: true, maxSteps }, { label });
    const executed = ((parseJson(ran.stdout)?.executed ?? []) as Array<{ reason: string; exit: number }>);
    lines.push(`${label} ran: ${executed.map(row => `${row.reason}:${row.exit}`).join(' > ') || '(nothing)'}`);
    return executed.map(row => row.reason);
  };
  const storyRunCommands: string[][] = [
    [process.execPath, '-e', `const fs=require('fs');fs.writeFileSync('strs/strs.go',${JSON.stringify(IMPL)});fs.writeFileSync('strs/strs_test.go',${JSON.stringify(TESTS)});fs.writeFileSync('strs/errors_test.go',${JSON.stringify(NXT_PREFIX_TEST)});`],
    ['/bin/sh', '-c', `git add strs && git -c user.name=${IMPLEMENTER} commit -qm '${o.storyId} CHK-001 CHK-002: implement Upper, Reverse and the error text' && git log --format=%h -1`],
    [process.execPath, CLI, 'checklist_update', JSON.stringify({ storyId: o.storyId, itemId: 'CHK-001', status: 'done' })],
  ];
  try {
    devSetup(o, false);
    let launch = ask('next (DEV start)');
    for (let guard = 0; launch.reason === 'checklist_item_start' && guard < 4; guard += 1) {
      o.mustCli(launch.cli!.command, launch.cli!.payload, { label: `checklist_update start ${String(launch.cli!.payload.itemId)}` });
      launch = ask('next (item started)');
    }
    assert.equal(launch.reason, 'implement_item', `[${tag}] DEV starts with the Story run: ${launch.reason}: ${launch.why}`);
    assert.deepEqual(launch.cli?.payload.groupItemIds, ['CHK-001', 'CHK-002'], `[${tag}] one Story run for both items`);
    o.script(IMPLEMENTER, { commands: storyRunCommands, final: 'Implemented CHK-001 and CHK-002; CHK-001 marked done.\n[intent-conflict] none' });
    const storyRun = String((parseJson(o.mustCli(launch.cli!.command, launch.cli!.payload, { label: 'host_run implementer (Story run)' }).stdout)?.run as Record<string, unknown>).runId);
    const storyTerminal = waitTerminal(o, 'implementer (Story run)', storyRun);
    o.unscript(IMPLEMENTER);
    assert.equal(storyTerminal.state, 'completed', `[${tag}] Story run terminal ${storyTerminal.state} (${storyTerminal.reason})`);

    const memberDone = ask('next (after the Story run)');
    assert.equal(memberDone.reason, 'story_item_done', `[${tag}] the member is marked done by the framework: ${memberDone.reason}: ${memberDone.why}`);
    assert.deepEqual(runNext('next --run (member done)', 1), ['story_item_done']);
    assert.equal(new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === 'CHK-002')?.status, 'done', `[${tag}] CHK-002 done`);

    // (b) Runs 117 / 118: the owner hand-launched the implementer for the done member.
    o.script(IMPLEMENTER, { commands: [[process.execPath, CLI, 'checklist_update', JSON.stringify({ storyId: o.storyId, itemId: 'CHK-002', status: 'done' })]],
      final: 'CHK-002 is already done; no change.\n[intent-conflict] none' });
    const { groupItemIds: _group, ...single } = launch.cli!.payload;
    const hand = o.cli('host_run', { ...single, itemId: 'CHK-002' }, { label: 'host_run implementer CHK-002 by hand (item done)' });
    if (hand.status === 0) {
      const handRun = String((parseJson(hand.stdout)?.run as Record<string, unknown> | undefined)?.runId ?? '');
      const handTerminal = handRun ? waitTerminal(o, 'implementer (hand, done item)', handRun) : { state: '?', reason: 'no run id' };
      problems.push(`(b) host_run for the done item CHK-002 was accepted and spawned a provider: ${handTerminal.state}:${handTerminal.reason}`);
    } else {
      if (!/managed_dispatch_target_already_done/.test(hand.out)) problems.push(`(b) the refusal does not name managed_dispatch_target_already_done: ${hand.out.slice(-600)}`);
      if (!new RegExp(`Next: proof-or-stop next --storyId=${o.storyId}`).test(hand.out)) problems.push(`(b) the refusal gives no Next: ${hand.out.slice(-600)}`);
      if (managedPrompts(o, IMPLEMENTER).length !== 1) problems.push('(b) a refused hand launch created a run');
    }
    o.unscript(IMPLEMENTER);

    // (a) The exact-text gate reopens the member; next must relaunch its implementer, not re-close it.
    o.script(IMPLEMENTER, { commands: [
      [process.execPath, '-e', `require('fs').writeFileSync('strs/errors_exact_test.go',${JSON.stringify(NXT_EXACT_TEST)});`],
      ['/bin/sh', '-c', `git add strs && git -c user.name=${IMPLEMENTER} commit -qm '${o.storyId} CHK-002: exact error text test' && git log --format=%h -1`],
      [process.execPath, CLI, 'checklist_update', JSON.stringify({ storyId: o.storyId, itemId: 'CHK-002', status: 'done' })],
    ], final: 'Asserted the error text exactly.\n[intent-conflict] none' });
    const launchedBefore = managedPrompts(o, IMPLEMENTER).length;
    const executed = runNext('next --run (exact-text reopen)', 3);
    if (executed[0] !== 'exact_text_prefix_assertion') problems.push(`(a) first step ${executed[0]}, expected the exact-text reopen`);
    if (executed.slice(1).includes('story_item_done')) problems.push(`(a) the reopened member was re-closed by story_item_done (dead end): ${executed.join(' > ')}`);
    if (executed[1] !== 'implement_item') problems.push(`(a) next did not relaunch the reopened item's implementer: ${executed.join(' > ')}`);
    const relaunched = managedPrompts(o, IMPLEMENTER);
    if (relaunched.length === launchedBefore + 1) {
      const run = relaunched.at(-1)!;
      if (run.target?.itemId !== 'CHK-002' || run.target?.groupItemIds !== undefined) problems.push(`(a) the relaunch is not bound to CHK-002 alone: ${JSON.stringify(run.target)}`);
      const terminal = waitTerminal(o, 'implementer (exact relaunch)', run.runId);
      if (terminal.state !== 'completed') problems.push(`(a) the relaunch did not deliver: ${terminal.state}:${terminal.reason}`);
      if (!/Reopened before REVIEW: [\s\S]*assertErrPrefix/.test(run.prompt)) problems.push('(a) the relaunch prompt does not name the prefix helper');
    } else {
      problems.push(`(a) implementer runs after next --run: ${relaunched.length - launchedBefore} new (expected 1)`);
    }
    o.unscript(IMPLEMENTER);
    if (!problems.some(row => row.startsWith('(a)'))) {
      const after = ask('next (exact assertion added)');
      if (['exact_text_prefix_assertion', 'story_item_done'].includes(after.reason) || after.kind === 'human') problems.push(`(a) after the relaunch next still loops or dead-ends: ${after.reason}: ${after.why.slice(0, 300)}`);
    }
    lines.push(`implementer runs: ${managedPrompts(o, IMPLEMENTER).length}; problems: ${problems.length}`);
    assert.deepEqual(problems, [], `[${tag}] ${problems.join(' | ')}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** CLI calls and seconds from REVIEW entry (after the shared DEV setup), per scenario. */
function fromReviewEntry(steps: Step[], scenario: string): { calls: number; seconds: number; nextCalls: number } | null {
  const rows = steps.filter(s => s.scenario === scenario).slice(DEV_SETUP_CALLS);
  if (!rows.length) return null;
  return { calls: rows.length, seconds: rows.reduce((sum, s) => sum + s.ms, 0) / 1000, nextCalls: rows.filter(s => s.label.startsWith('next')).length };
}

function printNComparison(steps: Step[]): void {
  const pairs: Array<[string, string]> = [['A', 'NA'], ['A', 'NA-run'], ['D', 'ND'], ['D', 'ND-run']];
  const rows = pairs.map(([hand, driven]) => ({ hand, driven, h: fromReviewEntry(steps, hand), d: fromReviewEntry(steps, driven) })).filter(row => row.d);
  if (!rows.length) return;
  console.log('\nnext-driven vs hand-coded owner sequence, from REVIEW entry (after the 6 shared DEV setup calls):');
  for (const { hand, driven, h, d } of rows) {
    const handText = h ? `${hand}: ${h.calls} calls, ${h.seconds.toFixed(1)} s` : `${hand}: not run in this invocation`;
    console.log(`  ${driven}: ${d!.calls} calls (${d!.nextCalls} next), ${d!.seconds.toFixed(1)} s   |   ${handText}`);
  }
}

function scenarioD3(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  // Run 13: the owner satisfied the review assurance floor with quorum_submit
  // (two distinct Codex sessions) instead of autopilot_review_submit. Its
  // lifecycle commit `quorum-submit` must keep the managed passes live at
  // done_prepare / DONE, and any lineage refusal in TEST must print a Next
  // that is valid in TEST.
  const name = 'D3 run 13: review assurance floor via quorum_submit, then done_prepare -> DONE';
  const o = new Owner('D3', 'B-e2e5', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  try {
    devToReview(o);
    reviewRound(o);
    inventory(o);
    precertToTest(o);
    liveSmoke(o);
    const delivery = deliveryReview(o, [
      { docPath: 'docs/types/string.md', promise: 'Upper returns the upper-case form of a string.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestUpper', evidence: '--- PASS: TestUpper' },
      { docPath: 'docs/types/string.md', promise: 'Reverse returns the string reversed by rune.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestReverse', evidence: '--- PASS: TestReverse' },
    ]);
    assert.equal(delivery.state, 'completed', `delivery reviewer terminal ${delivery.state} (${delivery.reason})\n${delivery.commandLog}`);
    authoredCloseout(o);
    const quorum = o.cli('quorum_submit', { storyId: o.storyId, hostA: 'e2e-codex-host-a', hostB: 'e2e-codex-host-b',
      providerA: 'codex', providerB: 'codex', sessionA: 'codex-session-a', sessionB: 'codex-session-b', json: true }, { label: 'quorum_submit (2 codex sessions)' });
    assert.equal(quorum.status, 0, `D3: quorum_submit failed:\n${quorum.out.slice(-2000)}`);
    lines.push(`quorum_submit: ${git(o.worktree, ['log', '--format=%h %s', '-1'])}`);
    const floor = closureRow(o, 'done_closure (after quorum)', 'review-assurance-floor');
    lines.push(`review-assurance-floor after quorum_submit: status=${String(floor?.status)} blocking=${String(floor?.blocking)}`);
    const prepare = o.cli('done_prepare', { storyId: o.storyId, json: true });
    const prepared = parseJson(prepare.stdout);
    lines.push(`done_prepare: exit ${prepare.status} status=${String(prepared?.status)} blockedAt=${String(prepared?.blockedAt ?? '-')}`);
    const prepareText = prepare.out.replace(/\\"/g, '"');
    const refusal = prepareText.match(/\(unauthenticated commit ([0-9a-f]{12}) "([^"]*)": (.*?); (Next: proof-or-stop [^;)]*)/);
    if (refusal) {
      lines.push(`  lineage refusal: commit ${refusal[1]} "${refusal[2]}": ${refusal[3].slice(0, 100)}; ${refusal[4]}`);
      assert.doesNotMatch(refusal[4], /review_round_prepare/, 'D3: a REVIEW-only Next printed in TEST');
    }
    assert.doesNotMatch(prepare.out, /managed_review_live_head_lineage_invalid/, `D3: done_prepare refused the managed passes after quorum_submit: ${String(prepared?.reason ?? '').slice(0, 600)}`);
    const done = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE' });
    lines.push(`story_advance DONE: exit ${done.status} ${done.status ? firstError(done) : 'ok'}`);
    assert.equal(done.status, 0, `D3: story_advance DONE refused:\n${done.out.slice(-3000)}`);
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`D3 fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

function printTimeline(steps: Step[], scenario: string): void {
  const rows = steps.filter(s => s.scenario === scenario);
  const total = rows.reduce((sum, s) => sum + s.ms, 0);
  console.log(`\nTimeline ${scenario} (${rows.length} CLI calls, ${(total / 1000).toFixed(1)} s inside the PoS CLI):`);
  console.log(`  ${'command'.padEnd(44)} ${'ms'.padStart(6)} exit  result | story metadata after`);
  for (const s of rows) {
    console.log(`  ${s.label.padEnd(44).slice(0, 44)} ${String(s.ms).padStart(6)} ${String(s.exit).padStart(4)}  ${s.result.replace(/\s+/g, ' ').slice(0, 88)} | ${s.dirty}`);
  }
}

/** NI/NQ: the request recorded at INIT. */
const NIQ_REQUEST = [
  'Implement the string helpers documented in docs/types/string.md:',
  '',
  '- `strs.Upper(s)` returns the upper-case form of `s`, for example `Upper("ab")` is `"AB"`.',
  '- `strs.Reverse(s)` returns `s` reversed by rune, for example `Reverse("héllo")` is `"olléh"`.',
].join('\n');

/** NI: the implementer declares a conflict between the request and CHK-001's pinned intent. */
const NI_CONFLICT_LINE = '[intent-conflict] CHK-001:happy:0 | request: "`strs.Upper(s)` returns the upper-case form of `s`" | request implies: Upper("ab") == "AB" | intent pins: Upper("ab") == "ab"';

function scenarioNI(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NI';
  const name = 'NI run 23: an implementer-declared [intent-conflict] blocks next until the owner revises the intent in PLAN';
  const o = new Owner(tag, 'B-e2c1', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[NI] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  try {
    devSetup(o, false);
    const launch = ask('next (DEV start)');
    assert.equal(launch.reason, 'implement_item', `[NI] first DEV step: ${launch.reason}: ${launch.why}`);
    const script = implementerScript(o.storyId, String(launch.cli!.payload.itemId));
    o.script(IMPLEMENTER, { ...script, final: `${script.final}\nNote on a deliberate choice: per the checklist intent Upper keeps its input.\n${NI_CONFLICT_LINE}` });
    const launched = o.mustCli(launch.cli!.command, launch.cli!.payload, { label: 'host_run implementer (conflict)' });
    const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
    const terminal = waitTerminal(o, 'implementer', runId);
    o.unscript(IMPLEMENTER);
    assert.equal(terminal.state, 'completed', `[NI] implementer terminal ${terminal.state} (${terminal.reason})\n${o.providerCommandLog()}`);
    assert.match(managedPrompts(o, IMPLEMENTER)[0]!.prompt, /\[intent-conflict\] none/, '[NI] the implementer prompt requires the [intent-conflict] section');
    // Old-PoS run 33: the probe matrix (runs 24-29 A) is the A/B arm implementation.probeMatrix=on (NPT covers it);
    // by default the prompt keeps one line and asks for no [probes] report.
    const niPrompt = managedPrompts(o, IMPLEMENTER)[0]!.prompt;
    assert.doesNotMatch(niPrompt, /Probe matrix before handoff/, '[NI] no probe matrix by default');
    assert.match(niPrompt, /No valid input form may crash or panic, and an explicit null\/nil operand is a different input from an omitted one/, '[NI] the one kept probe line');

    // D1: the declared conflict blocks the item before anything else.
    const blocked = ask('next (conflict declared)');
    assert.equal(blocked.reason, 'intent_conflict', `[NI] next must block on the declared intent conflict, got ${blocked.reason}: ${blocked.why}`);
    assert.equal(blocked.kind, 'agent', '[NI] the intent conflict is an owner step');
    assert.equal(blocked.cli?.command, 'story_advance', `[NI] the owner returns to PLAN to amend the frozen intent: ${blocked.command}`);
    assert.equal(blocked.cli?.payload.phase, 'PLAN', '[NI] story_advance PLAN');
    assert.match(blocked.why, /CHK-001:happy:0/, '[NI] the step names the conflicting intent');
    assert.match(blocked.why, /Upper\("ab"\) == "AB"/, '[NI] the step carries the value the request implies');
    o.mustCli('story_advance', blocked.cli!.payload, { label: 'story_advance PLAN (intent conflict)' });

    const amend = ask('next (PLAN, conflict open)');
    assert.equal(amend.reason, 'intent_conflict_amend', `[NI] in PLAN next must propose the intent revision, got ${amend.reason}: ${amend.why}`);
    assert.equal(amend.cli?.command, 'checklist_update', '[NI] the revision is a checklist_update');
    assert.equal(amend.cli?.payload.itemId, 'CHK-001', '[NI] the revision targets the conflicting item');
    assert.equal(amend.cli?.payload.status, 'pending', '[NI] the revised item is implemented again');
    assert.deepEqual([...(amend.placeholders ?? [])].sort(), ['reason', 'verificationIntent'], `[NI] the owner authors the revised intent and the reason: ${JSON.stringify(amend.placeholders)}`);
    const revised = JSON.parse(JSON.stringify(new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === 'CHK-001')!.verificationIntent)) as { happy: Array<{ desc: string }> };
    revised.happy[0]!.desc = 'TestUpper passes: Upper("ab") == "AB" as the request states';
    o.mustCli('checklist_update', { ...amend.cli!.payload, verificationIntent: revised, reason: 'The request says Upper returns the upper-case form; the pinned intent kept the input unchanged.' }, { label: 'checklist_update CHK-001 intent revision' });
    const afterAmend = ask('next (PLAN, conflict amended)');
    assert.doesNotMatch(afterAmend.reason, /^intent_conflict/, `[NI] the amended conflict must not block again: ${afterAmend.reason}: ${afterAmend.why}`);

    // PLAN re-approval is outside this harness: re-enter DEV as the fixture does.
    const store = new StoryStore(o.worktree);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'DEV' });
    const redo = ask('next (DEV, after revision)');
    assert.doesNotMatch(redo.reason, /^intent_conflict/, `[NI] DEV must not block on the amended conflict: ${redo.reason}`);
    assert.equal(redo.reason, 'checklist_item_start', `[NI] the revised item is implemented again: ${redo.reason}: ${redo.why}`);
    assert.equal(redo.cli?.payload.itemId, 'CHK-001', '[NI] the revised item restarts');
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NIU (old-PoS run 31, CHK-006): the conflict names userSees; the verificationIntent already stated the request value at dispatch. */
const NIU_STALE_USER_SEES = 'Upper("ab") == "ab"; go test -v ./strs -run TestUpper prints --- PASS: TestUpper';
const NIU_FIXED_USER_SEES = 'Upper("ab") == "AB"; go test -v ./strs -run TestUpper prints --- PASS: TestUpper';
const NIU_CONFLICT_LINE = '[intent-conflict] CHK-001 userSees | request: "`strs.Upper(s)` returns the upper-case form of `s`" | request implies: `Upper("ab") == "AB"` | intent pins: userSees says `"ab"`';

/** Commit the Story metadata the harness wrote directly (fixture setup, as the INIT_CHECK commit would carry it). */
function commitFixtureMetadata(o: Owner, message: string): void {
  git(o.worktree, ['add', '-A', '.proof-or-stop']);
  git(o.worktree, ['-c', 'user.name=Bench Owner', '-c', 'user.email=owner@bench.invalid', 'commit', '-qm', message]);
}

function scenarioNIU(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NIU';
  const name = 'NIU old-PoS run 31: a userSees [intent-conflict] clears once the owner amends userSees (the verificationIntent already stated the request value)';
  const o = new Owner(tag, 'B-e2ca', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[NIU] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  try {
    const store = new StoryStore(o.worktree);
    const cl = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => item.id === 'CHK-001' ? { ...item, userSees: NIU_STALE_USER_SEES } : item) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} CHK-001 userSees (stale pin)`);
    devSetup(o, false);
    const launch = ask('next (DEV start)');
    assert.equal(launch.reason, 'implement_item', `[NIU] first DEV step: ${launch.reason}: ${launch.why}`);
    const script = implementerScript(o.storyId, String(launch.cli!.payload.itemId));
    o.script(IMPLEMENTER, { ...script, final: `${script.final}\n${NIU_CONFLICT_LINE}` });
    const launched = o.mustCli(launch.cli!.command, launch.cli!.payload, { label: 'host_run implementer (userSees conflict)' });
    const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
    const terminal = waitTerminal(o, 'implementer', runId);
    o.unscript(IMPLEMENTER);
    assert.equal(terminal.state, 'completed', `[NIU] implementer terminal ${terminal.state} (${terminal.reason})\n${o.providerCommandLog()}`);
    const blocked = ask('next (userSees conflict declared)');
    assert.equal(blocked.reason, 'intent_conflict', `[NIU] next must block on the declared conflict: ${blocked.reason}: ${blocked.why}`);
    o.mustCli('story_advance', blocked.cli!.payload, { label: 'story_advance PLAN (userSees conflict)' });
    const amend = ask('next (PLAN, userSees conflict open)');
    assert.equal(amend.reason, 'intent_conflict_amend', `[NIU] in PLAN next proposes the amendment: ${amend.reason}: ${amend.why}`);
    // Run 31 step 118: the owner fixes userSees only; the verificationIntent already says "AB".
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', userSees: NIU_FIXED_USER_SEES, status: 'pending',
      reason: 'The request says Upper returns the upper-case form, so userSees states Upper("ab") == "AB".' }, { label: 'checklist_update CHK-001 userSees amended' });
    const after = ask('next (PLAN, userSees amended)');
    assert.doesNotMatch(after.reason, /^intent_conflict/, `[NIU] the amended userSees conflict must not block again (run 31 dead end): ${after.reason}: ${after.why}`);
    assert.ok('userSees' in (amend.cli?.payload ?? {}), `[NIU] a userSees conflict is amended in userSees: ${JSON.stringify(amend.cli?.payload)}`);
    assert.ok((amend.placeholders ?? []).includes('userSees'), `[NIU] userSees is the placeholder the owner authors: ${JSON.stringify(amend.placeholders)}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

function scenarioNAR(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NAR';
  const name = 'NAR old-PoS run 31: a PLAN intent amendment of a done item resets it (and the items whose intent names it) to pending with a recorded reason';
  const o = new Owner(tag, 'B-e2cb', machineEnv, steps, false, { trackedGateFailureCounts: true, unicodeOutput: true });
  const lines: string[] = [];
  try {
    const store = new StoryStore(o.worktree);
    const cl = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => item.id === 'CHK-002'
      ? { ...item, context: 'strs.Reverse does not exist; it reuses the rune handling CHK-001 settles.' } : item) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} CHK-002 context names CHK-001`);
    devSetup(o);
    const before = new StoryStore(o.worktree).readChecklist(o.storyId).items;
    assert.ok(before.every(item => item.status === 'done'), `[NAR] every item done before the amendment: ${before.map(item => `${item.id}=${item.status}`).join(' ')}`);
    o.mustCli('story_advance', { storyId: o.storyId, phase: 'PLAN' }, { label: 'story_advance PLAN (amendment)' });
    const revised = JSON.parse(JSON.stringify(before.find(item => item.id === 'CHK-001')!.verificationIntent)) as { happy: Array<{ desc: string }> };
    revised.happy[0]!.desc = 'TestUpper passes: Upper("ab") == "AB" as the request states';
    // Run 31 step 109: the owner amends the done item's intent without a status.
    const updated = o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', verificationIntent: revised,
      reason: 'The request says Upper returns the upper-case form; the intent now pins Upper("ab") == "AB".' }, { label: 'checklist_update CHK-001 intent amendment (no status)' });
    lines.push(updated.out.split('\n').filter(line => /pending/.test(line)).slice(0, 3).join(' | '));
    const after = new StoryStore(o.worktree).readChecklist(o.storyId);
    const status = (id: string) => after.items.find(item => item.id === id)?.status;
    assert.equal(status('CHK-001'), 'pending', '[NAR] the amended done item goes back to pending without a hand reset (run 31 step 110)');
    assert.equal(status('CHK-002'), 'pending', '[NAR] an item whose context names the amended item is reset too');
    for (const [id] of UNICODE_EXTRA_ITEMS) assert.equal(status(id), 'done', `[NAR] ${id} does not depend on CHK-001 and stays done`);
    const audit = (after.auditLog ?? []).filter(entry => entry.to === 'pending' && entry.from === 'done');
    assert.ok(audit.some(entry => entry.itemId === 'CHK-001' && /amend/i.test(entry.reason ?? '')), `[NAR] the reset is recorded with its reason: ${JSON.stringify(audit)}`);
    assert.ok(audit.some(entry => entry.itemId === 'CHK-002' && /CHK-001/.test(entry.reason ?? '')), `[NAR] the dependent reset names the amended item: ${JSON.stringify(audit)}`);
    assert.match(updated.out, /CHK-001[^\n]*pending/, '[NAR] the command output says the item went back to pending');
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NPO (old-PoS run 31): the project's own evaluator, declared as the pin oracle.
 * Base strs.Upper returns its input unchanged and strs.Reverse does not exist.
 */
const NPO_EVAL = [
  "const src = require('fs').readFileSync(process.argv[2], 'utf8').trim();",
  'const call = src.match(/^Upper\\((".*")\\)$/);',
  "if (!call) { console.error('undefined: ' + src); process.exit(1); }",
  '// The project base: Upper returns s unchanged.',
  'console.log(JSON.stringify(JSON.parse(call[1])));',
  '',
].join('\n');
const NPO_ORACLE = { command: 'node', args: ['tools/strs-eval.js', '{file}'], program: '{input}', extension: '.txt' };

function scenarioNPO(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NPO';
  const name = 'NPO old-PoS run 31: the pin oracle (project evaluator at the Story base) refuses a pinned example the base computes differently, at checklist_update and before the scope-plan reviewer';
  const o = new Owner(tag, 'B-e2cc', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST,
    config: { pinOracle: NPO_ORACLE }, baseFiles: { 'tools/strs-eval.js': NPO_EVAL } });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[NPO] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  const row = (desc: string, test: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass',
    requirementSource: 'story', verification: { command: `go test -v ./strs -run ^${test}$`, selector: `--- PASS: ${test}` }, ...extra });
  const upperIntent = (happy: Record<string, unknown>, edge: Record<string, unknown>) => ({ happy: [happy], edge: [edge],
    adversarial: [row('Reverse("héllo") -> "olléh"', 'TestReverse')] });
  try {
    const store = new StoryStore(o.worktree);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'PLAN' });
    const legacy = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...legacy, items: legacy.items.map(item => ({ ...item, status: 'pending', startTime: null })) } as never);
    o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });

    // (a) existing behaviour: base Upper("AB") is "AB"; the row pins "ab". The changed row Upper("ab") -> "AB"
    // differs from the base ("ab") too. Reverse is new (the base cannot run it): skipped silently.
    const refused = o.cli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001',
      verificationIntent: upperIntent(row('Upper("ab") -> "AB"', 'TestUpper'), row('Upper("AB") -> "ab"', 'TestUpperKeeps')) }, { label: 'checklist_update CHK-001 (wrong existing-behaviour pin)' });
    assert.notEqual(refused.status, 0, '[NPO] checklist_update must refuse the pin the base computes differently');
    assert.match(refused.out, /\[pin_oracle_mismatch\]/, `[NPO] the refusal names the rule:\n${refused.out.slice(-1500)}`);
    assert.match(refused.out, /CHK-001:edge:0[^\n]*"AB"/, '[NPO] the refusal carries the computed base value of the wrong pin');
    assert.match(refused.out, /CHK-001:happy:0[^\n]*"ab"/, '[NPO] the changed row is listed with its base value');
    assert.doesNotMatch(refused.out, /CHK-001:adversarial:0/, '[NPO] a row the base cannot evaluate (new function) is skipped');
    assert.match(refused.out, /Next: proof-or-stop checklist_update/, '[NPO] the refusal carries one checklist_update');
    // Correct the wrong pin; acknowledge the deliberate change with the base value.
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001',
      verificationIntent: upperIntent(row('Upper("ab") -> "AB"', 'TestUpper', { baseValue: '"ab"' }), row('Upper("AB") -> "AB"', 'TestUpperKeeps')) }, { label: 'checklist_update CHK-001 (pin fixed, change acknowledged)' });

    // A row stored before the oracle check (legacy write): next blocks before the scope-plan reviewer.
    const stored = new StoryStore(o.worktree);
    const cl = stored.readChecklist(o.storyId);
    stored.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => item.id === 'CHK-002'
      ? { ...item, verificationIntent: { happy: [row('Reverse("héllo") -> "olléh"', 'TestReverse')], edge: [row('Upper("x") -> "y"', 'TestUpperX')], adversarial: [row('Reverse("") -> ""', 'TestReverseEmpty')] } } : item) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} legacy CHK-002 pin`);
    const blocked = ask('next (PLAN, stored mismatching pin)');
    assert.equal(blocked.reason, 'pin_oracle_mismatch', `[NPO] next blocks on the stored mismatch before the scope-plan reviewer: ${blocked.reason}: ${blocked.why}`);
    assert.equal(blocked.cli?.command, 'checklist_update', '[NPO] one checklist_update');
    assert.equal(blocked.cli?.payload.itemId, 'CHK-002', '[NPO] the step names the item');
    assert.match(blocked.why, /CHK-002:edge:0[^\n]*"x"/, '[NPO] the step carries the computed base value');
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', verificationIntent: { happy: [row('Reverse("héllo") -> "olléh"', 'TestReverse')],
      edge: [row('Upper("x") -> "X"', 'TestUpperX', { baseValue: '"x"', derivation: { requestQuote: NP_QUOTE, computation: 'the upper-case form of "x" is "X"' } })], adversarial: [row('Reverse("") -> ""', 'TestReverseEmpty')] } }, { label: 'checklist_update CHK-002 (acknowledged)' });
    const after = ask('next (PLAN, pins consistent with the oracle)');
    assert.notEqual(after.reason, 'pin_oracle_mismatch', `[NPO] no mismatch remains: ${after.why}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NPT: the first implementer run probed a row its change decided but did not test it. */
const NPT_UNTESTED = '[probes] 4 rows run on base and change; changed: Upper("") base "" -> ""; tested: Upper("ab") -> "AB"; probed-only: Upper("ß") -> "SS" (multibyte); crashes: none';
const NPT_TESTED = '[probes] 4 rows run on base and change; changed: Upper("") base "" -> ""; tested: Upper("ab") -> "AB", Upper("ß") -> "SS" (multibyte); probed-only: none; crashes: none';

function scenarioNPT(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NPT';
  const name = 'NPT old-PoS run 30: a probed-only decided row in the implementer [probes] line reopens the item once (one owner step), the relaunch prompt names the rows';
  // Old-PoS run 33: the implementer probe-matrix contract is the A/B arm implementation.probeMatrix=on (default off).
  const o = new Owner(tag, 'B-e2c9', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST,
    config: { implementation: { probeMatrix: 'on' } } });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[NPT] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  const runImplementer = (launch: NextStepJson, script: ProviderScript, label: string): string => {
    o.script(IMPLEMENTER, script);
    const launched = o.mustCli(launch.cli!.command, launch.cli!.payload, { label });
    const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
    const terminal = waitTerminal(o, 'implementer', runId);
    o.unscript(IMPLEMENTER);
    assert.equal(terminal.state, 'completed', `[NPT] ${label} terminal ${terminal.state} (${terminal.reason})\n${o.providerCommandLog()}`);
    return runId;
  };
  try {
    devSetup(o, false);
    const launch = ask('next (DEV start)');
    assert.equal(launch.reason, 'implement_item', `[NPT] first DEV step: ${launch.reason}: ${launch.why}`);
    const itemId = String(launch.cli!.payload.itemId);
    const first = implementerScript(o.storyId, itemId);
    const firstRun = runImplementer(launch, { ...first, final: `${first.final}\n[intent-conflict] none\n${NPT_UNTESTED}` }, 'host_run implementer (probed-only row)');
    const prompt = managedPrompts(o, IMPLEMENTER)[0]!.prompt;
    assert.match(prompt, /explicit value equal to the default/, '[NPT] the probe matrix names the explicit-default class');
    assert.match(prompt, /\[probes\][^\n]*probed-only: /, '[NPT] the [probes] line separates probed-only rows');

    const reopen = ask('next (probed-only row)');
    assert.equal(reopen.reason, 'probe_tests_missing', `[NPT] next must reopen the item for the untested decided row, got ${reopen.reason}: ${reopen.why}`);
    assert.equal(reopen.kind, 'agent', '[NPT] one owner step');
    assert.equal(reopen.cli?.command, 'checklist_update', `[NPT] the step reopens the item: ${reopen.command}`);
    assert.equal(reopen.cli?.payload.itemId, itemId, '[NPT] the step names the item');
    assert.equal(reopen.cli?.payload.status, 'in_progress', '[NPT] the item goes back to in_progress');
    assert.match(reopen.why, /Upper\("ß"\) -> "SS"/, '[NPT] the step lists the probed-only row');
    assert.ok(reopen.why.includes(firstRun), '[NPT] the step names the run');
    assert.deepEqual(reopen.placeholders ?? [], [], '[NPT] the step is exact (no placeholder)');
    o.mustCli(reopen.cli!.command, reopen.cli!.payload, { label: 'checklist_update reopen (probed-only row)' });

    const relaunch = ask('next (reopened)');
    assert.equal(relaunch.reason, 'implement_item', `[NPT] the reopened item is implemented again: ${relaunch.reason}: ${relaunch.why}`);
    assert.equal(relaunch.cli?.payload.itemId, itemId, '[NPT] the relaunch is bound to the same item');
    const addTest = `const fs=require('fs');fs.appendFileSync('strs/strs_test.go','\\n// Upper multibyte row tested\\n');`;
    runImplementer(relaunch, { commands: [
      [process.execPath, '-e', addTest],
      ['/bin/sh', '-c', `git add strs && git -c user.name=${IMPLEMENTER} commit -qm '${o.storyId} ${itemId}: test the probed-only row' && git log --format=%h -1`],
      [process.execPath, CLI, 'checklist_update', JSON.stringify({ storyId: o.storyId, itemId, status: 'done' })],
    ], final: `Completed ${itemId}: tested the probed-only row.\n[intent-conflict] none\n${NPT_TESTED}` }, 'host_run implementer (relaunch)');
    const second = managedPrompts(o, IMPLEMENTER).at(-1)!.prompt;
    assert.ok(second.includes(firstRun), '[NPT] the relaunch prompt names the earlier run');
    assert.match(second, /Upper\("ß"\) -> "SS"/, '[NPT] the relaunch prompt lists the probed-only row');
    const after = ask('next (rows tested)');
    assert.notEqual(after.reason, 'probe_tests_missing', `[NPT] the tested rows leave no step: ${after.reason}: ${after.why}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NRP / NRQ (old-PoS run 31 F-006): a probe row whose observed output
 * contradicts the request sentence that defines it blocks handoff to REVIEW,
 * although the (owner-pinned, wrong) expected value agrees with the code.
 * NRP: the project declares a probeRunner (the framework runs the rows);
 * NRQ: no runner, the implementer's [probe-row] report says contradiction.
 */
const NRP_REQUEST = [
  'Add stepped slices to the strs mini language:',
  '',
  '- `value[start:end:step]`, with omitted components `value[:end:step]` and `value[::step]`.',
  '',
  '## Runtime support',
  '',
  '- A non-numeric `start` in array slices must keep the existing index-operator error format:',
  '  - `index operator not supported: <inspect> on ARRAY`',
].join('\n');
const NRP_SENTENCE = 'A non-numeric `start` in array slices must keep the existing index-operator error format:';
/** The project's own evaluator (base file): explicit null start errors unless strs.go says `null-start: omit`. */
const NRP_EVAL = [
  "const fs = require('fs'); const path = require('path');",
  "const mode = fs.readFileSync(path.join(__dirname, '..', 'strs', 'strs.go'), 'utf8').includes('null-start: omit') ? 'omit' : 'error';",
  "const vars = {}; const lit = t => JSON.parse(t.replace(/'/g, '\"'));",
  'const fail = m => { console.log(m); process.exit(99); };',
  "const show = v => Array.isArray(v) ? '[' + v.map(x => String(x)).join(', ') + ']' : String(v);",
  'function val(e) {',
  '  const m = e.match(/^([A-Za-z_]\\w*)\\[(.*)\\]$/); if (!m) return lit(e);',
  "  if (!(m[1] in vars)) fail('identifier not found: ' + m[1]);",
  "  const v = vars[m[1]]; const p = m[2].split(':').map(x => x.trim());",
  "  const num = x => { if (x === '') return null; if (x === 'null') { if (mode === 'omit') return null; fail('index operator not supported: null on ARRAY'); } return Number(x); };",
  "  const s = num(p[0]), e2 = num(p[1]), st = p.length > 2 ? (num(p[2]) ?? 1) : 1;",
  '  const out = []; for (let i = s ?? 0; i < (e2 ?? v.length) && i < v.length; i += st) out.push(v[i]); return out;',
  '}',
  "for (const line of fs.readFileSync(process.argv[2], 'utf8').split('\\n').map(l => l.trim()).filter(Boolean)) {",
  '  const a = line.match(/^([A-Za-z_]\\w*)\\s*=(?!=)\\s*(.+)$/); if (a) { vars[a[1]] = lit(a[2]); continue; }',
  '  const e = line.match(/^echo\\((.*)\\)$/); if (e) { console.log(show(val(e[1]))); continue; }',
  "  fail('parse error: ' + line);",
  '}', '',
].join('\n');
const NRP_RUNNER = { command: process.execPath, args: ['tools/strs-mini.js', '{file}'], program: 'echo({input})', extension: '.mini', selfTest: { input: '[1, 2]', output: '[1, 2]' } };
/** Run 31 at DEV start: the owner pinned explicit null start as omitted (the request says error). */
const NRP_ROW = 'explicit null start a[null:4:2] over [0,1,2,3,4,5] -> [0, 2]';
const NRP_CONFLICT = `[intent-conflict] CHK-001:edge:0 | request: "${NRP_SENTENCE}" | request implies: error index operator not supported: null on ARRAY | intent pins: [0, 2]`;

function nrpFixture(o: Owner): void {
  const store = new StoryStore(o.worktree);
  const cl = store.readChecklist(o.storyId);
  store.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => item.id === 'CHK-001' ? { ...item, verificationIntent: { ...item.verificationIntent!,
    edge: [{ id: 'CHK-001:edge:0', desc: NRP_ROW, type: 'logic' as const, priority: 'must' as const, scope: 'focused' as const, expectation: 'absolute_pass' as const, requirementSource: 'story' as const }] } } : item) } as never);
  commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} CHK-001 null-start probe row`);
  devSetup(o, false);
}

/** The implementer writes Upper/Reverse; `nullStart` marks the evaluator semantics its change has. */
function nrpImplementerCommands(storyId: string, itemId: string, nullStart: 'omit' | 'error', message: string): string[][] {
  const writeFiles = `const fs=require('fs');fs.writeFileSync('strs/strs.go',${JSON.stringify(IMPL)}+${JSON.stringify(nullStart === 'omit' ? '\n// null-start: omit\n' : '\n// null-start: error\n')});fs.writeFileSync('strs/strs_test.go',${JSON.stringify(TESTS)});`;
  return [
    [process.execPath, '-e', writeFiles],
    ['/bin/sh', '-c', `git add strs && git -c user.name=${IMPLEMENTER} commit -qm '${storyId} ${itemId}: ${message}' && git log --format=%h -1`],
    [process.execPath, CLI, 'checklist_update', JSON.stringify({ storyId, itemId, status: 'done' })],
  ];
}

function scenarioNRP(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NRP';
  const name = 'NRP old-PoS run 31 F-006: a framework-run probe row contradicting its request sentence refuses done once, then blocks handoff (reopen, relaunch names the row, intent conflict)';
  // Old-PoS run 33: the probe gate is the A/B arm dev.probeEnforcement=enforce (default advisory).
  const o = new Owner(tag, 'B-e2cd', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NRP_REQUEST,
    config: { probeRunner: NRP_RUNNER, dev: { probeEnforcement: 'enforce' } }, baseFiles: { 'tools/strs-mini.js': NRP_EVAL } });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[NRP] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  const runImplementer = (launch: NextStepJson, script: ProviderScript, label: string): string => {
    o.script(IMPLEMENTER, script);
    const launched = o.mustCli(launch.cli!.command, launch.cli!.payload, { label });
    const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
    const terminal = waitTerminal(o, 'implementer', runId);
    o.unscript(IMPLEMENTER);
    assert.equal(terminal.state, 'completed', `[NRP] ${label} terminal ${terminal.state} (${terminal.reason})\n${o.providerCommandLog()}`);
    return runId;
  };
  const doneCalls = (): Array<{ status: number; out: string }> => readFileSync(join(o.scriptsDir, 'commands.log'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { argv: string[]; status: number; out: string }).filter(row => row.argv[0] === 'checklist_update');
  try {
    nrpFixture(o);
    const launch = ask('next (DEV start)');
    assert.equal(launch.reason, 'implement_item', `[NRP] first DEV step: ${launch.reason}: ${launch.why}`);
    const itemId = String(launch.cli!.payload.itemId);
    assert.equal(itemId, 'CHK-001');
    // The implementer follows the pin (null start = omitted) and calls done twice (the second after the refusal).
    const first = nrpImplementerCommands(o.storyId, itemId, 'omit', 'implement (null start as omitted)');
    runImplementer(launch, { commands: [...first, first.at(-1)!], final: `Implemented ${itemId}.\n[intent-conflict] none` }, 'host_run implementer (pin followed)');
    const prompt = managedPrompts(o, IMPLEMENTER)[0]!.prompt;
    assert.match(prompt, /Framework probes \(project probeRunner/, '[NRP] the prompt carries the framework probe contract');
    assert.doesNotMatch(prompt, /Probe matrix before handoff/, '[NRP] no hand-written probe matrix when the framework runs the probes');
    assert.match(prompt, /CHK-001:edge:0: [^\n]*CONTRADICTS: pins the value \[0, 2\]/, '[NRP] the contradicting pin is named before coding');
    const calls = doneCalls();
    assert.equal(calls.length, 2, `[NRP] two done calls: ${JSON.stringify(calls)}`);
    assert.notEqual(calls[0]!.status, 0, '[NRP] the first done is refused');
    assert.match(calls[0]!.out, /\[probe_request_mismatch\][\s\S]*CHK-001:edge:0: [^\n]*HEAD \[0, 2\][^\n]*FLAG: the request sentence gives this input an error/, `[NRP] the refusal lists the row:\n${calls[0]!.out}`);
    assert.equal(calls[1]!.status, 0, `[NRP] the same flagged set is refused once:\n${calls[1]!.out}`);
    assert.equal(new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === itemId)?.status, 'done');

    const reopen = ask('next (row contradicts the request)');
    assert.equal(reopen.reason, 'probe_request_mismatch', `[NRP] handoff blocked: next reopens the item, got ${reopen.reason}: ${reopen.why}`);
    assert.equal(reopen.cli?.command, 'checklist_update');
    assert.equal(reopen.cli?.payload.status, 'in_progress');
    assert.match(reopen.why, new RegExp(`CHK-001:edge:0[^\\n]*${NRP_SENTENCE.slice(0, 30).replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')}`), '[NRP] the step pairs the row with its request sentence');
    o.mustCli(reopen.cli!.command, reopen.cli!.payload, { label: 'checklist_update reopen (probe row)' });
    const relaunch = ask('next (reopened)');
    assert.equal(relaunch.reason, 'implement_item', `[NRP] relaunch: ${relaunch.reason}: ${relaunch.why}`);
    // The relaunch implements the request (null start errors) and declares the wrong pin.
    runImplementer(relaunch, { commands: nrpImplementerCommands(o.storyId, itemId, 'error', 'explicit null start errors as the request says'),
      final: `Fixed ${itemId}: explicit null start errors.\n${NRP_CONFLICT}` }, 'host_run implementer (relaunch)');
    const second = managedPrompts(o, IMPLEMENTER).at(-1)!.prompt;
    assert.match(second, /framework probe run flagged rows of this item[\s\S]*CHK-001:edge:0/, '[NRP] the relaunch prompt names the flagged row');
    assert.equal(doneCalls().at(-1)!.status, 0, '[NRP] HEAD follows the request (pin wrong): done is not refused');
    const blocked = ask('next (pin declared wrong)');
    assert.equal(blocked.reason, 'intent_conflict', `[NRP] the wrong pin goes to the owner: ${blocked.reason}: ${blocked.why}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

function scenarioNRQ(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NRQ';
  const name = 'NRQ old-PoS run 31 F-006 (no probe runner): the prompt pairs each row with its request sentence; a [probe-row] contradiction neither fixed nor declared blocks handoff';
  // Old-PoS run 33: report mode is the A/B arms implementation.probeMatrix=on + dev.probeEnforcement=enforce.
  const o = new Owner(tag, 'B-e2ce', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NRP_REQUEST,
    config: { implementation: { probeMatrix: 'on' }, dev: { probeEnforcement: 'enforce' } } });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[NRQ] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  try {
    nrpFixture(o);
    const launch = ask('next (DEV start)');
    assert.equal(launch.reason, 'implement_item', `[NRQ] first DEV step: ${launch.reason}: ${launch.why}`);
    const itemId = String(launch.cli!.payload.itemId);
    o.script(IMPLEMENTER, { commands: nrpImplementerCommands(o.storyId, itemId, 'omit', 'implement'),
      final: `Implemented ${itemId}.\n[intent-conflict] none\n[probe-row] CHK-001:edge:0 | request: error index operator not supported: null on ARRAY | observed: [0, 2] | contradiction` });
    const launched = o.mustCli(launch.cli!.command, launch.cli!.payload, { label: 'host_run implementer (contradiction reported)' });
    const terminal = waitTerminal(o, 'implementer', String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId));
    o.unscript(IMPLEMENTER);
    assert.equal(terminal.state, 'completed', `[NRQ] implementer terminal ${terminal.state} (${terminal.reason})`);
    const prompt = managedPrompts(o, IMPLEMENTER)[0]!.prompt;
    assert.match(prompt, /Probe matrix before handoff/, '[NRQ] without a runner the probe matrix stays');
    assert.match(prompt, /S1: "A non-numeric `start` in array slices/, '[NRQ] the defining request sentence is in the prompt');
    assert.match(prompt, /CHK-001:edge:0: a=\[0,1,2,3,4,5\]; a\[null:4:2\] -> \[0, 2\] \| S1 \(request expects an error[^\n]*PIN CONTRADICTS REQUEST/, '[NRQ] the row is paired with its sentence and marked');
    assert.match(prompt, /\[probe-row\] <row> \| request: <expected per the sentence> \| observed: <HEAD output> \| ok\|contradiction/, '[NRQ] the per-row report contract');
    const reopen = ask('next ([probe-row] contradiction)');
    assert.equal(reopen.reason, 'probe_request_mismatch', `[NRQ] handoff blocked: ${reopen.reason}: ${reopen.why}`);
    assert.equal(reopen.cli?.payload.status, 'in_progress');
    assert.match(reopen.why, /CHK-001:edge:0[^\n]*contradiction/);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NXT (old-PoS run 32 F-001, run 30 F-001): the request says error strings must
 * match exactly; the Story's added test compares one only through a project
 * helper wrapping strings.HasPrefix. When every item is done, next reopens one
 * item (one owner step) before REVIEW, the relaunch prompt names the helper,
 * and an exact assertion clears it.
 */
const NXT_LITERAL = 'strs: empty input not allowed for Upper';
const NXT_REQUEST = [
  ...NIQ_REQUEST.split('\n'),
  '- Error strings must match exactly:',
  '  - `strs: empty input not allowed for <fn>`',
].join('\n');
const NXT_PREFIX_TEST = [
  'package strs', '', 'import (', '\t"strings"', '\t"testing"', ')', '',
  'func assertErrPrefix(t *testing.T, got, want string) {', '\tif !strings.HasPrefix(got, want) {', '\t\tt.Fatalf("got %q want prefix %q", got, want)', '\t}', '}', '',
  'func TestEmptyInputError(t *testing.T) {', `\tassertErrPrefix(t, "${NXT_LITERAL}", "${NXT_LITERAL}")`, '}', '',
].join('\n');
const NXT_EXACT_TEST = [
  'package strs', '', 'import "testing"', '',
  'func TestEmptyInputErrorExact(t *testing.T) {', `\tif got := "${NXT_LITERAL}"; got != "${NXT_LITERAL}" {`, '\t\tt.Fatal(got)', '\t}', '}', '',
].join('\n');

function scenarioNXT(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NXT';
  const name = 'NXT old-PoS run 32 F-001: a request-quoted exact string the added tests compare only through a prefix helper reopens one item before REVIEW; an exact assertion clears it';
  const o = new Owner(tag, 'B-e2d1', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NXT_REQUEST });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[NXT] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  const runImplementer = (launch: NextStepJson, script: ProviderScript, label: string): void => {
    o.script(IMPLEMENTER, script);
    const launched = o.mustCli(launch.cli!.command, launch.cli!.payload, { label });
    const terminal = waitTerminal(o, 'implementer', String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId));
    o.unscript(IMPLEMENTER);
    assert.equal(terminal.state, 'completed', `[NXT] ${label} terminal ${terminal.state} (${terminal.reason})\n${o.providerCommandLog()}`);
  };
  const writeAndCommit = (file: string, text: string, itemId: string, message: string): string[][] => [
    [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(file)},${JSON.stringify(text)});`],
    ['/bin/sh', '-c', `git add strs && git -c user.name=${IMPLEMENTER} commit -qm '${o.storyId} ${itemId}: ${message}' && git log --format=%h -1`],
    [process.execPath, CLI, 'checklist_update', JSON.stringify({ storyId: o.storyId, itemId, status: 'done' })],
  ];
  try {
    devSetup(o, false);
    const first = ask('next (DEV start)');
    assert.equal(first.reason, 'implement_item', `[NXT] first DEV step: ${first.reason}: ${first.why}`);
    const firstItem = String(first.cli!.payload.itemId);
    const script = implementerScript(o.storyId, firstItem);
    runImplementer(first, { ...script, final: `${script.final}\n[intent-conflict] none` }, 'host_run implementer (first item)');
    let second = ask('next (second item)');
    if (second.reason === 'checklist_item_start') { o.mustCli(second.cli!.command, second.cli!.payload, { label: 'checklist_update start second item' }); second = ask('next (second item started)'); }
    assert.equal(second.reason, 'implement_item', `[NXT] second item: ${second.reason}: ${second.why}`);
    const secondItem = String(second.cli!.payload.itemId);
    runImplementer(second, { commands: writeAndCommit('strs/errors_test.go', NXT_PREFIX_TEST, secondItem, 'error text test'),
      final: `Tested the error text of ${secondItem}.\n[intent-conflict] none` }, 'host_run implementer (prefix-helper test)');
    const prompt = managedPrompts(o, IMPLEMENTER).at(-1)!.prompt;
    assert.match(prompt, /full-string equality/, '[NXT] the implementer prompt asks for exact comparisons');

    const reopen = ask('next (every item done)');
    assert.equal(reopen.reason, 'exact_text_prefix_assertion', `[NXT] next reopens before REVIEW: ${reopen.reason}: ${reopen.why}`);
    // Old-PoS run 40 (N1): the reopen is a framework step; `next --run` runs it and relaunches the implementer.
    assert.equal(reopen.kind, 'framework', `[NXT] the reopen is a framework step, not an owner hand action: ${reopen.kind}`);
    assert.equal(reopen.cli?.payload.status, 'in_progress');
    assert.match(reopen.why, /strs: empty input not allowed for[^\n]*errors_test\.go:\d+\) in TestEmptyInputError[^\n]*assertErrPrefix/, `[NXT] the step names the row, the test and the helper: ${reopen.why}`);
    const itemId = String(reopen.cli!.payload.itemId);
    const launchedBefore = managedPrompts(o, IMPLEMENTER).length;
    o.script(IMPLEMENTER, { commands: writeAndCommit('strs/errors_exact_test.go', NXT_EXACT_TEST, itemId, 'exact error text test'),
      final: `Asserted the error text exactly.\n[intent-conflict] none` });
    const ran = o.cli('next', { storyId: o.storyId, run: true, json: true, maxSteps: 2 }, { label: 'next --run (exact-text reopen + relaunch)' });
    const ranJson = parseJson(ran.stdout);
    const executed = ((ranJson?.executed ?? []) as Array<{ reason: string; exit: number; tail: string }>);
    lines.push(`next --run ran: ${executed.map(row => `${row.reason}:${row.exit}`).join(' > ')}`);
    assert.deepEqual(executed.map(row => row.reason), ['exact_text_prefix_assertion', 'implement_item'], `[NXT] next --run reopens the item and relaunches its implementer itself:\n${ran.out.slice(-2000)}`);
    assert.ok(executed.every(row => row.exit === 0), `[NXT] both framework steps pass their gates: ${JSON.stringify(executed)}`);
    const relaunched = managedPrompts(o, IMPLEMENTER);
    assert.equal(relaunched.length, launchedBefore + 1, '[NXT] exactly one implementer relaunch');
    assert.equal(relaunched.at(-1)!.target?.itemId, itemId, '[NXT] the relaunch is bound to the reopened item');
    const relaunchTerminal = waitTerminal(o, 'implementer (exact relaunch)', relaunched.at(-1)!.runId);
    o.unscript(IMPLEMENTER);
    assert.equal(relaunchTerminal.state, 'completed', `[NXT] relaunch terminal ${relaunchTerminal.state} (${relaunchTerminal.reason})`);
    const again = managedPrompts(o, IMPLEMENTER).at(-1)!.prompt;
    assert.match(again, /Reopened before REVIEW: [\s\S]*assertErrPrefix/, '[NXT] the relaunch prompt names the helper');
    const after = ask('next (exact assertion added)');
    assert.notEqual(after.reason, 'exact_text_prefix_assertion', `[NXT] the exact assertion clears the gap: ${after.why}`);
    assert.notEqual(after.kind, 'human', `[NXT] no dead end: ${after.reason}: ${after.why}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

function scenarioNQ(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NQ';
  const name = 'NQ run 23/24: lanes get the request + rubric, the critic the no-limitation rule, the repair the variant rule; DONE';
  const o = new Owner(tag, 'B-e2c2', machineEnv, steps, false, { trackedGateFailureCounts: true, request: NIQ_REQUEST });
  const lines: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false }, lines);
    const lanes = managedPrompts(o).filter(row => row.agentType.startsWith('proof-or-stop-review-') && row.agentType !== DELIVERY && row.agentType !== MANAGED_INVENTORY_CRITIC_LANE);
    assert.ok(lanes.length >= 4, `[NQ] lane prompts captured (${lanes.length})`);
    for (const row of lanes) {
      assert.ok(row.prompt.includes('`strs.Reverse(s)` returns `s` reversed by rune'), `[NQ] ${row.agentType} ${row.runId}: lane prompt carries the verbatim request`);
      assert.match(row.prompt, /Request authority rubric/, `[NQ] ${row.agentType} ${row.runId}: lane prompt carries the rubric`);
    }
    const critics = managedPrompts(o, MANAGED_INVENTORY_CRITIC_LANE);
    assert.ok(critics.length >= 1, '[NQ] critic prompt captured');
    for (const row of critics) {
      assert.match(row.prompt, /Critic request rule: a divergence between the implementation, a pinned intent or a test and a request sentence is a finding/, `[NQ] critic ${row.runId}: no-limitation rule`);
      assert.match(row.prompt, /show both computed outputs/, `[NQ] critic ${row.runId}: both outputs rule`);
      assert.ok(row.prompt.includes('`strs.Upper(s)` returns the upper-case form'), `[NQ] critic ${row.runId}: the critic gets the verbatim request`);
    }
    const repairs = managedPrompts(o, FINDING_REPAIR);
    assert.ok(repairs.length >= 1, '[NQ] repair prompt captured');
    for (const row of repairs) {
      assert.match(row.prompt, /\[intent-conflict\] none/, `[NQ] repair ${row.runId}: [intent-conflict] section`);
      assert.match(row.prompt, /Input variants \(keep base behavior\)/, `[NQ] repair ${row.runId}: base-behavior variant rule`);
    }
    lines.push(`lane prompts with request+rubric: ${lanes.length}; critic prompts: ${critics.length}; repair prompts: ${repairs.length}`);
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NP: CHK-001 pins a wrong lower-case output for an input the request never quotes. */
const NP_WRONG_PIN = 'Upper("xy") -> "xy"';
const NP_QUOTE = '`strs.Upper(s)` returns the upper-case form of `s`';

function scenarioNP(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NP';
  const name = 'NP run 23 at the source: PLAN refuses an underived pin and the scope-plan pin audit blocks a wrong one before DEV';
  const o = new Owner(tag, 'B-e2c3', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[NP] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  const row = (desc: string, test: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass',
    requirementSource: 'story', verification: { command: `go test -v ./strs -run ^${test}$`, selector: `--- PASS: ${test}` }, ...extra });
  const intents = (pin: Record<string, unknown>) => ({
    'CHK-001': { happy: [row('strs.Upper(s): Upper("ab") -> "AB"', 'TestUpper'), pin], edge: [row('Upper("") -> ""', 'TestUpperEmpty')], adversarial: [row('Upper leaves digits and symbols unchanged', 'TestUpperSymbols')] },
    'CHK-002': { happy: [row('strs.Reverse(s): Reverse("héllo") -> "olléh"', 'TestReverse')], edge: [row('Reverse("") -> ""', 'TestReverseEmpty')], adversarial: [row('Reverse of a one-rune string is that string', 'TestReverseOne')] },
  });
  try {
    // INIT_CHECK -> PLAN: the owner's INIT intent pins a wrong value, stored before the derivation rule (no derivation).
    const store = new StoryStore(o.worktree);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'PLAN' });
    const legacy = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...legacy, items: legacy.items.map(item => ({ ...item, status: 'pending', startTime: null,
      verificationIntent: item.id === 'CHK-001'
        ? { ...item.verificationIntent!, happy: [...item.verificationIntent!.happy, { desc: NP_WRONG_PIN, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }] }
        : item.verificationIntent })) } as never);
    o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });

    const authoring = ask('next (PLAN, underived pin)');
    assert.equal(authoring.reason, 'plan_authoring', `[NP] the missing derivation is a PLAN authoring step: ${authoring.reason}: ${authoring.why}`);
    assert.match(authoring.why, /CHK-001:happy:1/, '[NP] the authoring step names the underived pinned row');
    assert.match(authoring.why, /derivation/, '[NP] the authoring step asks for its derivation');
    const proposed = (authoring.batch ?? []).find(call => call.cli.command === 'checklist_update' && call.cli.payload.itemId === 'CHK-001');
    // Lab initplan: a row patch of CHK-001:happy:1.
    const proposedPin = ((proposed?.cli.payload.intentRows as Array<Record<string, unknown>> | undefined) ?? []).find(patch => patch.ref === 'CHK-001:happy:1');
    assert.match(String((proposedPin?.derivation as Record<string, unknown> | undefined)?.requestQuote ?? ''), /^<.*>$/, '[NP] the exact checklist_update carries a derivation placeholder');

    const wrongRow = row(NP_WRONG_PIN, 'TestUpperXY');
    const refused = o.cli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', verificationIntent: intents(wrongRow)['CHK-001'] }, { label: 'checklist_update CHK-001 (no derivation)' });
    assert.notEqual(refused.status, 0, '[NP] checklist_update must refuse the underived pinned value');
    assert.match(refused.out, /\[intent_derivation_required\]/, '[NP] the refusal names the rule');
    const wrongDerivation = { requestQuote: NP_QUOTE, computation: 'Upper keeps characters that are already in their returned form, so "xy" stays "xy"' };
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', verificationIntent: intents(row(NP_WRONG_PIN, 'TestUpperXY', { derivation: wrongDerivation }))['CHK-001'] }, { label: 'checklist_update CHK-001 (wrong derivation)' });
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', verificationIntent: intents(wrongRow)['CHK-002'] }, { label: 'checklist_update CHK-002' });

    const launch = ask('next (PLAN, authored)');
    assert.equal(launch.reason, 'scope_plan_review_launch', `[NP] the scope-plan reviewer runs once the derivations are authored: ${launch.reason}: ${launch.why}`);
    o.script('proof-or-stop-review-scope-plan', { final: 'Scope review saved.', commands: [[process.execPath, CLI, 'scope_check_save', JSON.stringify({ storyId: o.storyId,
      features: [
        { feature: 'strs.Upper returns the upper-case form', covered_by: 'CHK-001', status: 'covered', excluded_by: null, source: 'request.md' },
        { feature: 'strs.Reverse reverses by rune', covered_by: 'CHK-002', status: 'covered', excluded_by: null, source: 'request.md' },
        { feature: 'pin-audit CHK-001:happy:1: pins "xy"; the cited sentence (upper-case form) gives "XY"', covered_by: null, status: 'gap', excluded_by: null, source: 'request.md' },
      ],
      summary: { total: 3, covered: 2, excluded: 0, gaps: 1 },
      readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null }, openQuestions: [] })]] });
    const payload = { ...launch.cli!.payload };
    for (const [key, value] of Object.entries({ host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort })) {
      if (typeof payload[key] !== 'string' || /^<.*>$/.test(String(payload[key]))) payload[key] = value;
    }
    const launched = o.mustCli('host_run', payload, { label: 'host_run --managedDispatch scope-plan' });
    const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
    const terminal = waitTerminal(o, 'scope-plan', runId);
    o.unscript('proof-or-stop-review-scope-plan');
    assert.equal(terminal.state, 'completed', `[NP] scope-plan terminal ${terminal.state} (${terminal.reason})\n${o.providerCommandLog()}`);
    const prompt = managedPrompts(o, 'proof-or-stop-review-scope-plan')[0]?.prompt ?? '';
    assert.match(prompt, /Pin audit \(blocking\)/, '[NP] the scope-plan prompt carries the pin-audit rule');
    assert.ok(prompt.includes(wrongDerivation.computation), '[NP] the scope-plan prompt carries the derivation verbatim');

    const review = o.cli('story_review', { storyId: o.storyId }, { label: 'story_review (pin-audit gap)' });
    assert.match(review.out, /pin-audit CHK-001:happy:1/, '[NP] story_review reports the pin-audit gap');
    // Lab initplan: the fix is a row patch of the named row (intentRows), not the whole intent.
    assert.match(review.out, /checklist_update[^\n]*--intentRows='\[\{\\?"ref\\?":\\?"CHK-001:happy:1/, '[NP] the pin-audit gap names the intent fix (checklist_update row patch of CHK-001:happy:1)');
    const dev = o.cli('story_advance', { storyId: o.storyId, phase: 'DEV' }, { label: 'story_advance DEV (refused)' });
    assert.notEqual(dev.status, 0, '[NP] the wrong pin must not reach DEV');
    assert.match(dev.out, /story_review round has 1 unresolved blocker/, '[NP] the only DEV blocker is the pin-audit gap');
    assert.equal(o.phase(), 'PLAN', '[NP] still PLAN');
    const held = ask('next (PLAN, pin-audit gap open)');
    assert.notEqual(held.reason, 'enter_dev', `[NP] next must not propose DEV while the pin-audit gap is open: ${held.why}`);

    const fixed = row('Upper("xy") -> "XY"', 'TestUpperXY', { derivation: { requestQuote: NP_QUOTE, computation: 'the upper-case form of "xy" is "XY"' } });
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', verificationIntent: intents(fixed)['CHK-001'] }, { label: 'checklist_update CHK-001 (pin fixed)' });
    const relaunch = ask('next (PLAN, pin fixed)');
    assert.equal(relaunch.reason, 'scope_plan_review_launch', `[NP] the fixed pin is re-audited: ${relaunch.reason}: ${relaunch.why}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NRW (old-PoS runs 35-39): runs 35/38/39 wrote every example row as prose, so the
 * declared probe runner extracted 0 rows and nothing said so; every one-row fix was
 * a whole-intent resubmission (run 37: 26 hand-built jq pipelines).
 */
function scenarioNRW(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NRW';
  const name = 'NRW old-PoS runs 35-39: a saved example row no probe can run is reported with ONE Next (row patch); intentRows patches one row with every intent check kept';
  // A declared probe runner (the bench arm bench.probeRunner=on): a program file echoed back.
  const runner = { command: process.execPath, args: ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', '{file}'], program: '{input}', extension: '.txt' };
  const o = new Owner(tag, 'B-e2c6', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST, config: { probeRunner: runner } });
  const lines: string[] = [];
  const row = (desc: string, test: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass',
    requirementSource: 'story', verification: { command: `go test -v ./strs -run ^${test}$`, selector: `--- PASS: ${test}` }, ...extra });
  try {
    const store = new StoryStore(o.worktree);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'PLAN' });
    const legacy = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...legacy, items: legacy.items.map(item => ({ ...item, status: 'pending', startTime: null })) } as never);
    o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });
    const intent = { happy: [row('Upper("ab") -> "AB"', 'TestUpper'), row('Upper of "ab" gives "AB"', 'TestUpperProse')],
      edge: [row('Upper("") -> ""', 'TestUpperEmpty')], adversarial: [row('Upper leaves digits and symbols unchanged', 'TestUpperSymbols')] };
    const saved = o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', verificationIntent: intent }, { label: 'checklist_update CHK-001 (one prose example row)' });
    lines.push(`save: ${saved.out.split('\n').filter(line => /not extractable|Next:/.test(line)).join(' / ').slice(0, 300)}`);
    assert.match(saved.out, /1 row (?:is )?not extractable/i, `[NRW] the save names the row the probe cannot run:\n${saved.out.slice(-1500)}`);
    assert.match(saved.out, /CHK-001:happy:1/, '[NRW] the save lists the row ref');
    assert.match(saved.out, /<input> -> <expected>/, '[NRW] the save names the accepted form');
    const note = saved.out.slice(saved.out.search(/not extractable/i));
    assert.equal((note.match(/Next: proof-or-stop /g) ?? []).length, 1, `[NRW] ONE next action:\n${note}`);
    assert.match(note, /Next: proof-or-stop checklist_update [^\n]*intentRows/, '[NRW] the Next patches only the listed row');

    const patched = o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', intentRows: [{ ref: 'CHK-001:happy:1', desc: 'Upper("ab") returns "AB"' }] }, { label: 'checklist_update CHK-001 intentRows (prose connector)' });
    assert.ok(!/not extractable/i.test(patched.out), `[NRW] a prose connector row is runnable (no report):\n${patched.out.slice(-1200)}`);
    const after = new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === 'CHK-001')!.verificationIntent!;
    assert.equal(after.happy[1]!.desc, 'Upper("ab") returns "AB"', '[NRW] the patched row carries the new desc');
    assert.deepEqual((after.happy[1] as unknown as Record<string, unknown>).verification, intent.happy[1]!.verification, '[NRW] the patched row keeps its other fields');
    assert.deepEqual([after.happy[0]!.desc, after.edge[0]!.desc, after.adversarial[0]!.desc], [intent.happy[0]!.desc, intent.edge[0]!.desc, intent.adversarial[0]!.desc], '[NRW] the other rows are unchanged');

    const underived = o.cli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', intentRows: [{ ref: 'CHK-001:edge:0', desc: 'Upper("xy") -> "XY"' }] }, { label: 'checklist_update intentRows (underived pin)' });
    assert.notEqual(underived.status, 0, '[NRW] a row patch passes the same derivation check as a whole intent');
    assert.match(underived.out, /\[intent_derivation_required\]/, '[NRW] the refusal names the rule');
    assert.equal(new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === 'CHK-001')!.verificationIntent!.edge[0]!.desc, 'Upper("") -> ""', '[NRW] nothing written');

    const unknown = o.cli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', intentRows: [{ ref: 'CHK-001:happy:9', desc: 'Upper("a") -> "A"' }] }, { label: 'checklist_update intentRows (unknown ref)' });
    assert.notEqual(unknown.status, 0, '[NRW] an unknown row ref is refused');
    assert.match(unknown.out, /CHK-001:happy:0/, `[NRW] the refusal lists the item's rows:\n${unknown.out.slice(-1200)}`);
    assert.equal(new Set(unknown.out.match(/Next: proof-or-stop .*/g) ?? []).size, 1, `[NRW] ONE next action (the CLI echoes the refusal once more as Error:):\n${unknown.out.slice(-1200)}`);
    const both = o.cli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', verificationIntent: intent, intentRows: [{ ref: 'CHK-001:happy:1', desc: 'Upper("ab") -> "AB"' }] }, { label: 'checklist_update intent + intentRows' });
    assert.notEqual(both.status, 0, '[NRW] a whole intent and a row patch together are refused');
    assert.equal(new Set(both.out.match(/Next: proof-or-stop .*/g) ?? []).size, 1, `[NRW] ONE next action:\n${both.out.slice(-1200)}`);
    lines.push('intentRows patch kept every other row; underived pin, unknown ref and intent+patch refused with one Next');
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NCV: a request with an n-part syntax, omitted forms, a non-numeric operand and a same-semantics assignment section. */
const NCV_REQUEST = [
  'Extend strs slicing with a third component: `value[start:end:step]`.',
  '',
  '## 1. Reads',
  '- Accept omitted components: `value[:end:step]` and `value[::step]`.',
  '- A non-numeric `step` must keep the error `index ranges can only be numerical`.',
  '',
  '## 2. Range assignment',
  '- Use the same index-selection semantics as read slicing.',
].join('\n');
const NCV_MIRROR_SENTENCE = 'Use the same index-selection semantics as read slicing.';

function scenarioNCV(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NCV';
  const name = 'NCV old-PoS runs 24-29: PLAN demands the coverage-matrix rows (write mirror, omission patterns, enumerated null) before the scope-plan reviewer; excludes and authored rows clear them';
  // Old-PoS run 33: the full coverage matrix is the A/B arm plan.coverageMatrix=on (default: exact-text rows only).
  const o = new Owner(tag, 'B-e2c4', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NCV_REQUEST,
    config: { plan: { coverageMatrix: 'on' } } });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[NCV] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  const row = (desc: string, test: string) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass',
    requirementSource: 'story', verification: { command: `go test -v ./strs -run ^${test}$`, selector: `--- PASS: ${test}` } });
  const reads = [row('x[0:4:2] reads every second element', 'TestReadStep'), row('x[::-1] reads backward', 'TestReadBack'),
    row('x[0:4:{}] keeps the index ranges can only be numerical error', 'TestReadStepType')];
  const writes = [row('x[0:4:2] = y writes every second element', 'TestWriteStep'), row('x[1:3] = y writes two elements', 'TestWriteTwo'),
    row('x[0:4] = z with a wrong length keeps the size check', 'TestWriteSize')];
  try {
    const store = new StoryStore(o.worktree);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'PLAN' });
    const legacy = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...legacy, items: legacy.items.map((item, at) => ({ ...item, status: 'pending', startTime: null,
      title: at === 0 ? 'Read stepped slices' : 'Range assignment through stepped slices',
      userSees: at === 0 ? '`value[start:end:step]`, `value[:end:step]` and `value[::step]` read; a non-numeric `step` errors with `index ranges can only be numerical`.' : 'Range assignment selects like reads.',
      verificationIntent: at === 0 ? { happy: [reads[0]], edge: [reads[1]], adversarial: [reads[2]] } : { happy: [writes[0]], edge: [writes[1]], adversarial: [writes[2]] } })) } as never);
    o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });

    // 1. next demands the rows before it launches the scope-plan reviewer.
    const authoring = ask('next (PLAN, coverage rows missing)');
    assert.equal(authoring.reason, 'plan_authoring', `[NCV] the missing coverage rows are a PLAN authoring step: ${authoring.reason}: ${authoring.why}`);
    assert.match(authoring.why, /Coverage rows the request demands/, '[NCV] the Why names the coverage rows');
    assert.ok(authoring.why.includes(`"${NCV_MIRROR_SENTENCE}"`), '[NCV] the Why lists the matched request sentence');
    for (const key of ['coverage write: negative step', 'coverage read or write: form [::]', 'coverage read: explicit null step']) {
      assert.ok(authoring.why.includes(key), `[NCV] the Why names "${key}": ${authoring.why}`);
    }
    const placeholders = (itemId: string): string[] => {
      const update = (authoring.batch ?? []).find(call => call.cli.command === 'checklist_update' && call.cli.payload.itemId === itemId);
      // Lab initplan: the coverage rows are appended to edge by a row patch.
      return ((update?.cli.payload.intentRows as Array<{ ref: string; desc?: string }> | undefined) ?? []).filter(entry => entry.ref.endsWith(':edge:+')).map(entry => String(entry.desc)).filter(desc => desc.startsWith('<'));
    };
    assert.ok(placeholders('CHK-002').some(desc => desc.startsWith('<write-mirror:')), `[NCV] CHK-002 gets the write-mirror placeholder: ${JSON.stringify(placeholders('CHK-002'))}`);
    assert.ok(placeholders('CHK-001').some(desc => desc.startsWith('<omit-combination:')), `[NCV] CHK-001 gets the omission-pattern placeholder: ${JSON.stringify(placeholders('CHK-001'))}`);

    // 2. story_review reports the same rows as blockers; DEV is refused.
    const review = o.cli('story_review', { storyId: o.storyId }, { label: 'story_review (coverage rows missing)' });
    assert.match(review.out, /missing_coverage_row|No intent states coverage write: negative step/, `[NCV] story_review reports the missing coverage rows:\n${review.out.slice(-1500)}`);
    const dev = o.cli('story_advance', { storyId: o.storyId, phase: 'DEV' }, { label: 'story_advance DEV (refused)' });
    assert.notEqual(dev.status, 0, '[NCV] PLAN cannot enter DEV with missing coverage rows');

    // 3. The owner writes the rows (one excluded with its reason); nothing is demanded any more.
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001',
      excludes: ['coverage read or write: form [::]: the all-omitted stepped form is a parse error by design'],
      verificationIntent: { happy: [reads[0]], edge: [reads[1], row('x[:3:1], x[1::1], x[0:2:], x[:2:] and x[1::] read like the two-part form', 'TestReadOmitted'),
        row('x[0:4:null] keeps the index ranges can only be numerical error', 'TestReadStepNull')], adversarial: [reads[2]] } }, { label: 'checklist_update CHK-001 (coverage rows)' });
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002',
      verificationIntent: { happy: [writes[0]], edge: [writes[1], row('x[::-1] = y writes backward', 'TestWriteBack'), row('x[0:2:] = y writes like the two-part form', 'TestWriteOmittedStep'),
        row('x[0:4:{}] = y and x[0:4:null] = y keep the read-side error', 'TestWriteStepType')], adversarial: [writes[2]] } }, { label: 'checklist_update CHK-002 (coverage rows)' });
    const launch = ask('next (PLAN, coverage rows written)');
    assert.equal(launch.reason, 'scope_plan_review_launch', `[NCV] the scope-plan reviewer runs once the rows are written: ${launch.reason}: ${launch.why}`);

    // 4. The scope-plan reviewer prompt carries the coverage rule; its verdict leaves no coverage blocker.
    o.script('proof-or-stop-review-scope-plan', { final: 'Scope review saved.', commands: [[process.execPath, CLI, 'scope_check_save', JSON.stringify({ storyId: o.storyId,
      features: [
        { feature: 'stepped reads with omitted components', covered_by: 'CHK-001', status: 'covered', excluded_by: null, source: 'request.md' },
        { feature: 'range assignment uses read selection', covered_by: 'CHK-002', status: 'covered', excluded_by: null, source: 'request.md' },
      ],
      summary: { total: 2, covered: 2, excluded: 0, gaps: 0 },
      readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null }, openQuestions: [] })]] });
    const payload = { ...launch.cli!.payload };
    for (const [key, value] of Object.entries({ host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort })) {
      if (typeof payload[key] !== 'string' || /^<.*>$/.test(String(payload[key]))) payload[key] = value;
    }
    const launched = o.mustCli('host_run', payload, { label: 'host_run --managedDispatch scope-plan' });
    const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
    const terminal = waitTerminal(o, 'scope-plan', runId);
    o.unscript('proof-or-stop-review-scope-plan');
    assert.equal(terminal.state, 'completed', `[NCV] scope-plan terminal ${terminal.state} (${terminal.reason})\n${o.providerCommandLog()}`);
    const prompt = managedPrompts(o, 'proof-or-stop-review-scope-plan')[0]?.prompt ?? '';
    assert.match(prompt, /Coverage matrix \(blocking\)/, '[NCV] the scope-plan prompt carries the coverage-matrix rule');
    assert.match(prompt, /Mechanical coverage rows: all present/, '[NCV] the scope-plan prompt reports the mechanical rows present');
    const after = o.cli('story_review', { storyId: o.storyId }, { label: 'story_review (coverage rows written)' });
    assert.doesNotMatch(after.out, /missing_coverage_row|No intent states coverage/, `[NCV] no coverage blocker is left:\n${after.out.slice(-1500)}`);
    lines.push(`coverage placeholders: CHK-001 ${placeholders('CHK-001').length}, CHK-002 ${placeholders('CHK-002').length}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NIN: the owner's values for the story_create template next prints (every '<...>' replaced). */
function fillStoryCreateTemplate(template: Record<string, unknown>): Record<string, unknown> {
  const filled = JSON.parse(JSON.stringify(template)) as Record<string, any>;
  Object.assign(filled, { name: 'strs-upper', title: 'Upper returns the upper-case form of a string', type: 'bug', priority: 'medium',
    description: 'strs.Upper returns its input unchanged; docs/types/string.md promises the upper-case form.',
    keywords: ['strs', 'upper', 'string'],
    background: [
      '## Trigger Event', 'On 2026-10-08 the benchmark-shaped fixture reports that strs.Upper returns its input unchanged, contrary to docs/types/string.md.',
      '## Key Insights', 'strs.Upper is a one-line stub returning s; the documented behavior is strings.ToUpper, so the fix is local to strs/strs.go and its test.',
      '## Solution Tradeoffs', 'Call strings.ToUpper directly instead of a hand-written loop; keep the function signature and every other helper unchanged.',
      '## Conversational Texture', 'The request is a single sentence with an exact expected output, so acceptance is one named Go test with an exact selector.',
    ].join('\n\n') });
  const item = filled.checklist[0];
  Object.assign(item, { title: 'Upper returns the upper-case form', context: 'strs/strs.go Upper returns s unchanged; it must call strings.ToUpper.',
    userSees: 'go test -v ./strs -run TestUpper prints --- PASS: TestUpper', files: { modify: ['strs/strs.go'], test: ['strs/strs_test.go'] } });
  Object.assign(item.verificationIntent.happy[0], { desc: 'Upper("ab") -> "AB"', verification: { command: 'go test -v ./strs -run ^TestUpper$', selector: '--- PASS: TestUpper' },
    derivation: { requestQuote: 'strs.Upper returns the upper-case form of its input', computation: 'the upper-case form of "ab" is "AB"' } });
  Object.assign(filled.scopeBoundary, { mode: 'correctness_fix', allowed: ['strs: Upper returns the upper-case form'], excluded: ['other string helpers'],
    confirmation: 'derived from the fixture request' });
  filled.executionBoundary.allowedCommands = (filled.executionBoundary.allowedCommands as string[]).filter(entry => !entry.startsWith('<'));
  filled.executionBoundary.allowedPaths = ['strs/'];
  const left = JSON.stringify(filled).match(/<[^>]*>/g);
  assert.equal(left, null, `[NIN] the harness left template placeholders unfilled: ${String(left)}`);
  return filled;
}

/**
 * NSC (old-PoS run 34 F3, INIT): story_create was refused twice on derivation
 * rows, one problem tier at a time, and each time the owner re-emitted the
 * whole 14-17k-token payload. Now one refusal lists every row's problem across
 * all items, stages the full payload in a runtime file and names ONE next
 * action: fix the listed rows in that file and run `story_create @<file>`.
 */
function scenarioNSC(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NSC';
  const name = 'NSC old-PoS run 34: a refused story_create lists every derivation problem at once and stages the payload for an @file resubmit';
  const o = new Owner(tag, 'B-0000', machineEnv, steps, false, { fromScratch: true });
  const lines: string[] = [];
  try {
    const first = o.cli('next', { json: true }, { label: 'next (no Story)' });
    const template = parseJson(first.stdout) as unknown as NextStepJson;
    assert.equal(template.reason, 'story_create_authoring', `[${tag}] template: ${template.reason}`);
    const payload = fillStoryCreateTemplate(template.cli!.payload) as Record<string, any>;
    payload.request = NIQ_REQUEST;
    // Old-PoS run 40 (N4): a schema-enum refusal (a row type outside the enum) is staged too: the template
    // lists the row type values, and the refusal names ONE story_create @<file> Next with the allowed values.
    assert.match(template.why, /logic\|cli\|browser\|manual\|docs/, `[${tag}] the template step lists the row type values: ${template.why.slice(0, 600)}`);
    const enumPayload = JSON.parse(JSON.stringify(payload)) as Record<string, any>;
    enumPayload.checklist[0].verificationIntent.happy[0].type = 'compatibility';
    const enumRefused = o.cli('story_create', enumPayload, { label: 'story_create (row type outside the enum)' });
    lines.push(enumRefused.out.split('\n').filter(line => /type|Next:/.test(line)).slice(0, 4).join(' | '));
    assert.notEqual(enumRefused.status, 0, `[${tag}] the row type outside the enum is refused`);
    assert.match(enumRefused.out, /compatibility[^\n]*logic[^\n]*cli[^\n]*browser[^\n]*manual[^\n]*docs/, `[${tag}] the refusal names the value and the allowed values:\n${enumRefused.out.slice(-1500)}`);
    const enumStaged = enumRefused.out.match(/proof-or-stop story_create @(\S+\.json)/)?.[1];
    assert.ok(enumStaged, `[${tag}] the enum refusal stages the payload with ONE story_create @<file> Next (run 40: the whole payload was re-sent):\n${enumRefused.out.slice(-1500)}`);
    assert.equal(new Set(enumRefused.out.match(/^Next:.*$/gm) ?? []).size, 1, `[${tag}] exactly one (distinct) Next line on the enum refusal`);
    assert.equal(JSON.parse(readFileSync(enumStaged!, 'utf8')).checklist[0].verificationIntent.happy[0].type, 'compatibility', `[${tag}] the staged file holds the submitted payload`);
    const one = payload.checklist[0];
    // Two items, each with an underived example the request does not quote (two problems in two items).
    Object.assign(one.verificationIntent.happy[0], { desc: 'Upper("abc") -> "ABC"', derivation: { requestQuote: 'Upper upper-cases its whole input', computation: 'the upper-case form of "abc" is "ABC"' } });
    const two = JSON.parse(JSON.stringify(one));
    Object.assign(two, { title: 'Reverse returns the rune-reversed string', context: 'strs.Reverse does not exist yet; it must reverse by rune.' });
    two.verificationIntent.happy[0] = { ...two.verificationIntent.happy[0], desc: 'Reverse("abc") -> "cba"', verification: { command: 'go test -v ./strs -run ^TestReverse$', selector: '--- PASS: TestReverse' } };
    delete two.verificationIntent.happy[0].derivation;
    payload.checklist = [one, two];
    const refused = o.cli('story_create', payload, { label: 'story_create (two underived rows)' });
    lines.push(refused.out.split('\n').filter(line => /REFUSED|CHK-00|Next:/.test(line)).slice(0, 6).join(' | '));
    assert.notEqual(refused.status, 0, `[${tag}] the underived rows are refused`);
    assert.match(refused.out, /CHK-001:happy:0/, `[${tag}] the first item's row is listed:\n${refused.out.slice(-2000)}`);
    assert.match(refused.out, /CHK-002:happy:0/, `[${tag}] every item's row is listed in the same refusal (run 34: one tier per refusal):\n${refused.out.slice(-2000)}`);
    const staged = refused.out.match(/proof-or-stop story_create @(\S+\.json)/)?.[1];
    assert.ok(staged, `[${tag}] the refusal names ONE next action, a story_create @<staged payload>:\n${refused.out.slice(-2000)}`);
    // The CLI echoes the error (failed: ... / Error: ...); the refusal itself names one next action.
    assert.equal(new Set(refused.out.match(/^Next:.*$/gm) ?? []).size, 1, `[${tag}] exactly one (distinct) Next line`);
    const stagedPayload = JSON.parse(readFileSync(staged!, 'utf8')) as Record<string, any>;
    assert.deepEqual(stagedPayload.checklist, payload.checklist, `[${tag}] the staged file holds the submitted payload`);
    // The owner patches only the refused rows in the staged file.
    const sentence = '`strs.Upper(s)` returns the upper-case form of `s`, for example `Upper("ab")` is `"AB"`.';
    stagedPayload.checklist[0].verificationIntent.happy[0].derivation = { requestQuote: sentence, computation: 'the upper-case form of "abc" is "ABC"' };
    stagedPayload.checklist[1].verificationIntent.happy[0].derivation = { requestQuote: '`strs.Reverse(s)` returns `s` reversed by rune, for example `Reverse("héllo")` is `"olléh"`.', computation: 'reversing the runes of "abc" gives "cba"' };
    writeFileSync(staged!, JSON.stringify(stagedPayload));
    const created = o.node([CLI, 'story_create', `@${staged}`]);
    assert.equal(created.status, 0, `[${tag}] the patched staged payload is accepted:\n${created.out.slice(-2000)}`);
    assert.match(created.stdout, /Story B-[a-f0-9]+ created/, `[${tag}] created`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NIN (N4, old-PoS runs 22-24: 30-36 owner requests in INIT, help pages,
 * manual INIT reviewer launches and polls). From an empty project the owner
 * runs `next` (no Story): it prints ONE complete story_create template (scope
 * and execution boundary inline, every placeholder described, so no --help).
 * After story_create, `next --run` alone must drive INIT: record the scope
 * freeze check, launch BOTH managed INIT reviewers (framework steps; the first
 * launch uses the qualified managed-reviewer default selection), wait, enter
 * INIT_CHECK and PLAN, and stop at PLAN's first agent step. No INIT step may be
 * returned to the owner.
 */
function scenarioNIN(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NIN';
  const name = 'NIN N4: next prints the story_create template, then next --run drives INIT to PLAN (reviewers launched and waited by the framework)';
  const o = new Owner(tag, 'B-0000', machineEnv, steps, false, { fromScratch: true });
  const lines: string[] = [];
  try {
    const first = o.cli('next', { json: true }, { label: 'next (no Story)' });
    const template = parseJson(first.stdout) as unknown as NextStepJson | null;
    assert.equal(template?.reason, 'story_create_authoring', `[NIN] next without a Story must print the story_create template:\n${first.out.slice(-1500)}`);
    assert.equal(template!.cli?.command, 'story_create', '[NIN] the template is a story_create command');
    for (const key of ['scopeBoundary', 'executionBoundary', 'checklist', 'background']) {
      assert.ok(template!.cli!.payload[key] !== undefined, `[NIN] the story_create template carries ${key}`);
    }
    const templateRow = ((template!.cli!.payload.checklist as Array<Record<string, any>>)[0]!.verificationIntent.happy as Array<Record<string, any>>)[0]!;
    assert.match(String(templateRow.derivation?.requestQuote ?? ''), /^<.*>$/, '[NIN] the template intent row carries the derivation placeholder (D4, run 23 pinned at story_create)');
    const missingHints = placeholderHintViolations(template!);
    assert.deepEqual(missingHints, [], `[NIN] every template placeholder has a one-line hint`);
    assert.ok(Object.values(template!.placeholderHints ?? {}).every(hint => hint !== 'author this value'), `[NIN] no generic hint: ${JSON.stringify(template!.placeholderHints)}`);
    const created = o.mustCli('story_create', fillStoryCreateTemplate(template!.cli!.payload), { label: 'story_create (template)' });
    const id = created.stdout.match(/Story (B-[a-f0-9]+) created/)?.[1];
    assert.ok(id, `[NIN] story_create returned an id:\n${created.out.slice(-1500)}`);
    o.storyId = id!;
    assert.ok(created.stdout.includes(`Next: proof-or-stop next --storyId=${id} --run`), `[NIN] story_create names next --run as the next step:\n${created.stdout.slice(-1500)}`);
    writeFileSync(join(o.scriptsDir, 'resolver.json'), JSON.stringify({ argv: [process.execPath, SELF, '--provide-script', o.root, id, o.scriptsDir, JSON.stringify({ findingRound1: false })] }));
    const ran: string[] = [];
    const ownerSteps: string[] = [];
    let next: NextStepJson | undefined;
    for (let call = 0; call < 8; call += 1) {
      const asked = o.cli('next', { storyId: id, run: true, json: true }, { label: 'next --run' });
      const parsed = parseJson(asked.stdout);
      next = parsed?.next as NextStepJson | undefined;
      assert.ok(next, `[NIN] next --run returned no step:\n${asked.out.slice(-2000)}`);
      for (const row of (parsed!.executed ?? []) as Array<{ command: string; reason: string; exit: number; tail: string }>) {
        ran.push(row.reason);
        assert.equal(row.exit, 0, `[NIN] next --run executed a step its gate refused: ${row.command}\n${row.tail}`);
      }
      assert.equal(parsed!.stopped ?? null, null, `[NIN] next --run stopped: ${String(parsed!.stopped)}\n${asked.out.slice(-2000)}`);
      if (next.phase === 'INIT' || next.phase === 'INIT_CHECK') {
        if (next.wait || parsed!.paused) continue;
        ownerSteps.push(`${next.phase}:${next.kind}:${next.reason}`);
        break;
      }
      break;
    }
    assert.deepEqual(ownerSteps, [], `[NIN] next returned INIT steps to the owner: ${ownerSteps.join(', ')} (why: ${next?.why.slice(0, 400)})`);
    assert.equal(next?.phase, 'PLAN', `[NIN] next --run must reach PLAN; at ${next?.phase} ${next?.reason}: ${next?.why.slice(0, 400)}`);
    for (const reason of ['scope_freeze_check', 'init_review_launch', 'enter_init_check', 'enter_plan']) {
      assert.ok(ran.includes(reason), `[NIN] next --run ran ${reason} itself (ran: ${ran.join(' > ')})`);
    }
    assert.equal(ran.filter(reason => reason === 'init_review_launch').length, 2, `[NIN] both INIT reviewers launched by the framework (ran: ${ran.join(' > ')})`);
    const firstWait = ran.indexOf('managed_run_wait');
    assert.ok(firstWait < 0 || ran.lastIndexOf('init_review_launch') < firstWait, `[NIN] both INIT reviewers launch before the first wait (parallel): ${ran.join(' > ')}`);
    const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
    for (const runId of readdirSync(runsRoot)) {
      const spec = JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as { agentType: string; model?: string; reasoningEffort?: string };
      if (!INIT_REVIEWERS.includes(spec.agentType)) continue;
      assert.equal(spec.model, MODEL.model, `[NIN] first INIT launch uses the qualified default model`);
      assert.equal(spec.reasoningEffort, MODEL.reasoningEffort, `[NIN] first INIT launch uses the qualified default effort`);
    }
    lines.push(`owner INIT turns: next (template) + story_create + ${ran.length ? 'next --run' : ''}; framework steps: ${ran.join(' > ')}`);
    lines.push(`stopped at ${next!.phase} ${next!.kind}:${next!.reason}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

// ---------------------------------------------------------------------------
// Lab initplan (bench-staging/oldpos/initplan-breakdown.md §5 ranks 4, 5, 6, 8-11): INIT + PLAN from an
// empty project to DEV entry, driven by `next` like the bench owner, with the owner turns counted.

const NIP_REQUEST = [
  'Fix `strs.Upper` as documented in docs/types/string.md:',
  '',
  '- `strs.Upper(s)` returns the upper-case form of `s`, for example `Upper("ab")` is `"AB"`.',
  '- Another example: `Upper("xyz")` is `"XYZ"`.',
  '- `Upper` of a number reports an error that starts with `Upper expects a string`.',
].join('\n');
const NIP_QUOTE = '`strs.Upper(s)` returns the upper-case form of `s`';
const NIP_ERROR_ROW = 'Upper(1) -> the whole error text is exactly "Upper expects a string"';
const isPlaceholder = (value: unknown): value is string => typeof value === 'string' && /^<[\s\S]*>$/.test(value.trim());

/** The NIP owner's authored values for every <...> field next or a refusal hands it (both payload shapes: whole intent rows and intentRows patches). */
function fillNipPlaceholders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fillNipPlaceholders);
  if (!value || typeof value !== 'object') return value;
  const row = { ...(value as Record<string, unknown>) };
  if (isPlaceholder(row.desc)) row.desc = /error/i.test(row.desc) ? 'Upper(1) -> an error that starts with "Upper expects a string"' : 'strs.Upper(s): Upper("xyz") -> "XYZ"';
  const desc = typeof row.desc === 'string' ? row.desc : '';
  const verification = row.verification as Record<string, unknown> | undefined;
  if (verification && (isPlaceholder(verification.command) || isPlaceholder(verification.selector))) {
    const test = /error|Upper\(1\)/.test(desc) ? 'TestUpperNumber' : 'TestUpperXYZ';
    row.verification = { command: `go test -v ./strs -run ^${test}$`, selector: `--- PASS: ${test}` };
  }
  const derivation = row.derivation as Record<string, unknown> | undefined;
  if (derivation && (isPlaceholder(derivation.requestQuote) || isPlaceholder(derivation.computation))) {
    const pinned = desc.split('->')[1]?.trim() ?? desc;
    row.derivation = { requestQuote: NIP_QUOTE, computation: `the upper-case form of the input, as the sentence says, is ${pinned}` };
  }
  if (isPlaceholder(row.reason)) row.reason = 'the request says the error message starts with the reason, so the row pins that prefix';
  if (isPlaceholder(row.userSees)) row.userSees = 'go test -v ./strs -run TestUpper prints --- PASS: TestUpper';
  for (const [key, inner] of Object.entries(row)) if (inner && typeof inner === 'object') row[key] = fillNipPlaceholders(inner);
  return row;
}

/**
 * NIP: INIT + PLAN to DEV entry from an empty project (lab initplan). The request has an example no
 * row states (plan_authoring: a request-literal row) and CHK-001 pins an exact whole error text
 * (exact_error_pin_check); the Story is created once refused (a CJK character and an underived row,
 * both in ONE refusal), then accepted. The owner acts on every agent step `next` returns (fills the
 * placeholders of exactly the commands it gives) and on the story_create PLAN pre-check when one is
 * printed. Checks: the base validation runs in the background from the first `next` and story_create
 * hands out its result; both INIT reviewers launch in ONE step; a refused whole-intent checklist_update
 * names the staged payload (@file); the dev-memory acknowledgement is a framework step (empty pack);
 * the PLAN lints come at most as ONE agent step before the scope-plan reviewer. Reports owner turns.
 */
function scenarioNIP(machineEnv: NodeJS.ProcessEnv, steps: Step[], skipPreCheck = false): Outcome {
  // NIP-M: the owner ignores the story_create PLAN pre-check, so PLAN's merged lint step does the work.
  const tag = skipPreCheck ? 'NIP-M' : 'NIP';
  const name = `${tag} lab initplan${skipPreCheck ? ' (owner skips the PLAN pre-check)' : ''}: INIT + PLAN to DEV entry from an empty project; background base validation, one INIT launch step, row-level refusal Nexts, framework dev-memory ack, PLAN lints in one step; owner turns counted`;
  const o = new Owner(tag, 'B-0000', machineEnv, steps, false, { fromScratch: true });
  const lines: string[] = [];
  const unmet: string[] = [];
  const expect = (ok: boolean, what: string): void => { if (!ok) unmet.push(what); };
  const memory = `${o.root}-memory`;
  try {
    mkdirSync(memory, { recursive: true });
    o.setEnv('PROOF_OR_STOP_GLOBAL_MEMORY_DIR', memory);
    o.mustCli('story_request_set', { request: NIP_REQUEST }, { label: 'story_request_set (staged, adapter)' });
    let ownerTurns = 0;

    // 1. The first next: the story_create template; the framework starts the base validation in the background.
    const first = o.cli('next', { json: true }, { label: 'next (no Story)' });
    ownerTurns += 1;
    const template = parseJson(first.stdout) as unknown as NextStepJson;
    assert.equal(template?.reason, 'story_create_authoring', `[${tag}] template: ${first.out.slice(-800)}`);
    expect(/base validation/i.test(template.why), 'the template names the background base validation (the owner does not run it)');
    const baseDir = join(o.root, '.proof-or-stop', 'runtime', 'base-validation');
    const deadline = Date.now() + 60_000;
    let record: { state?: string; status?: string } | null = null;
    while (Date.now() < deadline) {
      const file = existsSync(baseDir) ? readdirSync(baseDir).find(entry => entry.endsWith('.json')) : undefined;
      record = file ? JSON.parse(readFileSync(join(baseDir, file), 'utf8')) as { state?: string; status?: string } : null;
      if (record?.state === 'done' || (!file && Date.now() > deadline - 55_000)) break;
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 250)']);
    }
    expect(record?.state === 'done' && record.status === 'pass', `the base validation ran in the background and passed (record: ${JSON.stringify(record)})`);

    // 2. story_create: refused ONCE for a CJK character and an underived row, then accepted.
    const filled = fillStoryCreateTemplate(template.cli!.payload) as Record<string, any>;
    const item = filled.checklist[0];
    const happy = item.verificationIntent.happy[0];
    const { derivation: _quoted, ...plain } = happy;
    item.verificationIntent.edge = [{ ...plain, desc: 'Upper("") -> ""', verification: { command: 'go test -v ./strs -run ^TestUpperEmpty$', selector: '--- PASS: TestUpperEmpty' } }];
    item.verificationIntent.adversarial = [{ ...plain, desc: NIP_ERROR_ROW, verification: { command: 'go test -v ./strs -run ^TestUpperNumber$', selector: '--- PASS: TestUpperNumber' } }];
    const broken = JSON.parse(JSON.stringify(filled)) as Record<string, any>;
    broken.background = String(broken.background).replace('## Key Insights\n\n', '## Key Insights\n\nThe reporter wrote \u5927\u5199 in the ticket. ');
    broken.checklist[0].verificationIntent.happy = [{ ...plain, desc: 'Upper("q") -> "Q"' }];
    const refused = o.cli('story_create', broken, { label: 'story_create (CJK + underived row)' });
    ownerTurns += 1;
    assert.notEqual(refused.status, 0, `[${tag}] the broken story_create is refused`);
    expect(/\[intent_derivation_required\]/.test(refused.out) && /\[english_artifact_cjk_authoring\]/.test(refused.out), 'ONE story_create refusal lists both the underived row and the CJK text');
    const created = o.mustCli('story_create', filled, { label: 'story_create' });
    ownerTurns += 1;
    const id = created.stdout.match(/Story (B-[a-f0-9]+) created/)?.[1];
    assert.ok(id, `[${tag}] story_create returned an id:\n${created.out.slice(-1500)}`);
    o.storyId = id!;
    expect(/Base validation/.test(created.stdout), 'story_create hands out the base validation result');
    writeFileSync(join(o.scriptsDir, 'resolver.json'), JSON.stringify({ argv: [process.execPath, SELF, '--provide-script', o.root, id, o.scriptsDir, JSON.stringify({ findingRound1: false, scopePlanPass: true })] }));

    // 4. The PLAN pre-check story_create printed: the owner runs its commands now (INIT, before the reviewers judge the Story).
    const preCheck = created.stdout.includes('PLAN pre-check');
    expect(preCheck, 'story_create prints the PLAN pre-check (the lints PLAN would ask for, at once)');
    if (skipPreCheck) lines.push('the owner skips the PLAN pre-check');
    const runCalls = (label: string, calls: Array<{ command: string; payload: Record<string, unknown> }>): void => {
      for (const call of calls) {
        const payload = fillNipPlaceholders(call.payload) as Record<string, unknown>;
        const left = JSON.stringify(payload).match(/"<[^"]*>"/g);
        assert.equal(left, null, `[${tag}] ${label}: unfilled placeholders ${String(left)}`);
        o.mustCli(call.command, payload, { label: `${label}: ${call.command} ${String(payload.itemId ?? '')}` });
      }
    };
    if (preCheck && !skipPreCheck) {
      const block = created.stdout.slice(created.stdout.indexOf('PLAN pre-check'));
      const calls = [...block.matchAll(/proof-or-stop (checklist_update) '(\{[^\n]*\})'/g)].map(match => ({ command: match[1]!, payload: JSON.parse(match[2]!.replace(/'"'"'/g, "'")) as Record<string, unknown> }));
      expect(calls.length > 0, 'the PLAN pre-check carries runnable commands');
      if (calls.length) { runCalls('PLAN pre-check', calls); ownerTurns += 1; }
    }

    // 3. A refused whole-intent checklist_update names the staged payload; the owner patches the file and resubmits it.
    const underived = { ...plain, desc: 'Upper("q") -> "Q"', verification: { command: 'go test -v ./strs -run ^TestUpperQ$', selector: '--- PASS: TestUpperQ' } };
    const whole = { storyId: id, itemId: 'CHK-001', verificationIntent: { ...(new StoryStore(o.root).readChecklist(id!).items[0]!.verificationIntent as Record<string, unknown>), happy: [happy, underived] } };
    const refusedUpdate = o.cli('checklist_update', whole, { label: 'checklist_update CHK-001 (underived row, whole intent)' });
    assert.notEqual(refusedUpdate.status, 0, `[${tag}] the underived row is refused`);
    const stagedPath = refusedUpdate.out.match(/proof-or-stop checklist_update @(\S+\.json)/)?.[1];
    expect(Boolean(stagedPath), `the whole-intent refusal names the staged payload (@file), not the whole intent: ${refusedUpdate.out.split('\n').filter(line => line.startsWith('Next')).join(' | ').slice(0, 300)}`);
    if (stagedPath) {
      const staged = JSON.parse(readFileSync(stagedPath, 'utf8')) as Record<string, any>;
      staged.verificationIntent.happy[1].derivation = { requestQuote: NIP_QUOTE, computation: 'the upper-case form of "q" is "Q"' };
      writeFileSync(stagedPath, JSON.stringify(staged));
      const resubmitted = spawnSync(process.execPath, [CLI, 'checklist_update', `@${stagedPath}`], { cwd: o.root, encoding: 'utf8', env: o.env });
      expect(resubmitted.status === 0, `checklist_update @staged (fixed) is accepted: ${(resubmitted.stdout + resubmitted.stderr).slice(-400)}`);
    }

    // 5. INIT: the freeze check, then both reviewers in ONE launch step.
    const freeze = parseJson(o.cli('next', { storyId: id, run: true, json: true, maxSteps: 1 }, { label: 'next --run (one step)' }).stdout);
    assert.ok(freeze, `[${tag}] next --run (one step) answered`);
    const launch = parseJson(o.cli('next', { storyId: id, json: true }, { label: 'next --json (INIT launch)' }).stdout) as unknown as NextStepJson;
    expect(launch?.reason === 'init_review_launch' && (launch.parallel?.length ?? 0) === 2, `both INIT reviewers launch in ONE step (got ${launch?.reason} with ${launch?.parallel?.length ?? 0} parallel calls)`);

    // 6. next --run to DEV; the owner acts on each agent step.
    const ran: string[] = [];
    const agentSteps: string[] = [];
    let nextCalls = 0;
    let reachedDev = false;
    for (let call = 0; call < 24 && !reachedDev; call += 1) {
      const asked = o.cli('next', { storyId: id, run: true, json: true }, { label: 'next --run' });
      nextCalls += 1;
      ownerTurns += 1;
      const parsed = parseJson(asked.stdout);
      const next = parsed?.next as NextStepJson | undefined;
      assert.ok(next, `[${tag}] next --run returned no step:\n${asked.out.slice(-2000)}`);
      for (const row of (parsed!.executed ?? []) as Array<{ reason: string; exit: number; command: string; tail: string }>) {
        ran.push(row.reason);
        assert.equal(row.exit, 0, `[${tag}] next --run executed a refused step: ${row.command}\n${row.tail}`);
      }
      assert.equal(parsed!.stopped ?? null, null, `[${tag}] next --run stopped: ${String(parsed!.stopped)}\n${asked.out.slice(-1500)}`);
      if (next.phase === 'DEV' || ran.includes('enter_dev')) { reachedDev = true; break; }
      if (next.wait || parsed!.paused || next.kind === 'framework') continue;
      assert.ok(['PLAN', 'INIT', 'INIT_CHECK'].includes(next.phase), `[${tag}] unexpected phase ${next.phase}`);
      agentSteps.push(`${next.phase}:${next.reason}`);
      ownerTurns += 1;
      const calls = next.batch?.length ? next.batch.map(entry => entry.cli) : next.cli ? [next.cli] : [];
      assert.ok(calls.length > 0, `[${tag}] agent step ${next.reason} has no command: ${next.why.slice(0, 400)}`);
      runCalls(next.reason, calls);
    }
    assert.ok(reachedDev, `[${tag}] DEV entry reached (ran: ${ran.join(' > ')}; agent steps: ${agentSteps.join(', ')})`);
    const planAgentSteps = agentSteps.filter(row => row.startsWith('PLAN:'));
    expect(!agentSteps.includes('PLAN:dev_memory_preflight_ack'), 'the dev-memory acknowledgement (empty pack) is a framework step');
    expect(planAgentSteps.length <= 1, `the PLAN lints come at most as ONE agent step before the scope-plan reviewer (got ${planAgentSteps.join(', ') || 'none'})`);
    lines.push(`owner turns from the first next to DEV entry: ${ownerTurns} (next x1, story_create x2, ${nextCalls} next --run, ${agentSteps.length} agent step(s) acted on${preCheck && !skipPreCheck ? ', 1 PLAN pre-check' : ''}); agent steps: ${agentSteps.join(', ') || 'none'}`);
    lines.push(`framework steps: ${ran.join(' > ')}`);
    assert.deepEqual(unmet, [], `[${tag}] unmet:\n  - ${unmet.join('\n  - ')}`);
    o.cleanup();
    rmSync(memory, { recursive: true, force: true });
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, ...unmet.map(row => `unmet: ${row}`), error instanceof Error ? error.message : String(error)] };
  }
}

// ---------------------------------------------------------------------------
// Lab plan-light (structural-cost-analysis.md §7 item 4): plan.pinProbe (NPP),
// plan.reviewMerge (NPM-I, NPM-P), plan.rowBudget (NRB). Each switch is off by
// default; every scenario also runs its control with the switch absent.

/** NPP: the project's evaluator at the Story base; base Upper returns its input unchanged, Reverse does not exist. */
const NPP_EVAL = [
  "const lines = require('fs').readFileSync(process.argv[2], 'utf8').trim().split('\\n');",
  'const number = lines[lines.length - 1].trim().match(/^Upper\\((\\d+)\\)$/);',
  "if (number) { console.error('Upper expects a string, got ' + number[1]); process.exit(1); }",
  'const call = lines[lines.length - 1].trim().match(/^Upper\\((".*")\\)$/);',
  "if (!call) { console.error('undefined: ' + lines[lines.length - 1]); process.exit(1); }",
  'console.log(JSON.stringify(JSON.parse(call[1])));',
  '',
].join('\n');
const NPP_REQUEST = `${NIQ_REQUEST}\n- Mixed case is kept upper-case: \`Upper("xy") -> "XY"\`.`;

function scenarioNPP(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NPP';
  const name = 'NPP lab plan-light plan.pinProbe=on: a wrong value pin and a wrong error-format pin on unchanged behaviour and a pin contradicting a request literal refuse DEV entry with the observed value; the corrected pins pass; switch off = no probe';
  const runner = { command: process.execPath, args: ['tools/strs-eval.js', '{file}'], program: '{input}', extension: '.txt' };
  const row = (desc: string, test: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass',
    requirementSource: 'story', verification: { command: `go test -v ./strs -run ^${test}$`, selector: `--- PASS: ${test}` }, ...extra });
  const quote = '`strs.Upper(s)` returns the upper-case form of `s`';
  const intent = {
    happy: [row('Upper("AB") -> "ab"', 'TestUpperKeeps', { derivation: { requestQuote: quote, computation: 'upper-casing "AB" lower-cases nothing, so "ab"' } }),
      row('Upper("xy") -> "Xy"', 'TestUpperXY', { baseValue: '"xy"', derivation: { requestQuote: quote, computation: 'only the first letter is upper-cased: "Xy"' } })],
    edge: [row('Upper("ab") -> "AB"', 'TestUpper', { baseValue: '"ab"' }),
      // An existing error format pinned with the operand quoted (old-PoS run 49 class).
      row('Upper(1) -> error \'Upper expects a string, got "1"\'', 'TestUpperNumber')],
    adversarial: [row('Reverse("héllo") -> "olléh"', 'TestReverse')],
  };
  const lines: string[] = [];
  const setup = (o: Owner): void => {
    const store = new StoryStore(o.worktree);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'PLAN' });
    const legacy = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...legacy, items: legacy.items.map(item => ({ ...item, status: 'pending', startTime: null,
      ...(item.id === 'CHK-001' ? { verificationIntent: intent } : {}) })) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} PLAN pins`);
    o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });
  };
  const ask = (o: Owner, label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[NPP] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${o.scenario} ${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  const control = new Owner('NPP-off', 'B-e2f1', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NPP_REQUEST,
    config: { probeRunner: runner }, baseFiles: { 'tools/strs-eval.js': NPP_EVAL } });
  const o = new Owner(tag, 'B-e2f0', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NPP_REQUEST,
    config: { probeRunner: runner, plan: { pinProbe: 'on' } }, baseFiles: { 'tools/strs-eval.js': NPP_EVAL } });
  try {
    // Control: the switch absent, the same wrong pins are not probed (production behaviour unchanged).
    setup(control);
    const off = ask(control, 'next (switch off)');
    assert.notEqual(off.reason, 'pin_probe_mismatch', `[NPP] with plan.pinProbe absent nothing is probed: ${off.why}`);
    const offDev = control.cli('story_advance', { storyId: control.storyId, phase: 'DEV' }, { label: 'story_advance DEV (switch off)' });
    assert.doesNotMatch(offDev.out, /pin_probe_mismatch/, '[NPP] the DEV gate is unchanged with the switch off');
    control.cleanup();

    setup(o);
    const blocked = ask(o, 'next (wrong pins)');
    assert.equal(blocked.reason, 'pin_probe_mismatch', `[NPP] next names the wrong pins before the plan review: ${blocked.reason}: ${blocked.why}`);
    assert.match(blocked.why, /CHK-001:happy:0: `Upper\("AB"\)` -> the Story base computes "AB", the row pins ["']ab["']/, `[NPP] the unchanged-behaviour pin is named with the observed base value: ${blocked.why}`);
    assert.match(blocked.why, /CHK-001:happy:1: `Upper\("xy"\)` -> the request states "XY", the row pins ["']Xy["']/, `[NPP] the request-literal contradiction is named: ${blocked.why}`);
    assert.match(blocked.why, /CHK-001:edge:1: `Upper\(1\)` -> the Story base computes Upper expects a string, got 1, the row pins/, `[NPP] an existing error format pinned wrong is named with the base error: ${blocked.why}`);
    assert.doesNotMatch(blocked.why, /CHK-001:edge:0|CHK-001:adversarial:0/, '[NPP] a baseValue-acknowledged change and a row the base cannot run are not refused');
    assert.equal(blocked.cli?.command, 'checklist_update', '[NPP] ONE next action: a checklist_update row patch');
    const patch = (blocked.cli?.payload.intentRows as Array<{ ref: string }> | undefined) ?? [];
    assert.equal(patch.length, 1, '[NPP] the step patches one row');
    const dev = o.cli('story_advance', { storyId: o.storyId, phase: 'DEV' }, { label: 'story_advance DEV (refused: pins)' });
    assert.notEqual(dev.status, 0, '[NPP] the wrong pins must not reach DEV');
    assert.match(dev.out, /\[pin_probe_mismatch\]/, `[NPP] the DEV gate names the rule:\n${dev.out.slice(-1500)}`);
    assert.match(dev.out, /the Story base computes "AB"/, '[NPP] the refusal carries the observed value');
    assert.match(dev.out, /Next: proof-or-stop checklist_update '[^\n]*intentRows/, '[NPP] the refusal carries one row-patch Next');
    const evidencePath = [o.root, o.worktree].map(dir => join(dir, '.proof-or-stop', 'runtime', 'plan-pin-probe', `${o.storyId}.json`)).find(path => existsSync(path));
    assert.ok(evidencePath, '[NPP] the probe is recorded with its A/B evidence');
    const evidence = JSON.parse(readFileSync(evidencePath!, 'utf8')) as { abVariant?: { flags?: Record<string, string> }; runner?: string; judged?: number; skipped?: number };
    assert.deepEqual(evidence.abVariant?.flags, { 'plan.pinProbe': 'on' }, '[NPP] abVariantEvidence recorded');
    assert.equal(evidence.runner, 'probeRunner');
    lines.push(`probe: runner ${evidence.runner}, judged ${evidence.judged} case(s) on the base, skipped ${evidence.skipped} (new behaviour)`);

    // The owner applies the observed values (one row patch each); the correct pins pass.
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', intentRows: [{ ref: 'CHK-001:happy:0', desc: 'Upper("AB") -> "AB"' },
      { ref: 'CHK-001:happy:1', desc: 'Upper("xy") -> "XY"', derivation: null },
      { ref: 'CHK-001:edge:1', desc: 'Upper(1) -> error \'Upper expects a string, got 1\'',
        derivation: { requestQuote: quote, computation: 'a number is not a string, so Upper keeps its existing error naming the operand 1' } }] }, { label: 'checklist_update CHK-001 (pins corrected)' });
    const after = ask(o, 'next (pins corrected)');
    assert.notEqual(after.reason, 'pin_probe_mismatch', `[NPP] corrected pins pass the probe: ${after.why}`);
    const passed = JSON.parse(readFileSync(evidencePath!, 'utf8')) as { mismatches?: unknown[] };
    assert.deepEqual(passed.mismatches, [], '[NPP] the recorded probe is clean');
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NPM-I: INIT driven by next --run with plan.reviewMerge=on: no INIT reviewer runs. */
function scenarioNPMI(machineEnv: NodeJS.ProcessEnv, steps: Step[], lean = false): Outcome {
  // Lab lean (NLN-I): the same INIT flow under the umbrella pipeline.lean=on, which implies plan.reviewMerge=on.
  const tag = lean ? 'NLN-I' : 'NPM-I';
  const name = lean ? 'NLN-I lab lean pipeline.lean=on implies plan.reviewMerge=on: next --run drives INIT to PLAN with zero INIT reviewer sessions'
    : 'NPM-I lab plan-light plan.reviewMerge=on: next --run drives INIT to PLAN with zero INIT reviewer sessions (the plan is reviewed once in PLAN)';
  const o = new Owner(tag, 'B-0000', machineEnv, steps, false, { fromScratch: true, config: lean ? { pipeline: { lean: 'on' } } : { plan: { reviewMerge: 'on' } } });
  const lines: string[] = [];
  try {
    const first = o.cli('next', { json: true }, { label: 'next (no Story)' });
    const template = parseJson(first.stdout) as unknown as NextStepJson | null;
    assert.equal(template?.reason, 'story_create_authoring', `[NPM-I] next prints the story_create template:\n${first.out.slice(-1500)}`);
    assert.match(template!.why, /ONE merged plan review/, '[NPM-I] the template says the plan is reviewed once in PLAN');
    assert.doesNotMatch(template!.why, /launches both managed INIT reviewers/, '[NPM-I] no INIT reviewer is announced');
    const created = o.mustCli('story_create', fillStoryCreateTemplate(template!.cli!.payload), { label: 'story_create (template)' });
    const id = created.stdout.match(/Story (B-[a-f0-9]+) created/)?.[1];
    assert.ok(id, `[NPM-I] story_create returned an id:\n${created.out.slice(-1500)}`);
    o.storyId = id!;
    assert.match(created.stdout, /no INIT reviewer runs/, `[NPM-I] story_create names the deferral:\n${created.stdout.slice(-1200)}`);
    assert.doesNotMatch(created.stdout, /run the two managed INIT reviewers/, '[NPM-I] story_create prints no INIT reviewer launch');
    writeFileSync(join(o.scriptsDir, 'resolver.json'), JSON.stringify({ argv: [process.execPath, SELF, '--provide-script', o.root, id, o.scriptsDir, JSON.stringify({ findingRound1: false })] }));
    const ran: string[] = [];
    let next: NextStepJson | undefined;
    for (let call = 0; call < 8; call += 1) {
      const asked = o.cli('next', { storyId: id, run: true, json: true }, { label: 'next --run' });
      const parsed = parseJson(asked.stdout);
      next = parsed?.next as NextStepJson | undefined;
      assert.ok(next, `[NPM-I] next --run returned no step:\n${asked.out.slice(-2000)}`);
      for (const executed of (parsed!.executed ?? []) as Array<{ command: string; reason: string; exit: number; tail: string }>) {
        ran.push(executed.reason);
        assert.equal(executed.exit, 0, `[NPM-I] next --run executed a step its gate refused: ${executed.command}\n${executed.tail}`);
      }
      if ((next.phase === 'INIT' || next.phase === 'INIT_CHECK') && (next.wait || parsed!.paused)) continue;
      break;
    }
    assert.equal(next?.phase, 'PLAN', `[NPM-I] next --run reaches PLAN; at ${next?.phase} ${next?.reason}: ${next?.why.slice(0, 400)}`);
    for (const reason of ['scope_freeze_check', 'enter_init_check', 'enter_plan']) assert.ok(ran.includes(reason), `[NPM-I] next --run ran ${reason} (ran: ${ran.join(' > ')})`);
    assert.ok(!ran.includes('init_review_launch'), `[NPM-I] no INIT reviewer launched (ran: ${ran.join(' > ')})`);
    const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
    const initRuns = existsSync(runsRoot) ? readdirSync(runsRoot).filter(runId => {
      try { return INIT_REVIEWERS.includes((JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as { agentType: string }).agentType); } catch { return false; }
    }) : [];
    assert.deepEqual(initRuns, [], '[NPM-I] zero INIT reviewer sessions');
    lines.push(`INIT reviewer sessions: 0 (production: 2); framework steps: ${ran.join(' > ')}`);
    lines.push(`stopped at ${next!.phase} ${next!.kind}:${next!.reason}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NPM-P: the ONE merged plan review in PLAN; a gap fix gets a confirmation re-review of the changed rows; only an unanswered question blocks. */
function scenarioNPMP(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NPM-P';
  const name = 'NPM-P lab plan-light plan.reviewMerge=on: one merged plan-review session answers INIT + scope questions, its rerun confirms only the changed rows, only real gaps / unanswered questions block, then DEV';
  const o = new Owner(tag, 'B-e2f2', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST,
    config: { plan: { reviewMerge: 'on' } } });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[NPM-P] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  const row = (desc: string, test: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass',
    requirementSource: 'story', verification: { command: `go test -v ./strs -run ^${test}$`, selector: `--- PASS: ${test}` }, ...extra });
  const intents: Record<string, Record<string, unknown>> = {
    'CHK-001': { happy: [row('strs.Upper(s): Upper("ab") -> "AB"', 'TestUpper')], edge: [row('Upper("") -> ""', 'TestUpperEmpty')], adversarial: [row('Upper leaves digits and symbols unchanged', 'TestUpperSymbols')] },
    'CHK-002': { happy: [row('strs.Reverse(s): Reverse("héllo") -> "olléh"', 'TestReverse')], edge: [row('Reverse("") -> ""', 'TestReverseEmpty')], adversarial: [row('Reverse of a one-rune string is that string', 'TestReverseOne')] },
  };
  const verdict = (features: Array<Record<string, unknown>>, openQuestions: Array<Record<string, unknown>> = []) => JSON.stringify({ storyId: o.storyId, features,
    summary: { total: features.length, covered: features.filter(row => row.status === 'covered').length, excluded: 0, gaps: features.filter(row => row.status === 'gap').length },
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null }, openQuestions });
  const covered1 = { feature: 'strs.Upper returns the upper-case form', covered_by: 'CHK-001', status: 'covered', excluded_by: null, source: 'request.md' };
  const covered2 = { feature: 'strs.Reverse reverses by rune', covered_by: 'CHK-002', status: 'covered', excluded_by: null, source: 'request.md' };
  const gap = { feature: 'init-review: CHK-002 userSees names no reversed output, so success is not observable', covered_by: null, status: 'gap', excluded_by: null, source: 'init-review' };
  const launchAndWait = (launch: NextStepJson, script: string, label: string): void => {
    o.script('proof-or-stop-review-scope-plan', { final: 'Merged plan review saved.', commands: [[process.execPath, CLI, 'scope_check_save', script]] });
    const payload = { ...launch.cli!.payload };
    for (const [key, value] of Object.entries({ host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort })) {
      if (typeof payload[key] !== 'string' || /^<.*>$/.test(String(payload[key]))) payload[key] = value;
    }
    const launched = o.mustCli('host_run', payload, { label });
    const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
    const terminal = waitTerminal(o, 'merged plan review', runId);
    o.unscript('proof-or-stop-review-scope-plan');
    assert.equal(terminal.state, 'completed', `[NPM-P] merged review terminal ${terminal.state} (${terminal.reason})\n${o.providerCommandLog()}`);
  };
  try {
    const store = new StoryStore(o.worktree);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'PLAN' });
    const legacy = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...legacy, items: legacy.items.map(item => ({ ...item, status: 'pending', startTime: null, verificationIntent: intents[item.id] })) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} complete plan`);
    o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });

    const launch = ask('next (PLAN, plan complete)');
    assert.equal(launch.reason, 'scope_plan_review_launch', `[NPM-P] the merged plan review runs once the plan is complete: ${launch.reason}: ${launch.why}`);
    launchAndWait(launch, verdict([covered1, covered2, gap]), 'host_run merged plan review #1');
    const firstPrompt = managedPrompts(o, 'proof-or-stop-review-scope-plan')[0]?.prompt ?? '';
    assert.match(firstPrompt, /Merged plan review \(A\/B arm \{"plan.reviewMerge":"on"\}\)/, '[NPM-P] the one session gets the merged INIT + scope questions');
    assert.match(firstPrompt, /Request traceability \(required\)/, '[NPM-P] the request-coverage function of the plan review is kept');
    assert.doesNotMatch(firstPrompt, /Confirmation re-review/, '[NPM-P] the first run is a full review');
    const saved = new StoryStore(o.worktree).readScopeCheck(o.storyId) as unknown as { planReview?: string; abVariant?: { flags?: Record<string, string> } };
    assert.equal(saved.planReview, 'merged', '[NPM-P] scope-check.json records the merged review');
    assert.deepEqual(saved.abVariant?.flags, { 'plan.reviewMerge': 'on' }, '[NPM-P] scope-check.json records the arm');

    const review = o.cli('story_review', { storyId: o.storyId }, { label: 'story_review (merged review gap)' });
    assert.match(review.out, /init-review: CHK-002 userSees/, '[NPM-P] a real gap the merged review found blocks');
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', userSees: 'go test -v ./strs -run TestReverse prints --- PASS: TestReverse; Reverse("abc") returns "cba"' }, { label: 'checklist_update CHK-002 userSees (gap fixed)' });

    const relaunch = ask('next (PLAN, gap fixed)');
    assert.equal(relaunch.reason, 'scope_plan_review_launch', `[NPM-P] the fix is confirmed by a rerun: ${relaunch.reason}: ${relaunch.why}`);
    const question = { id: 'OQ-1', q: 'Should Upper of the German sharp s expand to two letters?', evidence: 'request.md says only "the upper-case form"', sourcePointers: ['request.md'] };
    launchAndWait(relaunch, verdict([covered1, { ...covered2, feature: 'strs.Reverse reverses by rune; userSees states the output' }], [question]), 'host_run merged plan review #2 (confirmation)');
    const secondPrompt = managedPrompts(o, 'proof-or-stop-review-scope-plan').at(-1)?.prompt ?? '';
    assert.match(secondPrompt, /Confirmation re-review \(A\/B plan\.reviewMerge=on\)/, '[NPM-P] the rerun is a confirmation re-review');
    assert.match(secondPrompt, /changed items \(CHK-002\)/, '[NPM-P] only the changed item is re-judged');
    const copied = secondPrompt.split('Previous rows to copy unchanged')[1] ?? '';
    assert.match(copied, /"covered_by":"CHK-001"/, '[NPM-P] the unchanged item\'s rows are copied');
    assert.doesNotMatch(copied, /"covered_by":"CHK-002"/, '[NPM-P] the changed item\'s rows are not copied');

    const blocked = o.cli('story_review', { storyId: o.storyId }, { label: 'story_review (unanswered question)' });
    assert.match(blocked.out, /scope_open_question_unresolved: OQ-1/, '[NPM-P] an unanswered question blocks');
    o.mustCli('scope_question_resolve', { storyId: o.storyId, oqId: 'OQ-1', resolution: 'The request asks for the upper-case form only; Go strings.ToUpper semantics apply, no special casing.' }, { label: 'scope_question_resolve OQ-1' });
    const clean = o.cli('story_review', { storyId: o.storyId }, { label: 'story_review (clean)' });
    assert.doesNotMatch(clean.out, /scope_open_question_unresolved|scope_gap/, `[NPM-P] answered, nothing else blocks:\n${clean.out.slice(-1500)}`);
    const dev = ask('next (PLAN, review answered)');
    assert.equal(dev.reason, 'enter_dev', `[NPM-P] PLAN is complete after one merged review + one confirmation: ${dev.reason}: ${dev.why}`);
    const sessions = managedPrompts(o).map(row => row.agentType);
    assert.equal(sessions.filter(agent => INIT_REVIEWERS.includes(agent)).length, 0, '[NPM-P] no INIT reviewer session');
    assert.equal(sessions.filter(agent => agent === 'proof-or-stop-review-scope-plan').length, 2, '[NPM-P] two plan-review sessions: the merged review + one confirmation');
    lines.push(`plan-review sessions: ${sessions.length} (merged review + confirmation; production: 2 INIT reviewers + 2 scope-plan runs)`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NRB: the story_create template authored with several literal examples of one operand class. */
function scenarioNRB(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NRB';
  const name = 'NRB lab plan-light plan.rowBudget=on: guidance in the template, story_create lists rows that repeat an operand class with one trim command per item; request-literal rows stay; switch off = no note';
  const lines: string[] = [];
  const rowsOf = (o: Owner): number => {
    const items = new StoryStore(o.root).readChecklist(o.storyId).items;
    return items.reduce((sum, item) => sum + ['happy', 'edge', 'adversarial'].reduce((lanes, lane) => lanes + ((item.verificationIntent as Record<string, unknown[]> | undefined)?.[lane]?.length ?? 0), 0), 0);
  };
  const author = (o: Owner): { payload: Record<string, unknown>; out: string } => {
    const first = o.cli('next', { json: true }, { label: 'next (no Story)' });
    const template = parseJson(first.stdout) as unknown as NextStepJson | null;
    assert.equal(template?.reason, 'story_create_authoring', `[NRB] template:\n${first.out.slice(-1200)}`);
    const payload = fillStoryCreateTemplate(template!.cli!.payload) as Record<string, any>;
    const base = payload.checklist[0].verificationIntent.happy[0];
    const extra = (desc: string, computation: string) => ({ ...base, desc, derivation: { requestQuote: base.derivation.requestQuote, computation } });
    // Four literal examples of one class (a lower-case ASCII word), one empty input (another class), one non-ASCII word (another class).
    payload.checklist[0].verificationIntent.happy.push(extra('Upper("cd") -> "CD"', 'the upper-case form of "cd" is "CD"'),
      extra('Upper("xyz") -> "XYZ"', 'the upper-case form of "xyz" is "XYZ"'), extra('Upper("hello") -> "HELLO"', 'the upper-case form of "hello" is "HELLO"'));
    payload.checklist[0].verificationIntent.edge.push(extra('Upper("") -> ""', 'the upper-case form of "" is ""'), extra('Upper("é") -> "É"', 'the upper-case form of "é" is "É"'));
    const created = o.mustCli('story_create', payload, { label: 'story_create (redundant rows)' });
    o.storyId = created.stdout.match(/Story (B-[a-f0-9]+) created/)?.[1] ?? o.storyId;
    return { payload: template!.cli!.payload, out: `${created.stdout}${created.stderr}` };
  };
  const control = new Owner('NRB-off', 'B-0000', machineEnv, steps, false, { fromScratch: true });
  const o = new Owner(tag, 'B-0000', machineEnv, steps, false, { fromScratch: true, config: { plan: { rowBudget: 'on' } } });
  try {
    const off = author(control);
    assert.doesNotMatch(off.out, /Row budget/, '[NRB] no note with the switch absent');
    const offRows = rowsOf(control);
    control.cleanup();

    const first = o.cli('next', { json: true }, { label: 'next (no Story, guidance)' });
    assert.match((parseJson(first.stdout) as unknown as NextStepJson).why, /ONE intent row per distinct behaviour/, '[NRB] the template carries the row-budget guidance');
    const on = author(o);
    const before = rowsOf(o);
    assert.equal(before, offRows, '[NRB] the switch never drops rows by itself');
    assert.match(on.out, /Row budget \(A\/B plan\.rowBudget=on, advisory \[row_budget\]\): 3 of 6 intent rows repeat an operand class/, `[NRB] the soft check lists the repeated rows:\n${on.out.slice(-2000)}`);
    assert.match(on.out, /CHK-001:happy:1 \(same class as CHK-001:happy:0/, '[NRB] the first repeat names the row it repeats');
    const trim = on.out.split('\n').find(line => /^\s*proof-or-stop checklist_update '/.test(line));
    assert.ok(trim, '[NRB] one trim command per item');
    const json = trim!.trim().replace(/^proof-or-stop checklist_update '/, '').replace(/'$/, '');
    o.mustCli('checklist_update', JSON.parse(json) as Record<string, unknown>, { label: 'checklist_update CHK-001 (trim)' });
    const after = rowsOf(o);
    assert.equal(after, before - 3, '[NRB] the trim drops exactly the repeated rows');
    const kept = JSON.stringify(new StoryStore(o.root).readChecklist(o.storyId).items[0]!.verificationIntent);
    for (const desc of ['Upper(\\"ab\\") -> \\"AB\\"', 'Upper(\\"\\") -> \\"\\"', 'Upper(\\"é\\") -> \\"É\\"']) assert.ok(kept.includes(desc), `[NRB] ${desc} (request literal / other class) stays`);
    const evidence = join(o.root, '.proof-or-stop', 'runtime', 'plan-row-budget', `${o.storyId}.jsonl`);
    assert.ok(existsSync(evidence), '[NRB] the row budget is recorded with its A/B evidence');
    const recorded = readFileSync(evidence, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { at: string; rows: number; extras: string[]; abVariant?: { flags?: Record<string, string> } });
    assert.deepEqual([recorded[0]!.at, recorded[0]!.rows, recorded[0]!.extras.length], ['story_create', before, 3], '[NRB] story_create records rows and extras');
    assert.deepEqual(recorded[0]!.abVariant?.flags, { 'plan.rowBudget': 'on' }, '[NRB] abVariantEvidence recorded');
    lines.push(`intent rows: ${before} -> ${after} after the advisory trim (switch off: ${offRows}, no note)`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

// Lab sibling-gate (EXPERIMENTAL A/B plan.counterpartCoverage, default off; core/counterpart-coverage.ts):
// old-PoS runs 43/46/55/57/71 (run69-72-analysis.md §1). A made-up Go store in the task baseline:
// Shelf.Get counts a negative index from the end (branch + base test), Bin.Put rejects it.
const NCC_SHELF = [
  'package store', '', 'import "errors"', '',
  'var ErrOutOfRange = errors.New("index out of range")', '',
  '// Shelf is an ordered row of labels.',
  'type Shelf struct {', '\titems []string', '}', '',
  'func NewShelf(items ...string) *Shelf { return &Shelf{items: items} }', '',
  '// Get returns the label at i; a negative i counts from the end.',
  'func (s *Shelf) Get(i int) (string, error) {',
  '\tif i < 0 {', '\t\ti += len(s.items)', '\t}',
  '\tif i < 0 || i >= len(s.items) {', '\t\treturn "", ErrOutOfRange', '\t}',
  '\treturn s.items[i], nil', '}', '',
].join('\n');
const NCC_BIN = [
  'package store', '',
  'type Bin struct {', '\tslots []string', '}', '',
  'func (b *Bin) Get(i int) (string, error) {',
  '\tif i < 0 || i >= len(b.slots) {', '\t\treturn "", ErrOutOfRange', '\t}',
  '\treturn b.slots[i], nil', '}', '',
  'func (b *Bin) Put(i int, v string) error {',
  '\tif i < 0 || i >= len(b.slots) {', '\t\treturn ErrOutOfRange', '\t}',
  '\tb.slots[i] = v', '\treturn nil', '}', '',
].join('\n');
const NCC_SHELF_TEST = [
  'package store', '', 'import "testing"', '',
  'func TestShelfGet(t *testing.T) {',
  '\ts := NewShelf("a", "b", "c")',
  '\tif got, _ := s.Get(-1); got != "c" {', '\t\tt.Fatalf("Get(-1) = %q", got)', '\t}',
  '\tif _, err := s.Get(3); err != ErrOutOfRange {', '\t\tt.Fatalf("Get(3) err = %v", err)', '\t}',
  '}', '',
].join('\n');
const NCC_REQUEST = `${NIQ_REQUEST}\n- Add \`Shelf.Put(i, v)\` to the store package; it replaces the label at position i.`;

/**
 * NCC: plan.counterpartCoverage (default on since lab run102). CHK-001 adds Shelf.Put with in-range rows only; the framework finds the
 * same receiver's counterpart Shelf.Get in the Story base, which special-cases a negative and an out-of-range
 * index (branch + base test), and refuses DEV entry with ONE Next (a placeholder row per class); the rows added,
 * DEV entry is no longer refused for it. Control NCC-off: the switch off, nothing is discovered or refused.
 */
function scenarioNCC(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NCC';
  const name = 'NCC lab sibling-gate plan.counterpartCoverage (default on since lab run102): an added operation (Shelf.Put) whose same-receiver counterpart (Shelf.Get) special-cases negative / out-of-range indexes no row covers refuses DEV entry (counterpart first, Bin.Put second, one Next); rows added = pass; the implementer prompt asks for [counterpart] probes; switch off = unchanged';
  const row = (desc: string, test: string) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass',
    requirementSource: 'story', verification: { command: `go test -v ./store -run ^${test}$`, selector: `--- PASS: ${test}` } });
  const quote = 'Add `Shelf.Put(i, v)` to the store package; it replaces the label at position i.';
  const derived = (desc: string, test: string, computation: string) => ({ ...row(desc, test), derivation: { requestQuote: quote, computation } });
  const intent = {
    happy: [derived('s := NewShelf("a", "b", "c"); s.Put(1, "x"); s.Get(1) -> "x"', 'TestShelfPut', 'Put replaces the label at 1, so Get(1) reads "x"')],
    edge: [derived('s := NewShelf("a", "b", "c"); s.Put(0, "y"); s.Get(0) -> "y"', 'TestShelfPutFirst', 'Put replaces the label at 0, so Get(0) reads "y"')],
    adversarial: [derived('s := NewShelf("a", "b", "c"); s.Put(2, "z"); s.Get(2) -> "z"', 'TestShelfPutLast', 'Put replaces the label at 2, so Get(2) reads "z"')],
  };
  const files = { modify: ['store/shelf.go'], create: [], test: ['store/shelf_test.go'] };
  const baseFiles = { 'store/shelf.go': NCC_SHELF, 'store/bin.go': NCC_BIN, 'store/shelf_test.go': NCC_SHELF_TEST };
  const lines: string[] = [];
  const setup = (o: Owner): void => {
    const store = new StoryStore(o.worktree);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'PLAN' });
    const legacy = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...legacy, items: legacy.items.map(item => ({ ...item, status: 'pending', startTime: null,
      ...(item.id === 'CHK-001' ? { title: 'Add Shelf.Put', userSees: '`s.Put(1, "x")` replaces the label at 1; `s.Get(1)` then returns "x"', files, verificationIntent: intent } : {}) })) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} PLAN rows`);
    o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });
  };
  const ask = (o: Owner, label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[NCC] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${o.scenario} ${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  /** The implementer dispatch prompt of CHK-001 (rendered in DEV; the phase is set back to PLAN afterwards). */
  const implementerPrompt = (o: Owner, label: string): string => {
    const store = new StoryStore(o.worktree);
    const story = store.readStory(o.storyId);
    store.writeStory(o.storyId, { ...story, phase: 'DEV' });
    try {
      const prompt = o.cli('dispatch', { storyId: o.storyId, agentType: IMPLEMENTER, itemId: 'CHK-001' }, { label });
      assert.equal(prompt.status, 0, `[NCC] ${label} rendered:\n${prompt.out.slice(-1500)}`);
      return prompt.stdout;
    } finally {
      store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'PLAN' });
    }
  };
  // Lab run102: the switch is on by default; the control sets the recorded rollback `off`.
  const control = new Owner('NCC-off', 'B-e2c1', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NCC_REQUEST,
    config: { plan: { counterpartCoverage: 'off' } }, baseFiles });
  const o = new Owner(tag, 'B-e2c0', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NCC_REQUEST, baseFiles });
  try {
    // Control: switch off, nothing is discovered, refused or added to the implementer prompt.
    setup(control);
    const off = ask(control, 'next (switch off)');
    assert.notEqual(off.reason, 'counterpart_coverage_missing', `[NCC] with plan.counterpartCoverage=off nothing is checked: ${off.why}`);
    const offDev = control.cli('story_advance', { storyId: control.storyId, phase: 'DEV' }, { label: 'story_advance DEV (switch off)' });
    assert.doesNotMatch(offDev.out, /counterpart_coverage_missing/, '[NCC] the DEV gate is unchanged with the switch off');
    const offPrompt = implementerPrompt(control, 'dispatch implementer (switch off)');
    assert.doesNotMatch(offPrompt, /\[counterpart\]/, '[NCC] the implementer prompt is unchanged with the switch off');
    control.cleanup();

    setup(o);
    const blocked = ask(o, 'next (counterpart cases uncovered)');
    assert.equal(blocked.reason, 'counterpart_coverage_missing', `[NCC] next names the uncovered counterpart cases before the plan review: ${blocked.reason}: ${blocked.why}`);
    assert.equal(blocked.kind, 'agent');
    assert.match(blocked.why, /CHK-001 adds Shelf\.Put/, `[NCC] the item and the added operation are named: ${blocked.why}`);
    assert.match(blocked.why, /Shelf\.Get \(store\/shelf\.go:\d+\)/, '[NCC] the same receiver\'s counterpart is named with its base location');
    assert.match(blocked.why, /negative, out of range/, '[NCC] the uncovered classes are named');
    assert.match(blocked.why, /Bin\.Put[^]*?only second/, '[NCC] another receiver\'s same operation is the second oracle only');
    assert.equal(blocked.cli?.command, 'checklist_update', '[NCC] ONE next action: a checklist_update');
    // Lab initplan: a row patch appending one placeholder row per class (`CHK-001:edge:+`), no whole intent.
    const intentPatch = blocked.cli?.payload.intentRows as Array<{ ref: string; desc: string }> | undefined;
    assert.equal(blocked.cli?.payload.verificationIntent, undefined, '[NCC] a row patch, not the whole intent');
    // The merged PLAN lint step (lab initplan) may append other lints' rows (e.g. a request-literal row) to the same item.
    assert.equal(intentPatch?.filter(rowValue => rowValue.ref === 'CHK-001:edge:+' && rowValue.desc.startsWith('<Shelf.Put on ')).length, 2, '[NCC] one placeholder row per uncovered class');
    const dev = o.cli('story_advance', { storyId: o.storyId, phase: 'DEV' }, { label: 'story_advance DEV (refused: counterpart cases)' });
    assert.notEqual(dev.status, 0, '[NCC] the uncovered counterpart cases must not reach DEV');
    assert.match(dev.out, /\[counterpart_coverage_missing\]/, `[NCC] the DEV gate names the rule:\n${dev.out.slice(-1500)}`);
    assert.match(dev.out, /Next: proof-or-stop checklist_update '[^\n]*intentRows/, '[NCC] the refusal carries one Next (a row patch)');
    const evidencePath = [o.root, o.worktree].map(dir => join(dir, '.proof-or-stop', 'runtime', 'counterpart-coverage', `${o.storyId}.json`)).find(path => existsSync(path));
    assert.ok(evidencePath, '[NCC] the discovery is recorded with its A/B evidence');
    const evidence = JSON.parse(readFileSync(evidencePath!, 'utf8')) as { abVariant?: { flags?: Record<string, string> }; refusals?: unknown[]; scanned?: number };
    assert.equal(evidence.abVariant, undefined, '[NCC] the default arm (on) records no A/B evidence');
    lines.push(`discovery: ${evidence.scanned} base source file(s) scanned, ${evidence.refusals?.length} refusal(s)`);
    const onPrompt = implementerPrompt(o, 'dispatch implementer (switch on)');
    assert.match(onPrompt, /\[counterpart\] <op> :: <case> -> <base result>/, '[NCC] the implementer prompt carries the counterpart probe contract');
    assert.match(onPrompt, /Shelf\.Put: counterpart Shelf\.Get/, '[NCC] the implementer prompt names the discovered counterpart');
    lines.push(`implementer prompt: ${Buffer.byteLength(offPrompt)} B (switch off) -> ${Buffer.byteLength(onPrompt)} B (switch on), +${Buffer.byteLength(onPrompt) - Buffer.byteLength(offPrompt)} B`);

    // The owner adds one row per class whose expected value follows Shelf.Get; DEV entry is no longer refused for it.
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', verificationIntent: { ...intent, edge: [...intent.edge,
      derived('s := NewShelf("a", "b", "c"); s.Put(-1, "z"); s.Get(2) -> "z"', 'TestShelfPutNegative', 'Shelf.Get counts a negative index from the end, so Put(-1) replaces the last label and Get(2) reads "z"'),
      derived('s := NewShelf("a", "b", "c"); s.Put(3, "z") -> ErrOutOfRange', 'TestShelfPutOutOfRange', 'Shelf.Get returns ErrOutOfRange past the end, so Put(3) returns ErrOutOfRange')] } }, { label: 'checklist_update CHK-001 (counterpart rows)' });
    const after = ask(o, 'next (counterpart rows added)');
    assert.notEqual(after.reason, 'counterpart_coverage_missing', `[NCC] covered classes pass: ${after.why}`);
    const devAfter = o.cli('story_advance', { storyId: o.storyId, phase: 'DEV' }, { label: 'story_advance DEV (counterpart rows added)' });
    assert.doesNotMatch(devAfter.out, /counterpart_coverage_missing/, '[NCC] the DEV gate no longer names the rule');
    const passed = JSON.parse(readFileSync(evidencePath!, 'utf8')) as { refusals?: unknown[] };
    assert.deepEqual(passed.refusals, [], '[NCC] the recorded discovery is clean');
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Owner-driver lab NOD-INIT (owner.driver=framework). From an empty project
 * `next --untilAgent` (no Story) hands the owner the story_create template;
 * story_create then tells the owner to END its turn (not to run next --run);
 * and ONE `next --untilAgent` call (no storyId: the one unfinished Story)
 * drives INIT to PLAN's first agent step with no owner turn in between: the
 * scope freeze check, both managed INIT reviewers, every wait and pause,
 * INIT_CHECK and PLAN. NIN needs the owner to call `next --run` again after
 * each `paused:` (one owner turn plus one write_stdin poll each on Codex).
 */
function scenarioNODInit(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NOD-INIT';
  const name = 'NOD-INIT owner-driver lab: next --untilAgent reaches PLAN\'s first agent step from story_create with no owner turn (INIT reviewers, waits, INIT_CHECK, PLAN run by the framework)';
  const o = new Owner(tag, 'B-0000', machineEnv, steps, false, { fromScratch: true, config: { owner: { driver: 'framework' } } });
  const lines: string[] = [];
  try {
    const first = parseJson(o.mustCli('next', { json: true, untilAgent: true }, { label: 'next --untilAgent (no Story)' }).stdout);
    assert.equal(first?.outcome, 'agent', `[${tag}] no Story: outcome agent`);
    const template = first!.next as NextStepJson;
    assert.equal(template.reason, 'story_create_authoring', `[${tag}] no Story: the story_create template is the agent step`);
    assert.ok(!/proof-or-stop next\b|`next --run`/.test(template.why), `[${tag}] the framework-driven template text does not send the owner to next: ${template.why.slice(-400)}`);
    assert.match(String(first!.rendered), /end your turn/i, `[${tag}] the handed-back template ends with "end your turn"`);
    const created = o.mustCli('story_create', fillStoryCreateTemplate(template.cli!.payload), { label: 'story_create (template)' });
    const id = created.stdout.match(/Story (B-[a-f0-9]+) created/)?.[1];
    assert.ok(id, `[${tag}] story_create returned an id:\n${created.out.slice(-1500)}`);
    o.storyId = id!;
    assert.match(created.stdout, /Next: end your turn now \(owner\.driver=framework\)/, `[${tag}] story_create tells the framework-driven owner to end its turn:\n${created.stdout.slice(-1200)}`);
    assert.ok(!created.stdout.includes(`Next: proof-or-stop next --storyId=${id} --run`), `[${tag}] story_create does not send the framework-driven owner to next --run`);
    assert.ok(!created.stdout.includes('Manual equivalent'), `[${tag}] no manual INIT reviewer sequence for a framework-driven owner`);
    writeFileSync(join(o.scriptsDir, 'resolver.json'), JSON.stringify({ argv: [process.execPath, SELF, '--provide-script', o.root, id, o.scriptsDir, JSON.stringify({ findingRound1: false })] }));
    const asked = o.mustCli('next', { json: true, untilAgent: true }, { label: 'next --untilAgent (INIT)' });
    const parsed = parseJson(asked.stdout)!;
    const next = parsed.next as NextStepJson;
    const ran = ((parsed.executed ?? []) as Array<{ reason: string; exit: number; command: string; tail: string }>).map(row => {
      assert.equal(row.exit, 0, `[${tag}] the driver ran a step its gate refused: ${row.command}\n${row.tail}`);
      return row.reason;
    });
    assert.equal(parsed.outcome, 'agent', `[${tag}] one call ends at an agent step (outcome ${String(parsed.outcome)}, stopped ${String(parsed.stopped)}):\n${String(parsed.rendered).slice(-1500)}`);
    assert.equal(parsed.storyId, id, `[${tag}] without --storyId the driver drives the one unfinished Story`);
    assert.equal(next.phase, 'PLAN', `[${tag}] the first agent step is in PLAN; at ${next.phase} ${next.kind}:${next.reason}`);
    assert.equal(next.kind, 'agent');
    for (const reason of ['scope_freeze_check', 'init_review_launch', 'managed_run_wait', 'enter_init_check', 'enter_plan', 'dev_memory_preflight_ack', 'scope_plan_review_launch']) {
      assert.ok(ran.includes(reason), `[${tag}] the driver ran ${reason} (ran: ${ran.join(' > ')})`);
    }
    assert.equal(ran.filter(reason => reason === 'init_review_launch').length, 2, `[${tag}] both INIT reviewers launched by the framework`);
    assert.match(String(parsed.rendered), /end your turn: owner\.driver=framework/, `[${tag}] the handed-back step tells the owner to end its turn afterwards`);
    const calls = (parsed.calls as unknown[]).length;
    lines.push(`owner turns story_create -> PLAN agent step: 0 (1 next --untilAgent call; ${calls} next --run call(s) inside it, ${ran.length} framework steps: ${ran.join(' > ')})`);
    lines.push(`handed back: ${next.phase} ${next.kind}:${next.reason}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Owner-driver lab NOD: D's flow (one verified finding in round 1, critic,
 * remediation back to DEV, managed repair, framework resolve, round 2, PRE_CERT,
 * TEST, DONE) driven twice from REVIEW entry with the same scripted owner:
 * llm mode (the owner's `next --run` loop, as ND-run) and framework mode
 * (`next --untilAgent`, owner.driver=framework). The owner must get exactly
 * the same judgment steps in both modes (none auto-performed, none lost), only
 * agent steps in framework mode, and fewer owner invocations.
 */
function scenarioNOD(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NOD';
  const name = 'NOD owner-driver lab: D\'s flow to DONE in framework mode (next --untilAgent) hands the owner the same judgment steps as llm mode with fewer owner invocations';
  const lines: string[] = [];
  let current: Owner | null = null;
  try {
    const llm = current = new Owner('NOD-llm', 'B-e6a1', machineEnv, steps, false, { trackedGateFailureCounts: true });
    devSetup(llm);
    const llmLines: string[] = [];
    const a = driveWithNext(llm, { findingRound1: true, run: true }, llmLines);
    assert.equal(new StoryStore(llm.root).readStory(llm.storyId).phase, 'DONE');
    llm.cleanup();
    const fw = current = new Owner(tag, 'B-e6a2', machineEnv, steps, false, { trackedGateFailureCounts: true, config: { owner: { driver: 'framework' } } });
    devSetup(fw);
    const b = driveWithNext(fw, { findingRound1: true, run: true, drive: true }, lines);
    assert.match(git(fw.root, ['log', '--format=%s', '-3', 'main']), new RegExp(`merge: ${fw.storyId} `), `[${tag}] story branch merged into main`);
    assert.match(readFileSync(join(fw.root, 'strs/strs_test.go'), 'utf8'), /TestReverseEmpty/, `[${tag}] repair merged into main`);
    // Lab neutral-64: the default live-smoke capture (the project validate command) is a framework step under owner.driver=framework
    // (a mechanical 0.4-minute owner turn in run 64); every other judgment step is still the owner's.
    assert.deepEqual(b.ownerSteps, a.ownerSteps.filter(reason => reason !== 'live_smoke'), `[${tag}] framework mode hands the owner the judgment steps llm mode does, minus the mechanical live_smoke capture:\nllm:       ${a.ownerSteps.join(' > ')}\nframework: ${b.ownerSteps.join(' > ')}`);
    assert.ok(existsSync(join(fw.root, '.proof-or-stop/story', 'actives', fw.storyId, 'evidence', 'live-smoke-transcript.json')) || /live_smoke/.test(lines.join('\n')), `[${tag}] the framework recorded the live-smoke transcript`);
    assert.ok(b.ownerTurns < a.ownerTurns, `[${tag}] fewer owner invocations in framework mode (${b.ownerTurns} vs ${a.ownerTurns})`);
    lines.push(`owner invocations from REVIEW entry: llm ${a.ownerTurns} (${a.nextCalls} next --run calls + ${a.ownerSteps.length} owner steps) vs framework ${b.ownerTurns} (${b.ownerSteps.length} owner steps; ${b.nextCalls} next --untilAgent calls made by the driver, ${b.driverRunCalls} next --run calls inside them)`);
    lines.push(`owner judgment steps (llm mode's minus the mechanical live_smoke capture): ${b.ownerSteps.join(' > ') || 'none'}`);
    fw.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    if (current) console.log(`${tag} fixture retained for diagnosis: ${current.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Owner-driver lab NOD-W (old-PoS run 55: `next --run` idle 25.8 min after a
 * completed wait until the owner killed it). A post-commit hook of the fixture
 * hangs ONCE (sleep) inside the first framework review-evidence commit, so the
 * `next --run` call the driver made blocks on that step. The driver's watchdog
 * (PROOF_OR_STOP_DRIVE_STEP_STALL_MS shortened for the fixture) kills the
 * call's process group, decides again from the real state, and the Story
 * still reaches DONE with no owner action.
 */
function scenarioNODW(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NOD-W';
  const name = 'NOD-W owner-driver lab: a hung step inside next --run (git hook blocked in a review commit) is killed by the driver watchdog and decided again; DONE';
  const o = new Owner(tag, 'B-e6a3', machineEnv, steps, false, { config: { owner: { driver: 'framework' } } });
  const lines: string[] = [];
  try {
    devSetup(o);
    const hookRel = git(o.worktree, ['rev-parse', '--git-path', 'hooks/post-commit']);
    const hook = isAbsolute(hookRel) ? hookRel : join(o.worktree, hookRel);
    assert.ok(!existsSync(hook), `[${tag}] the fixture has no post-commit hook of its own (${hook})`);
    const marker = join(o.root, '.nodw-hung-once');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, [
      '#!/bin/sh',
      `[ -e '${marker}' ] && exit 0`,
      `case "$(git log -1 --format=%s)" in ${NODW_HANG_SUBJECT}) ;; *) exit 0 ;; esac`,
      `git log -1 --format=%s > '${marker}'`,
      'sleep 600',
      'exit 0', '',
    ].join('\n'));
    chmodSync(hook, 0o755);
    o.setEnv('PROOF_OR_STOP_DRIVE_STEP_STALL_MS', '15000');
    o.setEnv('PROOF_OR_STOP_DRIVE_STALL_MS', '15000');
    o.setEnv('PROOF_OR_STOP_DRIVE_POLL_MS', '500');
    const stats = driveWithNext(o, { findingRound1: false, run: true, drive: true }, lines);
    assert.ok(existsSync(marker), `[${tag}] the hook hung inside a framework commit`);
    assert.ok(stats.watchdogKills.length >= 1, `[${tag}] the driver watchdog killed the hung call`);
    assert.equal(stats.watchdogKills[0]!.reason, 'step_stall', `[${tag}] a hung step (a process below the call), not an idle next`);
    lines.push(`hung commit: ${readFileSync(marker, 'utf8').trim()}; watchdog: ${stats.watchdogKills.map(row => `${row.reason} after ${(row.silentMs / 1000).toFixed(1)} s`).join(', ')}`);
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Owner-driver lab NOD-DUP (old-PoS run 65, owner.driver=framework): the task was DONE and
 * merged at minute 48, then the framework created two more Stories for the same request until
 * the timeout. The sequence: the TEST authoring step text told the owner to run `next --run`,
 * the owner did (it executed enter_done), and the driver's next `next --untilAgent` (no storyId)
 * saw "no unfinished Story" and handed back the story_create template as an agent step.
 *   1. no step text the driver hands back tells the owner to run next (driveWithNext Q6), even
 *      though this scripted owner runs `next --run` after TEST authoring anyway (the coin flip);
 *   2. `next --untilAgent` with every Story DONE is a terminal `done` outcome, never story_create;
 *   3. story_create of the request a DONE Story already delivered is refused (explicit and staged
 *      request), fail-closed; owner.driver=llm keeps creating it (advisory stderr note).
 */
function scenarioNODDup(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NOD-DUP';
  const name = 'NOD-DUP old-PoS run 65: after DONE under owner.driver=framework `next --untilAgent` ends (done) and story_create refuses the delivered request; no step text sends the owner to next --run';
  const o = new Owner(tag, 'B-e6a4', machineEnv, steps, false, { request: NIQ_REQUEST, config: { owner: { driver: 'framework' } } });
  const lines: string[] = [];
  try {
    devSetup(o);
    let followed = false;
    // Every defect is reported (soft checks), so the RED run names all three fixes.
    const problems: string[] = [];
    const soft = (fn: () => void): void => { try { fn(); } catch (error) { problems.push(error instanceof Error ? error.message.split('\n')[0]! : String(error)); } };
    driveWithNext(o, { findingRound1: false, run: true, drive: true, violations: problems, interject: next => {
      // The run-65 owner: follows the step text of TEST authoring literally (authoring commands, then next --run).
      if (next.reason !== 'test_authoring' || followed) return false;
      followed = true;
      for (const call of next.batch ?? []) {
        const filled = { ...call.cli.payload };
        authorPayload(o, call.reason, filled, () => '');
        o.mustCli(call.cli.command, filled, { label: `  owner:${call.reason}` });
      }
      o.mustCli('next', { storyId: o.storyId, run: true, json: true }, { label: 'owner next --run (run 65)' });
      return true;
    } }, lines);
    assert.ok(followed, `[${tag}] the TEST authoring step reached the owner`);
    const store = new StoryStore(o.root);
    assert.equal(store.readStory(o.storyId).phase, 'DONE');
    const idsBefore = store.listStoryIds().length;
    // 2. the driver's next call after DONE (no storyId).
    const after = o.cli('next', { json: true, untilAgent: true }, { label: 'next --untilAgent (all Stories DONE)' });
    assert.equal(after.status, 0, `[${tag}] next --untilAgent after DONE:\n${after.out.slice(-1500)}`);
    const parsed = parseJson(after.stdout)!;
    soft(() => assert.equal(parsed.outcome, 'done', `[${tag}] all Stories DONE: outcome done, not ${String(parsed.outcome)}`));
    soft(() => assert.equal(parsed.storyId, o.storyId, `[${tag}] the done outcome names the DONE Story`));
    soft(() => assert.notEqual((parsed.next as NextStepJson).reason, 'story_create_authoring', `[${tag}] never the story_create template`));
    soft(() => assert.ok(!/story_create/.test(String(parsed.rendered)), `[${tag}] the rendered terminal step does not mention story_create`));
    // 3. the delivered request is refused (explicit request, then a staged one).
    const template = parseJson(o.mustCli('next', { json: true }, { label: 'next (no unfinished Story)' }).stdout) as unknown as NextStepJson;
    assert.equal(template.reason, 'story_create_authoring', `[${tag}] plain next still prints the template (a new request is the owner's call)`);
    const filled = fillStoryCreateTemplate(template.cli!.payload);
    const explicit = o.cli('story_create', { ...filled, request: NIQ_REQUEST }, { label: 'story_create (delivered request)' });
    soft(() => assert.notEqual(explicit.status, 0, `[${tag}] story_create of the delivered request must be refused`));
    soft(() => assert.match(explicit.out, /request_already_delivered/, `[${tag}] refusal names the rule`));
    soft(() => assert.match(explicit.out, new RegExp(o.storyId), `[${tag}] refusal names the delivered Story`));
    o.mustCli('story_request_set', { request: NIQ_REQUEST }, { label: 'story_request_set (stage)' });
    const staged = o.cli('story_create', filled, { label: 'story_create (staged delivered request)' });
    soft(() => assert.notEqual(staged.status, 0, `[${tag}] story_create of the staged delivered request must be refused`));
    soft(() => assert.match(staged.out, /request_already_delivered/, `[${tag}] staged refusal names the rule`));
    soft(() => assert.equal(store.listStoryIds().length, idsBefore, `[${tag}] no Story was created`));
    // owner.driver=llm keeps today's behaviour: the delivered request is created again, with an advisory note.
    const configPath = join(o.root, 'proof-or-stop.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, any>;
    delete config.owner;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const llmCreate = o.cli('story_create', { ...filled, request: NIQ_REQUEST }, { label: 'story_create (delivered request, owner.driver=llm)' });
    soft(() => assert.equal(llmCreate.status, 0, `[${tag}] owner.driver=llm still creates the delivered request: ${llmCreate.out.slice(-600)}`));
    soft(() => assert.match(llmCreate.out, new RegExp(`already delivered by ${o.storyId}`), `[${tag}] llm mode prints the advisory note`));
    // A different request is not refused.
    const other = o.cli('story_create', { ...filled, request: `${NIQ_REQUEST}\nAlso: a different, new request.` }, { label: 'story_create (different request)' });
    soft(() => assert.ok(!/request_already_delivered/.test(other.out), `[${tag}] a different request is not refused as delivered`));
    assert.deepEqual([...new Set(problems)], [], `[${tag}] run-65 defects:\n- ${[...new Set(problems)].join('\n- ')}`);
    lines.push(`after DONE: next --untilAgent -> done (${o.storyId}); story_create of the delivered request refused (explicit and staged); a different request is not`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NOD-W: the commit subject (sh case pattern) whose post-commit hook hangs once. */
const NODW_HANG_SUBJECT = '*review*evidence*|*managed*review*';

/**
 * NX, old-PoS runs 20 and 25 (F1): the task's own Unicode test prints a CJK
 * subtest name under `go test -v`. The framework captures that output into
 * checklist.json verification evidence (`outputTail`), and the DONE summary's
 * observed transcript quotes it. Captured program output is not owner prose:
 * the English-only gate must not refuse REVIEW→TEST or DONE on it, and the
 * owner never has to edit the tests (run 25 edited fixtures and livelocked).
 */
function scenarioNX(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const name = 'NX old-PoS runs 20/25 F1: CJK in captured go test -v output (checklist outputTail) and the observed DONE transcript never trips the English-only gate; DONE';
  const o = new Owner('NX', 'B-e2d1', machineEnv, steps, false, { unicodeOutput: true });
  const lines: string[] = [];
  try {
    devSetup(o);
    const storyDir = new StoryStore(o.worktree).storyDirPath(o.storyId);
    const checklist = JSON.parse(readFileSync(join(storyDir, 'checklist.json'), 'utf8')) as { items: Array<{ verificationEvidence?: unknown[] }> };
    assert.ok(JSON.stringify(checklist).includes(CJK_WORD), 'NX precondition: the captured go test -v output in checklist.json carries the CJK subtest name');
    driveWithNext(o, { findingRound1: false, run: false }, lines);
    assert.ok(readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8').includes(CJK_WORD), 'NX: the Unicode test reached main unchanged (no fixture edit to satisfy the gate)');
    const summary = readFileSync(join(new StoryStore(o.root).storyDirPath(o.storyId), 'summary.json'), 'utf8');
    assert.ok(summary.includes(CJK_WORD), 'NX: the observed transcript kept the verbatim CJK output');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`NX fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NM, old-PoS run 25 (F2): after a clean round (lanes pass, critic, finalize,
 * certification) the owner commits a test-only change while still in REVIEW.
 * Material changed since the round's head and no finding is open, so the round
 * can never certify that material. Before: `next` said `human — none runnable`
 * and story_advance DEV refused without a FINALIZED inventory receipt. Now next
 * returns ONE framework step, the review reopen (story_advance DEV): the reason
 * is recorded on the phase_transition, the round is invalidated, DEV refreshes
 * the stale evidence and a fresh round reviews the new material, then DONE.
 */
function scenarioNM(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const name = 'NM old-PoS run 25 F2: material committed during REVIEW without a finding -> one framework review_reopen step, fresh round, DONE';
  const o = new Owner('NM', 'B-e2d2', machineEnv, steps);
  const lines: string[] = [];
  let edited = false;
  let afterEdit: NextStepJson | undefined;
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: false, run: false, interject: next => {
      if (edited || next.reason !== 'enter_test') return false;
      edited = true;
      write(o.worktree, 'strs/strs_test.go', `${readFileSync(join(o.worktree, 'strs/strs_test.go'), 'utf8')}\nfunc TestUpperEmpty(t *testing.T) {\n\tif Upper("") != "" {\n\t\tt.Fatal("empty")\n\t}\n}\n`);
      git(o.worktree, ['add', 'strs/strs_test.go']);
      git(o.worktree, ['commit', '-qm', 'owner: add an empty-string Upper test during REVIEW']);
      lines.push(`owner test-only commit in REVIEW after a clean round: ${git(o.worktree, ['log', '--format=%h %s', '-1'])}`);
      // The owner's own story_advance TEST is routed with exactly one Next (the reopen), never a dead end.
      const refused = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: 'owner story_advance TEST (REVIEW-time edit)' });
      assert.notEqual(refused.status, 0, `NM: TEST must refuse a round whose material changed:\n${refused.out.slice(-1500)}`);
      const nextLines = [...new Set(refused.out.split('\n').filter(line => line.includes('Next: ')).map(line => line.slice(line.indexOf('Next: '))))];
      assert.deepEqual(nextLines, [`Next: proof-or-stop story_advance '{"storyId":"${o.storyId}","phase":"DEV"}'`], `NM: one Next naming the review reopen:\n${refused.out.slice(-1500)}`);
      lines.push(`owner story_advance TEST refused with: ${nextLines[0]}`);
      return true;
    } }, lines, next => { if (edited && !afterEdit) afterEdit = next; });
    assert.ok(edited, 'NM: the harness committed the REVIEW-time change');
    assert.equal(afterEdit?.reason, 'review_reopen', `NM: next's first step after the material change is the review reopen (got ${afterEdit?.kind} ${afterEdit?.reason}: ${afterEdit?.why})`);
    assert.equal(afterEdit?.kind, 'framework', 'NM: the reopen is a framework step');
    assert.deepEqual(afterEdit?.cli, { command: 'story_advance', payload: { storyId: o.storyId, phase: 'DEV' } }, 'NM: the reopen is story_advance DEV');
    const events = new StoryStore(o.root).readProcessEvents(o.storyId) as unknown as Array<Record<string, unknown>>;
    const reopen = events.find(row => row.type === 'phase_transition' && row.fromPhase === 'REVIEW' && row.toPhase === 'DEV');
    assert.equal(reopen?.transitionType, 'review_reopen', `NM: the REVIEW→DEV transition is recorded as a review reopen: ${JSON.stringify(reopen)}`);
    assert.match(String(reopen?.reason ?? ''), /material changed since review round .* no open finding/, `NM: the reopen reason is recorded: ${String(reopen?.reason)}`);
    const rounds = new Set(events.filter(row => row.type === 'phase_transition' && row.toPhase === 'REVIEW').map(row => String(row.reviewRound)));
    assert.equal(rounds.size, 2, `NM: REVIEW re-entered with a fresh round (${[...rounds].join(', ')})`);
    assert.match(readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8'), /TestUpperEmpty/, 'NM: the REVIEW-time change was reviewed and merged');
    lines.push(`reopen recorded: ${String(reopen?.reason).slice(0, 140)}`);
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`NM fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Old-PoS run 27 (B-c562 §4): N1 launches the delivery reviewer at TEST entry
 * and lets the owner author the finish decision/summary and next --run submit
 * the single-host quorum meanwhile. Both commit metadata only, so HEAD moves
 * under the reviewer's dispatch binding while material and story files stay.
 *   NDL: the first delivery run saves after both overlap commits; its
 *        delivery_check_set must be accepted (one delivery run, completed, no
 *        save-repair turns), DONE.
 *   NDS: the first run also commits a change to a delivery input (a
 *        delivery_context_pack publication) before saving: the refusal is a
 *        deterministic stale binding, so the run ends without same-session
 *        save-repair turns, and next --run relaunches the delivery reviewer
 *        itself (a framework step, never the owner's), DONE.
 */
/**
 * NQR (old-PoS run 40 §6, the NDS harness flake: quorum_submit --singleHost
 * refused about 1 run in 4): another framework writer (the delivery reviewer's
 * metadata save under the N1 overlap) appends to process-events.jsonl inside
 * the single-host closeout's post-commit window. The closeout refuses and rolls
 * back its own commit (fail-closed, unchanged), and `next --run` stopped on a
 * refused framework step. Here a post-commit hook of the fixture repository
 * plays that writer deterministically: on the first quorum-submit metadata
 * commit it appends one journal line, and a second later a framework command
 * (review_host_availability_probe) journals and commits the Story metadata
 * with it, as the delivery reviewer's save does. quorum_submit --singleHost must wait for the
 * concurrent writer to land and redo its closeout on the new HEAD; DONE.
 */
function scenarioNQR(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NQR';
  const name = 'NQR old-PoS run 40 (NDS flake): a concurrent process-events writer inside the single-host quorum closeout window is waited for and the closeout redone, not a refused next --run step; DONE';
  const o = new Owner(tag, 'B-e2b4', machineEnv, steps);
  const lines: string[] = [];
  try {
    devSetup(o);
    const hookRel = git(o.worktree, ['rev-parse', '--git-path', 'hooks/post-commit']);
    const hook = isAbsolute(hookRel) ? hookRel : join(o.worktree, hookRel);
    assert.ok(!existsSync(hook), `[${tag}] the fixture has no post-commit hook of its own (${hook})`);
    const storyDir = new StoryStore(o.worktree).storyDirPath(o.storyId);
    const marker = join(o.root, '.nqr-concurrent-writer');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, [
      '#!/bin/sh',
      `[ -e '${marker}' ] && exit 0`,
      "case \"$(git log -1 --format=%s)\" in *quorum-submit*) ;; *) exit 0 ;; esac",
      `touch '${marker}'`,
      `printf '%s\\n' '{"type":"harness_concurrent_metadata_writer"}' >> '${storyDir}/process-events.jsonl'`,
      // The writer's own authenticated metadata commit: a framework command that journals and commits the Story metadata.
      `(unset GIT_INDEX_FILE; sleep 1; cd '${o.worktree}' && '${process.execPath}' '${CLI}' review_host_availability_probe '{"storyId":"${o.storyId}","json":true}') >'${marker}.log' 2>&1 &`,
      'exit 0', '',
    ].join('\n'));
    chmodSync(hook, 0o755);
    driveWithNext(o, { findingRound1: false, run: true }, lines);
    assert.ok(existsSync(marker), `[${tag}] the concurrent writer fired inside a quorum-submit closeout`);
    const subjects = git(o.root, ['log', '--format=%s', '-60', 'main']);
    assert.match(subjects, /quorum-submit metadata/, `[${tag}] the single-host quorum was committed`);
    const journal = readFileSync(join(storyDir.replace(o.worktree, o.root), 'process-events.jsonl'), 'utf8');
    assert.match(journal, /harness_concurrent_metadata_writer/, `[${tag}] the concurrent writer's journal line is kept (committed by its own writer):\n${readFileSync(`${marker}.log`, 'utf8').slice(-800)}`);
    lines.push('DONE reached with a concurrent process-events writer inside the single-host quorum closeout');
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

function scenarioNDL(machineEnv: NodeJS.ProcessEnv, steps: Step[], fault: DeliveryFault): Outcome {
  const tag = fault === 'overlap' ? 'NDL' : 'NDS';
  const name = fault === 'overlap'
    ? 'NDL run 27: delivery_check_set after the N1 overlap metadata commits (summary_set, quorum-submit) is accepted; one delivery run, DONE'
    : 'NDS run 27: a genuinely stale delivery binding fails without save-repair and next --run relaunches the delivery reviewer itself, DONE';
  const o = new Owner(tag, fault === 'overlap' ? 'B-e2b1' : 'B-e2b2', machineEnv, steps);
  const lines: string[] = [];
  const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
  const deliveryRuns = (): Array<{ runId: string; createdAt: string; state?: string; reason?: string; events: string[] }> => existsSync(runsRoot) ? readdirSync(runsRoot).flatMap(runId => {
    try {
      const spec = JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as { agentType?: string; createdAt?: string };
      if (spec.agentType !== DELIVERY) return [];
      const terminalPath = join(runsRoot, runId, 'terminal.json');
      const terminal = existsSync(terminalPath) ? JSON.parse(readFileSync(terminalPath, 'utf8')) as { state?: string; reason?: string } : {};
      const events = readFileSync(join(runsRoot, runId, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => String((JSON.parse(line) as { type?: string }).type));
      return [{ runId, createdAt: String(spec.createdAt ?? ''), state: terminal.state, reason: terminal.reason, events }];
    } catch { return []; }
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: false, run: true, delivery: fault }, lines);
    const runs = deliveryRuns();
    lines.push(`delivery runs: ${runs.map(run => `${run.state}${run.reason && run.state !== 'completed' ? ` (${run.reason})` : ''}${run.events.includes('managed_dispatch_save_repair') ? ' +save-repair' : ''}`).join(' > ')}`);
    const subjects = git(o.root, ['log', '--format=%s', '-40', 'main']);
    assert.match(subjects, /quorum-submit metadata/, `${tag}: the single-host quorum was submitted during the overlap`);
    if (fault === 'overlap') {
      assert.equal(runs.length, 1, `${tag}: exactly one delivery run (no relaunch): ${JSON.stringify(runs.map(run => [run.state, run.reason]))}`);
      assert.equal(runs[0]!.state, 'completed', `${tag}: the delivery run whose dispatch head was moved only by metadata-only overlap commits completed (${String(runs[0]!.reason)})`);
      assert.ok(!runs[0]!.events.includes('managed_dispatch_save_repair'), `${tag}: no save-repair turn was needed`);
    } else {
      assert.equal(runs.length, 2, `${tag}: the stale run plus one framework relaunch: ${JSON.stringify(runs.map(run => [run.state, run.reason]))}`);
      assert.equal(runs[0]!.state, 'failed', `${tag}: the first run failed on its stale binding`);
      assert.match(String(runs[0]!.reason), /^managed_dispatch_binding_stale/, `${tag}: the stale binding is its own terminal reason`);
      assert.ok(!runs[0]!.events.includes('managed_dispatch_save_repair'), `${tag}: a deterministic stale-binding refusal never resumes the session for a save-repair turn (events: ${runs[0]!.events.join(', ')})`);
      assert.equal(runs[1]!.state, 'completed', `${tag}: the relaunched delivery run completed`);
    }
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Old-PoS run 27 (§2.2, row 1): lane shell commands took ~5.7 s with 4 lanes
 * live. NDG: every managed run records per-command wall time (Codex
 * item.started -> item.completed) and host load samples in its run directory
 * (diagnostics.jsonl), host_run_status --full summarizes them, and
 * review.laneLaunchStaggerMs (default 8000 since runs 28/29; 0 = parallel) spaces the lane launches.
 */
function scenarioNDG(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NDG';
  const name = 'NDG run 27: managed runs record per-command wall time + host load; host_run_status --full summarizes; review.laneLaunchStaggerMs spaces lane launches';
  const staggerMs = 4000;
  const o = new Owner(tag, 'B-e2b3', machineEnv, steps, false, { config: { review: { laneLaunchStaggerMs: staggerMs } } });
  const lines: string[] = [];
  const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: false, run: true }, lines);
    const runs = readdirSync(runsRoot).map(runId => ({ runId, spec: JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as { agentType: string; createdAt: string; reviewRunId?: string | null } }));
    const firstLanes = runs.filter(run => run.spec.agentType.startsWith('proof-or-stop-review-') && run.spec.agentType !== DELIVERY && run.spec.agentType !== MANAGED_INVENTORY_CRITIC_LANE)
      .map(run => Date.parse(run.spec.createdAt)).sort((a, b) => a - b);
    assert.ok(firstLanes.length >= 2, `${tag}: the round launched several lanes (${firstLanes.length})`);
    const spread = firstLanes.at(-1)! - firstLanes[0]!;
    lines.push(`lane launches: ${firstLanes.length}, createdAt spread ${(spread / 1000).toFixed(1)} s with review.laneLaunchStaggerMs=${staggerMs}`);
    assert.ok(spread >= staggerMs * (firstLanes.length - 1) * 0.6, `${tag}: lane launches are staggered by ${staggerMs} ms (spread ${spread} ms over ${firstLanes.length} lanes)`);
    const delivery = runs.find(run => run.spec.agentType === DELIVERY)!;
    const diagnosticsPath = join(runsRoot, delivery.runId, 'diagnostics.jsonl');
    assert.ok(existsSync(diagnosticsPath), `${tag}: the delivery run recorded diagnostics.jsonl`);
    const rows = readFileSync(diagnosticsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; ms?: number; load1?: number; liveRuns?: number });
    assert.ok(rows.some(row => row.type === 'command' && typeof row.ms === 'number' && row.ms >= 0), `${tag}: a per-command wall-time row: ${JSON.stringify(rows.slice(0, 4))}`);
    assert.ok(rows.some(row => row.type === 'load' && typeof row.load1 === 'number' && typeof row.liveRuns === 'number'), `${tag}: a host load sample row: ${JSON.stringify(rows.slice(0, 4))}`);
    const full = o.cli('host_run_status', { runId: delivery.runId, full: true }, { label: 'host_run_status --full (delivery)' });
    const status = parseJson(full.stdout) as { diagnostics?: { commands?: { count?: number; medianMs?: number }; load?: { samples?: number } } } | null;
    assert.ok((status?.diagnostics?.commands?.count ?? 0) >= 1, `${tag}: --full summarizes the command timings: ${JSON.stringify(status?.diagnostics ?? null)}`);
    assert.ok((status?.diagnostics?.load?.samples ?? 0) >= 1, `${tag}: --full summarizes the load samples: ${JSON.stringify(status?.diagnostics ?? null)}`);
    lines.push(`delivery diagnostics: ${JSON.stringify(status!.diagnostics).slice(0, 220)}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Old-PoS run 29 (REM2, run28-29-analysis.md §3.4): the grouped repair worker
 * put its regression test in a NEW file outside the item's declared files
 * (allowedCreate empty). The repair prompt never stated the allowed files, and
 * only the REVIEW scope gate caught it, as an owner step (6 turns). NRS: the
 * finding-repair prompt names the allowed files; the worker's commit is
 * scope-checked when the provider ends and, on a violation, the SAME session is
 * resumed once with the exact paths and the allowed lists; the moved test is
 * committed and next --run reaches DONE without a scope stop.
 */
function scenarioNRS(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NRS';
  const name = 'NRS run 29 REM2: repair prompt states the allowed files; an out-of-scope repair commit is fixed in the same worker session (no owner scope stop); DONE';
  const o = new Owner(tag, 'B-e2c9', machineEnv, steps, false, { trackedGateFailureCounts: true, codexHome: true });
  const lines: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: true, repairOutOfScope: true }, lines);
    const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
    const repairRuns = readdirSync(runsRoot).filter(runId => (JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as { agentType?: string }).agentType === FINDING_REPAIR);
    assert.equal(repairRuns.length, 1, `${tag}: one finding-repair run (no relaunch): ${repairRuns.join(', ')}`);
    const runId = repairRuns[0]!;
    const prompt = readFileSync(join(o.scriptsDir, 'prompts', `${runId}.txt`), 'utf8');
    assert.match(prompt, /Allowed files[^\n]*\n[^]*strs\/strs_test\.go/, `${tag}: the repair prompt states the allowed files:\n${prompt.slice(-3000)}`);
    assert.match(prompt, /do not create any other file/i, `${tag}: the repair prompt forbids other files`);
    const resumePath = join(o.scriptsDir, 'prompts', `${runId}.resume.txt`);
    assert.ok(existsSync(resumePath), `${tag}: the worker resumed the repair session for the scope violation`);
    const resumePrompt = readFileSync(resumePath, 'utf8');
    assert.ok(resumePrompt.includes(NRS_OUT_OF_SCOPE_TEST), `${tag}: the scope repair turn names the out-of-scope path:\n${resumePrompt}`);
    assert.ok(resumePrompt.includes('strs/strs_test.go'), `${tag}: the scope repair turn names the allowed test files:\n${resumePrompt}`);
    const events = readFileSync(join(runsRoot, runId, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { type: string; detail?: { outcome?: string } });
    assert.ok(events.some(row => row.type === 'managed_writer_scope_repair'), `${tag}: the scope repair turn is journaled on the run`);
    assert.ok(events.some(row => row.type === 'managed_writer_scope_repair_outcome' && row.detail?.outcome === 'in_scope'),
      `${tag}: the resumed turn left the run in scope: ${JSON.stringify(events.filter(row => row.type.startsWith('managed_writer_scope')))}`);
    assert.ok(!existsSync(join(o.root, NRS_OUT_OF_SCOPE_TEST)), `${tag}: the out-of-scope file never reached main`);
    assert.match(readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8'), /TestReverseEmpty/, `${tag}: the moved regression test reached main`);
    lines.push(`DONE reached; repair run ${runId} resumed once for scope; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Old-PoS run 28 INIT (run28-29-analysis.md §3.1): both INIT reviewers blocked;
 * the owner fixed priority and a pinned intent, but next kept returning
 * `init_review_blockers` because the INIT signature covers checklist
 * title/context only, so the verdict never went stale (about 12 owner turns
 * and two hand-launched reviewers). And story_create had only WARNED about
 * priority=high without risk wording, which the story-init reviewer then
 * raised as a high issue. NIS:
 *   - story_create with priority=high and no risk wording records medium and
 *     says so (no reviewer round for a mechanical rule);
 *   - the first story-init run blocks on CHK-001's userSees; the owner edits
 *     ONLY userSees (one checklist_update); next --run then relaunches the
 *     blocking reviewer itself (framework init_review_launch) because the
 *     inputs it judged changed, and reaches PLAN with no further owner INIT step.
 */
function scenarioNIS(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NIS';
  const name = 'NIS run 28 INIT: priority=high without risk wording is lowered at story_create; a blocking INIT verdict on userSees goes stale on the owner fix and next --run relaunches the reviewer itself';
  const o = new Owner(tag, 'B-0000', machineEnv, steps, false, { fromScratch: true });
  const lines: string[] = [];
  try {
    const first = o.cli('next', { json: true }, { label: 'next (no Story)' });
    const template = parseJson(first.stdout) as unknown as NextStepJson | null;
    assert.equal(template?.reason, 'story_create_authoring', `[NIS] next without a Story prints the story_create template:\n${first.out.slice(-1500)}`);
    const payload = { ...fillStoryCreateTemplate(template!.cli!.payload), priority: 'high' };
    const created = o.mustCli('story_create', payload, { label: 'story_create (priority=high, no risk wording)' });
    const id = created.stdout.match(/Story (B-[a-f0-9]+) created/)?.[1];
    assert.ok(id, `[NIS] story_create returned an id:\n${created.out.slice(-1500)}`);
    o.storyId = id!;
    assert.equal(new StoryStore(o.root).readStory(id!).priority, 'medium', `[NIS] story_create records medium for priority=high without risk wording:\n${created.out.slice(-2000)}`);
    assert.match(created.out, /priority=high lowered to medium/, `[NIS] story_create says it lowered the priority:\n${created.out.slice(-2000)}`);
    writeFileSync(join(o.scriptsDir, 'resolver.json'), JSON.stringify({ argv: [process.execPath, SELF, '--provide-script', o.root, id, o.scriptsDir, JSON.stringify({ findingRound1: false, initBlocking: true })] }));
    const ran: string[] = [];
    const ownerSteps: string[] = [];
    let next: NextStepJson | undefined;
    let fixed = false;
    for (let call = 0; call < 12; call += 1) {
      const asked = o.cli('next', { storyId: id, run: true, json: true }, { label: 'next --run' });
      const parsed = parseJson(asked.stdout);
      next = parsed?.next as NextStepJson | undefined;
      assert.ok(next, `[NIS] next --run returned no step:\n${asked.out.slice(-2000)}`);
      for (const row of (parsed!.executed ?? []) as Array<{ command: string; reason: string; exit: number; tail: string }>) {
        ran.push(row.reason);
        assert.equal(row.exit, 0, `[NIS] next --run executed a step its gate refused: ${row.command}\n${row.tail}`);
      }
      assert.equal(parsed!.stopped ?? null, null, `[NIS] next --run stopped: ${String(parsed!.stopped)}\n${asked.out.slice(-2000)}`);
      if (next.phase !== 'INIT' && next.phase !== 'INIT_CHECK') break;
      if (next.wait || parsed!.paused) continue;
      ownerSteps.push(`${next.phase}:${next.kind}:${next.reason}`);
      if (next.reason === 'init_review_blockers' && !fixed) {
        assert.ok(next.why.includes(NIS_BLOCKING_ISSUE.slice(0, 40)), `[NIS] the blocker names the reviewer issue: ${next.why.slice(0, 600)}`);
        // The owner's one fix: the judged field only (title/context unchanged).
        o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-001', userSees: 'go test -v ./strs -run TestUpper prints --- PASS: TestUpper; Upper("ab") returns "AB"' }, { label: 'checklist_update CHK-001 userSees (owner fix)' });
        fixed = true;
        continue;
      }
      break;
    }
    assert.ok(fixed, `[NIS] the first story-init verdict blocked (owner steps: ${ownerSteps.join(', ')}; ran: ${ran.join(' > ')})`);
    assert.deepEqual(ownerSteps, ['INIT:agent:init_review_blockers'], `[NIS] after the owner fix next --run relaunches the blocking reviewer itself; owner steps: ${ownerSteps.join(', ')} (why: ${next?.why.slice(0, 400)})`);
    assert.equal(next?.phase, 'PLAN', `[NIS] next --run reaches PLAN; at ${next?.phase} ${next?.reason}: ${next?.why.slice(0, 400)}`);
    assert.equal(ran.filter(reason => reason === 'init_review_launch').length, 3, `[NIS] both reviewers once + the blocking story-init again, all by the framework (ran: ${ran.join(' > ')})`);
    lines.push(`owner INIT steps: ${ownerSteps.join(', ')} + 1 checklist_update; framework steps: ${ran.join(' > ')}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Old-PoS run 30 (B-c201:F-005): the docs reviewer reported wrong range
 * examples in a doc that is byte-identical on main (pre-existing drift, outside
 * the request and the scope contract). The grouped repair and a dedicated
 * repair both ended without a commit (the worker would not edit a file outside
 * its allowed list), next kept proposing the same repair, the owner's
 * applicability record was refused (proposalRef must be an object) and the
 * Story stopped in DEV with nothing merged.
 *   NPX  next never routes the pre-existing out-of-scope finding to repair; it
 *        proposes ONE audited disposition (finding_resolve
 *        disposition=preexisting_out_of_scope) whose record carries the base
 *        evidence (cited lines unchanged base..head) and a follow-up; DONE, the
 *        doc on main untouched, nothing dropped.
 *   NPXA the owner records it through the applicability path run 30's owner
 *        tried (finding_applicability_assess verdict=pre_existing_unaffected,
 *        proposalRef = the finding id): accepted when the framework's own base
 *        evidence holds, same audited closure, DONE.
 *   NPXS the request asks to correct that doc (in scope): repaired as before. The
 *        repair prompt says documentation files are admitted; the first attempt
 *        reports blocked without a commit, so next relaunches the repair with
 *        that report in the prompt; the second commits the doc fix; DONE.
 */
function scenarioNPX(machineEnv: NodeJS.ProcessEnv, steps: Step[], tag: 'NPX' | 'NPXA' | 'NPXS' | 'NPXC' | 'NPXF'): Outcome {
  const inScope = tag === 'NPXS';
  // Lab run95 (fix 2, run 95 REM1): NPXF is NPX driven by `next --run`: the disposition is a framework step run inside
  // next --run before the repair launch of the other finding; the owner is never handed a step about it.
  const runMode = tag === 'NPXF';
  // Old-PoS runs 36/37: NPXC is NPX with a code evidence anchor in the finding.
  PX_FINDING.desc = tag === 'NPXC' ? PX_FINDING_CODE_ANCHOR : PX_FINDING_DOC_ONLY;
  const name = tag === 'NPXF'
    ? 'NPXF lab run95 fix 2: under next --run the pre-existing disposition is a framework step and the repair of the other finding launches in the same flow; the owner never gets a step about it; DONE'
    : tag === 'NPX' || tag === 'NPXC'
    ? `${tag} run ${tag === 'NPX' ? '30' : '36/37'}: a pre-existing out-of-scope doc finding${tag === 'NPXC' ? ' citing an unchanged code line of an in-scope file' : ''} is closed by ONE audited disposition (base evidence + follow-up), never routed to repair; DONE`
    : tag === 'NPXA'
      ? 'NPXA run 30: the owner\'s applicability record (pre_existing_unaffected, proposalRef = finding id) is accepted on valid base evidence; DONE'
      : 'NPXS run 30: a pre-existing doc finding the request covers is repaired; a repair run without a commit is relaunched with its report; DONE';
  const o = new Owner(tag, tag === 'NPX' ? 'B-e3a0' : tag === 'NPXA' ? 'B-e3a1' : tag === 'NPXC' ? 'B-e3a3' : tag === 'NPXF' ? 'B-e3a5' : 'B-e3a2', machineEnv, steps, false,
    { trackedGateFailureCounts: true, preexistingDoc: true, request: inScope ? PX_REQUEST_IN : PX_REQUEST_OUT });
  const lines: string[] = [];
  const reasons: string[] = [];
  let applicability: CliResult | undefined;
  try {
    devSetup(o);
    const pxOf = () => new StoryStore(existsSync(o.worktree) ? o.worktree : o.root).readFindings(o.storyId).findings.find(f => f.desc === PX_FINDING.desc);
    const stats = driveWithNext(o, { findingRound1: true, run: runMode, preexisting: inScope ? 'in' : 'out',
      interject: tag !== 'NPXA' ? undefined : next => {
        // Run 30's owner: once the pre-existing finding is the subject of the step, record it as pre-existing.
        const px = pxOf();
        if (applicability || !px || px.status !== 'open' || next.phase !== 'DEV' || !JSON.stringify(next.cli?.payload ?? {}).includes(px.id)) return false;
        applicability = o.cli('finding_applicability_assess', { storyId: o.storyId, findingId: px.id, idempotencyKey: 'f005-pre-existing-unaffected-1',
          verdict: 'pre_existing_unaffected', proofStrength: 'strong', proposalRef: px.id, evaluationScope: 'target_story', dispositionPlan: 'defer_with_proof',
          gateImpact: 'does_not_block', evidenceRefs: [`git diff --name-only main...HEAD -- ${PX_DOC_PATH} is empty`, `git show main:${PX_DOC_PATH} lines 3 and 4 contain the same examples`],
          recheckTriggers: [`future change to ${PX_DOC_PATH}`], expiresAt: '2026-11-09T00:00:00Z' }, { label: 'finding_applicability_assess (owner, run 30)' });
        assert.equal(applicability.status, 0, `[${tag}] the run 30 applicability record must be accepted when its base evidence is valid:\n${applicability.out.slice(-2000)}`);
        reasons.push('owner_applicability_assess');
        return true;
      } }, lines, next => {
      const payload = next.cli?.payload ?? {};
      const px = pxOf();
      if (px && JSON.stringify(payload).includes(px.id)) reasons.push(`${next.reason}${payload.disposition ? `:${String(payload.disposition)}` : ''}`);
    });
    const px = pxOf()!;
    const order = reasons.filter((row, index) => row !== reasons[index - 1]);
    lines.push(`steps about the pre-existing finding ${px.id}: ${order.join(' > ')}`);
    const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
    const pxRuns = repairRunsOnDisk(runsRoot).get(px.id) ?? [];
    const final = new StoryStore(o.root).readFindings(o.storyId).findings.find(f => f.id === px.id)!;
    assert.equal(final.status, 'resolved', `[${tag}] ${px.id} is closed before DONE (never dropped): ${JSON.stringify(final)}`);
    const doc = readFileSync(join(o.root, PX_DOC_PATH), 'utf8');
    if (!inScope) {
      assert.deepEqual(pxRuns, [], `[${tag}] a pre-existing out-of-scope finding is never routed to repair (runs: ${pxRuns.join(', ')})`);
      assert.equal(String(final.resolutionType), 'preexisting_out_of_scope', `[${tag}] closed by the named disposition: ${JSON.stringify(final)}`);
      // The Story base: the main commit story/<id> branched from (the INIT_CHECK metadata commit).
      const base = git(o.root, ['log', '--format=%H', '-1', `--grep=INIT_CHECK metadata ${o.storyId}`, 'main']);
      const reason = String(final.resolvedReason);
      for (const needle of [base.slice(0, 12), `${PX_DOC_PATH}:3`, `${PX_DOC_PATH}:4`, 'strs/strs.go']) {
        assert.ok(reason.includes(needle), `[${tag}] the disposition record carries ${needle}: ${reason}`);
      }
      assert.match(reason, /pre-existing at the Story base/i, `[${tag}] the record states the base evidence: ${reason}`);
      assert.match(reason, /follow-up/i, `[${tag}] the record carries a follow-up: ${reason}`);
      assert.equal(doc, PX_DOC, `[${tag}] the doc on main is untouched (recorded follow-up, not a silent edit)`);
      if (tag === 'NPXC') assert.ok(reason.includes('strs/strs.go:1'), `[${tag}] the record names the code evidence anchor: ${reason}`);
      if (tag === 'NPXF') {
        assert.deepEqual(order, [], `[${tag}] no step about the pre-existing finding is handed to the owner: ${order.join(' > ')}`);
        assert.ok(!stats.ownerSteps.includes('finding_preexisting_disposition'), `[${tag}] the owner never ran the disposition: ${stats.ownerSteps.join(' > ')}`);
        lines.push(`owner steps: ${stats.ownerSteps.join(' > ')}`);
      } else if (tag === 'NPX' || tag === 'NPXC') assert.deepEqual(order, ['finding_preexisting_disposition:preexisting_out_of_scope'], `[${tag}] ONE disposition step: ${order.join(' > ')}`);
      // NPXA: next proposed the disposition; the owner recorded it the run 30 way instead.
      else assert.deepEqual(order, ['finding_preexisting_disposition:preexisting_out_of_scope', 'owner_applicability_assess'], `[${tag}] the owner's applicability record closed it: ${order.join(' > ')}`);
      lines.push(`${px.id} closed: ${reason.slice(0, 300)}`);
    } else {
      assert.notEqual(String(final.resolutionType), 'preexisting_out_of_scope', `[${tag}] an in-scope finding is repaired, not dispositioned`);
      assert.equal(doc, PX_DOC_FIXED, `[${tag}] the doc fix reached main`);
      assert.ok(pxRuns.length >= 2, `[${tag}] the repair without a commit was relaunched (runs: ${pxRuns.join(', ')})`);
      const prompts = managedPrompts(o, FINDING_REPAIR).filter(row => pxRuns.includes(row.runId));
      assert.match(prompts[0]!.prompt, /documentation files[^\n]*admitted/i, `[${tag}] the repair prompt says documentation files are admitted:\n${prompts[0]!.prompt.slice(-2500)}`);
      assert.ok(prompts.at(-1)!.prompt.includes(PX_BLOCKED), `[${tag}] the relaunched repair prompt carries the earlier run's report:\n${prompts.at(-1)!.prompt.slice(-3000)}`);
      lines.push(`${px.id} repaired after ${pxRuns.length} runs: ${String(final.resolvedReason).slice(0, 200)}`);
    }
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  } finally {
    PX_FINDING.desc = PX_FINDING_DOC_ONLY;
  }
}

/**
 * Old-PoS run 110 (bench-staging/oldpos/run110-analysis.md §4, §6; lab run110): the Story's scope boundary excludes
 * "changes to docs"; the docs lane reports pre-existing doc/code drift in docs/types/array.md whose code anchor
 * (strs/strs.go:6) lies inside the Story's own hunk and whose description starts with a lane tag. Run 110 repaired it
 * (the repair edited the excluded docs), the other lanes reported the edit as a scope violation, its revert re-created
 * the drift: 6 rounds, timeout.
 *   NFS   the boundary exclusion reaches the scope contract (explicitExcludes = the documentation pattern), the repair
 *         prompt of the other finding does not say docs are admitted, and the drift finding is closed once by the
 *         framework (file-state conflict: scope boundary > reviewer opinion, resolutionType superseded, reason
 *         `[file_state_conflict]`), never routed to repair; the doc is untouched; DONE.
 *   NFS-S the request asks to correct that doc (request text > scope boundary): docs stay admitted (no derived
 *         exclusion) and the finding is repaired as before (NPXS); DONE.
 */
function scenarioNFS(machineEnv: NodeJS.ProcessEnv, steps: Step[], tag: 'NFS' | 'NFS-S'): Outcome {
  const inScope = tag === 'NFS-S';
  PX_FINDING.desc = PX_FINDING_RUN110;
  const name = inScope
    ? 'NFS-S lab run110: the request asks for the doc fix, so the boundary\'s "changes to docs" does not exclude it (request > boundary); the drift is repaired; DONE'
    : 'NFS lab run110: "changes to docs" in the scope boundary becomes explicitExcludes; a tagged doc-code drift with an in-hunk code anchor is settled once (scope boundary > reviewer), never repaired; DONE';
  const o = new Owner(tag, inScope ? 'B-f110' : 'B-f111', machineEnv, steps, false, { trackedGateFailureCounts: true, preexistingDoc: true,
    request: inScope ? PX_REQUEST_IN : PX_REQUEST_OUT, scopeBoundary: { allowed: ['strs: Upper and Reverse helpers'], excluded: ['changes to docs'] } });
  const lines: string[] = [];
  try {
    devSetup(o);
    const pxOf = () => new StoryStore(existsSync(o.worktree) ? o.worktree : o.root).readFindings(o.storyId).findings.find(f => f.desc === PX_FINDING.desc);
    const reasons: string[] = [];
    driveWithNext(o, { findingRound1: true, run: false, preexisting: inScope ? 'in' : 'out' }, lines, next => {
      const px = pxOf();
      if (px && JSON.stringify(next.cli?.payload ?? {}).includes(px.id)) reasons.push(next.reason);
    });
    const px = pxOf()!;
    const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
    const pxRuns = repairRunsOnDisk(runsRoot).get(px.id) ?? [];
    const final = new StoryStore(o.root).readFindings(o.storyId).findings.find(f => f.id === px.id)!;
    assert.equal(final.status, 'resolved', `[${tag}] ${px.id} is closed before DONE (never dropped): ${JSON.stringify(final)}`);
    const contract = new StoryStore(o.root).readScopeContract(o.storyId)!;
    const doc = readFileSync(join(o.root, PX_DOC_PATH), 'utf8');
    const docExcluded = contract.explicitExcludes.some(pattern => /\.\{?md/.test(pattern));
    lines.push(`explicitExcludes: [${contract.explicitExcludes.join(', ')}]; steps about ${px.id}: ${reasons.join(' > ') || '(none)'}`);
    if (!inScope) {
      assert.ok(docExcluded, `[${tag}] the boundary's "changes to docs" is in explicitExcludes: ${JSON.stringify(contract.explicitExcludes)}`);
      assert.deepEqual(pxRuns, [], `[${tag}] the drift on an excluded doc is never routed to repair (runs: ${pxRuns.join(', ')})`);
      assert.equal(String(final.resolutionType), 'superseded', `[${tag}] closed by the file-state settlement: ${JSON.stringify(final)}`);
      const reason = String(final.resolvedReason);
      assert.match(reason, /^\[file_state_conflict\]/, `[${tag}] the recorded reason: ${reason}`);
      assert.match(reason, /request text > scope boundary > reviewer/, `[${tag}] the precedence is recorded: ${reason}`);
      assert.match(reason, /changes to docs/, `[${tag}] the boundary entry is named: ${reason}`);
      assert.equal(doc, PX_DOC, `[${tag}] the excluded doc on main is untouched`);
      const prompts = managedPrompts(o, FINDING_REPAIR);
      assert.ok(prompts.length > 0, `[${tag}] the other finding was repaired by a managed run`);
      for (const row of prompts) {
        assert.doesNotMatch(row.prompt, /admitted by the gate too/i, `[${tag}] no repair prompt says docs are admitted:\n${row.prompt.slice(-2500)}`);
      }
      assert.match(prompts[0]!.prompt, /documentation[^\n]*not admitted/i, `[${tag}] the repair prompt says docs are excluded`);
      lines.push(`${px.id} closed: ${reason.slice(0, 300)}`);
    } else {
      assert.ok(!docExcluded, `[${tag}] request text > scope boundary: docs stay admitted: ${JSON.stringify(contract.explicitExcludes)}`);
      assert.notEqual(String(final.resolutionType), 'superseded', `[${tag}] a requested doc fix is repaired, not settled`);
      assert.equal(doc, PX_DOC_FIXED, `[${tag}] the doc fix reached main`);
      lines.push(`${px.id} repaired after ${pxRuns.length} runs`);
    }
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  } finally {
    PX_FINDING.desc = PX_FINDING_DOC_ONLY;
  }
}

/**
 * Old-PoS run 52 (bench-staging/oldpos/run52-analysis.md §4; run 48 cycle C): 12
 * of 17 findings were ONE pre-existing docs defect in the frozen docs tree,
 * re-filed by four lanes in rounds 1, 3, 4 and 5. Each copy was a new open
 * blocking finding: one owner preexisting_out_of_scope turn each, and a round
 * whose only findings were copies forced another full round on unchanged code.
 * Here round 1 files RX_FINDING (a guide line on main that the Story never
 * touches) beside D_FINDING; next proposes the ONE audited disposition; in
 * round 2 the quality lane re-files the same site in other words (RX_REFILED).
 *   NPXR  RX_REFILED is closed at import as a recurrence of the disposition
 *         (resolutionType preexisting_out_of_scope, recurringPreexistingOf =
 *         RX_FINDING's id, a process event), with no owner step and no repair;
 *         round 2 is then clean: no round 3 (exactly 2 rounds); round-2 lane
 *         prompts list the dispositioned site; DONE, the guide untouched.
 *   NPXRE negative control: the round-1 repair also rewrote that guide line
 *         (the Story changed the site): RX_REFILED is NOT auto-closed; it stays
 *         an open finding of round 2 and takes the ordinary route (a closure
 *         step next proposes; a third round); DONE.
 *   NPXRN negative control: round 2 also files RX_NEW_SITE, another pre-existing
 *         line of the same guide nobody dispositioned: RX_REFILED is auto-closed
 *         but RX_NEW_SITE stays open and goes through the owner disposition
 *         (a new finding is never closed by a site it does not share); DONE.
 */
function scenarioNPXR(machineEnv: NodeJS.ProcessEnv, steps: Step[], tag: 'NPXR' | 'NPXRE' | 'NPXRN'): Outcome {
  const recurring: RecurringMode = tag === 'NPXRE' ? 'edited' : tag === 'NPXRN' ? 'new-site' : 'site';
  const name = tag === 'NPXR'
    ? 'NPXR run 52: a re-filed pre-existing finding on a dispositioned, unchanged site closes at import (no owner turn, no extra round); DONE'
    : tag === 'NPXRE'
      ? 'NPXRE run 52: a re-filed finding on a dispositioned site the Story edited is not auto-closed (stays an open finding, its own round); DONE'
      : 'NPXRN run 52: a new finding on another line of the same doc stays open (owner disposition) beside an auto-closed recurrence; DONE';
  const o = new Owner(tag, tag === 'NPXR' ? 'B-e5a0' : tag === 'NPXRE' ? 'B-e5a1' : 'B-e5a2', machineEnv, steps, false,
    { trackedGateFailureCounts: true, baseFiles: { [RX_DOC_PATH]: RX_DOC } });
  const lines: string[] = [];
  const named: Array<{ reason: string; payload: string }> = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, recurring }, lines, next => {
      named.push({ reason: next.reason, payload: JSON.stringify(next.cli?.payload ?? {}) });
    });
    const store = new StoryStore(o.root);
    const findings = store.readFindings(o.storyId).findings;
    const byDesc = (desc: string) => findings.find(f => f.desc === desc);
    const original = byDesc(RX_FINDING.desc);
    const refiled = byDesc(RX_REFILED.desc);
    assert.ok(original && refiled, `[${tag}] both filings recorded (${findings.map(f => f.id).join(', ')})`);
    const runs = store.readReviewRuns(o.storyId).runs.filter(run => run.reviewPurpose !== 'inventory-completeness');
    const rounds = [...new Set(runs.map(run => run.reviewRound))];
    const events = store.readProcessEvents(o.storyId);
    const recurrence = events.filter(event => String(event.type) === 'finding_preexisting_recurrence_closed');
    const stepsNaming = (id: string) => named.filter(row => row.payload.includes(`"${id}"`)).map(row => row.reason);
    const marker = (f: typeof refiled) => { const of = f ? recurringPreexistingOf(f) : []; return of.length ? of : undefined; };
    assert.equal(original!.resolutionType, 'preexisting_out_of_scope', `[${tag}] round 1's filing is closed by the ONE audited disposition`);
    assert.ok(stepsNaming(original!.id).includes('finding_preexisting_disposition'), `[${tag}] next proposed that disposition (${stepsNaming(original!.id).join(', ')})`);
    lines.push(`review rounds: ${rounds.length}; findings: ${findings.map(f => `${f.id.split(':')[1]}=${f.status}/${f.resolutionType ?? '-'}${marker(f) ? `(recurring of ${marker(f)!.join(',')})` : ''}`).join(' ')}`);
    const laneRuns = (index: number) => runs.filter(run => run.reviewRound === rounds[index]).map(run => run.reviewRunId);
    const prompts = managedPrompts(o).filter(row => row.agentType.startsWith('proof-or-stop-review-') && row.agentType !== DELIVERY && row.agentType !== MANAGED_INVENTORY_CRITIC_LANE);
    // A later-round prompt also names earlier ReviewRuns (re-review block): match the run each prompt is bound to.
    const promptsOf = (index: number) => prompts.filter(row => laneRuns(index).some(id => row.prompt.includes(`"reviewRunId":"${id}"`)));
    assert.ok(promptsOf(0).every(row => !row.prompt.includes('DISPOSITIONED PRE-EXISTING SITES')), `[${tag}] round 1 has nothing dispositioned yet`);
    assert.ok(promptsOf(1).length >= 3 && promptsOf(1).every(row => row.prompt.includes('--- BEGIN DISPOSITIONED PRE-EXISTING SITES') && row.prompt.includes(`${RX_DOC_PATH}:3`)),
      `[${tag}] every round-2 lane prompt lists the dispositioned site ${RX_DOC_PATH}:3`);
    lines.push(`round-2 lane prompt bytes: ${promptsOf(1).map(row => Buffer.byteLength(row.prompt, 'utf8')).join(', ')}`);
    if (tag === 'NPXRE') {
      // The Story edited the site: not a recurrence and not pre-existing, so it stays an open finding of round 2 and
      // takes the ordinary route, costing its remediation round. Lab run58-fixes: its canonical (the pre-existing
      // disposition) was closed without a repair, so it is no duplicate closure target (closedWithoutFix): next gives
      // it its own repair (before: next proposed the duplicate closure and run 46's live-canonical check refused it).
      assert.equal(marker(refiled), undefined, `[${tag}] a site the Story edited is never auto-closed: ${JSON.stringify(refiled)}`);
      assert.notEqual(refiled!.resolutionType, 'preexisting_out_of_scope', `[${tag}] it is not closed as pre-existing: ${JSON.stringify(refiled)}`);
      assert.equal(refiled!.status, 'resolved', `[${tag}] closed before DONE`);
      assert.ok(stepsNaming(refiled!.id).length > 0, `[${tag}] closed by a next step naming it, not at import`);
      assert.equal(refiled!.resolutionType === 'duplicate', false, `[${tag}] never closed as a duplicate of a disposition that fixed nothing: ${JSON.stringify(refiled)}`);
      assert.equal(recurrence.length, 0, `[${tag}] no recurrence closure`);
      assert.ok(rounds.length >= 3, `[${tag}] the open finding cost its remediation round (rounds ${rounds.length})`);
    } else {
      assert.equal(refiled!.status, 'resolved', `[${tag}] the re-filed finding is closed`);
      assert.equal(refiled!.resolutionType, 'preexisting_out_of_scope', `[${tag}] as a recurrence of the disposition`);
      assert.deepEqual(marker(refiled), [original!.id], `[${tag}] recurringPreexistingOf names the dispositioned finding`);
      assert.match(String(refiled!.resolvedReason), /recurring/i, `[${tag}] the record says why: ${refiled!.resolvedReason}`);
      assert.ok(String(refiled!.resolvedReason).includes(`${RX_DOC_PATH}:3`), `[${tag}] the record names the site: ${refiled!.resolvedReason}`);
      assert.deepEqual(stepsNaming(refiled!.id), [], `[${tag}] no next step (owner turn, repair) ever named the recurrence`);
      assert.equal(recurrence.length, 1, `[${tag}] one recurrence event (${JSON.stringify(recurrence)})`);
      assert.equal(readFileSync(join(o.root, RX_DOC_PATH), 'utf8'), RX_DOC, `[${tag}] the guide on main is untouched`);
      if (tag === 'NPXR') {
        assert.equal(rounds.length, 2, `[${tag}] a round whose only finding is an auto-closed recurrence starts no further round (rounds ${rounds.length})`);
      } else {
        const fresh = byDesc(RX_NEW_SITE.desc);
        assert.ok(fresh, `[${tag}] the new-site finding was recorded`);
        assert.equal(marker(fresh), undefined, `[${tag}] a new site is never auto-closed: ${JSON.stringify(fresh)}`);
        assert.ok(stepsNaming(fresh!.id).includes('finding_preexisting_disposition'), `[${tag}] it got the owner disposition (${stepsNaming(fresh!.id).join(', ')})`);
        assert.equal(fresh!.status, 'resolved', `[${tag}] closed before DONE`);
        assert.equal(rounds.length, 3, `[${tag}] the open new finding cost its remediation round (rounds ${rounds.length})`);
      }
    }
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

// ---------------------------------------------------------------------------
// Old-PoS run 31 (121.6 min): metadata findings, literal sweep, resolution
// integrity, product code reading PoS metadata, owner-context cost.

const META_STALE_USER_SEES: Record<string, string> = {
  'CHK-001': 'Upper("ab") == "ab"; go test -v ./strs -run TestUpper prints --- PASS: TestUpper',
  'CHK-002': 'Reverse("héllo") == "olléh" and Upper("ab") == "ab" is unaffected; go test -v ./strs -run TestReverse prints --- PASS: TestReverse',
};
const META_FIXED_USER_SEES: Record<string, string> = {
  'CHK-001': 'Upper("ab") == "AB"; go test -v ./strs -run TestUpper prints --- PASS: TestUpper',
  'CHK-002': 'Reverse("héllo") == "olléh" and Upper("ab") == "AB" is unaffected; go test -v ./strs -run TestReverse prints --- PASS: TestReverse',
};

/** Old-PoS run 44 (R2): a short quoted literal inside a backticked span, copied in two items; the request renders the name bare. */
const META_SHORT_STALE_USER_SEES: Record<string, string> = {
  'CHK-001': 'Upper("ab") == "AB" and logs `upper: "a" mapped`; go test -v ./strs -run TestUpper prints --- PASS: TestUpper',
  'CHK-002': 'Reverse("héllo") == "olléh"; Upper still logs `upper: "a" mapped`; go test -v ./strs -run TestReverse prints --- PASS: TestReverse',
};
const META_SHORT_FIXED_USER_SEES: Record<string, string> = {
  'CHK-001': 'Upper("ab") == "AB" and logs `upper: a mapped`; go test -v ./strs -run TestUpper prints --- PASS: TestUpper',
  'CHK-002': 'Reverse("héllo") == "olléh"; Upper still logs `upper: a mapped`; go test -v ./strs -run TestReverse prints --- PASS: TestReverse',
};
const META_SHORT_DESC = 'CHK-001 userSees still quotes the rune name "a" in its log line; the request prints the rune name bare (its placeholder slot), so the acceptance text contradicts the request.';

/** The Story's checklist.json, relative to the worktree (what a reviewer cites). */
function checklistRel(worktree: string, storyId: string): string {
  return relative(worktree, new StoryStore(worktree).storyFilePath(storyId, 'checklist.json'));
}

/**
 * Run 31 F-001 / F-002 shapes. `cited`: names the item and field, cites only
 * checklist.json. `restated`: cites checklist.json:<line> (no item id) plus the
 * passing test that already asserts the right value.
 */
function metadataFindings(worktree: string, storyId: string): { cited: Record<string, unknown>; restated: Record<string, unknown>; productCopy: Record<string, unknown>; intentRow: Record<string, unknown>; short: Record<string, unknown>; intentLiteral: Record<string, unknown> } {
  const rel = checklistRel(worktree, storyId);
  const text = readFileSync(join(worktree, rel), 'utf8').split('\n');
  const line = text.findIndex(row => row.includes('"userSees": "Upper(\\"ab\\") == \\"ab\\"')) + 1;
  return {
    cited: { desc: 'CHK-001 userSees says Upper("ab") == "ab", but docs/types/string.md says Upper returns the upper-case form, which yields "AB"; TestUpper already asserts "AB", so the userSees acceptance text contradicts the request.',
      severity: 'medium', category: 'missing', files: [rel], evidenceState: 'verified' },
    restated: { desc: `checklist-userSees-contradiction: ${rel}:${line} says \`Upper("ab") == "ab"\`, but the request re-derives \`Upper("ab") == "AB"\`; strs/strs_test.go:9 asserts "AB", so the pinned userSees misstates the required behavior.`,
      severity: 'medium', category: 'missing', files: [rel, 'strs/strs_test.go'], evidenceState: 'verified' },
    // Old-PoS run 33 F-003 (docs lane): the same correction, citing the product file and its test as well.
    productCopy: { desc: META_PRODUCT_COPY_DESC, severity: 'medium', category: 'missing', files: [rel, 'strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified' },
    // Old-PoS run 44 R2: only a short quoted literal is cited (no corrected value, no statement).
    short: { desc: META_SHORT_DESC, severity: 'medium', category: 'missing', files: [rel], evidenceState: 'verified' },
    // Old-PoS run 33 trip 5: an intent row the request contradicts (only PLAN may correct it).
    intentRow: { desc: 'checklist-intent-drift: CHK-001:happy:0 verificationIntent pins Upper behaviour the request does not state; the request says Upper returns the upper-case form, so the row must say Upper("ab") -> "AB".',
      severity: 'medium', category: 'missing', files: [rel], evidenceState: 'verified' },
    // Lab run131 (NMC): an intent row states a wrong statement; the reviewer gives the value.
    intentLiteral: { desc: `checklist-intent-drift: CHK-001:happy:0 verificationIntent states \`${NIO_PINNED}\`, but the request says Upper returns the upper-case form, so it should be \`"AB"\`.`,
      severity: 'medium', category: 'missing', files: [rel], evidenceState: 'verified' },
  };
}

const META_PRODUCT_COPY_DESC = 'checklist-intent-drift: CHK-001 userSees says `Upper("ab") == "ab"`, but the request implies `Upper("ab") == "AB"`; strs/strs.go:4 already returns "AB" and strs/strs_test.go asserts it, so only the stale acceptance text contradicts the request.';

/** The stale userSees of run 31 (the hooo / abc copies), committed as Story metadata before DEV. */
function writeStaleUserSees(o: Owner): void {
  const store = new StoryStore(o.worktree);
  const cl = store.readChecklist(o.storyId);
  store.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => META_STALE_USER_SEES[item.id] ? { ...item, userSees: META_STALE_USER_SEES[item.id]! } : item) } as never);
  commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} stale userSees pins`);
}

function reviewRoundCount(o: Owner): number {
  return new Set(new StoryStore(o.root).readReviewRuns(o.storyId).runs.map(run => run.reviewRound)).size;
}

/**
 * NMF / NMF2 (old-PoS run 31 D2/D5/D6, 10 of 13 findings): lanes report the wrong
 * userSees literal as findings. They are metadata, not product findings: never
 * stored in the finding ledger, never routed to a repair worker; next emits ONE
 * owner checklist_update (wrong literal + the reviewer's value + every other
 * occurrence of the literal), the framework refuses an update that leaves the
 * cited text unchanged, and a metadata-only round costs no remediation round.
 */
function scenarioNMF(machineEnv: NodeJS.ProcessEnv, steps: Step[], tag: 'NMF' | 'NMF2'): Outcome {
  const withProduct = tag === 'NMF';
  const name = withProduct
    ? 'NMF old-PoS run 31: metadata findings beside a product finding: one checklist_update (literal swept across items), no repair of metadata, DONE in the product-finding round count'
    : 'NMF2 old-PoS run 31: a metadata-only review round costs no remediation round: one checklist_update, DONE after one review round';
  const o = new Owner(tag, withProduct ? 'B-e3b0' : 'B-e3b1', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const corrections: NextStepJson[] = [];
  let afterCorrection: string | null = null;
  let laneState = '';
  try {
    writeStaleUserSees(o);
    devSetup(o);
    const rel = checklistRel(o.worktree, o.storyId);
    driveWithNext(o, { findingRound1: withProduct, run: false, metadata: withProduct ? 'with-product' : 'only' }, lines, next => {
      if (corrections.length === 1 && afterCorrection === null && next.reason !== 'metadata_correction') {
        afterCorrection = next.reason;
        if (next.reason === 'review_round_prepare') {
          laneState = JSON.stringify(collectReviewerEvidenceState(new StoryStore(o.worktree), o.storyId, o.worktree).invalid.map(issue => [issue.evidenceId, issue.code, issue.message.slice(0, 300)]));
        }
      }
      if (next.reason !== 'metadata_correction') return;
      corrections.push(next);
      if (corrections.length > 1) return;
      // The framework verifies the cited text changed: an update that keeps the wrong literal is refused.
      const unchanged = o.cli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', userSees: META_STALE_USER_SEES['CHK-001'], metadataCorrection: true,
        reason: 'Restating the same userSees text without correcting the cited literal.' }, { label: 'checklist_update CHK-001 (unchanged metadata)' });
      assert.notEqual(unchanged.status, 0, `[${tag}] an update leaving the cited userSees unchanged must be refused`);
      assert.match(unchanged.out, /\[metadata_correction_unchanged\]/, `[${tag}] refusal code:\n${unchanged.out.slice(-1500)}`);
    });
    assert.notEqual(afterCorrection, 'review_round_prepare', `[${tag}] the text correction must not rerun the round's lanes:\n${laneState}`);
    assert.equal(corrections.length, 1, `[${tag}] exactly ONE metadata correction step (deduped across lanes): ${corrections.map(row => row.why.slice(0, 120)).join(' | ')}`);
    const step = corrections[0]!;
    assert.equal(step.cli?.command, 'checklist_update', `[${tag}] the correction is a checklist_update`);
    assert.equal(step.cli?.payload.itemId, 'CHK-001', `[${tag}] it names the cited item`);
    assert.ok('userSees' in (step.cli?.payload ?? {}), `[${tag}] it corrects userSees: ${JSON.stringify(step.cli?.payload)}`);
    assert.equal(step.cli?.payload.metadataCorrection, true, `[${tag}] it is a framework metadata correction`);
    assert.ok(step.why.includes('Upper("ab") == "ab"'), `[${tag}] the step carries the cited wrong literal: ${step.why}`);
    assert.ok(step.why.includes('Upper("ab") == "AB"'), `[${tag}] the step carries the reviewer's corrected value: ${step.why}`);
    assert.ok((step.batch ?? []).some(call => call.cli.payload.itemId === 'CHK-002'), `[${tag}] the literal sweep puts CHK-002's copy in the same step: ${JSON.stringify((step.batch ?? []).map(call => call.cli.payload.itemId))}`);
    const store = new StoryStore(o.root);
    const findings = store.readFindings(o.storyId).findings;
    assert.deepEqual(findings.filter(f => (f.files ?? []).includes(rel)).map(f => f.id), [], `[${tag}] no metadata finding enters the finding ledger`);
    assert.equal(findings.length, withProduct ? 1 : 0, `[${tag}] only the product finding is a finding: ${findings.map(f => f.desc.slice(0, 60)).join(' | ')}`);
    const events = store.readProcessEvents(o.storyId).filter(event => (event.type as string) === 'review_metadata_finding_reclassified');
    assert.ok(events.length >= 1, `[${tag}] the reclassification is recorded as a process event`);
    const items = store.readChecklist(o.storyId).items;
    assert.equal(items.find(item => item.id === 'CHK-001')?.userSees, META_FIXED_USER_SEES['CHK-001'], `[${tag}] CHK-001 userSees corrected`);
    assert.equal(items.find(item => item.id === 'CHK-002')?.userSees, META_FIXED_USER_SEES['CHK-002'], `[${tag}] CHK-002's copy corrected in the same step`);
    const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
    const repairs = [...repairRunsOnDisk(runsRoot).values()].flat();
    const rounds = reviewRoundCount(o);
    if (withProduct) assert.equal(rounds, 2, `[${tag}] the product finding costs its one remediation round, the metadata none: ${rounds}`);
    else {
      assert.equal(rounds, 1, `[${tag}] a metadata-only round needs no remediation round: ${rounds}`);
      assert.deepEqual(repairs, [], `[${tag}] no finding-repair run`);
    }
    lines.push(`metadata correction: ${step.why.slice(0, 240)}`);
    lines.push(`review rounds ${rounds}; repair runs ${repairs.length}; DONE`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** Thrown by an onStep hook to stop driveWithNext once a scenario has checked what it needs. */
class StopDrive extends Error {}

/**
 * NMO (old-PoS run 33 §3.2): framework steps before the metadata agent step. A
 * lane reports a product finding and a metadata finding on an intent row (a
 * correction only PLAN may make). With the round's inventory epoch OPEN and its
 * critic pending, next used to return metadata_correction_plan first; the owner
 * then launched and imported the critic by hand (28 turns, 5.35M). Now next
 * launches, imports and finalizes the critic itself, and only then returns the
 * metadata correction.
 */
function scenarioNMO(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NMO';
  const name = 'NMO old-PoS run 33: with the inventory critic pending, next runs the critic launch/import/finalize before the metadata correction that needs PLAN';
  const o = new Owner(tag, 'B-e3b4', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const reasons: string[] = [];
  try {
    devSetup(o);
    try {
      driveWithNext(o, { findingRound1: true, run: false, metadata: 'intent-rows' }, lines, next => {
        reasons.push(next.reason);
        if (next.reason !== 'metadata_correction_plan') return;
        if (next.phase === 'REVIEW') {
          const status = o.cli('review_inventory_status', { storyId: o.storyId }, { label: 'review_inventory_status (NMO ordering)' });
          assert.doesNotMatch(status.out, /REVIEW_INVENTORY_CRITIC_INCOMPLETE/, `[${tag}] the metadata step came while the critic was still pending (steps: ${reasons.join(' > ')}):\n${status.out.slice(-1200)}`);
        }
        assert.ok(reasons.includes('inventory_critic_launch'), `[${tag}] next launched the critic itself before the metadata step: ${reasons.join(' > ')}`);
        throw new StopDrive('metadata step reached');
      });
      assert.fail(`[${tag}] next never proposed the intent-row metadata correction: ${reasons.join(' > ')}`);
    } catch (error) {
      if (!(error instanceof StopDrive)) throw error;
    }
    lines.push(`steps: ${reasons.join(' > ')}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${reasons.join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NMT (old-PoS run 33 §3.5): metadata findings are classified by their
 * correction target, not by lane. The test-coverage lane's copy of a wrong
 * userSees literal is reclassified (it cites only checklist.json); the quality
 * lane's copy also cites the product file and its test (run 33 F-003, docs
 * lane). It is stored, but its correction target is the reclassified one, so it
 * is closed after the one correction without any finding-repair run.
 */
function scenarioNMT(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NMT';
  const name = 'NMT old-PoS run 33: a metadata finding copy that also cites product code is closed by the correction, never repaired';
  const o = new Owner(tag, 'B-e3b5', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  try {
    writeStaleUserSees(o);
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, metadata: 'with-product-copy' }, lines);
    const store = new StoryStore(o.root);
    const copy = store.readFindings(o.storyId).findings.find(f => f.desc === META_PRODUCT_COPY_DESC);
    assert.ok(copy, `[${tag}] the product-citing copy is a stored finding: ${store.readFindings(o.storyId).findings.map(f => f.desc.slice(0, 50)).join(' | ')}`);
    assert.equal(copy!.status, 'resolved', `[${tag}] the copy is closed`);
    const repairs = repairRunsOnDisk(join(o.root, '.proof-or-stop', 'runtime', 'host-runs'));
    assert.deepEqual(repairs.get(copy!.id) ?? [], [], `[${tag}] no finding-repair run for the metadata copy (run 33: repair #2, 2.2 min / 0.91M for already-correct code)`);
    assert.equal(store.readChecklist(o.storyId).items.find(item => item.id === 'CHK-001')?.userSees, META_FIXED_USER_SEES['CHK-001'], `[${tag}] the text is corrected`);
    lines.push(`copy ${copy!.id} resolved without repair; repair runs: ${[...repairs.values()].flat().length}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** Old-PoS run 34 (§4 sink 1d): the historically slowest lanes launch first (runs 27-34 lane wall times). */
const NLI_LANE_ORDER = ['docs', 'test-coverage', 'concept', 'quality'];

/**
 * NLI (old-PoS run 34 §4 sink 1c/1d): R1/R2 waited for the slowest lane before
 * importing any lane (15 + 8 + 7 s per round on the critical path), and the
 * slowest lanes (test-coverage R1, docs R2) were launched 3rd / 4th behind the
 * 8 s stagger. Now the lanes launch slowest-first, and a lane that finished is
 * imported while a slower one still runs.
 */
function scenarioNLI(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NLI';
  const name = 'NLI old-PoS run 34: lanes launch slowest-first and a finished lane is imported while a slower lane still runs';
  const o = new Owner(tag, 'B-e3c1', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const release = join(o.scriptsDir, 'nli-release');
  let checked = false;
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: false, run: false, interject: next => {
      if (checked || next.reason !== 'review_lane_launch' || !next.parallel?.length) return false;
      checked = true;
      const lanes = next.parallel.map(call => short(String(call.cli.payload.lane)));
      lines.push(`launch order: ${lanes.join(', ')}`);
      const ranked = lanes.filter(lane => NLI_LANE_ORDER.includes(lane));
      assert.deepEqual(ranked, NLI_LANE_ORDER.filter(lane => ranked.includes(lane)), `[${tag}] the slowest lanes launch first: ${lanes.join(', ')}`);
      // The first launched lane is held; the others finish. A lane prompt may name the
      // other lanes' ReviewRuns (the fake provider then picks any lane script), so every
      // lane script carries the hold, and it binds by the held run's host run id.
      const held = String(next.parallel[0]!.cli.payload.lane);
      const heldFile = join(o.scriptsDir, 'nli-held-run');
      const hold = ['/bin/sh', '-c', `while [ ! -s '${heldFile}' ]; do sleep 0.1; done; if [ "$(cat '${heldFile}')" = "$LATTICE_MANAGED_HOST_RUN_ID" ]; then while [ ! -f '${release}' ]; do sleep 0.2; done; fi`];
      const runIds = new Map<string, { runId: string; reviewRunId: string }>();
      for (const call of next.parallel) {
        const payload = call.cli.payload;
        const lane = String(payload.lane);
        const reviewRunId = String(payload.reviewRunId);
        const base = laneScript(o.worktree, o.storyId, lane, reviewRunId, true, { findingRound1: false });
        o.script(reviewRunId, { ...base, commands: [hold, ...(base.commands ?? [])] });
      }
      for (const call of next.parallel) {
        const payload = call.cli.payload;
        const lane = String(payload.lane);
        const ran = o.mustCli('host_run', payload, { label: `host_run ${short(lane)}` });
        const runId = String((parseJson(ran.stdout)?.run as Record<string, unknown>).runId);
        if (lane === held) writeFileSync(heldFile, runId);
        runIds.set(lane, { runId, reviewRunId: String(payload.reviewRunId) });
      }
      try {
        for (const [lane, row] of runIds) if (lane !== held) assert.equal(waitTerminal(o, short(lane), row.runId).state, 'completed', `[${tag}] ${short(lane)} completed`);
        const asked = o.cli('next', { storyId: o.storyId, json: true }, { label: 'next (slowest lane still running)' });
        const step = parseJson(asked.stdout) as unknown as NextStepJson;
        lines.push(`with ${short(held)} running: ${step.kind} ${step.reason}`);
        assert.equal(step.reason, 'review_evidence_import', `[${tag}] the finished lanes are imported before the held lane ends (run 34: import waited for the slowest lane): ${step.reason}: ${step.why}`);
        const imported = Array.isArray(step.cli?.payload.imports) ? (step.cli!.payload.imports as Array<{ runId: string }>).map(row => row.runId) : [String(step.cli?.payload.runId)];
        // (A lane launched alone before this parallel step, e.g. the round's first unbound launch, may be in it too.)
        for (const [lane, row] of runIds) {
          if (lane === held) assert.ok(!imported.includes(row.runId), `[${tag}] the held lane is not imported while it runs`);
          else assert.ok(imported.includes(row.runId), `[${tag}] finished lane ${short(lane)} is in the import: ${imported.join(', ')}`);
        }
        o.mustCli(step.cli!.command, step.cli!.payload, { label: 'f:review_evidence_import (early)' });
        const wait = parseJson(o.cli('next', { storyId: o.storyId, json: true }, { label: 'next (after early import)' }).stdout) as unknown as NextStepJson;
        lines.push(`then: ${wait.kind} ${wait.reason}`);
        assert.equal(wait.reason, 'managed_run_wait', `[${tag}] then next waits for the held lane: ${wait.reason}: ${wait.why}`);
        const waited = wait.cli?.payload.runId ?? (wait.cli?.payload.targets as Array<{ runId: string }> | undefined)?.map(row => row.runId).join(',');
        assert.equal(waited, runIds.get(held)!.runId, `[${tag}] the wait names the held lane`);
      } finally {
        writeFileSync(release, '');
      }
      assert.equal(waitTerminal(o, short(held), runIds.get(held)!.runId).state, 'completed', `[${tag}] the held lane completed`);
      for (const row of runIds.values()) o.unscript(row.reviewRunId);
      return true;
    } }, lines);
    assert.ok(checked, `[${tag}] the round launched its lanes in one parallel step`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    try { writeFileSync(release, ''); } catch { /* fixture gone */ }
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** The implementer run of NAV/NAVF/NID: writes the code, pins its focused test, commits, marks done. */
function pinnedImplementerCommands(storyId: string, itemId: string): string[][] {
  const base = implementerScript(storyId, itemId).commands!;
  return [base[0]!, base[1]!,
    [process.execPath, CLI, 'verification_evidence_add', JSON.stringify({ storyId, itemId, intentRef: `${itemId}:happy:0`, kind: 'logic_test',
      command: 'go test -v ./strs -run TestUpper', selector: '--- PASS: TestUpper', note: 'Pinned focused go test proves Upper upper-cases its input.' })],
    base[2]!];
}

/**
 * NAV / NAVF (old-PoS run 34 F5, sink 2): after the owner amends an intent the
 * implementer declared in conflict (adopting the value the implementer says
 * the request implies), next relaunched the implementer by hand (4 owner
 * turns; the reopen run found nothing to change and only re-ran the focused
 * test: 1.5 min, 2.0M). Now next verifies the item's pinned test itself
 * (verification_run, framework) and marks it done (framework); only when that
 * verification fails (NAVF: the amended pin names a test that does not pass)
 * is the implementer relaunched (framework launch, the why names the failure).
 */
function scenarioNAV(machineEnv: NodeJS.ProcessEnv, steps: Step[], failing: boolean): Outcome {
  const tag = failing ? 'NAVF' : 'NAV';
  const name = failing
    ? 'NAVF old-PoS run 34: after an adopted intent amendment whose pinned test fails, next relaunches the implementer (framework) naming the failed verification'
    : 'NAV old-PoS run 34: after an adopted intent amendment, next verifies the pinned test itself and marks the item done (no implementer relaunch)';
  const o = new Owner(tag, failing ? 'B-e3c3' : 'B-e3c2', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[${tag}] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  const implementerRuns = () => managedPrompts(o, IMPLEMENTER).filter(row => row.target?.itemId === 'CHK-001').length;
  try {
    devSetup(o, false);
    const launch = ask('next (DEV start)');
    assert.equal(launch.reason, 'implement_item', `[${tag}] first DEV step: ${launch.reason}: ${launch.why}`);
    assert.equal(launch.cli?.payload.itemId, 'CHK-001');
    o.script(IMPLEMENTER, { commands: pinnedImplementerCommands(o.storyId, 'CHK-001'), final: `Implemented Upper; CHK-001 marked done.\n${NI_CONFLICT_LINE}` });
    const launched = o.mustCli(launch.cli!.command, launch.cli!.payload, { label: 'host_run implementer (conflict)' });
    const terminal = waitTerminal(o, 'implementer', String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId));
    o.unscript(IMPLEMENTER);
    assert.equal(terminal.state, 'completed', `[${tag}] implementer terminal ${terminal.state} (${terminal.reason})\n${o.providerCommandLog()}`);
    const blocked = ask('next (conflict declared)');
    assert.equal(blocked.reason, 'intent_conflict', `[${tag}] the declared conflict blocks: ${blocked.reason}: ${blocked.why}`);
    o.mustCli('story_advance', blocked.cli!.payload, { label: 'story_advance PLAN (intent conflict)' });
    const amend = ask('next (PLAN, conflict open)');
    assert.equal(amend.reason, 'intent_conflict_amend', `[${tag}] PLAN proposes the revision: ${amend.reason}`);
    const current = new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === 'CHK-001')!;
    const revised = JSON.parse(JSON.stringify(current.verificationIntent)) as { happy: Array<{ desc: string; verification?: { command: string; selector: string } }> };
    assert.ok(revised.happy[0]!.verification, `[${tag}] the implementer pinned CHK-001:happy:0: ${JSON.stringify(revised.happy[0])}`);
    revised.happy[0]!.desc = 'TestUpper passes: Upper("ab") == "AB" as the request states';
    // NAVF: the amendment pins a test the implementation does not have yet.
    if (failing) revised.happy[0]!.verification = { command: 'go test -v ./strs -run TestUpperRequestValue', selector: '--- PASS: TestUpperRequestValue' };
    o.mustCli('checklist_update', { ...amend.cli!.payload, verificationIntent: revised,
      reason: 'The request says Upper returns the upper-case form; the pinned intent kept the input unchanged.' }, { label: 'checklist_update CHK-001 intent revision' });
    // PLAN re-approval is outside this harness: re-enter DEV as NI does.
    const store = new StoryStore(o.worktree);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'DEV' });
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} re-enter DEV after the amendment (fixture)`);
    let step = ask('next (DEV, after amendment)');
    if (step.reason === 'checklist_item_start') { o.mustCli(step.cli!.command, step.cli!.payload, { label: 'f:checklist_item_start' }); step = ask('next (item restarted)'); }
    assert.equal(step.reason, 'intent_amend_verify', `[${tag}] next verifies the amended item's pinned test itself (run 34: the owner relaunched the implementer by hand): ${step.reason}: ${step.why}`);
    assert.equal(step.kind, 'framework', `[${tag}] the verification is a framework step`);
    assert.equal(step.cli?.command, 'verification_run', `[${tag}] it runs the pinned verifier: ${step.command}`);
    assert.equal(step.cli?.payload.intentRef, 'CHK-001:happy:0', `[${tag}] the pinned intent of the amended item`);
    const verified = o.cli(step.cli!.command, step.cli!.payload, { label: 'f:intent_amend_verify' });
    if (!failing) {
      assert.equal(verified.status, 0, `[${tag}] the pinned test passes:\n${verified.out.slice(-1500)}`);
      const done = ask('next (verified)');
      assert.equal(done.reason, 'intent_amend_done', `[${tag}] next marks the verified item done: ${done.reason}: ${done.why}`);
      assert.equal(done.kind, 'framework');
      assert.equal(done.cli?.payload.status, 'done');
      o.mustCli(done.cli!.command, done.cli!.payload, { label: 'f:intent_amend_done' });
      assert.equal(new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === 'CHK-001')?.status, 'done', `[${tag}] CHK-001 done`);
      const after = ask('next (CHK-001 done)');
      assert.ok(!(after.reason === 'implement_item' && after.cli?.payload.itemId === 'CHK-001'), `[${tag}] no implementer relaunch of CHK-001: ${after.reason}`);
      assert.equal(implementerRuns(), 1, `[${tag}] one implementer run of CHK-001`);
    } else {
      assert.notEqual(verified.status, 0, `[${tag}] the amended pin names a test that does not pass`);
      const relaunch = ask('next (verification failed)');
      assert.equal(relaunch.reason, 'implement_item', `[${tag}] a failed verification relaunches the implementer: ${relaunch.reason}: ${relaunch.why}`);
      assert.equal(relaunch.cli?.payload.itemId, 'CHK-001');
      assert.equal(relaunch.kind, 'framework', `[${tag}] the relaunch after a failed framework verification is the framework's`);
      assert.match(relaunch.why, /verification/i, `[${tag}] the why names the failed verification: ${relaunch.why}`);
    }
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NID (old-PoS run 34 sink 2): the implementer's per-item tail was 4 turns
 * (git diff --check + status, git add + commit as the canonical author,
 * checklist_update done, report) plus one turn re-reading background.md /
 * plan.md / request.md at every run start. Now checklist_update done with
 * `commit: {files}` runs diff --check, stages, commits as the canonical
 * implementer author and marks the item done in one call (a whitespace error is
 * refused with nothing committed), the prompt names that call and inlines the
 * Story documents, and no `[probes]` contract is asked for with the matrix off.
 */
function scenarioNID(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NID';
  const name = 'NID old-PoS run 34: checklist_update done + commit runs diff --check, commits as the implementer and marks done in one call; the prompt inlines the Story documents';
  const o = new Owner(tag, 'B-e3c4', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST });
  const lines: string[] = [];
  try {
    devSetup(o, false);
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label: 'next (DEV start)' });
    const launch = parseJson(asked.stdout) as unknown as NextStepJson;
    assert.equal(launch.reason, 'implement_item', `[${tag}] first DEV step: ${launch.reason}`);
    const itemId = String(launch.cli!.payload.itemId);
    const doneCall = [process.execPath, CLI, 'checklist_update', JSON.stringify({ storyId: o.storyId, itemId, status: 'done', commit: { files: ['strs/strs.go', 'strs/strs_test.go'] } })];
    const writeFiles = (implText: string) => [process.execPath, '-e', `const fs=require('fs');fs.writeFileSync('strs/strs.go',${JSON.stringify(implText)});fs.writeFileSync('strs/strs_test.go',${JSON.stringify(TESTS)});`];
    o.script(IMPLEMENTER, { commands: [writeFiles(`${IMPL}// trailing whitespace   \n`), doneCall, writeFiles(IMPL), doneCall],
      final: `Implemented Upper and Reverse; ${itemId} committed and marked done.\n[intent-conflict] none` });
    const launched = o.mustCli(launch.cli!.command, launch.cli!.payload, { label: 'host_run implementer (item done command)' });
    const terminal = waitTerminal(o, 'implementer', String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId));
    o.unscript(IMPLEMENTER);
    const log = o.providerCommandLog().trim().split('\n').filter(Boolean).map(row => JSON.parse(row) as { status: number; out: string });
    lines.push(`done calls: ${log.filter((_, index) => index % 2 === 1).map(row => row.status).join(', ')}`);
    assert.notEqual(log[1]?.status, 0, `[${tag}] a whitespace error is refused:\n${log[1]?.out}`);
    assert.match(log[1]?.out ?? '', /diff --check/, `[${tag}] the refusal names git diff --check:\n${log[1]?.out}`);
    assert.equal(log[3]?.status, 0, `[${tag}] the clean call commits and marks done:\n${log[3]?.out}`);
    assert.equal(terminal.state, 'completed', `[${tag}] implementer terminal ${terminal.state} (${terminal.reason})`);
    const commits = git(o.worktree, ['log', '--format=%an|%s', '-5']).split('\n');
    const item = new StoryStore(o.worktree).readChecklist(o.storyId).items.find(row => row.id === itemId)!;
    assert.ok(commits.some(row => row.startsWith('proof-or-stop-implementer|') && row.includes(`${o.storyId} ${itemId}: ${item.title}`)), `[${tag}] one commit by the canonical implementer author: ${commits.join(' ; ')}`);
    assert.equal(commits.filter(row => row.startsWith('proof-or-stop-implementer|')).length, 1, `[${tag}] the refused call committed nothing: ${commits.join(' ; ')}`);
    assert.equal(item.status, 'done', `[${tag}] ${itemId} done`);
    const prompt = managedPrompts(o, IMPLEMENTER)[0]!.prompt;
    assert.match(prompt, /"commit":\{"files":/, `[${tag}] the prompt names the one done + commit call`);
    assert.match(prompt, /Story documents \(inlined/, `[${tag}] the prompt inlines the Story documents`);
    assert.match(prompt, /returns the upper-case form of `s`, for example/, `[${tag}] the request text is inlined`);
    assert.doesNotMatch(prompt, /\[probes\]/, `[${tag}] no [probes] report contract with implementation.probeMatrix off (run 34 F6)`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

const NRI_CODE_FINDING = {
  desc: 'strs/strs.go:4 Upper has no focused test for an empty string: Upper("") must return "".',
  severity: 'medium', category: 'edge', files: ['strs/strs.go'], evidenceState: 'verified',
};

/**
 * NRI (old-PoS run 31 D3/D4): resolution integrity. finding_resolve refuses a
 * resolution whose cited code is unchanged and no test changed since the finding;
 * a finding citing Story metadata as well as code (a product finding) is not
 * closed while the cited checklist text is unchanged (run 31 closed F-001 with a
 * code test while checklist.json:5251 still said hooo); next routes that text to
 * one metadata correction in DEV. plan_acceptance_prepare/apply refuse a batch
 * that changes nothing (run 31 printed "Applied 1 PLAN acceptance items" while
 * userSees was unchanged), and the intentProposalApproval refusal names the
 * plain userSees update.
 */
function scenarioNRI(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NRI';
  const name = 'NRI old-PoS run 31: finding_resolve refuses unchanged citations (code without a test, cited checklist text), plan acceptance refuses a no-op';
  const o = new Owner(tag, 'B-e3b2', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  try {
    writeStaleUserSees(o);
    const rel = checklistRel(o.worktree, o.storyId);
    const mixed = { desc: `CHK-001 userSees says \`Upper("ab") == "ab"\` while strs/strs.go:4 Upper returns the upper-case form, so the request implies \`Upper("ab") == "AB"\`; strs/strs.go has no test for Upper("") either.`,
      severity: 'medium', category: 'missing', files: [rel, 'strs/strs.go'], evidenceState: 'verified' };
    devToReview(o);
    reviewRound(o, lane => lane === 'proof-or-stop-review-test-coverage'
      ? { conclusion: 'findings', note: 'Scripted findings: an untested edge and a userSees/code mismatch.', findings: [NRI_CODE_FINDING, mixed] }
      : PASS_ENVELOPE(lane));
    const codeId = `${o.storyId}:F-001`;
    const mixedId = `${o.storyId}:F-002`;
    const stored = new StoryStore(o.worktree).readFindings(o.storyId).findings.map(f => f.id);
    assert.deepEqual(stored, [codeId, mixedId], `[${tag}] a finding citing code and metadata stays a product finding: ${stored.join(', ')}`);
    inventoryCritic(o, { tag: 'r1', dispositions: [
      { finding: { findingId: codeId }, disposition: 'verified_family', familyKey: 'upper-empty-string', reason: 'Upper("") has no focused test; one verified family.' },
      { finding: { findingId: mixedId }, disposition: 'verified_family', familyKey: 'upper-user-sees', reason: 'CHK-001 userSees contradicts the request; one verified family.' }] });
    o.mustCli('review_inventory_finalize', { storyId: o.storyId, remediation: true }, { label: 'review_inventory_finalize --remediation' });
    o.mustCli('story_advance', { storyId: o.storyId, phase: 'DEV' }, { label: 'story_advance DEV (REVIEW->DEV)' });

    // 1. Nothing changed since the finding: refused.
    const early = o.cli('finding_resolve', { storyId: o.storyId, findingId: codeId, resolution: 'Upper is correct as implemented; nothing to change here.' }, { label: 'finding_resolve F-001 (nothing changed)' });
    assert.notEqual(early.status, 0, `[${tag}] a resolution with the cited code unchanged and no test change must be refused`);
    assert.match(early.out, /\[finding_resolution_unchanged_citation\]/, `[${tag}] refusal code:\n${early.out.slice(-1500)}`);
    // The mixed finding's cited checklist text is routed to ONE metadata correction (stored finding path).
    const routed = o.cli('next', { storyId: o.storyId, json: true }, { label: 'next (DEV, cited metadata unchanged)' });
    const step = parseJson(routed.stdout) as NextStepJson | null;
    assert.equal(step?.reason, 'metadata_correction', `[${tag}] next routes the cited checklist text first: ${step?.reason}: ${step?.why}`);
    assert.equal(step?.cli?.payload.itemId, 'CHK-001', `[${tag}] correction names CHK-001`);
    // The finding-repair prompt tells the worker never to read PoS metadata from product code.
    const dispatched = o.mustCli('dispatch', { storyId: o.storyId, agentType: FINDING_REPAIR, findingId: codeId }, { label: 'dispatch finding-repair (prompt)' });
    assert.match(dispatched.out, /never read or reference[^\n]*\.proof-or-stop\//i, `[${tag}] the repair prompt forbids product code reading .proof-or-stop/:\n${dispatched.out.slice(-2500)}`);

    // 2. A test change covers the code finding.
    writeFileSync(join(o.worktree, 'strs/strs_test.go'), readFileSync(join(o.worktree, 'strs/strs_test.go'), 'utf8') + NF_REPAIR_TEST);
    git(o.worktree, ['add', 'strs/strs_test.go']);
    git(o.worktree, ['-c', 'user.name=Bench Owner', '-c', 'user.email=owner@bench.invalid', 'commit', '-qm', 'test: Upper of the empty string']);
    o.mustCli('finding_resolve', { storyId: o.storyId, findingId: codeId, resolution: 'Commit adds TestUpperEmpty; go test -v ./strs -run TestUpperEmpty passes.' }, { label: 'finding_resolve F-001 (test added)' });

    // 3. The mixed finding: code test added, cited checklist text unchanged -> refused (run 31 F-001).
    const refused = o.cli('finding_resolve', { storyId: o.storyId, findingId: mixedId, resolution: 'Commit adds TestUpperEmpty asserting the upper-case form; passes.' }, { label: 'finding_resolve F-002 (checklist text unchanged)' });
    assert.notEqual(refused.status, 0, `[${tag}] a resolution leaving the cited checklist text unchanged must be refused`);
    assert.match(refused.out, /\[finding_resolution_unchanged_citation\]/, `[${tag}] refusal code:\n${refused.out.slice(-1500)}`);
    assert.match(refused.out, /CHK-001[^\n]*userSees/, `[${tag}] refusal names the cited item field:\n${refused.out.slice(-1500)}`);
    assert.match(refused.out, /Next: proof-or-stop checklist_update/, `[${tag}] refusal carries the metadata correction:\n${refused.out.slice(-1500)}`);
    // 4. The owner corrects the text in DEV (metadata correction), then the resolution is accepted.
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', userSees: META_FIXED_USER_SEES['CHK-001'], metadataCorrection: true,
      reason: 'The request says Upper returns the upper-case form, so Upper("ab") == "AB".' }, { label: 'checklist_update CHK-001 userSees (DEV metadata correction)' });
    o.mustCli('finding_resolve', { storyId: o.storyId, findingId: mixedId, resolution: 'CHK-001 userSees now states Upper("ab") == "AB"; TestUpperEmpty covers the code part.' }, { label: 'finding_resolve F-002 (text corrected)' });
    lines.push('code finding: refused unchanged, accepted after a test; mixed finding: refused while checklist text unchanged, accepted after the correction');
    o.cleanup();
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
  // 5. PLAN: plan acceptance of an unchanged intent is refused; the proposal refusal names the plain userSees update.
  const p = new Owner(`${tag}-plan`, 'B-e3b3', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST });
  try {
    const store = new StoryStore(p.worktree);
    store.writeStory(p.storyId, { ...store.readStory(p.storyId), phase: 'PLAN' });
    const legacy = store.readChecklist(p.storyId);
    store.writeChecklist(p.storyId, { ...legacy, items: legacy.items.map(item => ({ ...item, status: 'pending', startTime: null })) } as never);
    p.mustCli('dev_memory_preflight_ack', { storyId: p.storyId });
    const item = new StoryStore(p.worktree).readChecklist(p.storyId).items[0]!;
    const prepared = p.cli('plan_acceptance_prepare', { storyId: p.storyId, items: [{ itemId: item.id, files: item.files, verificationIntent: item.verificationIntent }] }, { label: 'plan_acceptance_prepare (no change)' });
    let refusal = prepared;
    if (prepared.status === 0) {
      const batch = parseJson(prepared.stdout) ?? JSON.parse(prepared.stdout.slice(prepared.stdout.indexOf('{')));
      refusal = p.cli('plan_acceptance_apply', { storyId: p.storyId, prepared: batch, reason: 'Run 31 shape: the owner applies a batch that changes no field of the item.' }, { label: 'plan_acceptance_apply (no change)' });
    }
    assert.notEqual(refusal.status, 0, `[${tag}] a plan acceptance batch that changes nothing must not report success:\n${refusal.out.slice(-1500)}`);
    assert.match(refusal.out, /\[plan_acceptance_noop\]/, `[${tag}] refusal code:\n${refusal.out.slice(-1500)}`);
    assert.match(refusal.out, /userSees/, `[${tag}] the refusal says how userSees is changed:\n${refusal.out.slice(-1500)}`);
    lines.push('plan acceptance no-op refused');
    p.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${p.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NMR (old-PoS run 31 REM2): the repair shipped a Go test that parses
 * .proof-or-stop/story/actives/<id>/checklist.json in model.patch. The scope gate
 * refuses product source/test changes referencing the Story's metadata, and the
 * implementer prompt says so.
 */
function scenarioNMR(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NMR';
  const name = 'NMR old-PoS run 31: a product test reading the Story checklist.json is refused at REVIEW entry; the implementer prompt forbids it';
  const o = new Owner(tag, 'B-e3b4', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  try {
    devSetup(o);
    const prompt = o.mustCli('dispatch', { storyId: o.storyId, agentType: IMPLEMENTER, itemId: 'CHK-001' }, { label: 'dispatch implementer (prompt)' });
    assert.match(prompt.out, /never read or reference[^\n]*\.proof-or-stop\//i, `[${tag}] the implementer prompt forbids product code reading .proof-or-stop/:\n${prompt.out.slice(-2500)}`);
    const rel = checklistRel(o.worktree, o.storyId);
    const test = `\nfunc TestAcceptanceText(t *testing.T) {\n\tif _, err := os.ReadFile("${rel}"); err != nil {\n\t\tt.Skip(err)\n\t}\n}\n`;
    const source = readFileSync(join(o.worktree, 'strs/strs_test.go'), 'utf8').replace('import "testing"', 'import (\n\t"os"\n\t"testing"\n)');
    writeFileSync(join(o.worktree, 'strs/strs_test.go'), source + test);
    git(o.worktree, ['add', 'strs/strs_test.go']);
    git(o.worktree, ['-c', 'user.name=proof-or-stop-finding-repair', '-c', 'user.email=repair@bench.invalid', 'commit', '-qm', 'test: acceptance text reads the checklist']);
    o.mustCli('verification_evidence_refresh_stale', { storyId: o.storyId }, { label: 'verification_evidence_refresh_stale (after the test commit)' });
    const refused = o.cli('story_advance', { storyId: o.storyId, phase: 'REVIEW' }, { label: 'story_advance REVIEW (test reads checklist.json)' });
    assert.notEqual(refused.status, 0, `[${tag}] REVIEW entry must refuse a product test that reads the Story metadata`);
    assert.match(refused.out, /\[scope_story_metadata_reference\]/, `[${tag}] refusal code:\n${refused.out.slice(-2000)}`);
    assert.match(refused.out, /strs\/strs_test\.go/, `[${tag}] refusal names the file:\n${refused.out.slice(-2000)}`);
    lines.push(`refused: ${refused.out.split('\n').find(row => row.includes('scope_story_metadata_reference'))?.slice(0, 200) ?? ''}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NLS (old-PoS run 31 D5: hooo and abc each needed two passes): the conflict
 * names CHK-001 userSees; the same wrong literal also sits in CHK-002's userSees.
 * The amendment step lists both in ONE step.
 */
function scenarioNLS(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NLS';
  const name = 'NLS old-PoS run 31: an intent-conflict amendment sweeps the wrong literal across every item in one step';
  const o = new Owner(tag, 'B-e3b5', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[${tag}] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  try {
    writeStaleUserSees(o);
    devSetup(o, false);
    const launch = ask('next (DEV start)');
    assert.equal(launch.reason, 'implement_item', `[${tag}] first DEV step: ${launch.reason}: ${launch.why}`);
    const script = implementerScript(o.storyId, String(launch.cli!.payload.itemId));
    const conflict = '[intent-conflict] CHK-001 userSees | request: "`strs.Upper(s)` returns the upper-case form of `s`" | request implies: `Upper("ab") == "AB"` | intent pins: userSees says `Upper("ab") == "ab"`';
    o.script(IMPLEMENTER, { ...script, final: `${script.final}\n${conflict}` });
    const launched = o.mustCli(launch.cli!.command, launch.cli!.payload, { label: 'host_run implementer (userSees conflict)' });
    const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
    const terminal = waitTerminal(o, 'implementer', runId);
    o.unscript(IMPLEMENTER);
    assert.equal(terminal.state, 'completed', `[${tag}] implementer terminal ${terminal.state} (${terminal.reason})`);
    const blocked = ask('next (conflict declared)');
    o.mustCli('story_advance', blocked.cli!.payload, { label: 'story_advance PLAN (conflict)' });
    const amend = ask('next (PLAN, conflict open)');
    assert.equal(amend.reason, 'intent_conflict_amend', `[${tag}] PLAN proposes the amendment: ${amend.reason}: ${amend.why}`);
    const ids = (amend.batch ?? []).map(call => String(call.cli.payload.itemId));
    assert.deepEqual(ids, ['CHK-001', 'CHK-002'], `[${tag}] the amendment step carries every item stating the wrong literal: ${JSON.stringify(ids)}; why: ${amend.why}`);
    assert.match(amend.why, /CHK-002 userSees/, `[${tag}] the why names the other occurrence: ${amend.why}`);
    for (const call of amend.batch ?? []) {
      const payload = { ...call.cli.payload, userSees: META_FIXED_USER_SEES[String(call.cli.payload.itemId)], status: 'pending',
        reason: 'The request says Upper returns the upper-case form, so Upper("ab") == "AB" everywhere it is stated.' };
      o.mustCli('checklist_update', payload, { label: `checklist_update ${String(call.cli.payload.itemId)} (swept)` });
    }
    const after = ask('next (PLAN, swept)');
    assert.doesNotMatch(after.reason, /^intent_conflict/, `[${tag}] the swept amendment clears the conflict: ${after.reason}: ${after.why}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NPA / NSR fixture: PLAN, request NIQ, every row pinned and derived. */
function planFixture(o: Owner, rowsPerItem: number, pad: string): void {
  const store = new StoryStore(o.worktree);
  store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'PLAN' });
  const legacy = store.readChecklist(o.storyId);
  const row = (desc: string, test: string, quote: string) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
    verification: { command: `go test -v ./strs -run ^${test}$`, selector: `--- PASS: ${test}` }, derivation: { requestQuote: quote, computation: `${desc}${pad}` } });
  const upperQuote = '`strs.Upper(s)` returns the upper-case form of `s`, for example `Upper("ab")` is `"AB"`.';
  const reverseQuote = '`strs.Reverse(s)` returns `s` reversed by rune, for example `Reverse("héllo")` is `"olléh"`.';
  const many = (make: (n: number) => ReturnType<typeof row>) => Array.from({ length: rowsPerItem }, (_, n) => make(n));
  store.writeChecklist(o.storyId, { ...legacy, items: legacy.items.map(item => item.id === 'CHK-001'
    ? { ...item, status: 'pending', startTime: null, userSees: 'Upper("ab") == "AB"; go test -v ./strs -run TestUpper prints --- PASS: TestUpper',
      verificationIntent: { happy: [row('Upper("ab") -> "AB"', 'TestUpper', upperQuote)], edge: many(n => row(`Upper("a${n}") -> "A${n}"`, `TestUpper${n}`, upperQuote)),
        adversarial: [row('Upper("") -> ""', 'TestUpperEmpty', upperQuote)] } }
    : { ...item, status: 'pending', startTime: null, userSees: 'Reverse("héllo") == "olleh"; go test -v ./strs -run TestReverse prints --- PASS: TestReverse',
      verificationIntent: { happy: [row('Reverse("héllo") -> "olleh"', 'TestReverse', reverseQuote)], edge: many(n => row(`Reverse("x${n}") -> "${n}x"`, `TestReverse${n}`, reverseQuote)),
        adversarial: [row('Reverse("") -> ""', 'TestReverseEmpty', reverseQuote)] } }) } as never);
  commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} PLAN checklist`);
  o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });
}

/**
 * NPA (old-PoS run 31 D7: plan_authoring printed 10.6k + 11.1k tokens into the
 * owner's context, carried ~212 turns): a step whose text render exceeds the
 * cap writes each long command payload to a file and prints `@<file>`.
 */
function scenarioNPA(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NPA';
  const name = 'NPA old-PoS run 31: a large next step prints at most ~2k tokens; the full payload is a file the command reads (@file)';
  const o = new Owner(tag, 'B-e3b6', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST });
  const lines: string[] = [];
  try {
    planFixture(o, 30, ' (each case is one input in the request syntax and the exact output the request states for it)');
    // Missing userSees + unpinned rows make a pre-scope authoring batch (row patches since lab initplan; smaller than the full intents it carried before).
    const store = new StoryStore(o.worktree);
    const cl = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => ({ ...item, userSees: '',
      verificationIntent: { ...item.verificationIntent!, edge: item.verificationIntent!.edge.map(({ verification: _pin, ...rest }) => rest) } })) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} unpinned rows`);
    const json = o.cli('next', { storyId: o.storyId, json: true }, { label: 'next --json (plan authoring)' });
    const step = parseJson(json.stdout) as NextStepJson | null;
    assert.equal(step?.reason, 'plan_authoring', `[${tag}] the fixture yields a plan_authoring step: ${step?.reason}: ${step?.why?.slice(0, 300)}`);
    const full = JSON.stringify(step).length;
    const text = o.cli('next', { storyId: o.storyId }, { label: 'next (text, plan authoring)' });
    assert.equal(text.status, 0, `[${tag}] next text render failed:\n${text.out.slice(-1500)}`);
    assert.ok(text.stdout.length <= 8000, `[${tag}] the text step is capped at ~2k tokens: ${text.stdout.length} chars`);
    const files = [...text.stdout.matchAll(/ @(\S+\.json)/g)].map(match => match[1]!);
    if (full > 8000) assert.ok(files.length >= 1, `[${tag}] the long commands read their payload from a file:\n${text.stdout.slice(0, 3000)}`);
    if (files.length) {
      const payloadFile = files[0]!.startsWith('/') ? files[0]! : join(o.worktree, files[0]!);
      const payload = JSON.parse(readFileSync(payloadFile, 'utf8')) as Record<string, unknown>;
      assert.equal(payload.storyId, o.storyId, `[${tag}] the file holds the command payload`);
      assert.ok('intentRows' in payload, `[${tag}] the file carries the row patch`);
    }
    lines.push(`plan_authoring: ${full} chars as JSON, ${text.stdout.length} chars printed, ${files.length} payload file(s)`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NSR (old-PoS run 31 D8: scope-plan reruns #4/#5 for value corrections the
 * verdict itself asked for): the verdict's pin audit names CHK-002:happy:0
 * (pins "olleh", the request gives "olléh"); next proposes that correction with
 * every other occurrence of the pinned literal (CHK-002 userSees); once applied,
 * next does not relaunch the scope-plan reviewer. Any other change still does.
 */
function scenarioNSR(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NSR';
  const name = 'NSR old-PoS run 31: a pin-audit value correction is checked deterministically (no scope-plan rerun); another change reruns it';
  const o = new Owner(tag, 'B-e3b7', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIQ_REQUEST });
  const lines: string[] = [];
  const ask = (label: string): NextStepJson => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[${tag}] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
  try {
    planFixture(o, 1, '');
    const launch = ask('next (PLAN, verdict missing)');
    assert.equal(launch.reason, 'scope_plan_review_launch', `[${tag}] the scope-plan reviewer is launched: ${launch.reason}: ${launch.why}`);
    const gap = 'pin-audit CHK-002:happy:0: pins "olleh"; request gives "olléh" (rune reversal keeps é)';
    o.script('proof-or-stop-review-scope-plan', { final: 'Scope review saved.', commands: [[process.execPath, CLI, 'scope_check_save', JSON.stringify({ storyId: o.storyId,
      features: [
        { feature: 'Upper returns the upper-case form', covered_by: 'CHK-001', status: 'covered', excluded_by: null, source: 'request.md' },
        { feature: gap, covered_by: null, status: 'gap', excluded_by: null, source: 'request.md' },
      ],
      summary: { total: 2, covered: 1, excluded: 0, gaps: 1 },
      readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null }, openQuestions: [] })]] });
    const payload = { ...launch.cli!.payload };
    for (const [key, value] of Object.entries({ host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort })) {
      if (typeof payload[key] !== 'string' || /^<.*>$/.test(String(payload[key]))) payload[key] = value;
    }
    const launched = o.mustCli('host_run', payload, { label: 'host_run scope-plan' });
    const terminal = waitTerminal(o, 'scope-plan', String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId));
    o.unscript('proof-or-stop-review-scope-plan');
    assert.equal(terminal.state, 'completed', `[${tag}] scope-plan terminal ${terminal.state} (${terminal.reason})`);
    const correction = ask('next (PLAN, pin-audit gap)');
    assert.equal(correction.reason, 'pin_audit_correction', `[${tag}] next proposes the pin-audit correction: ${correction.reason}: ${correction.why}`);
    assert.ok(correction.why.includes('"olleh"') && correction.why.includes('"olléh"'), `[${tag}] the step carries both values: ${correction.why}`);
    assert.match(correction.why, /CHK-002 userSees/, `[${tag}] the literal sweep names the userSees copy: ${correction.why}`);
    // The owner applies exactly the requested value (row and its userSees copy).
    const item = new StoryStore(o.worktree).readChecklist(o.storyId).items.find(row => row.id === 'CHK-002')!;
    const intent = JSON.parse(JSON.stringify(item.verificationIntent).replaceAll('"olleh"', '"olléh"').replaceAll('\\"olleh\\"', '\\"olléh\\"'));
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', verificationIntent: intent, userSees: (item.userSees ?? '').replace('"olleh"', '"olléh"') }, { label: 'checklist_update CHK-002 (requested value)' });
    const after = ask('next (PLAN, requested value applied)');
    assert.notEqual(after.reason, 'scope_plan_review_launch', `[${tag}] no scope-plan rerun for the value the verdict requested: ${after.why}`);
    assert.notEqual(after.reason, 'pin_audit_correction', `[${tag}] the applied correction clears the gap: ${after.why}`);
    // Another change since the verdict: the reviewer must judge it again.
    const changed = new StoryStore(o.worktree).readChecklist(o.storyId).items.find(row => row.id === 'CHK-001')!;
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', userSees: `${changed.userSees} (and nothing else)` }, { label: 'checklist_update CHK-001 (unrelated change)' });
    const rerun = ask('next (PLAN, unrelated change)');
    assert.equal(rerun.reason, 'scope_plan_review_launch', `[${tag}] an unrelated change still reruns the reviewer: ${rerun.reason}: ${rerun.why}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NUB (old-PoS run 31 D6): two critic duplicates of a resolved canonical close in ONE batch step. */
function scenarioNUB(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NUB';
  const name = 'NUB old-PoS run 31: duplicates of a resolved canonical are closed in one batch step (each with its own coverage run)';
  const o = new Owner(tag, 'B-e3b8', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const reasons: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, duplicate: 'covered2' }, lines, next => {
      if (/finding_(repair|resolve|duplicate)/.test(next.reason)) reasons.push(next.reason);
    });
    const order = reasons.filter((row, index) => row !== reasons[index - 1]);
    assert.deepEqual(order, ['finding_repair', 'finding_resolve', 'finding_duplicate_resolve_batch'], `[${tag}] finding steps: ${order.join(' > ')}`);
    const findings = new StoryStore(o.root).readFindings(o.storyId).findings;
    for (const desc of [NU_DUP_FINDING.desc, NU_DUP_FINDING2.desc]) {
      const dup = findings.find(f => f.desc === desc);
      assert.equal(dup?.status, 'resolved', `[${tag}] duplicate closed: ${desc.slice(0, 60)}`);
      assert.equal(dup?.resolutionType, 'duplicate', `[${tag}] closed as a duplicate`);
    }
    lines.push(`finding steps: ${order.join(' > ')}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NMS (old-PoS run 44 R2, run44-analysis.md §2.3): a lane cites a short quoted
 * literal of CHK-001's userSees (no `a == b` / `a -> b` statement, no corrected
 * value) beside a product finding; CHK-002 states the same span. Before, the
 * extraction kept the bare literal with correctedValue null, the sweep skipped
 * it (under 4 characters), and the digest tolerance needed the corrected value:
 * the owner's correction invalidated every lane envelope of the round, the
 * lanes ran again and `next` printed a circular pointer (guard_dev_blocked ->
 * review_inventory_status -> session_brief). Now the literal is widened to its
 * span (the sweep lists CHK-002 in the same step), the applied correction is
 * reverted from its recorded text, and the round's lane evidence stays valid.
 */
function scenarioNMS(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NMS';
  const name = 'NMS old-PoS run 44: a short-literal metadata correction (no corrected value) keeps the round\'s lane evidence: one swept correction, no lane rerun, no dead end';
  const o = new Owner(tag, 'B-e3c1', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const reasons: string[] = [];
  const corrections: NextStepJson[] = [];
  let afterCorrection: string | null = null;
  let laneState = '';
  try {
    const store0 = new StoryStore(o.worktree);
    const cl = store0.readChecklist(o.storyId);
    store0.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => META_SHORT_STALE_USER_SEES[item.id] ? { ...item, userSees: META_SHORT_STALE_USER_SEES[item.id]! } : item) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} stale short-literal userSees`);
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, metadata: 'short-literal' }, lines, next => {
      reasons.push(`${next.phase}:${next.reason}`);
      assert.ok(!(next.phase === 'REVIEW' && next.reason.startsWith('guard_')), `[${tag}] REVIEW dead end ${next.reason}: ${next.why.slice(0, 400)} (steps: ${reasons.join(' > ')})`);
      if (corrections.length === 1 && afterCorrection === null && next.reason !== 'metadata_correction') {
        afterCorrection = next.reason;
        if (next.reason === 'review_round_prepare') {
          laneState = JSON.stringify(collectReviewerEvidenceState(new StoryStore(o.worktree), o.storyId, o.worktree).invalid.map(issue => [issue.evidenceId, issue.code, issue.message.slice(0, 300)]));
        }
      }
      if (next.reason === 'metadata_correction') corrections.push(next);
    });
    assert.notEqual(afterCorrection, 'review_round_prepare', `[${tag}] the text correction must not rerun the round's lanes:\n${laneState}`);
    assert.equal(corrections.length, 1, `[${tag}] exactly ONE metadata correction step: ${corrections.map(row => row.why.slice(0, 160)).join(' | ')}`);
    const step = corrections[0]!;
    assert.ok(step.why.includes('upper: "a" mapped'), `[${tag}] the step names the span around the short literal: ${step.why.slice(0, 400)}`);
    assert.ok((step.batch ?? []).some(call => call.cli.payload.itemId === 'CHK-002'), `[${tag}] the sweep puts CHK-002's copy in the same step: ${JSON.stringify((step.batch ?? []).map(call => call.cli.payload.itemId))}`);
    const store = new StoryStore(o.root);
    const reclassified = store.readProcessEvents(o.storyId).filter(event => (event.type as string) === 'review_metadata_finding_reclassified')
      .flatMap(event => ((event as unknown as { reclassified?: Array<{ corrections?: Array<{ correctedValue: string | null }> }> }).reclassified ?? []).flatMap(row => row.corrections ?? []));
    assert.ok(reclassified.length >= 1 && reclassified.every(row => row.correctedValue === null), `[${tag}] the run 44 shape: no corrected value was extracted: ${JSON.stringify(reclassified)}`);
    const items = store.readChecklist(o.storyId).items;
    for (const id of ['CHK-001', 'CHK-002']) assert.equal(items.find(item => item.id === id)?.userSees, META_SHORT_FIXED_USER_SEES[id], `[${tag}] ${id} userSees corrected`);
    const rounds = reviewRoundCount(o);
    assert.equal(rounds, 2, `[${tag}] the product finding costs its one remediation round, the correction none: ${rounds}`);
    lines.push(`metadata correction: ${step.why.slice(0, 200)}`);
    lines.push(`review rounds ${rounds}; DONE`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${reasons.join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NMD (old-PoS run 44 R2, §2.3 links 4-5 and the 5 orphan ReviewRuns): the
 * Story's task context changes after round 1's lanes imported a verified
 * finding (here: the description, an edit the metadata tolerance does not
 * cover), so every lane envelope of the round is invalid and the lanes rerun.
 * The first wave's open finding is then invalid only for its task digest. Before,
 * it was not carried forward, no lane was launchable, and the stop-loss went to
 * guardStep(DEV), whose refusal (no remediation receipt) pointed at
 * review_inventory_status -> session_brief: a circle with no framework step.
 * Now the finding is carried and `next` opens the inventory epoch (one forward
 * framework step). Also: a hand `review_run_start` for a lane or critic whose
 * prepared ReviewRun is still live is refused with ONE Next naming that run
 * (run 44: the owner started 6 critic runs, 5 orphaned).
 */
function scenarioNMD(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NMD';
  const name = 'NMD old-PoS run 44: an invalidated round with an open finding and no epoch routes to the inventory epoch (no circular pointer); a duplicate review_run_start is refused with one Next';
  const o = new Owner(tag, 'B-e3c2', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const reasons: string[] = [];
  let mutated = false;
  let laneDup = '';
  let criticDup = '';
  const duplicateStart = (payload: Record<string, unknown>, live: string, label: string): string => {
    const refused = o.cli('review_run_start', payload, { label });
    assert.notEqual(refused.status, 0, `[${tag}] ${label}: a second ReviewRun for a target whose run ${live} is still live must be refused:\n${refused.out.slice(-1200)}`);
    assert.match(refused.out, /\[review_run_live\]/, `[${tag}] ${label}: refusal code:\n${refused.out.slice(-1200)}`);
    assert.ok(refused.out.includes(live), `[${tag}] ${label}: the refusal names the live run ${live}:\n${refused.out.slice(-1200)}`);
    // The CLI echoes the error twice (progress line + Error:); one distinct Next.
    assert.equal(new Set(refused.out.match(/^Next: .*$/gm) ?? []).size, 1, `[${tag}] ${label}: ONE Next:\n${refused.out.slice(-1200)}`);
    return refused.out.split('\n').find(row => row.startsWith('Next: ')) ?? '';
  };
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, interject: next => {
      const runs = new StoryStore(o.worktree).readReviewRuns(o.storyId).runs;
      if (next.reason === 'review_lane_launch' && !laneDup) {
        const payload = next.parallel?.[0]?.cli.payload ?? next.cli!.payload;
        laneDup = duplicateStart({ storyId: o.storyId, agent: String(payload.lane), lane: String(payload.lane), summary: true }, String(payload.reviewRunId), 'review_run_start (duplicate lane)');
        assert.equal(new StoryStore(o.worktree).readReviewRuns(o.storyId).runs.length, runs.length, `[${tag}] the refused start wrote no ReviewRun`);
      }
      if (next.reason === 'inventory_critic_launch' && !criticDup) {
        const epoch = new StoryStore(o.worktree).readReviewInventoryEpochs(o.storyId).epochs.at(-1)!;
        criticDup = duplicateStart({ storyId: o.storyId, agent: MANAGED_INVENTORY_CRITIC_LANE, lane: MANAGED_INVENTORY_CRITIC_LANE, reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch.epochId },
          String(next.cli!.payload.reviewRunId), 'review_run_start (duplicate critic)');
      }
      if (next.reason === 'inventory_begin' && !mutated) {
        // The task context changes after the lanes imported (an edit the metadata tolerance does not cover).
        const store = new StoryStore(o.worktree);
        store.writeStory(o.storyId, { ...store.readStory(o.storyId), description: `${store.readStory(o.storyId).description} (clarified)` });
        commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} task context edited after the lanes ran`);
        mutated = true;
        reasons.push('fixture:task_context_edited');
        return true;
      }
      return false;
    } }, lines, next => {
      reasons.push(`${next.phase}:${next.reason}`);
      assert.ok(!(next.phase === 'REVIEW' && (next.reason.startsWith('guard_') || /^(?:session_brief|review_inventory_status)$/.test(next.cli?.command ?? ''))),
        `[${tag}] REVIEW returned a pointer instead of a framework step: ${next.reason}: ${next.why.slice(0, 500)} (steps: ${reasons.join(' > ')})`);
    });
    assert.ok(mutated, `[${tag}] the fixture edited the task context`);
    assert.ok(laneDup && criticDup, `[${tag}] both duplicate starts were checked`);
    assert.match(laneDup, /proof-or-stop next --storyId=B-e3c2/, `[${tag}] the Next runs next (it launches or waits on the live run): ${laneDup}`);
    lines.push(`duplicate lane start: ${laneDup}`);
    lines.push(`steps: ${reasons.join(' > ').slice(0, 1500)}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${reasons.join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NMP (old-PoS run 44 F-021, §2.5): an intent-row metadata correction raised in
 * REVIEW needs PLAN. Before, `metadata_correction_plan` was an agent step whose
 * command (story_advance DEV) and refusal text (checklist.ts: "return to PLAN",
 * Next: story_advance DEV) disagreed; the owner tried checklist_update twice,
 * PLAN directly, then DEV, PLAN (7 commands, 2 refusals). Now the hop is the
 * framework's: REVIEW->DEV and DEV->PLAN are framework steps `next --run` runs,
 * the why names both hops, and the refusal from REVIEW points at `next --run`.
 */
function scenarioNMP(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NMP';
  const name = 'NMP old-PoS run 44: an intent-row correction raised in REVIEW reaches PLAN through framework steps (REVIEW->DEV->PLAN), with one correct pointer';
  const o = new Owner(tag, 'B-e3c3', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const seen: Array<{ phase: string; reason: string; kind: string; command: string }> = [];
  let refusal = '';
  try {
    devSetup(o);
    try {
      driveWithNext(o, { findingRound1: true, run: false, metadata: 'intent-rows' }, lines, next => {
        seen.push({ phase: next.phase, reason: next.reason, kind: next.kind, command: `${next.cli?.command ?? ''} ${JSON.stringify(next.cli?.payload ?? {})}` });
        if (next.reason === 'metadata_correction_plan' && next.phase === 'REVIEW' && !refusal) {
          const item = new StoryStore(o.worktree).readChecklist(o.storyId).items.find(row => row.id === 'CHK-001')!;
          const refused = o.cli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', verificationIntent: item.verificationIntent, metadataCorrection: true,
            reason: 'The request says Upper returns the upper-case form; the cited row must say so.' }, { label: 'checklist_update intent (REVIEW, refused)' });
          assert.notEqual(refused.status, 0, `[${tag}] an intent-row correction in REVIEW is refused (rows are frozen outside PLAN)`);
          assert.match(refused.out, /\[metadata_correction_intent_outside_plan\]/, `[${tag}] refusal code:\n${refused.out.slice(-800)}`);
          refusal = refused.out.split('\n').find(row => row.startsWith('Next: ')) ?? '';
        }
        if (next.reason === 'metadata_correction' && next.phase === 'PLAN') throw new StopDrive('PLAN correction reached');
      });
      assert.fail(`[${tag}] next never reached the PLAN correction: ${seen.map(row => `${row.phase}:${row.reason}`).join(' > ')}`);
    } catch (error) {
      if (!(error instanceof StopDrive)) throw error;
    }
    const at = seen.findIndex(row => row.reason === 'metadata_correction_plan');
    const hop = seen.slice(at);
    lines.push(`steps from the correction: ${hop.map(row => `${row.phase}:${row.reason}(${row.kind})`).join(' > ')}`);
    assert.equal(refusal, `Next: proof-or-stop next --storyId=${o.storyId} --run`, `[${tag}] the REVIEW refusal points at next --run (it makes both hops): ${refusal}`);
    assert.deepEqual(hop.map(row => `${row.phase}:${row.reason}:${row.kind}`), ['REVIEW:metadata_correction_plan:framework', 'DEV:metadata_correction_plan:framework', 'PLAN:metadata_correction:agent'],
      `[${tag}] REVIEW->DEV->PLAN are framework steps, then the one PLAN correction`);
    assert.match(hop[0]!.command, /story_advance .*"phase":"DEV"/, `[${tag}] the first hop leaves REVIEW for DEV: ${hop[0]!.command}`);
    assert.match(hop[1]!.command, /story_advance .*"phase":"PLAN"/, `[${tag}] the second hop goes to PLAN: ${hop[1]!.command}`);
    assert.match(hop[2]!.command, /checklist_update .*verificationIntent/, `[${tag}] PLAN proposes the intent correction: ${hop[2]!.command}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${seen.map(row => `${row.phase}:${row.reason}(${row.kind})`).join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NRG (old-PoS run 46, run46-analysis.md §0-§2, §5): a repair that reverses a
 * resolved finding's fix (and rewrites that finding's test to match) is caught by
 * the framework's post-repair guard: the resolved finding's covering test as
 * recorded at its resolution fails, the repair is not accepted, a
 * `[regression-of <id>]` finding opens, and the Story reaches DONE only with the
 * resolved behaviour intact. RED on the base: the reversing repair was resolved.
 */
function scenarioNRG(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NRG';
  const name = 'NRG old-PoS runs 46/47: a repair that reverses a resolved finding is rejected by its recorded covering test, a regression finding opens, and the conflict goes to the owner\'s PLAN pin (not to another repair)';
  const o = new Owner(tag, 'B-46e1', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const seen: Array<{ phase: string; reason: string; kind: string; command: string; why: string }> = [];
  try {
    devSetup(o);
    try {
      driveWithNext(o, { findingRound1: true, run: false, reversing: true }, lines, next => {
        seen.push({ phase: next.phase, reason: next.reason, kind: next.kind, command: `${next.cli?.command ?? ''} ${JSON.stringify(next.cli?.payload ?? {})}`, why: next.why });
        if (next.reason === 'finding_conflict_pin') throw new StopDrive('finding conflict reached');
      });
      assert.fail(`[${tag}] next never routed the conflict to the owner: ${seen.map(row => `${row.phase}:${row.reason}`).join(' > ')}`);
    } catch (error) {
      if (!(error instanceof StopDrive)) throw error;
    }
    lines.push(`finding steps: ${seen.filter(row => /finding_/.test(row.reason)).map(row => `${row.phase}:${row.reason}`).join(' > ')}`);
    const store = new StoryStore(o.worktree);
    const findings = store.readFindings(o.storyId).findings;
    const reversing = findings.find(f => f.desc === NRG_FINDING.desc);
    const regression = findings.find(f => f.desc.startsWith('[regression-of F-001]'));
    assert.ok(reversing, `${tag}: round 2 reported the marker finding`);
    assert.equal(reversing!.status, 'open', `${tag}: the reversing repair was not accepted (the finding stays open)`);
    assert.ok(regression && regression.status === 'open', `${tag}: the framework opened a [regression-of F-001] finding; findings: ${findings.map(f => `${f.id} ${f.status} ${f.desc.slice(0, 60)}`).join(' | ')}`);
    const events = store.readProcessEvents(o.storyId).filter(e => String(e.type) === 'resolved_finding_guard_checked') as Array<{ findingId?: string; passed?: boolean; restoredTests?: boolean; rejectedRepairs?: Array<{ findingId: string }> }>;
    assert.ok(events.some(e => e.findingId === `${o.storyId}:F-001` && e.passed === false && e.restoredTests === true && e.rejectedRepairs?.some(r => r.findingId === reversing!.id)),
      `${tag}: F-001's recorded test failed and rejected ${reversing!.id}'s repair: ${JSON.stringify(events)}`);
    const pin = seen.at(-1)!;
    assert.deepEqual([pin.phase, pin.kind], ['DEV', 'agent'], `${tag}: one owner step in DEV`);
    assert.match(pin.command, /story_advance .*"phase":"PLAN"/, `${tag}: the one Next is the PLAN pin: ${pin.command}`);
    assert.match(pin.why, new RegExp(`${reversing!.id} and resolved ${o.storyId}:F-001`), `${tag}: the why names both sides: ${pin.why}`);
    assert.equal(seen.filter(row => row.reason === 'finding_repair').length, 2, `${tag}: no second repair of the reversing finding before the pin: ${seen.map(row => row.reason).join(' > ')}`);
    lines.push(`stopped at the owner's pin: ${pin.why.slice(0, 160)}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${seen.map(row => `${row.phase}:${row.reason}(${row.kind})`).join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NRF (old-PoS run 73, run73-analysis.md §6 A/B): round 2 re-finds round 1's defect through two other call shapes (two
 * `[regression-of F-001]` findings, F-001 resolved) beside one distinct finding. The base repaired them one after the other:
 * the owner first tried `finding_resolve duplicateOf` on each regression (coverage refused), then F-002 and the distinct
 * finding shared a run and F-003 got its own serial run. Now a regression of a resolved finding is never offered the
 * duplicate-coverage path and joins the ONE grouped repair run (three findings, one run); its prompt carries the earlier
 * repair's diff and repro and asks for a family test (`[family-test]`); each finding is still resolved with its own commit.
 * RED on the base: `duplicate_coverage_refused` steps and a second round-2 repair run.
 */
function scenarioNRF(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NRF';
  const name = 'NRF old-PoS run 73: two regression-of findings of a resolved finding and one distinct finding are repaired in ONE grouped run (no duplicate-coverage attempt, no serial repair); the prompt carries the earlier repair diff and the family-test requirement';
  const o = new Owner(tag, 'B-73f1', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const reasons: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, regFamily: true, duplicate: 'uncovered' }, lines, next => {
      if (next.reason === 'finding_repair' || next.reason === 'finding_resolve' || next.reason === 'finding_resolve_batch' || next.reason === 'finding_duplicate_resolve' || next.reason === 'finding_duplicate_resolve_batch') {
        const group = next.cli?.payload.groupFindingIds;
        const ids = Array.isArray(group) ? (group as string[]).map(row => row.split(':').pop()).join('+') : String(next.cli?.payload.findingId ?? '').split(':').pop();
        reasons.push(`${next.reason}:${ids}`);
      }
    });
    const order = reasons.filter((row, index) => row !== reasons[index - 1]);
    lines.push(`finding steps: ${order.join(' > ')}`);
    assert.ok(!order.some(row => row.startsWith('finding_duplicate_resolve')), `${tag}: a regression of a resolved finding is never offered the duplicate-coverage path: ${order.join(' > ')}`);
    const repairs = managedPrompts(o, FINDING_REPAIR);
    assert.equal(repairs.length, 2, `${tag}: round 1's repair plus ONE grouped round-2 run (got ${repairs.length}): ${order.join(' > ')}`);
    assert.equal((repairs[1]!.target?.groupFindingIds as string[] | undefined)?.length, 3, `${tag}: the round-2 run binds the three findings: ${JSON.stringify(repairs[1]!.target)}`);
    assert.match(repairs[1]!.prompt, /\[family-test\]/, `${tag}: the grouped run's prompt asks for the family test`);
    assert.match(repairs[1]!.prompt, /Family-complete repair/, `${tag}: the prompt carries the family-complete brief`);
    const findings = new StoryStore(o.root).readFindings(o.storyId).findings;
    for (const finding of findings) assert.equal(finding.status, 'resolved', `${tag}: ${finding.id} resolved`);
    const commits = findings.filter(f => /F-00[234]$/.test(f.id)).map(f => String(f.resolvedReason).match(/\[repair commit ([0-9a-f]+)/)?.[1]);
    assert.equal(new Set(commits).size, 3, `${tag}: each of the three findings cites its own commit (${commits.join(', ')})`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${reasons.join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NGS (old-PoS run 58, run58-analysis.md §4 "Why the guard loops"): the
 * resolved-finding guard judges a later repair by the finding's OWN repro rows
 * of its repair test, not by every row of the test function as it stood in the
 * repair commit. Round 1's F-001 (Repro `Reverse("")`) is repaired with a table
 * test that also holds a then-correct row of another case; round 2's F-002
 * changes that case legitimately (and updates the row). F-002 is resolved,
 * round 3 is clean, DONE. RED on the base: the stale row failed F-001's guard,
 * F-002's repair was rejected, `[regression-of F-001]` opened and next asked
 * for a PLAN pin (the run-58 cascade).
 */
function scenarioNGS(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NGS';
  const name = 'NGS old-PoS run 58: a stale row of another case in a resolved finding\'s repair test no longer rejects a later correct repair (the guard runs the finding\'s own repro rows); DONE without a regression finding or a pin';
  const o = new Owner(tag, 'B-58e1', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const seen: Array<{ phase: string; reason: string }> = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: false, run: false, staleRow: true }, lines, next => {
      seen.push({ phase: next.phase, reason: next.reason });
      if (next.reason === 'finding_conflict_pin') assert.fail(`${tag}: a stale snapshot row sent a correct repair to a PLAN pin (run-58 cascade): ${next.why.slice(0, 400)}`);
    });
    const store = new StoryStore(o.root);
    const findings = store.readFindings(o.storyId).findings;
    lines.push(`findings: ${findings.map(f => `${f.id.split(':').pop()} ${f.status}`).join(', ')}`);
    lines.push(`finding steps: ${seen.filter(row => /finding_/.test(row.reason)).map(row => `${row.phase}:${row.reason}`).join(' > ')}`);
    assert.equal(seen.some(row => row.reason === 'finding_conflict_pin'), false, `${tag}: no pin step: ${seen.map(row => row.reason).join(' > ')}`);
    assert.equal(findings.some(f => f.desc.startsWith('[regression-of')), false, `${tag}: no regression finding opened: ${findings.map(f => f.desc.slice(0, 60)).join(' | ')}`);
    for (const desc of [NGS_FINDING1.desc, NGS_FINDING2.desc]) {
      assert.equal(findings.find(f => f.desc === desc)?.status, 'resolved', `${tag}: ${desc.slice(0, 40)} resolved`);
    }
    const events = store.readProcessEvents(o.storyId).filter(e => String(e.type) === 'resolved_finding_guard_checked') as Array<{ findingId?: string; passed?: boolean; scope?: string }>;
    const first = findings.find(f => f.desc === NGS_FINDING1.desc)!.id;
    assert.ok(events.some(e => e.findingId === first && e.passed === true && e.scope === 'repro'), `${tag}: ${first}'s guard ran its repro rows and passed: ${JSON.stringify(events)}`);
    assert.equal(store.readStory(o.storyId).phase, 'DONE', `${tag}: DONE`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${seen.map(row => `${row.phase}:${row.reason}`).join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NGF (old-PoS run 58 F-004/F-009): a SUSPECTED `[precedent-conflict]`
 * finding is a question for the owner's pin as soon as the Story is in DEV for
 * the round's remediation; it does not wait a round for a verified re-filing.
 * RED on the base: the suspected conflict was ignored (only verified findings
 * were offered to the conflict step) and the verified finding went to repair.
 */
function scenarioNGF(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NGF';
  const name = 'NGF old-PoS run 58: a suspected [precedent-conflict] finding goes to ONE PLAN pin step in the same remediation (no extra round), before any repair';
  const o = new Owner(tag, 'B-58e2', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const seen: Array<{ phase: string; reason: string; kind: string; command: string; why: string }> = [];
  try {
    devSetup(o);
    try {
      driveWithNext(o, { findingRound1: false, run: false, suspectedConflict: true }, lines, next => {
        seen.push({ phase: next.phase, reason: next.reason, kind: next.kind, command: `${next.cli?.command ?? ''} ${JSON.stringify(next.cli?.payload ?? {})}`, why: next.why });
        if (next.reason === 'finding_conflict_pin' || next.reason === 'finding_repair') throw new StopDrive('first remediation step reached');
      });
      assert.fail(`[${tag}] no remediation step: ${seen.map(row => `${row.phase}:${row.reason}`).join(' > ')}`);
    } catch (error) {
      if (!(error instanceof StopDrive)) throw error;
    }
    const store = new StoryStore(o.worktree);
    const conflict = store.readFindings(o.storyId).findings.find(f => f.desc === NGF_SUSPECTED_CONFLICT.desc);
    assert.ok(conflict, `${tag}: round 1 recorded the suspected conflict`);
    const last = seen.at(-1)!;
    lines.push(`first remediation step: ${last.phase}:${last.reason}`);
    assert.equal(last.reason, 'finding_conflict_pin', `${tag}: the suspected conflict is pinned first: ${seen.map(row => row.reason).join(' > ')}`);
    assert.match(last.command, /story_advance .*"phase":"PLAN"/, `${tag}: one Next, the PLAN pin`);
    assert.match(last.why, new RegExp(conflict!.id), `${tag}: the why names the suspected conflict: ${last.why}`);
    assert.match(last.why, /Oracle order/, `${tag}: the why gives the oracle order`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${seen.map(row => `${row.phase}:${row.reason}(${row.kind})`).join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NMW (old-PoS run 68 R2, run68-analysis.md §5 links 2-4): a wave whose only report is a
 * Story-metadata finding on an intent row (a correction only PLAN may make; no product
 * finding). The REVIEW verdict refuses [review_metadata_correction_open]. Before, that
 * code went through the stale-evidence stop-loss: the live epoch was cancelled twice
 * (each cancel staled the wave, so all lanes reran: two wasted waves), and with the
 * cancel budget spent REVIEW->DEV was refused for the OPEN epoch's missing receipt and
 * `next` returned the agent step `guard_dev_blocked` whose only command was the read-only
 * `review_inventory_status` (the owner ran the critic by hand). Now the wave's lanes
 * finish, the round's critic and finalize run as framework steps, and the correction
 * takes ONE framework hop REVIEW->DEV->PLAN: one lane wave, no stop-loss cancel, no
 * guard step, no read-only pointer.
 */
function scenarioNMW(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NMW';
  const name = 'NMW old-PoS run 68: a metadata-only wave (intent row) keeps its one lane wave: critic and finalize, then one framework hop to the PLAN correction (no stop-loss cancel, no dead end)';
  const o = new Owner(tag, 'B-68a1', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const seen: Array<{ phase: string; reason: string; kind: string; command: string }> = [];
  const violations: string[] = [];
  try {
    devSetup(o);
    try {
      driveWithNext(o, { findingRound1: false, run: false, metadata: 'intent-only' }, lines, next => {
        seen.push({ phase: next.phase, reason: next.reason, kind: next.kind, command: `${next.cli?.command ?? ''} ${JSON.stringify(next.cli?.payload ?? {})}` });
        // Recorded, not thrown, so a RED run shows the whole base path (cancels, relaunches, the dead end).
        if (next.reason === 'review_stop_loss_inventory_cancel') violations.push(`stop-loss cancel #${violations.filter(row => row.startsWith('stop-loss')).length + 1} for a metadata-only report`);
        const readOnly = next.kind === 'agent' && /^(?:review_inventory_status|session_brief|certification_window_status)$/.test(next.cli?.command ?? '');
        if ((next.phase === 'REVIEW' && next.reason.startsWith('guard_')) || readOnly) {
          violations.push(`dead end ${next.phase}:${next.reason} (${next.kind}, command ${next.cli?.command ?? 'none'}): ${next.why.slice(0, 300)}`);
          throw new StopDrive('dead end');
        }
        if (next.reason === 'metadata_correction' && next.phase === 'PLAN') throw new StopDrive('PLAN correction reached');
      });
      assert.fail(`[${tag}] next never reached the PLAN correction: ${seen.map(row => `${row.phase}:${row.reason}`).join(' > ')}`);
    } catch (error) {
      if (!(error instanceof StopDrive)) throw error;
    }
    const store = new StoryStore(o.worktree);
    const laneRuns = store.readReviewRuns(o.storyId).runs.filter(run => run.reviewPurpose !== 'inventory-completeness');
    const lanes = new Set(laneRuns.map(run => run.lane));
    lines.push(`lane runs ${laneRuns.length} (${lanes.size} lanes); steps: ${seen.map(row => `${row.phase}:${row.reason}(${row.kind})`).join(' > ')}`);
    assert.deepEqual(violations, [], `[${tag}] the metadata-only report went through the stale-wave stop-loss / a dead end`);
    assert.equal(laneRuns.length, lanes.size, `[${tag}] ONE lane wave for the metadata-only report (run 68: three): ${laneRuns.map(run => `${run.reviewRunId}:${run.lane}`).join(', ')}`);
    const cancels = store.readReviewInventoryEpochs(o.storyId).epochs.filter(epoch => epoch.state === 'CANCELLED');
    assert.deepEqual(cancels.map(epoch => epoch.epochId), [], `[${tag}] no inventory epoch is cancelled for a metadata-only report: ${JSON.stringify(cancels.map(epoch => [epoch.epochId, epoch.cancelReason]))}`);
    const at = seen.findIndex(row => row.reason === 'metadata_correction_plan');
    assert.ok(at >= 0, `[${tag}] the correction hop is a step`);
    assert.ok(seen.slice(0, at).some(row => row.reason === 'inventory_critic_launch'), `[${tag}] the round's critic ran as a framework launch before the hop: ${seen.map(row => row.reason).join(' > ')}`);
    assert.deepEqual(seen.slice(at).map(row => `${row.phase}:${row.reason}:${row.kind}`), ['REVIEW:metadata_correction_plan:framework', 'DEV:metadata_correction_plan:framework', 'PLAN:metadata_correction:agent'],
      `[${tag}] one framework hop REVIEW->DEV->PLAN, then the one PLAN correction`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${seen.map(row => `${row.phase}:${row.reason}(${row.kind})`).join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

/** NRV: CHK-002's edge row pins the trailing-newline case as the first implementation tested it. */
const NRV_ROW_DESC = 'Reverse keeps every rune: `Reverse("ab\\n") -> "\\nba"`';

/**
 * NRV (old-PoS run 68 R1 -> R2, run68-analysis.md §5 link 1): a verified finding's repair
 * fixes the code AND changes the expected value of the table-test row that a checklist
 * intent row also pins (`<case> -> <old>`). Nothing amended the checklist, so the next
 * round's lanes reported the stale intent row as Story metadata (run 68: two R2 waves,
 * a dead end, a DEV->PLAN trip and a third round, +34 min). Now, once the repair is
 * resolved, the framework derives the changed value from the repair commit's test diff,
 * takes the Story to PLAN (framework hop) and applies the row patch itself (a framework
 * `checklist_update` with `re-pin: <case> was <old>, now <new>`) before the next round:
 * the row states the repaired value before the next round (the run stops at PLAN's own
 * scope-plan rerun, unchanged behaviour the fixture has no reviewer script for).
 */
function scenarioNRV(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NRV';
  const name = 'NRV old-PoS run 68: a repair that changes a pinned expected value sweeps the checklist intent row in the same repair window (framework re-pin before the next round)';
  const o = new Owner(tag, 'B-68a2', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const seen: Array<{ phase: string; reason: string; kind: string; command: string }> = [];
  try {
    // The first implementation tested the trailing-newline case with its then value.
    writeFileSync(join(o.worktree, 'strs/strs_test.go'), `${readFileSync(join(o.worktree, 'strs/strs_test.go'), 'utf8')}${NGS_REPAIR_TEST}`);
    git(o.worktree, ['add', 'strs/strs_test.go']);
    git(o.worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'test: Reverse edge table']);
    const store0 = new StoryStore(o.worktree);
    const cl = store0.readChecklist(o.storyId);
    store0.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => item.id === 'CHK-002' ? { ...item, verificationIntent: { ...item.verificationIntent!,
      edge: [{ id: 'CHK-002:edge:0', desc: NRV_ROW_DESC, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
        verification: { command: 'go test -v ./strs -run ^TestReverseEdges$', selector: '--- PASS: TestReverseEdges' } }] } } : item) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} CHK-002 edge row`);
    o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });
    o.mustCli('scope_contract_init_from_plan', { storyId: o.storyId });
    addItemEvidence(o);
    o.mustCli('verification_evidence_add', { storyId: o.storyId, itemId: 'CHK-002', intentRef: 'CHK-002:edge:0', kind: 'logic_test',
      command: 'go test -v ./strs -run ^TestReverseEdges$', selector: '--- PASS: TestReverseEdges', note: 'Pinned focused go test proves the trailing-newline row.' }, { label: 'verification_evidence_add CHK-002 edge' });
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', status: 'done' }, { label: 'checklist_update CHK-001 done' });
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', status: 'done' }, { label: 'checklist_update CHK-002 done' });
    // The fixture has no scope-plan reviewer script: stop at the first PLAN step after the patch (PLAN's own
    // scope-plan rerun after a checklist edit is unchanged behaviour). RED on the base: no patch, DONE reached.
    let patchedAt = -1;
    try {
      driveWithNext(o, { findingRound1: false, run: false, repin: true }, lines, next => {
        seen.push({ phase: next.phase, reason: next.reason, kind: next.kind, command: `${next.cli?.command ?? ''} ${JSON.stringify(next.cli?.payload ?? {})}` });
        if (patchedAt >= 0 && next.phase === 'PLAN') throw new StopDrive('PLAN after the re-pin');
        if (next.phase === 'PLAN' && next.reason === 'metadata_correction') patchedAt = seen.length - 1;
      });
    } catch (error) {
      if (!(error instanceof StopDrive)) throw error;
    }
    const store = new StoryStore(o.worktree);
    const row = store.readChecklist(o.storyId).items.find(item => item.id === 'CHK-002')!.verificationIntent!.edge[0]!;
    lines.push(`CHK-002:edge:0 now: ${row.desc}`);
    lines.push(`steps: ${seen.map(entry => `${entry.phase}:${entry.reason}(${entry.kind})`).join(' > ').slice(0, 1600)}`);
    assert.ok(row.desc.includes('Reverse("ab\\n") -> "ba\\n"'), `[${tag}] the intent row states the repaired value: ${row.desc}`);
    assert.ok(!row.desc.includes('-> "\\nba"'), `[${tag}] the old pinned value is gone from the row: ${row.desc}`);
    assert.match(`${row.desc} ${(row as { derivation?: { computation?: string } }).derivation?.computation ?? ''}`, /re-pin: .*was .*now /, `[${tag}] the row states the re-pin (run-58 pin-reversal rule): ${JSON.stringify(row)}`);
    const patch = seen.find(entry => entry.phase === 'PLAN' && entry.reason === 'metadata_correction');
    assert.ok(patch, `[${tag}] the PLAN row patch is a step: ${seen.map(entry => `${entry.phase}:${entry.reason}`).join(' > ')}`);
    assert.equal(patch!.kind, 'framework', `[${tag}] the framework applies the derived row patch (no owner authoring): ${patch!.command}`);
    assert.match(patch!.command, /checklist_update .*"intentRows"/, `[${tag}] a row-level patch: ${patch!.command}`);
    const at = seen.findIndex(entry => entry.reason === 'finding_resolve');
    assert.deepEqual(seen.slice(at + 1, at + 3).map(entry => `${entry.phase}:${entry.reason}:${entry.kind}`), ['DEV:metadata_correction_plan:framework', 'PLAN:metadata_correction:framework'],
      `[${tag}] right after the resolve, in the same repair window: the framework DEV->PLAN hop and the framework row patch`);
    assert.equal(new Set(store.readReviewRuns(o.storyId).runs.map(run => run.reviewRound)).size, 1, `[${tag}] the re-pin happens before the next review round`);
    assert.equal(store.readChecklist(o.storyId).items.find(item => item.id === 'CHK-002')!.status, 'done', `[${tag}] the metadata re-pin keeps the done item done (the code already satisfies it)`);
    assert.ok(store.readProcessEvents(o.storyId).some(event => (event.type as string) === 'repair_expected_value_changed'), `[${tag}] the derived value change is journaled`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${seen.map(entry => `${entry.phase}:${entry.reason}(${entry.kind})`).join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

// ---------------------------------------------------------------------------
// Lab round-cut (bench-staging/oldpos/run74-75-analysis.md §7 N1-N3): fewer review rounds.

/** NRC: the task base has a Clip helper whose nil-n branch keeps the whole string; its base test exercises it. */
const NRC_CLIP_BASE = '\n// Clip returns s[:*n]; a nil n keeps the whole string.\nfunc Clip(s string, n *int) string {\n\tif n != nil {\n\t\treturn s[:*n]\n\t}\n\treturn s\n}\n';
/** NRC: the Story's refactor of Clip drops the nil branch (run-75 shape: `end != NULL` became `!endOmitted`). */
const NRC_CLIP_HEAD = '\n// Clip returns s[:*n]; a nil n keeps the whole string.\nfunc Clip(s string, n *int) string {\n\treturn s[:*n]\n}\n';
const NRC_BASE_STRS = `package strs\n\n// Upper returns s unchanged (baseline bug).\nfunc Upper(s string) string { return s }\n${NRC_CLIP_BASE}`;
const NRC_CLIP_TEST = '\nfunc TestClipNil(t *testing.T) {\n\tif Clip("abc", nil) != "abc" {\n\t\tt.Fatal("a nil n keeps the whole string")\n\t}\n}\n';
const NRC_BASE_TESTS = `package strs\n\nimport "testing"\n\nfunc TestBaseline(t *testing.T) {}\n${NRC_CLIP_TEST}`;

/** NRC: the relaunched implementer restores the base branch and tests it. */
function nrcRestoreScript(storyId: string, itemId: string): ProviderScript {
  const writeFiles = `const fs=require('fs');fs.writeFileSync('strs/strs.go',${JSON.stringify(`${IMPL}${NRC_CLIP_BASE}`)});fs.writeFileSync('strs/strs_test.go',${JSON.stringify(`${TESTS}${NRC_CLIP_TEST}`)});`;
  return { commands: [
    [process.execPath, '-e', writeFiles],
    // A framework git read (a status poll) may hold the index lock for a moment: retry the commit.
    ['/bin/sh', '-c', `for i in 1 2 3 4 5 6 7 8; do git add strs && git -c user.name=${IMPLEMENTER} commit -qm '${storyId} ${itemId}: keep the base nil branch of Clip' && break; sleep 1; done; git log --format=%h -1`],
    [process.execPath, CLI, 'checklist_update', JSON.stringify({ storyId, itemId, status: 'done' })],
  ], final: `Restored the nil-n branch of Clip and tested it (TestClipNil); ${itemId} marked done.\n[intent-conflict] none` };
}

/**
 * NRC / NRC-ADV (lab round-cut N1, run 75 F-006 / runs 65, 71, 73, 74): the Story's refactor of a
 * helper drops a base operand guard (a nil branch) that no row covers. RED on the base: nothing
 * looked at the base→HEAD diff before REVIEW, so the regression waited for a lane (1-3 rounds
 * late). Now (dev.removedGuardScan=on, NRC) the DEV exit reopens the item that declares the file
 * and relaunches its implementer with the removed guard, its base line and the base test (a
 * framework step, once per guard set): the relaunch restores it and the Story passes REVIEW in one
 * round. With the default (advisory, NRC-ADV) nothing is reopened and every review lane's prompt
 * carries the removed guard as an advisory note.
 */
function scenarioNRC(machineEnv: NodeJS.ProcessEnv, steps: Step[], advisory: boolean): Outcome {
  const tag = advisory ? 'NRC-ADV' : 'NRC';
  const name = advisory
    ? 'NRC-ADV lab round-cut N1 (default advisory): a base operand guard the Story removed is named in every review lane prompt; nothing is reopened'
    : 'NRC lab round-cut N1 (dev.removedGuardScan=on): a base operand guard the Story removed reopens its item before REVIEW; the relaunch restores it; one review round';
  const o = new Owner(tag, advisory ? 'B-7c02' : 'B-7c01', machineEnv, steps, false, { trackedGateFailureCounts: true,
    baseFiles: { 'strs/strs.go': NRC_BASE_STRS, 'strs/strs_test.go': NRC_BASE_TESTS }, ...(advisory ? {} : { config: { dev: { removedGuardScan: 'on' } } }) });
  const lines: string[] = [];
  const seen: Array<{ phase: string; reason: string; kind: string }> = [];
  try {
    // The Story's implementation keeps Clip but drops its nil branch.
    writeFileSync(join(o.worktree, 'strs/strs.go'), `${IMPL}${NRC_CLIP_HEAD}`);
    git(o.worktree, ['add', 'strs/strs.go']);
    git(o.worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'refactor Clip']);
    devSetup(o);
    driveWithNext(o, { findingRound1: false, run: false, implementerScript: itemId => nrcRestoreScript(o.storyId, itemId) }, lines, next => {
      seen.push({ phase: next.phase, reason: next.reason, kind: next.kind });
    });
    const order = seen.map(row => `${row.phase}:${row.reason}`);
    const reopen = seen.findIndex(row => row.reason === 'removed_guard_reopen');
    const review = seen.findIndex(row => row.reason === 'enter_review');
    lines.push(`steps to REVIEW: ${order.slice(0, review + 1).join(' > ')}`);
    const lanePrompts = managedPrompts(o).filter(row => /proof-or-stop-review-(?:test-coverage|quality|concept|docs)/.test(row.agentType));
    if (advisory) {
      assert.equal(reopen, -1, `${tag}: advisory mode never reopens: ${order.join(' > ')}`);
      assert.ok(lanePrompts.length > 0, `${tag}: lanes ran`);
      for (const row of lanePrompts) {
        assert.match(row.prompt, /Removed base guard/, `${tag}: ${row.agentType} prompt names the removed guard`);
        assert.match(row.prompt, /strs\/strs\.go:\d+[^\n]*n != nil/, `${tag}: with its base line`);
      }
    } else {
      assert.ok(reopen >= 0 && reopen < review, `${tag}: the removed guard reopens an item before REVIEW: ${order.join(' > ')}`);
      assert.equal(seen[reopen]!.kind, 'framework', `${tag}: the reopen is a framework step`);
      const relaunch = managedPrompts(o, IMPLEMENTER).at(-1);
      assert.ok(relaunch, `${tag}: an implementer relaunch`);
      assert.match(relaunch!.prompt, /Removed base guard/, `${tag}: the relaunch prompt carries the guard`);
      assert.match(relaunch!.prompt, /strs\/strs\.go:\d+[^\n]*n != nil/, `${tag}: with its base line`);
      assert.match(relaunch!.prompt, /TestClipNil|Clip\("abc", nil\)/, `${tag}: and the base test of the class`);
      assert.equal(reviewRoundCount(o), 1, `${tag}: one review round`);
      assert.match(readFileSync(join(o.root, 'strs/strs.go'), 'utf8'), /if n != nil/, `${tag}: the merged code keeps the base branch`);
    }
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE', `${tag}: DONE`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${seen.map(row => `${row.phase}:${row.reason}(${row.kind})`).join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

/** NRM: the Story adds a Window helper that branches on two operands (start, end). */
const NRM_WINDOW = '\n// Window returns s[start:end] with both bounds clamped to the string.\nfunc Window(s string, start, end int) string {\n\tif start < 0 {\n\t\tstart = 0\n\t}\n\tif end > len(s) {\n\t\tend = len(s)\n\t}\n\treturn s[start:end]\n}\n';
const NRM_START_LINE = `${IMPL}${NRM_WINDOW}`.split('\n').findIndex(line => line === '\tif start < 0 {') + 1;
const NRM_FINDING = {
  desc: `strs/strs.go:${NRM_START_LINE} Window clamps a negative start to 0 without a test of the start branch. Repro: \`Window("abc", -1, 3)\``,
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};
const NRM_TEST_START = '\nfunc TestWindowNegativeStart(t *testing.T) {\n\tif Window("abc", -1, 3) != "abc" {\n\t\tt.Fatal("start")\n\t}\n}\n';
const NRM_TEST_END = '\nfunc TestWindowEndBeyond(t *testing.T) {\n\tif Window("abc", 0, 9) != "abc" {\n\t\tt.Fatal("end")\n\t}\n}\n';
/** NRM: attempt 1 tests and reports only the finding's own branch; attempt 2 (only reached before lab run89) every operand. */
function nrmRepairScript(storyId: string, attempt: number): ProviderScript {
  const test = attempt === 1 ? NRM_TEST_START : NRM_TEST_END;
  const lines = attempt === 1 ? ['[branch-test] Window start=-1: TestWindowNegativeStart -> abc']
    : ['[branch-test] Window start=-1: TestWindowNegativeStart -> abc', '[branch-test] Window end=9 (beyond len): TestWindowEndBeyond -> abc'];
  return { commands: [['/bin/sh', '-c', `printf '%s' '${test.replace(/'/g, "'\\''")}' >> strs/strs_test.go && git add strs/strs_test.go && git -c user.name=${FINDING_REPAIR} commit -qm 'test: Window bounds (attempt ${attempt})' && git log --format=%h -1`]],
    final: `Tested Window's bounds (attempt ${attempt}); committed.\n${lines.join('\n')}` };
}

/**
 * NRM (lab round-cut N2, run 75 F-001 -> F-003): a finding sits in a helper that branches on two
 * operands. The repair prompt carries a bound matrix (every branch of the helper) with the exact
 * `[branch-test]` line per operand. Lab run89 (fix 2c, run 89 REM3): a report that misses a line is a
 * report problem, not a repair problem: the worker asks the same session for the missing line (NFR);
 * here the provider session cannot be resumed, so the miss is journaled and the commit-bearing repair is
 * accepted: no relaunch, no replan (before run89: relaunched, a second miss sent the Story to PLAN).
 */
function scenarioNRM(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NRM';
  const name = 'NRM lab round-cut N2 + lab run89: the repair prompt carries the bound matrix with the exact [branch-test] line per operand; a partial report (session not resumable) is journaled and the commit-bearing repair is accepted (no relaunch, no replan)';
  const o = new Owner(tag, 'B-7c03', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const seen: Array<{ phase: string; reason: string; kind: string; why: string }> = [];
  try {
    writeFileSync(join(o.worktree, 'strs/strs.go'), `${IMPL}${NRM_WINDOW}`);
    git(o.worktree, ['add', 'strs/strs.go']);
    git(o.worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'add Window']);
    devSetup(o);
    driveWithNext(o, { findingRound1: false, run: false, roundCut: 'matrix' }, lines, next => {
      seen.push({ phase: next.phase, reason: next.reason, kind: next.kind, why: next.why });
    });
    const repairs = managedPrompts(o, FINDING_REPAIR);
    lines.push(`repair runs: ${repairs.length}; steps: ${seen.filter(row => /finding_/.test(row.reason)).map(row => row.reason).join(' > ')}`);
    assert.equal(repairs.length, 1, `${tag}: the commit-bearing repair is accepted, not relaunched (got ${repairs.length})`);
    assert.match(repairs[0]!.prompt, /Bound matrix/, `${tag}: the repair prompt carries the bound matrix`);
    assert.match(repairs[0]!.prompt, /\[branch-test\] Window end=<case>: <test name> -> <result>/, `${tag}: with the exact line per operand`);
    assert.ok(!seen.some(row => row.reason === 'finding_repair_replan'), `${tag}: no replan`);
    const events = readFileSync(join(o.root, '.proof-or-stop', 'runtime', 'host-runs', repairs[0]!.runId, 'events.jsonl'), 'utf8');
    assert.match(events, /managed_repair_report_follow_up_unavailable/, `${tag}: the missing line is journaled (session not resumable)`);
    const finding = new StoryStore(o.root).readFindings(o.storyId).findings.find(f => f.desc === NRM_FINDING.desc);
    assert.equal(finding?.status, 'resolved', `${tag}: resolved`);
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE', `${tag}: DONE`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${seen.map(row => `${row.phase}:${row.reason}(${row.kind})`).join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

/** NRD: a critic duplicate of D_FINDING whose own repro is the call the canonical repair's test makes. */
const NRD_DUP_FINDING = {
  desc: 'Reverse of an empty input reads the last rune of an empty slice (same root cause as the empty-string edge). Repro: `Reverse("")`',
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};

/**
 * NRD (lab round-cut N3, run 75: three owner duplicate closures, about 2.4 min): a critic duplicate
 * whose repro a test of the canonical repair commit states is closed by the framework (it authors
 * the coverage command and selector; the same coverage run and refusal path decide). RED on the
 * base: an agent step with placeholders the owner had to fill.
 */
function scenarioNRD(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NRD';
  const name = 'NRD lab round-cut N3: an accepted duplicate (its repro is in the canonical repair test) is closed by a framework step, no owner turn';
  const o = new Owner(tag, 'B-7c04', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const seen: Array<{ reason: string; kind: string; placeholders: string[]; payload: Record<string, unknown> }> = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: false, run: false, roundCut: 'dup' }, lines, next => {
      if (/finding_/.test(next.reason)) seen.push({ reason: next.reason, kind: next.kind, placeholders: next.placeholders ?? [], payload: next.cli?.payload ?? {} });
    });
    lines.push(`finding steps: ${seen.map(row => `${row.reason}(${row.kind})`).join(' > ')}`);
    const dupStep = seen.find(row => row.reason === 'finding_duplicate_resolve');
    assert.ok(dupStep, `${tag}: a duplicate closure step`);
    assert.equal(dupStep!.kind, 'framework', `${tag}: the framework closes the duplicate (no owner turn): ${JSON.stringify(dupStep)}`);
    assert.deepEqual(dupStep!.placeholders, [], `${tag}: nothing for the owner to author`);
    assert.match(String((dupStep!.payload.coverage as { command?: string } | undefined)?.command ?? ''), /-run \^TestReverseEmpty\$/, `${tag}: the canonical repair test runs the duplicate's repro`);
    const dup = new StoryStore(o.root).readFindings(o.storyId).findings.find(f => f.desc === NRD_DUP_FINDING.desc);
    assert.equal(dup?.status, 'resolved', `${tag}: resolved`);
    assert.equal(dup?.resolutionType, 'duplicate', `${tag}: as a duplicate`);
    assert.equal(managedPrompts(o, FINDING_REPAIR).length, 1, `${tag}: no repair of its own`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

// ---------------------------------------------------------------------------
// Lab run89 (bench-staging/oldpos/run88-89-analysis.md §5): NPB, NPD, NTS, NFR, NRX. Synthetic `pipe` printer and
// `strs` helpers only; the run-89 shapes, not its values.

/** The base printer tests: an infix operator renders spaced inside parentheses (the base already prints it). */
const PIPE_PRINTER_TEST = ['package strs', '', 'import "testing"', '', 'var printCases = []struct {', '\tinput    string', '\texpected string', '}{',
  '\t{"a + b", "(a + b)"},', '\t{"a * b + c", "((a * b) + c)"},', '\t{"a * b - c", "((a * b) - c)"},', '}', '', 'func TestPrintCases(t *testing.T) {', '\tif len(printCases) == 0 {', '\t\tt.Fatal("no cases")', '\t}', '}', ''].join('\n');
const PIPE_REQUEST = ['Add a pipe operator `x |> f` that passes `x` to `f`.', '', '- Accept `value |> fn` as an expression.',
  '- AST stringification must parenthesize pipes, for example:', '  - `x |> f` -> `(x |> f)`', '  - `x |> f |> g` -> `((x |> f) |> g)`', ''].join('\n');
const PIPE_QUOTE = 'Accept `value |> fn` as an expression.';
/** The invented pin (run-89 shape): the request is silent on infix operands, the owner pinned them compact. */
const PIPE_INVENTED = '1 + 2 |> f -> ((1+2) |> f)';
const PIPE_BASE_FORM_ROW = '1 + 2 |> f -> ((1 + 2) |> f)';
const pipeRow = (desc: string) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
  verification: { command: 'go test -v ./strs -run ^TestPipePrint$', selector: '--- PASS: TestPipePrint' },
  derivation: { requestQuote: PIPE_QUOTE, computation: 'each operand is a full expression and the printer keeps the infix compact: ((1+2) |> f)' } });

function askNextOf(o: Owner, tag: string, lines: string[]): (label: string) => NextStepJson {
  return label => {
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label });
    const next = (asked.status === 0 ? parseJson(asked.stdout) : null) as NextStepJson | null;
    assert.ok(next && typeof next.kind === 'string', `[${tag}] next did not return a step:\n${asked.out.slice(-2000)}`);
    lines.push(`${label}: ${next.phase} ${next.kind} ${next.reason}`);
    return next;
  };
}

/** A managed launch the harness runs for an agent-kind step (placeholders filled with the qualified selection). */
function launchManaged(o: Owner, tag: string, step: NextStepJson, label: string): { runId: string; state: string; reason: string } {
  const payload = { ...step.cli!.payload };
  for (const [key, value] of Object.entries({ host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort })) {
    if (typeof payload[key] !== 'string' || /^<.*>$/.test(String(payload[key]))) payload[key] = value;
  }
  const launched = o.mustCli(step.cli!.command, payload, { label });
  const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
  const terminal = waitTerminal(o, label, runId);
  assert.equal(terminal.state, 'completed', `[${tag}] ${label} terminal ${terminal.state} (${terminal.reason})\n${o.providerCommandLog()}`);
  return { runId, ...terminal };
}

/** Open findings written as the review import leaves them (committed Story metadata). */
function seedFindings(o: Owner, findings: Array<Record<string, unknown>>): void {
  const store = new StoryStore(o.worktree);
  store.writeFindings(o.storyId, { findings: findings.map((row, index) => ({ id: `${o.storyId}:F-${String(index + 1).padStart(3, '0')}`, agent: 'proof-or-stop-review-quality',
    createdAt: '2026-10-15T00:00:00.000Z', status: 'open', evidenceState: 'verified', severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], ...row })) } as never);
  commitFixtureMetadata(o, `proof-or-stop: review findings ${o.storyId}`);
}

function runEvents(o: Owner, runId: string): Array<{ type?: string; detail?: Record<string, unknown> }> {
  const path = join(o.root, '.proof-or-stop', 'runtime', 'host-runs', runId, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as { type?: string; detail?: Record<string, unknown> }]; } catch { return []; } });
}

/**
 * NPB (lab run89 fix 1, run 89 CHK-001:adversarial:0): a PLAN row pins a printed form whose infix operand the base
 * printer renders differently ((1+2) vs the base's (a + b)), the request silent on it. RED on the base: no PLAN step
 * or pre-check names it; the implementer built a compaction mechanism for it and 6 of 11 findings followed. Now the
 * checklist_update pre-check and PLAN's lint step list it with the base sample and a concrete row patch to the base
 * form; once applied it is not offered again.
 */
function scenarioNPB(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NPB';
  const name = 'NPB lab run89 fix 1: a pinned printed form contradicting the base printer (request silent) is listed at PLAN with the base sample and a concrete row patch to the base form';
  const o = new Owner(tag, 'B-89b1', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: PIPE_REQUEST, baseFiles: { 'strs/print_test.go': PIPE_PRINTER_TEST } });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    const store = new StoryStore(o.worktree);
    // INIT authoring (the PLAN pre-check prints on an INIT checklist_update), then PLAN.
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'INIT' });
    const added = o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', intentRows: [{ ref: 'CHK-001:adversarial:+', ...pipeRow(PIPE_INVENTED) }],
      reason: 'adversarial printer row for infix operands' }, { label: 'checklist_update CHK-001 (invented printer pin)' });
    assert.match(added.out, /CHK-001:adversarial:0[^\n]*\[pin_base_form\]/, `[${tag}] the INIT checklist_update pre-check lists the row: ${added.out.slice(-1500)}`);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'PLAN' });
    o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });
    const step = ask('next (PLAN, invented pin)');
    assert.match(step.why, /\[pin_base_form\]/, `[${tag}] PLAN's lint step names the pin: ${step.reason}: ${step.why.slice(0, 600)}`);
    assert.match(step.why, /strs\/print_test\.go:\d+/, `[${tag}] with the base printer sample`);
    const calls = step.batch?.length ? step.batch.map(call => call.cli) : step.cli ? [step.cli] : [];
    const patch = calls.flatMap(call => call.command === 'checklist_update' && call.payload.itemId === 'CHK-001' ? (call.payload.intentRows as Array<Record<string, unknown>> | undefined) ?? [] : [])
      .find(row => row.ref === 'CHK-001:adversarial:0');
    assert.ok(patch, `[${tag}] a row patch of CHK-001:adversarial:0: ${JSON.stringify(calls).slice(0, 800)}`);
    assert.equal(patch!.desc, PIPE_BASE_FORM_ROW, `[${tag}] the patch states the base form`);
    assert.doesNotMatch(JSON.stringify(patch), /"<[^"]*>"/, `[${tag}] nothing for the owner to author`);
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', intentRows: [patch], reason: 'pin re-derived from the base printer (request silent)' }, { label: 'checklist_update CHK-001 (base form)' });
    const after = ask('next (PLAN, base form)');
    assert.doesNotMatch(after.why, /\[pin_base_form\]/, `[${tag}] not offered again: ${after.why.slice(0, 400)}`);
    const rowNow = new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === 'CHK-001')!.verificationIntent!.adversarial[0]!;
    assert.equal(rowNow.desc, PIPE_BASE_FORM_ROW, `[${tag}] the row pins the base form`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NPD (lab run89 fix 1, implementer half; run 89 DEV 12:43 "altering String to compact spaces is odd ... request examples
 * don't include expressions", then built it): the implementer reports `[pin-doubt]` for a row the base contradicts and
 * the request does not state. RED on the base: the line is not read, next goes on (the mechanism ships). Now the DEV->PLAN
 * hop and the row re-derivation to the base form are framework steps; the item is implemented again.
 */
function scenarioNPD(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NPD';
  const name = 'NPD lab run89 fix 1: an implementer [pin-doubt] on a base-contradicted, request-silent row is routed to a framework row re-derivation (DEV->PLAN, row patch, item pending)';
  const o = new Owner(tag, 'B-89d1', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: PIPE_REQUEST, baseFiles: { 'strs/print_test.go': PIPE_PRINTER_TEST } });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    const store = new StoryStore(o.worktree);
    const checklist = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...checklist, items: checklist.items.map(item => item.id !== 'CHK-001' ? item
      : { ...item, verificationIntent: { ...item.verificationIntent!, happy: [...item.verificationIntent!.happy, pipeRow(PIPE_INVENTED) as never] } }) } as never);
    commitFixtureMetadata(o, `proof-or-stop: PLAN revision ${o.storyId}`);
    devSetup(o, false);
    const launch = ask('next (DEV start)');
    assert.equal(launch.reason, 'implement_item', `[${tag}] first DEV step: ${launch.reason}: ${launch.why}`);
    const script = implementerScript(o.storyId, String(launch.cli!.payload.itemId));
    o.script(IMPLEMENTER, { ...script, final: `${script.final}\n[pin-doubt] CHK-001:happy:1 | base prints: ((1 + 2) |> f) | request: silent\n[intent-conflict] none` });
    launchManaged(o, tag, launch, 'host_run implementer (pin doubt)');
    o.unscript(IMPLEMENTER);
    assert.match(managedPrompts(o, IMPLEMENTER)[0]!.prompt, /\[pin-doubt\]/, `[${tag}] the implementer prompt names the pin-doubt route`);
    const hop = ask('next (pin doubt reported)');
    assert.equal(hop.reason, 'pin_doubt_plan', `[${tag}] the doubt returns the Story to PLAN: ${hop.reason}: ${hop.why.slice(0, 400)}`);
    assert.equal(hop.kind, 'framework', `[${tag}] a framework hop`);
    assert.match(hop.why, /CHK-001:happy:1/, `[${tag}] naming the row`);
    o.mustCli(hop.cli!.command, hop.cli!.payload, { label: 'story_advance PLAN (pin doubt)' });
    const amend = ask('next (PLAN, pin doubt)');
    assert.equal(amend.reason, 'pin_doubt_amend', `[${tag}] the row is re-derived: ${amend.reason}: ${amend.why.slice(0, 400)}`);
    assert.equal(amend.kind, 'framework', `[${tag}] by the framework (base form verified)`);
    const rows = amend.cli!.payload.intentRows as Array<Record<string, unknown>>;
    assert.equal(rows?.[0]?.ref, 'CHK-001:happy:1');
    assert.equal(rows?.[0]?.desc, PIPE_BASE_FORM_ROW, `[${tag}] to the base form`);
    assert.equal(amend.cli!.payload.status, 'pending', `[${tag}] the item is implemented again`);
    o.mustCli(amend.cli!.command, amend.cli!.payload, { label: 'checklist_update CHK-001 (pin doubt amend)' });
    const after = ask('next (PLAN, amended)');
    assert.doesNotMatch(after.reason, /^(?:intent_conflict|pin_doubt)/, `[${tag}] the amended doubt does not block again: ${after.reason}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NTS: the Story adds a helper that dispatches on the type of one operand (a type switch). */
const NTS_KIND = '\n// Kind names the kind of v.\nfunc Kind(v interface{}) string {\n\tswitch v := v.(type) {\n\tcase string:\n\t\treturn "string:" + v\n\tcase int:\n\t\treturn "int"\n\tcase []string:\n\t\treturn "list"\n\tdefault:\n\t\treturn "?"\n\t}\n}\n';
const NTS_LINE = `${IMPL}${NTS_KIND}`.split('\n').findIndex(line => line === '\t\treturn "string:" + v') + 1;
const NTS_TEST = '\nfunc TestKindString(t *testing.T) {\n\tif Kind("a b") != "string:a b" {\n\t\tt.Fatal("string")\n\t}\n}\n';

/**
 * NTS (lab run89 fix 2a, run 89 F-010: a type switch with 11 case arms was read as 12 branches of one operand and the
 * repair was refused five times for a missing `[branch-test] <fn> component=` line). RED on the base: the commit-bearing
 * repair is not accepted, relaunched, then sent to PLAN. Now a single-operand type switch is a dispatch table: the
 * prompt names its arms, no operand line is required, the first repair is accepted.
 */
function scenarioNTS(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NTS';
  const name = 'NTS lab run89 fix 2a: a repair in a single-operand type switch is not held to per-operand [branch-test] lines; one repair run is accepted (no relaunch, no PLAN trip)';
  const o = new Owner(tag, 'B-89c1', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    writeFileSync(join(o.worktree, 'strs/strs.go'), `${IMPL}${NTS_KIND}`);
    git(o.worktree, ['add', 'strs/strs.go']);
    git(o.worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'add Kind']);
    devSetup(o);
    seedFindings(o, [{ desc: `strs/strs.go:${NTS_LINE} Kind loses the payload of a string with a space. Repro: \`Kind("a b")\`` }]);
    const launch = ask('next (open finding)');
    assert.equal(launch.reason, 'finding_repair', `[${tag}] ${launch.reason}: ${launch.why.slice(0, 300)}`);
    o.script(FINDING_REPAIR, { commands: [['/bin/sh', '-c', `printf '%s' '${NTS_TEST}' >> strs/strs_test.go && git add strs/strs_test.go && git -c user.name=${FINDING_REPAIR} commit -qm '${o.storyId} F-001: test Kind string payload' && git log --format=%h -1`]],
      final: 'Tested the string arm of Kind; committed.\n[family] string payload: fixed\n[family] int, list arms: unaffected (no payload)\n[intent-conflict] none' });
    launchManaged(o, tag, launch, 'host_run finding-repair (type switch)');
    o.unscript(FINDING_REPAIR);
    const prompt = managedPrompts(o, FINDING_REPAIR)[0]!.prompt;
    assert.doesNotMatch(prompt, /\[branch-test\] Kind v=/, `[${tag}] no per-operand [branch-test] requirement for a type switch`);
    const after = ask('next (repaired)');
    assert.match(after.reason, /^(?:evidence_chain|finding_resolve)/, `[${tag}] the commit-bearing repair is accepted (receipts, then its resolution): ${after.reason}: ${after.why.slice(0, 400)}`);
    assert.equal(managedPrompts(o, FINDING_REPAIR).length, 1, `[${tag}] one repair run`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NFR (lab run89 fix 2b-d, run 89 REM3: 5 repair runs, 2 DEV->PLAN trips, 28.5 min for a report line): a commit-bearing
 * repair of a finding in a two-operand helper reports only one operand. RED on the base: the run is "without a repair
 * commit", the owner relaunches it, a second miss sends the Story to PLAN. Now the managed worker asks the same session
 * for the missing line only (the exact template) and the run is accepted: one run, no relaunch, no replan.
 */
function scenarioNFR(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NFR';
  const name = 'NFR lab run89 fix 2b-d: a report-format miss of a commit-bearing repair is asked for in the same session (exact missing line); one run accepted, no relaunch, no PLAN trip';
  const o = new Owner(tag, 'B-89f1', machineEnv, steps, false, { trackedGateFailureCounts: true, codexHome: true });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    writeFileSync(join(o.worktree, 'strs/strs.go'), `${IMPL}${NRM_WINDOW}`);
    git(o.worktree, ['add', 'strs/strs.go']);
    git(o.worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'add Window']);
    devSetup(o);
    seedFindings(o, [{ desc: NRM_FINDING.desc }]);
    const launch = ask('next (open finding)');
    assert.equal(launch.reason, 'finding_repair', `[${tag}] ${launch.reason}: ${launch.why.slice(0, 300)}`);
    const commitTest = (test: string, subject: string) => ['/bin/sh', '-c', `printf '%s' '${test.replace(/'/g, "'\\''")}' >> strs/strs_test.go && git add strs/strs_test.go && git -c user.name=${FINDING_REPAIR} commit -qm '${o.storyId} F-001: ${subject}' && git log --format=%h -1`];
    o.script(FINDING_REPAIR, { commands: [commitTest(NRM_TEST_START, 'test Window start')], final: 'Tested the start branch; committed.\n[branch-test] Window start=-1: TestWindowNegativeStart -> abc\n[intent-conflict] none',
      resume: { commands: [commitTest(NRM_TEST_END, 'test Window end')], final: 'Added the end branch test; committed.\n[branch-test] Window start=-1: TestWindowNegativeStart -> abc\n[branch-test] Window end=9: TestWindowEndBeyond -> abc\n[intent-conflict] none' } });
    const run = launchManaged(o, tag, launch, 'host_run finding-repair (partial report)');
    o.unscript(FINDING_REPAIR);
    const resumePrompt = join(o.scriptsDir, 'prompts', `${run.runId}.resume.txt`);
    assert.ok(existsSync(resumePrompt), `[${tag}] the worker resumed the session for the missing line: ${JSON.stringify(runEvents(o, run.runId).map(row => row.type))}`);
    const asked = readFileSync(resumePrompt, 'utf8');
    assert.match(asked, /\[branch-test\] Window end=<case>: <test name> -> <result>/, `[${tag}] the follow-up quotes the exact missing line: ${asked.slice(0, 600)}`);
    assert.doesNotMatch(asked, /Window start=<case>/, `[${tag}] only the missing line`);
    assert.ok(runEvents(o, run.runId).some(row => row.type === 'managed_repair_report_follow_up'), `[${tag}] the follow-up is journaled`);
    const after = ask('next (repaired)');
    assert.match(after.reason, /^(?:evidence_chain|finding_resolve)/, `[${tag}] accepted (receipts, then its resolution): ${after.reason}: ${after.why.slice(0, 400)}`);
    assert.equal(managedPrompts(o, FINDING_REPAIR).length, 1, `[${tag}] one repair run (no relaunch)`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NRX (lab run89 fix 3, run 89 F-004 -> F-007 -> F-010 -> F-011): the third finding of one chain (two `[regression-of]`
 * links). RED on the base: the repair prompt carried the family brief only and the repair patched one more variant. Now
 * it carries the mechanism-level block, and a report without the `[mechanism]` line is asked for that line in the
 * same session before the run seals.
 */
function scenarioNRX(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NRX';
  const name = 'NRX lab run89 fix 3: the second [regression-of] link of a chain requires the repair to name what requires the mechanism ([mechanism] line, asked in the same session when missing)';
  const o = new Owner(tag, 'B-89e1', machineEnv, steps, false, { trackedGateFailureCounts: true, codexHome: true });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    devSetup(o);
    const commitTest = (name: string, body: string): string => {
      writeFileSync(join(o.worktree, 'strs/strs_test.go'), `${readFileSync(join(o.worktree, 'strs/strs_test.go'), 'utf8')}\nfunc ${name}(t *testing.T) {\n\t${body}\n}\n`);
      git(o.worktree, ['add', 'strs/strs_test.go']);
      git(o.worktree, ['-c', `user.name=${FINDING_REPAIR}`, 'commit', '-qm', `test ${name}`]);
      return git(o.worktree, ['rev-parse', 'HEAD']);
    };
    const first = commitTest('TestReverseEmptyChain', 'if Reverse("") != "" {\n\t\tt.Fatal("empty")\n\t}');
    const second = commitTest('TestReverseOneChain', 'if Reverse("a") != "a" {\n\t\tt.Fatal("one")\n\t}');
    seedFindings(o, [
      { desc: 'strs/strs.go:9 Reverse of an empty string indexes past the end. Repro: `Reverse("")`', status: 'resolved', resolvedReason: `Repaired [repair commit ${first.slice(0, 12)}]` },
      { desc: '[regression-of F-001] strs/strs.go:9 Reverse of a one-rune string swaps it with itself. Repro: `Reverse("a")`', status: 'resolved', resolvedReason: `Repaired [repair commit ${second.slice(0, 12)}]` },
      { desc: '[regression-of F-002] strs/strs.go:9 Reverse of a two-rune string with a combining mark splits it. Repro: `Reverse("e\\u0301x")`' },
    ]);
    const launch = ask('next (third chain finding)');
    assert.equal(launch.reason, 'finding_repair', `[${tag}] ${launch.reason}: ${launch.why.slice(0, 300)}`);
    const third = '\nfunc TestReverseMarkChain(t *testing.T) {\n\tif Reverse("ab") != "ba" {\n\t\tt.Fatal("two")\n\t}\n}\n';
    o.script(FINDING_REPAIR, { commands: [['/bin/sh', '-c', `printf '%s' '${third}' >> strs/strs_test.go && git add strs/strs_test.go && git -c user.name=${FINDING_REPAIR} commit -qm '${o.storyId} F-003: test two runes' && git log --format=%h -1`]],
      final: 'Tested the two-rune case; committed.\n[family-test] TestReverseMarkChain: two runes\n[intent-conflict] none',
      resume: { final: 'Tested the two-rune case; committed.\n[family-test] TestReverseMarkChain: two runes\n[mechanism] Reverse rune loop: required by row CHK-002:happy:0\n[intent-conflict] none' } });
    const run = launchManaged(o, tag, launch, 'host_run finding-repair (chain)');
    o.unscript(FINDING_REPAIR);
    const prompt = managedPrompts(o, FINDING_REPAIR)[0]!.prompt;
    assert.match(prompt, /Mechanism-level repair/, `[${tag}] the repair prompt carries the mechanism-level block`);
    assert.match(prompt, /F-001 -> F-002 -> F-003/, `[${tag}] naming the chain`);
    const resumePrompt = join(o.scriptsDir, 'prompts', `${run.runId}.resume.txt`);
    assert.ok(existsSync(resumePrompt), `[${tag}] the missing [mechanism] line is asked in the same session: ${JSON.stringify(runEvents(o, run.runId).map(row => row.type))}`);
    assert.match(readFileSync(resumePrompt, 'utf8'), /\[mechanism\]/, `[${tag}] the follow-up asks for the [mechanism] line`);
    const after = ask('next (repaired)');
    assert.match(after.reason, /^(?:evidence_chain|finding_resolve)/, `[${tag}] accepted (receipts, then its resolution): ${after.reason}: ${after.why.slice(0, 400)}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

// ---------------------------------------------------------------------------
// Lab run95 (bench-staging/oldpos/run93-96-analysis.md §7 fixes 1, 2): NUP, NPR, NPR-C, NPXF. Synthetic `strs` helpers
// with a made-up error template only; the run-95 shapes, not its values.

/** The request: one exact error template, scoped by its list line to Upper. */
const R95_REQUEST = ['Implement the string helpers documented in docs/types/string.md:', '',
  '- `strs.Upper(s)` returns the upper-case form of `s`, for example `Upper("ab")` is `"AB"`.',
  '- `strs.Reverse(s)` returns `s` reversed by rune, for example `Reverse("héllo")` is `"olléh"`.',
  '- Error strings must match exactly:',
  '  - Upper of a value that is not a string:',
  '    - `upper expects STRING, got <TYPE>`', ''].join('\n');
const R95_HEADER = 'Error strings must match exactly:';
const r95Row = (desc: string, test: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass',
  requirementSource: 'story', verification: { command: `go test -v ./strs -run ^${test}$`, selector: `--- PASS: ${test}` }, ...extra });
/** A complete PLAN for both items (pins, derivations, the exact-text row) plus `extra` edge rows on CHK-002. */
function r95Intents(extraReverse: Array<Record<string, unknown>>) {
  return {
    'CHK-001': { happy: [r95Row('strs.Upper(s): Upper("ab") -> "AB"', 'TestUpper')], edge: [r95Row('Upper("") -> ""', 'TestUpperEmpty')],
      adversarial: [r95Row('Upper(5) -> error, the whole error equals "upper expects STRING, got NUMBER"', 'TestUpperNumber',
        { derivation: { requestQuote: 'Upper of a value that is not a string:', computation: 'TYPE is NUMBER for 5, so the whole error equals "upper expects STRING, got NUMBER"' } })] },
    'CHK-002': { happy: [r95Row('strs.Reverse(s): Reverse("héllo") -> "olléh"', 'TestReverse')], edge: [r95Row('Reverse("") -> ""', 'TestReverseEmpty'), ...extraReverse],
      adversarial: [r95Row('Reverse of a one-rune string is that string', 'TestReverseOne')] },
  };
}

/** Owner in PLAN with the two items authored from `intents` (the Story's INIT metadata kept). */
function r95Plan(o: Owner, intents: ReturnType<typeof r95Intents>, phase: 'INIT' | 'PLAN' = 'PLAN'): void {
  const store = new StoryStore(o.worktree);
  store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase });
  const checklist = store.readChecklist(o.storyId);
  store.writeChecklist(o.storyId, { ...checklist, items: checklist.items.map(item => ({ ...item, status: 'pending', startTime: null })) } as never);
  for (const [itemId, intent] of Object.entries(intents)) o.mustCli('checklist_update', { storyId: o.storyId, itemId, verificationIntent: intent }, { label: `checklist_update ${itemId} (authored)` });
  if (phase === 'PLAN') o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });
}

/**
 * NUP (lab run95 fix 1a/b/d): a PLAN row pins an exact error text neither the request nor the Story base states (run 95's
 * CHK-003:edge:8 shape). RED on the base: no pre-check line or PLAN step names it; `{"ref":..,"drop":true}` printed
 * "updated" and left the row; an unknown row field was written; an exclusion the item's own userSees names was accepted
 * and refused only by the reviewer one rerun later. Now: the INIT pre-check and PLAN's lint step list it [unstated_pin]
 * with a ready relax patch; the remove op removes the row; an unknown field is refused, nothing written; the exclusion
 * gets ONE command that also edits userSees.
 */
function scenarioNUP(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NUP';
  const name = 'NUP lab run95 fix 1: an exact text neither request nor base states is listed at PLAN with a ready patch; {ref, remove} removes a row; an unknown row field is refused; an exclusion its own userSees names gets one command for both';
  const o = new Owner(tag, 'B-95a1', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: R95_REQUEST });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    const invented = r95Row('Reverse(nil) -> error, the whole error equals "reverse cannot take a nil value here"', 'TestReverseNil',
      { derivation: { requestQuote: '`strs.Reverse(s)` returns `s` reversed by rune, for example `Reverse("héllo")` is `"olléh"`.', computation: 'a nil value is refused: "reverse cannot take a nil value here"' } });
    r95Plan(o, r95Intents([]), 'INIT');
    const added = o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', intentRows: [{ ref: 'CHK-002:edge:+', ...invented }], reason: 'nil row' }, { label: 'checklist_update CHK-002 (invented exact text)' });
    assert.match(added.out, /CHK-002:edge:1 pins `reverse cannot take a nil value here`[^\n]*\[unstated_pin\]/, `[${tag}] the INIT pre-check lists the row: ${added.out.slice(-1500)}`);
    // Unknown row field: refused, nothing written.
    const before = JSON.stringify(new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === 'CHK-002')!.verificationIntent);
    const bogus = o.cli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', intentRows: [{ ref: 'CHK-002:edge:1', bogus: true }] }, { label: 'checklist_update CHK-002 (unknown field)' });
    assert.notEqual(bogus.status, 0, `[${tag}] an unknown row field is refused`);
    assert.match(bogus.out, /"bogus", which is not a row field[\s\S]*\[intent_rows_invalid\]/, `[${tag}] the refusal names the field: ${bogus.out.slice(-800)}`);
    assert.equal(JSON.stringify(new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === 'CHK-002')!.verificationIntent), before, `[${tag}] nothing written`);
    const store = new StoryStore(o.worktree);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'PLAN' });
    o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });
    const step = ask('next (PLAN, invented exact text)');
    assert.match(step.why, /\[unstated_pin\][^\n]*CHK-002:edge:1/, `[${tag}] PLAN's lint step names the row: ${step.reason}: ${step.why.slice(0, 700)}`);
    const calls = step.batch?.length ? step.batch.map(call => call.cli) : step.cli ? [step.cli] : [];
    const patch = calls.flatMap(call => call.command === 'checklist_update' && call.payload.itemId === 'CHK-002' ? (call.payload.intentRows as Array<Record<string, unknown>> | undefined) ?? [] : [])
      .find(row => row.ref === 'CHK-002:edge:1');
    assert.ok(patch, `[${tag}] a row patch of CHK-002:edge:1: ${JSON.stringify(calls).slice(0, 800)}`);
    assert.equal(patch!.desc, 'Reverse(nil) -> error', `[${tag}] the ready patch keeps the case and pins only the error`);
    assert.doesNotMatch(JSON.stringify(patch), /"<[^"]*>"/, `[${tag}] nothing to author`);
    // The owner removes the row instead (the op run 95's owner reached for).
    const removed = o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', intentRows: [{ ref: 'CHK-002:edge:1', drop: true }], reason: 'row removed' }, { label: 'checklist_update CHK-002 (drop)' });
    assert.match(removed.out, /removed CHK-002:edge:1/, `[${tag}] the removal is named: ${removed.out.slice(-600)}`);
    const edge = new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === 'CHK-002')!.verificationIntent!.edge;
    assert.deepEqual(edge.map(row => row.desc), ['Reverse("") -> ""'], `[${tag}] the row is gone`);
    // An exclusion the item's own userSees names: ONE command sets both.
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', userSees: 'Reverse returns the rune-reversed string. Reverse of a nil value fails with an error. Reverse("") returns "".' }, { label: 'checklist_update CHK-002 userSees' });
    const excluded = o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', excludes: ['Reverse of a nil value: the request does not state its error text'] }, { label: 'checklist_update CHK-002 excludes' });
    assert.match(excluded.out, /Exclusion vs userSees[\s\S]*Reverse of a nil value fails with an error/, `[${tag}] the clause naming the case is quoted: ${excluded.out.slice(-1200)}`);
    const next = excluded.out.split('\n').find(line => line.startsWith('Next (one command, both fields): '));
    assert.ok(next, `[${tag}] ONE command for both fields`);
    const both = o.shell('checklist_update (excludes + userSees, from the note)', next!.replace('Next (one command, both fields): ', ''));
    assert.equal(both.status, 0, `[${tag}] the command runs: ${both.out.slice(-600)}`);
    assert.doesNotMatch(both.out, /Exclusion vs userSees/, `[${tag}] consistent now`);
    lines.push(`userSees now: ${new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === 'CHK-002')!.userSees}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** One scripted scope-plan verdict: every promise covered, plus the given gap rows. */
function r95Verdict(o: Owner, gaps: string[]): void {
  o.script('proof-or-stop-review-scope-plan', { final: 'Scope review saved.', commands: [[process.execPath, CLI, 'scope_check_save', JSON.stringify({ storyId: o.storyId,
    features: [
      { feature: 'strs.Upper returns the upper-case form', covered_by: 'CHK-001', status: 'covered', excluded_by: null, source: 'request.md' },
      { feature: 'strs.Reverse reverses by rune', covered_by: 'CHK-002', status: 'covered', excluded_by: null, source: 'request.md' },
      ...gaps.map(feature => ({ feature, covered_by: null, status: 'gap', excluded_by: null, source: 'request.md' })),
    ],
    summary: { total: 2 + gaps.length, covered: 2, excluded: 0, gaps: gaps.length },
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null }, openQuestions: [] })]] });
}

/** next until the scope-plan launch (a skippable PLAN lint on the way is skipped: asked again), then the scripted run. */
function r95ScopeRun(o: Owner, tag: string, ask: (label: string) => NextStepJson, label: string): { runId: string; prompt: string } {
  let step = ask(`next (${label})`);
  for (let guard = 0; guard < 4 && step.reason !== 'scope_plan_review_launch'; guard += 1) step = ask(`next (${label}, after ${step.reason})`);
  assert.equal(step.reason, 'scope_plan_review_launch', `[${tag}] the scope-plan reviewer is (re)launched: ${step.reason}: ${step.why.slice(0, 500)}`);
  const run = launchManaged(o, tag, step, `scope-plan (${label})`);
  o.unscript('proof-or-stop-review-scope-plan');
  const prompt = managedPrompts(o, 'proof-or-stop-review-scope-plan').find(row => row.runId === run.runId)?.prompt ?? '';
  return { runId: run.runId, prompt };
}

/**
 * NPR / NPR-C (lab run95 fix 1c, run 95 PLAN rounds 2-7): the scope-plan reviewer raises the same pin-audit gap on the
 * same row twice. RED on the base: the second verdict gives the same generic plan_review_blockers placeholder patch
 * ("<row with the expected value the request gives>") and another full rerun follows each guess. Now the second verdict
 * gives ONE step plan_pin_dispute whose command needs no authoring (the error pin relaxed to "<case> -> error"); applied,
 * the reviewer reruns once with the disputed row and the remedy in its prompt; under the A/B plan.disputeConfirm=on
 * (NPR-C) that rerun is a confirmation re-review.
 */
function scenarioNPR(machineEnv: NodeJS.ProcessEnv, steps: Step[], confirm: boolean): Outcome {
  const tag = confirm ? 'NPR-C' : 'NPR';
  const name = `${tag} lab run95 fix 1c: the same row raised in two consecutive scope-plan verdicts gets ONE ready remedy (plan_pin_dispute), then one rerun naming it${confirm ? ' as a confirmation re-review (plan.disputeConfirm=on)' : ''}`;
  const o = new Owner(tag, confirm ? 'B-95c2' : 'B-95b1', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: R95_REQUEST,
    ...(confirm ? { config: { plan: { disputeConfirm: 'on' } } } : {}) });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    const guess = (text: string) => r95Row(`Reverse(5) -> error, the whole error equals "${text}"`, 'TestReverseNumber',
      { derivation: { requestQuote: R95_HEADER, computation: `TYPE is NUMBER for 5, so the whole error equals "${text}"` } });
    r95Plan(o, r95Intents([guess('upper expects STRING, got NUMBER')]));
    const gap = (pinned: string) => `pin-audit CHK-002:edge:1 pins Reverse(5) -> "${pinned}"; request gives no error text for Reverse (its template is scoped to Upper)`;
    r95Verdict(o, [gap('upper expects STRING, got NUMBER')]);
    r95ScopeRun(o, tag, ask, 'verdict 1');
    const review1 = o.cli('story_review', { storyId: o.storyId }, { label: 'story_review (verdict 1)' });
    assert.match(review1.out, /pin-audit CHK-002:edge:1/, `[${tag}] story_review reports the gap`);
    const first = ask('next (verdict 1)');
    assert.notEqual(first.reason, 'plan_pin_dispute', `[${tag}] one verdict is not a dispute: ${first.reason}`);
    // The owner's second guess (run 95: five of them).
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', intentRows: [{ ref: 'CHK-002:edge:1', ...guess('reverse expects STRING, got NUMBER') }], reason: 'second guess' }, { label: 'checklist_update CHK-002 (second guess)' });
    r95Verdict(o, [gap('reverse expects STRING, got NUMBER')]);
    r95ScopeRun(o, tag, ask, 'verdict 2');
    o.cli('story_review', { storyId: o.storyId }, { label: 'story_review (verdict 2)' });
    const dispute = ask('next (verdict 2, same row)');
    assert.equal(dispute.reason, 'plan_pin_dispute', `[${tag}] the repeated gap is escalated: ${dispute.reason}: ${dispute.why.slice(0, 600)}`);
    assert.match(dispute.why, /CHK-002:edge:1 \(2 verdicts in a row\)/, `[${tag}] the streak is named`);
    const calls = dispute.batch?.length ? dispute.batch.map(call => call.cli) : dispute.cli ? [dispute.cli] : [];
    assert.equal(calls.length, 1, `[${tag}] ONE command: ${JSON.stringify(calls).slice(0, 600)}`);
    assert.doesNotMatch(JSON.stringify(calls[0]!.payload), /"<[^"]*>"/, `[${tag}] nothing to author`);
    const rows = calls[0]!.payload.intentRows as Array<Record<string, unknown>>;
    assert.equal(rows[0]!.desc, 'Reverse(5) -> error', `[${tag}] the error pin is relaxed to the error only`);
    o.mustCli(calls[0]!.command, calls[0]!.payload, { label: 'checklist_update (dispute remedy)' });
    r95Verdict(o, []);
    const rerun = r95ScopeRun(o, tag, ask, 'after the remedy');
    assert.match(rerun.prompt, /Disputed rows[^\n]*CHK-002:edge:1 \(relaxed to the error only/, `[${tag}] the rerun prompt names the disputed row and the remedy:\n${rerun.prompt.slice(0, 200)}`);
    if (confirm) assert.match(rerun.prompt, /Confirmation re-review/, `[${tag}] plan.disputeConfirm=on: a confirmation re-review`);
    else assert.doesNotMatch(rerun.prompt, /Confirmation re-review/, `[${tag}] default: a full rerun`);
    const runs = listScopeRuns(o);
    lines.push(`scope-plan runs: ${runs}`);
    assert.equal(runs, 3, `[${tag}] three reviewer runs in all (two verdicts + one after the remedy)`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

// ---------------------------------------------------------------------------
// Lab plan-deadend (old-PoS run 121, bench-staging/oldpos/run121-analysis.md): NPDE, NPDE-D, NPDE-S. The r95 `strs`
// fixture with main's pre-existing docs/types/array.md drift (the NPX doc, which the request never names); synthetic gaps
// in run 121's shapes, not its values.

/** Run 121 gap (1): a doc/code conflict the reviewer sources from an unrequested documentation file. */
const R121_DOC_GAP = `Applicable array documentation conflict: ${PX_DOC_PATH} says [0, 1, 2, 3][0:2] returns [0, 1, 2], while the existing implementation excludes the end and returns [0, 1]; the PLAN promises unchanged existing behaviour without resolving this published promise`;
/** Run 121 gaps (2) and (3): coverage gaps no row template matched (one names its item, one does not). */
const R121_RUNE_GAP = 'Reverse is rune-correct for multibyte input: CHK-002 has no multibyte case after removing its former row, although the request requires reversal by rune';
const R121_UPPER_GAP = 'Upper keeps multibyte letters intact: no planned case gives Upper a multibyte input, so rune handling is not distinguished from byte handling';
const R121_REVERSE_QUOTE = '`strs.Reverse(s)` returns `s` reversed by rune, for example `Reverse("héllo")` is `"olléh"`.';
const R121_UPPER_QUOTE = '`strs.Upper(s)` returns the upper-case form of `s`, for example `Upper("ab")` is `"AB"`.';
/** The rows an owner authors into the framework's covering-row patches (each placeholder filled). */
const R121_FILLED: Record<string, Record<string, unknown>> = {
  'CHK-002': { desc: 'Reverse("añb") -> "bña"', verification: { command: 'go test -v ./strs -run ^TestReverseMultibyte$', selector: '--- PASS: TestReverseMultibyte' },
    derivation: { requestQuote: R121_REVERSE_QUOTE, computation: 'reversing the runes a, ñ, b gives b, ñ, a: "bña"' } },
  'CHK-001': { desc: 'Upper("ñb") -> "ÑB"', verification: { command: 'go test -v ./strs -run ^TestUpperMultibyte$', selector: '--- PASS: TestUpperMultibyte' },
    derivation: { requestQuote: R121_UPPER_QUOTE, computation: 'the upper-case form of ñ is Ñ and of b is B: "ÑB"' } },
};

/** One scripted scope-plan verdict: both promises covered, plus gap rows with their own source. */
function r121Verdict(o: Owner, gaps: Array<{ feature: string; source: string }>): void {
  o.script('proof-or-stop-review-scope-plan', { final: 'Scope review saved.', commands: [[process.execPath, CLI, 'scope_check_save', JSON.stringify({ storyId: o.storyId,
    features: [
      { feature: 'strs.Upper returns the upper-case form', covered_by: 'CHK-001', status: 'covered', excluded_by: null, source: 'request.md' },
      { feature: 'strs.Reverse reverses by rune', covered_by: 'CHK-002', status: 'covered', excluded_by: null, source: 'request.md' },
      ...gaps.map(gap => ({ feature: gap.feature, covered_by: null, status: 'gap', excluded_by: null, source: gap.source })),
    ],
    summary: { total: 2 + gaps.length, covered: 2, excluded: 0, gaps: gaps.length },
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null }, openQuestions: [] })]] });
}

/** next, running the mechanical story_review reruns it names (as `next --run` does), until a step that is not one. */
function r121Settle(o: Owner, ask: (label: string) => NextStepJson, label: string): NextStepJson {
  let next = ask(`next (${label})`);
  for (let guard = 0; guard < 4 && next.kind === 'framework' && ['story_review_rerun', 'plan_remedy_settled'].includes(next.reason); guard += 1) {
    o.mustCli(next.cli!.command, next.cli!.payload, { label: `${next.cli!.command} (${next.reason}, ${label})` });
    next = ask(`next (${label}, after ${next.reason})`);
  }
  return next;
}

/** The step as the owner reads it (text, not --json). */
function r121Text(o: Owner, label: string): string {
  return o.cli('next', { storyId: o.storyId }, { label }).stdout;
}

/**
 * NPDE / NPDE-D (old-PoS run 121): the verdict's gaps are a pre-existing doc/code drift sourced from docs/types/array.md
 * (the request never names it; no item modifies it) and two coverage gaps whose text matches no row template. RED on the
 * base: story_review records three scope_gap blockers, next returns plan_review_blockers with no command and the text
 * ends `Next: none runnable (see Why)` (run 121's owner stopped there). Now: story_review records the drift as
 * framework-settled (advisory [scope_gap_doc_drift_settled]); next gives one checklist_update per item, each appending a
 * covering row to the item the gap names (CHK-002) or shares terms with (CHK-001); applied, the reviewer reruns once and a
 * verdict that re-raises only the drift leaves PLAN complete (enter_dev). Run 121 ran pipeline.lean=on (NPDE); the step
 * is not lean's (NPDE-D, default flags).
 */
function scenarioNPDE(machineEnv: NodeJS.ProcessEnv, steps: Step[], lean: boolean): Outcome {
  const tag = lean ? 'NPDE' : 'NPDE-D';
  const name = `${tag} lab plan-deadend (run 121): plain scope gaps get ready covering rows, a pre-existing drift in an unrequested doc is settled; never "none runnable" in PLAN${lean ? ' (pipeline.lean=on)' : ' (default flags)'}`;
  const o = new Owner(tag, lean ? 'B-121a' : 'B-121d', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: R95_REQUEST, preexistingDoc: true,
    ...(lean ? { config: { pipeline: { lean: 'on' } } } : {}) });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    r95Plan(o, r95Intents([]));
    r121Verdict(o, [{ feature: R121_DOC_GAP, source: PX_DOC_PATH }, { feature: R121_RUNE_GAP, source: 'request.md' }, { feature: R121_UPPER_GAP, source: 'request.md' }]);
    r95ScopeRun(o, tag, ask, 'verdict 1');
    const blockers = r121Settle(o, ask, 'verdict 1');
    const issues = (new StoryStore(o.worktree).readReview(o.storyId).reviews.at(-1)?.issues ?? []) as Array<{ type?: string; severity?: string; message?: string }>;
    const docIssue = issues.find(issue => String(issue.message ?? '').includes('Applicable array documentation conflict'));
    const calls = stepCalls(blockers);
    const text = r121Text(o, 'next (text, verdict 1)');
    const problems: string[] = [];
    if (docIssue?.severity !== 'advisory' || docIssue?.type !== 'scope_gap_doc_drift_settled') problems.push(`the pre-existing drift in the unrequested doc is a ${String(docIssue?.severity)} ${String(docIssue?.type)}, not settled`);
    if (blockers.reason !== 'plan_review_blockers') problems.push(`the coverage gaps do not block: ${blockers.reason}`);
    if (calls.length === 0) problems.push(`plan_review_blockers carries no command (run 121; the owner stopped): ${blockers.kind} ${blockers.reason}`);
    if (/none runnable/.test(text)) problems.push(`the text says "none runnable" while blockers remain: ${text.split('\n').filter(line => line.startsWith('Next')).join(' / ')}`);
    if (!rowPatches(blockers, 'CHK-002').some(row => row.ref === 'CHK-002:edge:+')) problems.push('no covering row on CHK-002 for the gap naming it');
    if (!rowPatches(blockers, 'CHK-001').some(row => row.ref === 'CHK-001:edge:+')) problems.push('no covering row on CHK-001 for the Upper gap');
    if (calls.some(call => JSON.stringify(call.payload).includes('array.md'))) problems.push('a command asks to change the doc');
    lines.push(`verdict 1: ${problems.length} problem(s)`);
    assert.deepEqual(problems, [], `[${tag}] ${problems.join(' | ')}`);
    for (const call of calls) {
      const payload = { ...call.payload, intentRows: (call.payload.intentRows as Array<Record<string, unknown>>).map(row => /:\+$/.test(String(row.ref)) ? { ...row, ...R121_FILLED[String(call.payload.itemId)] } : row) };
      o.mustCli(call.command, payload, { label: `${call.command} ${String(call.payload.itemId)} (covering row from the step)` });
    }
    const after = new StoryStore(o.worktree).readChecklist(o.storyId).items;
    assert.ok(after.find(item => item.id === 'CHK-002')!.verificationIntent!.edge.some(row => /añb/.test(String(row.desc))), `[${tag}] the rune gap became a row (detection kept)`);
    assert.ok(after.find(item => item.id === 'CHK-001')!.verificationIntent!.edge.some(row => /ñb/.test(String(row.desc))), `[${tag}] the Upper gap became a row`);
    // The reviewer reruns on the changed checklist and re-raises only the drift.
    r121Verdict(o, [{ feature: R121_DOC_GAP, source: PX_DOC_PATH }]);
    r95ScopeRun(o, tag, ask, 'verdict 2 (drift only)');
    const done = r121Settle(o, ask, 'verdict 2');
    assert.equal(done.reason, 'enter_dev', `[${tag}] PLAN is complete with only the settled drift left: ${done.kind} ${done.reason}: ${done.why.slice(0, 600)}`);
    lines.push(`scope-plan runs: ${listScopeRuns(o)}`);
    assert.equal(listScopeRuns(o), 2, `[${tag}] two reviewer runs`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NPDE-S (old-PoS run 121, pipeline.lean=on): the reviewer raises the same row twice (a pin dispute) and its second
 * verdict adds a new plain gap. Run 121's next decided plan_pin_dispute right after the scope-plan wait, from the
 * story_review round of the PREVIOUS verdict, so the dispute step's "other blockers" were stale and the new verdict's
 * gaps were never shown with a remedy. RED on the base: the dispute step has no covering row for the new gap. Now:
 * story_review reruns first (framework step), then the dispute step carries the new gap's covering row.
 */
function scenarioNPDES(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NPDE-S';
  const name = 'NPDE-S lab plan-deadend (run 121): a pin dispute right after a new verdict lists the current verdict\'s other gaps with their covering rows (story_review reruns first)';
  const o = new Owner(tag, 'B-121s', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: R95_REQUEST, config: { pipeline: { lean: 'on' } } });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    const guess = (text: string) => r95Row(`Reverse(5) -> error, the whole error equals "${text}"`, 'TestReverseNumber',
      { derivation: { requestQuote: R95_HEADER, computation: `TYPE is NUMBER for 5, so the whole error equals "${text}"` } });
    r95Plan(o, r95Intents([guess('upper expects STRING, got NUMBER')]));
    const gap = (pinned: string) => `pin-audit CHK-002:edge:1 pins Reverse(5) -> "${pinned}"; request gives no error text for Reverse (its template is scoped to Upper)`;
    r121Verdict(o, [{ feature: gap('upper expects STRING, got NUMBER'), source: 'request.md' }]);
    r95ScopeRun(o, tag, ask, 'verdict 1');
    const first = r121Settle(o, ask, 'verdict 1');
    assert.notEqual(first.reason, 'plan_pin_dispute', `[${tag}] one verdict is no dispute: ${first.reason}`);
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', intentRows: [{ ref: 'CHK-002:edge:1', ...guess('reverse expects STRING, got NUMBER') }], reason: 'second guess' }, { label: 'checklist_update CHK-002 (second guess)' });
    r121Verdict(o, [{ feature: gap('reverse expects STRING, got NUMBER'), source: 'request.md' }, { feature: R121_UPPER_GAP, source: 'request.md' }]);
    r95ScopeRun(o, tag, ask, 'verdict 2');
    // No hand story_review here: run 121's next decided the dispute right after the scope-plan wait.
    const dispute = r121Settle(o, ask, 'verdict 2');
    assert.equal(dispute.reason, 'plan_pin_dispute', `[${tag}] the repeated row is disputed: ${dispute.reason}: ${dispute.why.slice(0, 600)}`);
    assert.ok(rowPatches(dispute, 'CHK-002').some(row => row.ref === 'CHK-002:edge:1'), `[${tag}] the dispute remedy is there`);
    assert.ok(rowPatches(dispute, 'CHK-001').some(row => row.ref === 'CHK-001:edge:+'), `[${tag}] the current verdict's new gap comes with its covering row (run 121: stale blockers, none): ${JSON.stringify(stepCalls(dispute)).slice(0, 900)}`);
    assert.match(dispute.why, /Upper keeps multibyte letters intact/, `[${tag}] the new gap is named among the other blockers`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

// ---------------------------------------------------------------------------
// Lab run102 (bench-staging/oldpos/run100-103-analysis.md §1, §2, §5): NCD, NCE, NCS. A made-up interpreter whose text read
// counts a negative index from the end (a wrap) and whose list write rejects it; rows on a new text single-index write.
// Synthetic values only; the run-101 / run-102 shapes, not their values.

const R102_EVAL = [
  'package eval', '',
  'func evalStringIndexExpression(str, index Object) Object {',
  '\ts := str.(*String).Value',
  '\tidx := index.(*Number).Int()',
  '\tmax := len(s) - 1',
  '\tif idx > max {', '\t\treturn &String{Value: ""}', '\t}',
  '\tif idx < 0 {', '\t\tlength := max + 1',
  '\t\tif -idx > length {', '\t\t\treturn &String{Value: ""}', '\t\t}',
  '\t\tidx = length + idx', '\t}',
  '\treturn &String{Value: string(s[idx])}', '}', '',
  'func evalIndexAssignment(target, index, value Object) Object {',
  '\tswitch left := target.(type) {',
  '\tcase *Array:',
  '\t\tidx := index.(*Number).Int()',
  '\t\tif idx < 0 {', '\t\t\treturn newError("index out of range: %d", idx)', '\t\t}',
  '\t\tleft.Elements[idx] = value',
  '\t\treturn value',
  '\t}',
  '\treturn newError("index assignment not supported: %s", target.Type())', '}', '',
].join('\n');
const R102_EVAL_TEST = ['package eval', '', 'var stringIndexTests = []struct{ input, want string }{', '\t{`"pqr"[0]`, "p"},', '\t{`"pqr"[-1]`, "r"},', '\t{`"pqr"[7]`, ""},', '}', ''].join('\n');
const R102_QUOTE = 'A text variable accepts `t[i] = "c"`, which replaces the character at index i.';
const R102_REQUEST = `${R95_REQUEST}- ${R102_QUOTE}\n`;
const R102_VALUE_NEG = 't = "pqr"; t[-1] = "z"; t -> "pqz"';
const R102_ERROR_NEG = 't = "pqr"; t[-1] = "z" -> index out of range: -1';
const R102_OOR = 't = "pqr"; t[5] = "z" -> index out of range: 5';
const r102Row = (desc: string, test: string) => r95Row(desc, test, { derivation: { requestQuote: R102_QUOTE, computation: `the write replaces the character the index selects: ${desc.split('->').at(-1)!.trim()}` } });
/** The r95 PLAN plus a text single-index write on CHK-001 (edge:1 = the negative row, edge:2 = the out-of-range row). */
function r102Intents(negative: string) {
  const intents = r95Intents([]);
  return { ...intents, 'CHK-001': { ...intents['CHK-001'], happy: [...intents['CHK-001'].happy, r102Row('t = "pqr"; t[1] = "z"; t -> "pzr"', 'TestTextAssign')],
    edge: [...intents['CHK-001'].edge, r102Row(negative, 'TestTextAssignNegative'), r102Row(R102_OOR, 'TestTextAssignPastEnd')] } };
}
const r102Owner = (tag: string, storyId: string, machineEnv: NodeJS.ProcessEnv, steps: Step[]) => new Owner(tag, storyId, machineEnv, steps, false,
  { trackedGateFailureCounts: true, unimplemented: true, request: R102_REQUEST, config: { plan: { counterpartCoverage: 'on' } }, baseFiles: { 'eval/eval.go': R102_EVAL, 'eval/eval_test.go': R102_EVAL_TEST } });
const stepCalls = (step: NextStepJson) => (step.batch?.length ? step.batch.map(call => call.cli) : step.cli ? [step.cli] : []).filter(Boolean) as Array<{ command: string; payload: Record<string, unknown> }>;
const rowPatches = (step: NextStepJson, itemId: string) => stepCalls(step).flatMap(call => call.command === 'checklist_update' && call.payload.itemId === itemId ? (call.payload.intentRows as Array<Record<string, unknown>> | undefined) ?? [] : []);
const edgeRow = (o: Owner, index: number): string => String((new StoryStore(o.worktree).readChecklist(o.storyId).items.find(item => item.id === 'CHK-001')!.verificationIntent!.edge[index] as { desc?: string } | undefined)?.desc ?? '');

/**
 * NCE (run 101): CHK-001:edge:1 pins an error for `t[-1] = "z"` while the same receiver's read counts a negative index from the
 * end. RED on the base: the counterpart gate counted the error row as coverage (value-agnostic), so nothing stopped it and every
 * later lane trusted the row. Now: `next` names the row [counterpart_coverage_missing] with ONE ready re-pin to the counterpart
 * value; the DEV gate refuses the same; applied, the gate passes.
 */
function scenarioNCE(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NCE';
  const name = 'NCE lab run102 fix 2: a row pinning an error for a case the same receiver\'s counterpart resolves is no counterpart coverage: ONE ready re-pin to the counterpart value, DEV refused until applied';
  const o = r102Owner(tag, 'B-102e', machineEnv, steps);
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    r95Plan(o, r102Intents(R102_ERROR_NEG));
    const step = ask('next (error row on a negative index)');
    assert.equal(step.reason, 'counterpart_coverage_missing', `[${tag}] the error row is no coverage: ${step.reason}: ${step.why.slice(0, 600)}`);
    assert.match(step.why, /CHK-001:edge:1 pins an error[^]*evalStringIndexExpression/, `[${tag}] the row and the counterpart are named: ${step.why.slice(0, 900)}`);
    const patch = rowPatches(step, 'CHK-001').find(row => row.ref === 'CHK-001:edge:1');
    assert.equal(patch?.desc, R102_VALUE_NEG, `[${tag}] a ready re-pin to the counterpart value: ${JSON.stringify(rowPatches(step, 'CHK-001'))}`);
    assert.ok(!rowPatches(step, 'CHK-001').some(row => row.ref === 'CHK-001:edge:+' && /negative/.test(String(row.desc))), `[${tag}] no appended placeholder for the class`);
    const dev = o.cli('story_advance', { storyId: o.storyId, phase: 'DEV' }, { label: 'story_advance DEV (refused: error row on a resolved case)' });
    assert.notEqual(dev.status, 0, `[${tag}] DEV is refused`);
    assert.match(dev.out, /\[counterpart_coverage_missing\][^\n]*CHK-001:edge:1/, `[${tag}] the gate names the row:\n${dev.out.slice(-1200)}`);
    for (const call of stepCalls(step)) o.mustCli(call.command, call.payload, { label: `${call.command} (from the step)` });
    assert.equal(edgeRow(o, 1), R102_VALUE_NEG, `[${tag}] the row now follows the counterpart`);
    const after = ask('next (re-pinned)');
    assert.notEqual(after.reason, 'counterpart_coverage_missing', `[${tag}] covered now: ${after.why.slice(0, 400)}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NCS (run 101 scope-plan #1): the scope-plan pin audit raised the counterpart-consistent row CHK-001:edge:1 ("request gives
 * no settled value", quoting another receiver's precedent). RED on the base: story_review blocked on it and `next` handed the
 * owner the reviewer's value (pin_audit_correction / plan_review_blockers): the run-101 flip. Now: the scope-plan prompt lists
 * the row as counterpart-backed with the precedence, story_review records the gap as settled (advisory), and `next` offers no
 * value change for it.
 */
function scenarioNCS(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NCS';
  const name = 'NCS lab run102 fix 2: a pin-audit gap on a counterpart-backed row is settled by the framework (request > base counterpart > reviewer); the prompt lists the row; no flip is offered';
  const o = r102Owner(tag, 'B-102s', machineEnv, steps);
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    r95Plan(o, r102Intents(R102_VALUE_NEG));
    const gap = 'pin-audit CHK-001:edge:1: pins "pqz"; request gives index out of range: -1 (no settled value: keep the existing single-index assignment behaviour; the list write rejects a negative index)';
    r95Verdict(o, [gap]);
    const run = r95ScopeRun(o, tag, ask, 'verdict 1');
    assert.match(run.prompt, /Counterpart-backed rows[^]*CHK-001:edge:1[^]*evalStringIndexExpression/, `[${tag}] the prompt lists the row:\n${run.prompt.slice(0, 300)}`);
    const review = o.cli('story_review', { storyId: o.storyId }, { label: 'story_review (verdict 1)' });
    assert.match(review.out, /scope_gap_counterpart_settled/, `[${tag}] the gap is recorded as settled:\n${review.out.slice(-1500)}`);
    const next = ask('next (verdict 1)');
    assert.ok(!['pin_audit_correction', 'plan_review_blockers', 'plan_pin_dispute'].includes(next.reason), `[${tag}] no value change is offered: ${next.reason}: ${next.why.slice(0, 600)}`);
    assert.equal(edgeRow(o, 1), R102_VALUE_NEG, `[${tag}] the counterpart-backed row stands`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NCD (run 102): the scope-plan reviewer raised the counterpart row CHK-001:edge:1 and the out-of-range error row
 * CHK-001:edge:2 in two consecutive verdicts. RED on the base: plan_pin_dispute removed both rows and excluded their cases,
 * then counterpart_coverage_missing asked for them again, forever (10 offers, owner stopped). Now: the counterpart-backed row
 * is settled (not disputed), the out-of-range error row is relaxed with its case kept, the counterpart gate stays satisfied
 * after the remedy, a third identical verdict gives no exclusion either, and the remedies are journaled.
 */
function scenarioNCD(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NCD';
  const name = 'NCD lab run102 fix 1: the pin-dispute remedy never removes / excludes a case the counterpart gate requires; no dispute <-> counterpart alternation';
  const o = r102Owner(tag, 'B-102d', machineEnv, steps);
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    r95Plan(o, r102Intents(R102_VALUE_NEG));
    const gaps = ['pin-audit CHK-001:edge:1: pins "pqz"; request gives no settled value (the list write rejects a negative index)',
      'pin-audit CHK-001:edge:2: pins index out of range: 5; request gives no error text for a text assignment'];
    r95Verdict(o, gaps);
    r95ScopeRun(o, tag, ask, 'verdict 1');
    o.cli('story_review', { storyId: o.storyId }, { label: 'story_review (verdict 1)' });
    const first = ask('next (verdict 1)');
    assert.notEqual(first.reason, 'plan_pin_dispute', `[${tag}] one verdict is no dispute`);
    // The owner answers the out-of-range gap with another guess (run 102: every precedent tried).
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', intentRows: [{ ref: 'CHK-001:edge:2', desc: 't = "pqr"; t[5] = "z" -> index out of range: 5 (text)', derivation: { requestQuote: R102_QUOTE, computation: 'past the end: index out of range: 5 (text)' } }], reason: 'guess' }, { label: 'checklist_update CHK-001 (guess)' });
    r95Verdict(o, gaps);
    r95ScopeRun(o, tag, ask, 'verdict 2');
    o.cli('story_review', { storyId: o.storyId }, { label: 'story_review (verdict 2)' });
    const dispute = ask('next (verdict 2, same rows)');
    assert.equal(dispute.reason, 'plan_pin_dispute', `[${tag}] the repeated gap on the error row is escalated: ${dispute.reason}: ${dispute.why.slice(0, 600)}`);
    const patches = rowPatches(dispute, 'CHK-001');
    assert.ok(!patches.some(row => row.ref === 'CHK-001:edge:1'), `[${tag}] the counterpart-backed row is not disputed: ${JSON.stringify(patches)}`);
    assert.ok(!patches.some(row => row.remove || row.drop), `[${tag}] nothing removed: ${JSON.stringify(patches)}`);
    assert.ok(!stepCalls(dispute).some(call => Array.isArray(call.payload.excludes) && (call.payload.excludes as string[]).some(entry => /t\[-1\]|t\[5\]/.test(entry))), `[${tag}] no case excluded`);
    assert.equal(patches.find(row => row.ref === 'CHK-001:edge:2')?.desc, 't = "pqr"; t[5] = "z" -> error', `[${tag}] the out-of-range error row is relaxed, its case kept`);
    for (const call of stepCalls(dispute)) o.mustCli(call.command, call.payload, { label: `${call.command} (dispute remedy)` });
    const after = ask('next (after the remedy)');
    assert.notEqual(after.reason, 'counterpart_coverage_missing', `[${tag}] the remedy keeps the counterpart gate satisfied (no alternation): ${after.why.slice(0, 500)}`);
    // A third identical verdict: still no exclusion and no counterpart refusal (the cycle cannot start).
    r95Verdict(o, gaps);
    const rerun = r95ScopeRun(o, tag, ask, 'verdict 3');
    assert.match(rerun.prompt, /Disputed rows[^\n]*CHK-001:edge:2[^\n]*counterpart/, `[${tag}] the rerun context says the framework requires the case:\n${rerun.prompt.slice(0, 200)}`);
    o.cli('story_review', { storyId: o.storyId }, { label: 'story_review (verdict 3)' });
    const third = ask('next (verdict 3)');
    assert.notEqual(third.reason, 'counterpart_coverage_missing', `[${tag}] verdict 3: ${third.reason}`);
    assert.ok(!stepCalls(third).some(call => Array.isArray(call.payload.intentRows) && (call.payload.intentRows as Array<Record<string, unknown>>).some(row => row.remove || row.drop)), `[${tag}] verdict 3: nothing removed`);
    const journal = [o.root, o.worktree].map(dir => join(dir, '.proof-or-stop', 'runtime', 'plan-remedy', `${o.storyId}.jsonl`)).find(path => existsSync(path));
    assert.ok(journal, `[${tag}] the PLAN remedies are journaled for the cycle breaker`);
    lines.push(`plan-remedy journal: ${readFileSync(journal!, 'utf8').trim().split('\n').length} entr(ies)`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

function listScopeRuns(o: Owner): number {
  const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
  if (!existsSync(runsRoot)) return 0;
  return readdirSync(runsRoot).filter(runId => {
    try { return (JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as { agentType?: string }).agentType === 'proof-or-stop-review-scope-plan'; } catch { return false; }
  }).length;
}

// ---------------------------------------------------------------------------
// Lab run131 (bench-staging/oldpos/run131-analysis.md, run127-129-phase-cost.md): NSG / NSG-X (scope finding vs the
// scope gate), NIO (intent conflict overruled by a bare re-assertion), NFC (finding conflict settled once), NPV (pin
// reversal remedy at the first refusal), NMC (metadata correction ready rows), NDI (delta-confirmation refusal commit vs
// a sibling lane import), NSL (a stalled lane relaunched while its siblings run). Synthetic `strs` helpers only.

/** Run 131 F-024's shape (made-up): a lane calls a repair's doc edit a scope violation the scope gate admits. */
const NSG_DOC = 'docs/types/string.md';
const NSG_FINDING = `Scope violation: the repair of F-001 edited ${NSG_DOC}, but the scope-contract allowedModify lists no docs (only strs/strs.go); revert the documentation edit.`;
const NSG_X_FINDING = 'Scope violation: the repair of F-001 edited internal/cache/cache.go, which the scope contract does not admit; revert it.';

function scenarioNSG(machineEnv: NodeJS.ProcessEnv, steps: Step[], tag: 'NSG' | 'NSG-X'): Outcome {
  const admitted = tag === 'NSG';
  const name = admitted
    ? 'NSG lab run131 fix 1: a scope-violation finding on a doc the scope gate admits (documentation-default) is settled by ONE framework step: no repair, no guard, no PLAN trip'
    : 'NSG-X lab run131 fix 1 control: a scope-violation finding on a path the scope gate refuses still goes to repair';
  const o = new Owner(tag, admitted ? 'B-131a' : 'B-131b', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    devSetup(o);
    seedFindings(o, [{ desc: admitted ? NSG_FINDING : NSG_X_FINDING, files: [admitted ? NSG_DOC : 'internal/cache/cache.go'], category: 'adversarial' }]);
    const step = ask('next (scope finding)');
    if (!admitted) {
      assert.equal(step.reason, 'finding_repair', `[${tag}] a refused path keeps the repair route: ${step.reason}: ${step.why.slice(0, 400)}`);
      o.cleanup();
      return { name, status: 'PASS', lines };
    }
    assert.equal(step.reason, 'finding_file_state_settled', `[${tag}] the scope gate decides, not a repair: ${step.reason}: ${step.why.slice(0, 400)}`);
    assert.equal(step.kind, 'framework', `[${tag}] no owner turn`);
    assert.match(step.why, /scope gate|scope_contract_check/, `[${tag}] the why names the gate verdict: ${step.why.slice(0, 400)}`);
    o.mustCli(step.cli!.command, step.cli!.payload, { label: 'finding_resolve (scope gate settle)' });
    const finding = new StoryStore(o.worktree).readFindings(o.storyId).findings.find(row => row.desc === NSG_FINDING)!;
    assert.equal(finding.status, 'resolved', `[${tag}] closed`);
    assert.equal(finding.resolutionType, 'superseded', `[${tag}] superseded`);
    assert.match(String(finding.resolvedReason), /^\[file_state_conflict\].*documentation-default/, `[${tag}] the gate verdict is recorded: ${finding.resolvedReason}`);
    const after = ask('next (settled)');
    assert.doesNotMatch(after.reason, /^finding_(?:repair|conflict_pin|file_state)/, `[${tag}] nothing left for the finding: ${after.reason}`);
    assert.equal(managedPrompts(o, FINDING_REPAIR).length, 0, `[${tag}] no repair run`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NIO: the implementer reports the pinned row contradicts the request; the pin is a literal the request never states. */
const NIO_PINNED = 'Upper("ab") == "ab"';
const NIO_IMPLIED = 'Upper("ab") == "AB"';
const NIO_CONFLICT_LINE = `[intent-conflict] CHK-001:happy:0 | request: "\`strs.Upper(s)\` returns the upper-case form of \`s\`" | request implies: ${NIO_IMPLIED} | intent pins: ${NIO_PINNED}`;
const NIO_REQUEST = ['Implement the string helpers documented in docs/types/string.md:', '', '- `strs.Upper(s)` returns the upper-case form of `s`.', '- `strs.Reverse(s)` returns `s` reversed by rune.', ''].join('\n');

function scenarioNIO(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NIO';
  const name = 'NIO lab run131 fix 2: an amend that re-asserts the pin an implementer\'s [intent-conflict] disputed (request silent) is refused with ONE ready row patch; the amend step itself is ready';
  const o = new Owner(tag, 'B-131c', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NIO_REQUEST });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    const store = new StoryStore(o.worktree);
    const cl = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => item.id === 'CHK-001' ? { ...item, verificationIntent: { ...item.verificationIntent!,
      happy: [{ ...item.verificationIntent!.happy[0]!, desc: `${NIO_PINNED}; go test -v ./strs -run TestUpper prints --- PASS: TestUpper`,
        derivation: { requestQuote: '`strs.Upper(s)` returns the upper-case form of `s`.', computation: 'the helper keeps lower-case input as is' } }] } } : item) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} pinned row`);
    devSetup(o, false);
    const launch = ask('next (DEV start)');
    assert.equal(launch.reason, 'implement_item', `[${tag}] ${launch.reason}: ${launch.why.slice(0, 300)}`);
    const script = implementerScript(o.storyId, String(launch.cli!.payload.itemId));
    o.script(IMPLEMENTER, { ...script, final: `${script.final}\n${NIO_CONFLICT_LINE}` });
    const launched = o.mustCli(launch.cli!.command, launch.cli!.payload, { label: 'host_run implementer (conflict)' });
    waitTerminal(o, 'implementer', String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId));
    o.unscript(IMPLEMENTER);
    const blocked = ask('next (conflict declared)');
    assert.equal(blocked.reason, 'intent_conflict', `[${tag}] ${blocked.reason}: ${blocked.why.slice(0, 300)}`);
    o.mustCli('story_advance', blocked.cli!.payload, { label: 'story_advance PLAN (intent conflict)' });
    const amend = ask('next (PLAN, conflict open)');
    assert.equal(amend.reason, 'intent_conflict_amend', `[${tag}] ${amend.reason}`);
    assert.deepEqual(amend.placeholders ?? [], [], `[${tag}] the amend is ready (the implementer's value, the re-pin stated): ${JSON.stringify(amend.cli?.payload).slice(0, 600)}`);
    // The owner overrules with a bare re-assertion (run 131 06:40): refused, with the ready patch as the one Next.
    const item = new StoryStore(o.worktree).readChecklist(o.storyId).items.find(row => row.id === 'CHK-001')!;
    const reasserted = JSON.parse(JSON.stringify(item.verificationIntent)) as { happy: Array<{ derivation?: { computation?: string } }> };
    reasserted.happy[0]!.derivation = { ...reasserted.happy[0]!.derivation, computation: 'the pinned value stands: Upper keeps lower-case input, so Upper("ab") == "ab"' };
    const refused = o.cli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', verificationIntent: reasserted, reason: 'The intent is right.', status: 'pending' }, { label: 'checklist_update CHK-001 (re-assert)' });
    assert.notEqual(refused.status, 0, `[${tag}] a bare re-assertion is refused`);
    assert.match(refused.out, /\[intent_conflict_overruled\]/, `[${tag}] refusal code:\n${refused.out.slice(-1200)}`);
    const nextLine = refused.out.split('\n').find(row => row.startsWith('Next: proof-or-stop checklist_update ')) ?? '';
    assert.doesNotMatch(nextLine, /<[a-z][^<>]*>/i, `[${tag}] the Next is ready: ${nextLine}`);
    const ready = JSON.parse(nextLine.slice('Next: proof-or-stop checklist_update '.length).replace(/^'|'$/g, '').replace(/'\\''/g, "'")) as Record<string, unknown>;
    o.mustCli('checklist_update', ready, { label: 'checklist_update CHK-001 (ready patch)' });
    const after = ask('next (amended)');
    assert.doesNotMatch(after.reason, /^intent_conflict/, `[${tag}] the conflict is settled: ${after.reason}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NFC (runs 128 / 129): resolved G pins `Reverse("")` to an error marker (its repair test states it, a row pins it); open F demands the opposite. */
const NFC_CASE = 'Reverse("")';
const NFC_G = `strs/strs.go:9 Reverse of an empty string must return the error marker. Repro: \`${NFC_CASE}\``;
const NFC_F = `strs/strs.go:9 Reverse of an empty string should return the empty string, like an omitted input. Repro: \`${NFC_CASE}\``;
const NFC_TEST = '\nfunc TestReverseEmptyMarker(t *testing.T) {\n\tif Reverse("") != "error" {\n\t\tt.Fatal("want the error marker")\n\t}\n}\n';

function scenarioNFC(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NFC';
  const name = 'NFC lab run131 fix 3: a finding whose repair broke a resolved finding\'s test, on a case the checklist pins as that test states, is settled once by a framework step (no repair, no PLAN trip)';
  const o = new Owner(tag, 'B-131d', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    devSetup(o);
    write(o.worktree, 'strs/strs_test.go', `${readFileSync(join(o.worktree, 'strs/strs_test.go'), 'utf8')}${NFC_TEST}`);
    git(o.worktree, ['add', 'strs/strs_test.go']);
    git(o.worktree, ['-c', `user.name=${FINDING_REPAIR}`, 'commit', '-qm', `${o.storyId} F-001: test the empty-string marker`]);
    const gRepair = git(o.worktree, ['rev-parse', 'HEAD']);
    write(o.worktree, 'strs/strs.go', `${readFileSync(join(o.worktree, 'strs/strs.go'), 'utf8')}\n// empty input handled\n`);
    git(o.worktree, ['add', 'strs/strs.go']);
    git(o.worktree, ['-c', `user.name=${FINDING_REPAIR}`, 'commit', '-qm', `${o.storyId} F-002: empty input returns empty`]);
    const fRepair = git(o.worktree, ['rev-parse', 'HEAD']);
    const store = new StoryStore(o.worktree);
    const cl = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => item.id === 'CHK-002' ? { ...item, verificationIntent: { ...item.verificationIntent!,
      edge: [...(item.verificationIntent!.edge ?? []), { desc: `\`${NFC_CASE} -> error\``, derivation: { requestQuote: 'Reverse returns the string reversed by rune.', computation: 'the empty string has no rune to reverse: the error marker' } }] } } : item) } as never);
    seedFindings(o, [{ desc: NFC_G, status: 'resolved', resolutionType: 'fixed', resolvedAt: '2026-10-15T00:10:00.000Z', resolvedReason: `Repaired [repair commit ${gRepair.slice(0, 12)}]` }, { desc: NFC_F }]);
    store.appendProcessEvent(o.storyId, { type: 'resolved_finding_guard_checked', storyId: o.storyId, findingId: `${o.storyId}:F-001`, passed: false, inconclusive: false,
      command: 'go test -v ./strs -run ^TestReverseEmptyMarker$', scope: 'repro', outputTail: '--- FAIL: TestReverseEmptyMarker', rejectedRepairs: [{ findingId: `${o.storyId}:F-002`, commit: fRepair }] } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} guard rejected F-002's repair`);
    const step = ask('next (conflict)');
    assert.equal(step.reason, 'finding_conflict_settled', `[${tag}] the pin decides once, by the framework: ${step.reason}: ${step.why.slice(0, 500)}`);
    assert.equal(step.kind, 'framework', `[${tag}] no owner turn`);
    o.mustCli(step.cli!.command, step.cli!.payload, { label: 'finding_resolve (conflict settle)' });
    const findings = new StoryStore(o.worktree).readFindings(o.storyId).findings;
    const f = findings.find(row => row.desc === NFC_F)!;
    assert.equal(f.status, 'resolved', `[${tag}] the losing finding is closed`);
    assert.match(String(f.resolvedReason), /^\[finding_conflict_settled\]/, `[${tag}] ${f.resolvedReason}`);
    const after = ask('next (settled)');
    assert.doesNotMatch(after.reason, /^finding_(?:repair|conflict)/, `[${tag}] never reopened: ${after.reason}: ${after.why.slice(0, 300)}`);
    assert.equal(managedPrompts(o, FINDING_REPAIR).length, 0, `[${tag}] no repair run`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NPV (run 131 PLAN-C): after DEV, the owner flips a pinned value without stating the re-pin. */
function scenarioNPV(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NPV';
  const name = 'NPV lab run131 fix 4: the first pin_reversal_unstated refusal carries the remedy as ONE ready command, which applies';
  const o = new Owner(tag, 'B-131e', machineEnv, steps, false, { trackedGateFailureCounts: true, request: NIO_REQUEST });
  const lines: string[] = [];
  try {
    const store = new StoryStore(o.worktree);
    const cl = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => item.id === 'CHK-002' ? { ...item, verificationIntent: { ...item.verificationIntent!,
      edge: [{ ...item.verificationIntent!.happy[0]!, id: 'CHK-002:edge:0', desc: '`Reverse("abc") -> "cba"`', derivation: { requestQuote: '`strs.Reverse(s)` returns `s` reversed by rune.', computation: 'three runes reversed' } }] } } : item) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} pinned edge row`);
    devSetup(o);
    o.mustCli('story_advance', { storyId: o.storyId, phase: 'PLAN' }, { label: 'story_advance PLAN (re-plan)' });
    const item = new StoryStore(o.worktree).readChecklist(o.storyId).items.find(row => row.id === 'CHK-002')!;
    const flipped = JSON.parse(JSON.stringify(item.verificationIntent)) as { edge: Array<{ desc: string; derivation?: { requestQuote?: string; computation?: string } }> };
    flipped.edge[0]!.desc = '`Reverse("abc") -> "cb"`';
    flipped.edge[0]!.derivation = { ...flipped.edge[0]!.derivation, computation: 'the runes reversed, the first one dropped: "cb"' };
    const refused = o.cli('checklist_update', { storyId: o.storyId, itemId: 'CHK-002', verificationIntent: flipped, reason: 'Correct the pin.' }, { label: 'checklist_update CHK-002 (silent reversal)' });
    assert.notEqual(refused.status, 0, `[${tag}] a silent reversal is refused`);
    assert.match(refused.out, /\[pin_reversal_unstated\]/, `[${tag}] refusal code:\n${refused.out.slice(-1200)}`);
    const nextLine = refused.out.split('\n').find(row => row.startsWith('Next: proof-or-stop checklist_update ')) ?? '';
    lines.push(`refusal Next: ${nextLine.slice(0, 300)}`);
    assert.doesNotMatch(nextLine, /<[a-z][^<>]*>/i, `[${tag}] the Next is ready: ${nextLine}`);
    const ready = JSON.parse(nextLine.slice('Next: proof-or-stop checklist_update '.length).replace(/^'|'$/g, '').replace(/'\\''/g, "'")) as Record<string, unknown>;
    o.mustCli('checklist_update', ready, { label: 'checklist_update CHK-002 (ready remedy)' });
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NMC (run 131 PLAN-B): the PLAN intent-row correction is ready (no placeholder); an unchanged update's refusal names the ready rows. */
function scenarioNMC(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NMC';
  const name = 'NMC lab run131 fix 5: the PLAN metadata correction carries the corrected rows (no placeholder); a refusal names the exact next command';
  const o = new Owner(tag, 'B-131f', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  let reached: NextStepJson | null = null;
  try {
    const store0 = new StoryStore(o.worktree);
    const cl0 = store0.readChecklist(o.storyId);
    store0.writeChecklist(o.storyId, { ...cl0, items: cl0.items.map(item => item.id === 'CHK-001' ? { ...item, verificationIntent: { ...item.verificationIntent!,
      happy: [{ ...item.verificationIntent!.happy[0]!, desc: `${NIO_PINNED}; go test -v ./strs -run TestUpper prints --- PASS: TestUpper` }] } } : item) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} row stating a wrong statement`);
    devSetup(o);
    try {
      driveWithNext(o, { findingRound1: true, run: false, metadata: 'intent-literal' }, lines, next => {
        if (next.reason === 'metadata_correction' && next.phase === 'PLAN') { reached = next; throw new StopDrive('PLAN correction reached'); }
      });
    } catch (error) {
      if (!(error instanceof StopDrive)) throw error;
    }
    const step = reached as NextStepJson | null;
    assert.ok(step, `[${tag}] next reached the PLAN correction`);
    const calls = step!.batch?.length ? step!.batch.map(call => call.cli) : [step!.cli!];
    for (const call of calls) assert.doesNotMatch(JSON.stringify(call.payload), /<[a-z][^<>]*>/i, `[${tag}] ready payload: ${JSON.stringify(call.payload).slice(0, 500)}`);
    const item = new StoryStore(o.worktree).readChecklist(o.storyId).items.find(row => row.id === String(calls[0]!.payload.itemId))!;
    const unchanged = o.cli('checklist_update', { storyId: o.storyId, itemId: item.id, verificationIntent: item.verificationIntent, metadataCorrection: true, reason: 'Restating the rows.' }, { label: 'checklist_update (unchanged rows)' });
    assert.match(unchanged.out, /\[metadata_correction_unchanged\]/, `[${tag}] refusal:\n${unchanged.out.slice(-800)}`);
    const nextLine = unchanged.out.split('\n').find(row => row.startsWith('Next: ')) ?? '';
    assert.match(nextLine, /^Next: proof-or-stop checklist_update '/, `[${tag}] the refusal names the ready rows: ${nextLine}`);
    for (const call of calls) o.mustCli(call.command, call.payload, { label: `checklist_update ${String(call.payload.itemId)} (ready correction)` });
    const none = o.cli('checklist_update', { storyId: o.storyId, itemId: item.id, userSees: item.userSees, metadataCorrection: true, reason: 'Again: the same correction.' }, { label: 'checklist_update (nothing open)' });
    assert.match(none.out, /\[metadata_correction_none\]/, `[${tag}] refusal:\n${none.out.slice(-800)}`);
    assert.match(none.out.split('\n').find(row => row.startsWith('Next: ')) ?? '', /^Next: proof-or-stop (?:checklist_update '|next --storyId)/, `[${tag}] one exact next command`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NDI (run 127 R2: 3 of 4 lane imports refused `managed_review_live_head_lineage_invalid`, the round discarded): a delta
 * round whose confirmation lane gaps (its refusal commit lands first) while the raising lane is still running; the raising
 * lane, reviewed against the head before that commit, imports.
 */
function scenarioNDI(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NDI';
  const name = 'NDI lab run131 fix 6: a delta-confirmation refusal commit does not invalidate the sibling lane reviewed before it (no lane re-run, no discarded evidence)';
  const o = new Owner(tag, 'B-131g', machineEnv, steps, false, { trackedGateFailureCounts: true, config: { review: { deltaRounds: 'on' } } });
  const lines: string[] = [];
  try {
    devSetup(o, true);
    driveWithNext(o, { findingRound1: true, run: false, deltaNote: 'gap', laneLatencyFor: { 'test-coverage': { baseMs: 6000, perDimensionMs: 0, fromRound: 2 } } }, lines);
    const store = new StoryStore(o.root);
    const events = store.readProcessEvents(o.storyId);
    const lineage = events.filter(event => event.type === 'managed_review_import_refused' && /lineage/.test(String(event.reason)));
    const rounds = [...new Set(store.readReviewRuns(o.storyId).runs.map(run => run.reviewRound))];
    const round2 = store.readReviewRuns(o.storyId).runs.filter(run => run.reviewRound === rounds[1] && run.reviewPurpose !== 'inventory-completeness').map(run => run.lane.replace('proof-or-stop-review-', ''));
    lines.push(`round 2 lanes: ${round2.join(', ')}`);
    assert.deepEqual(lineage, [], `[${tag}] no lineage refusal: ${JSON.stringify(lineage).slice(0, 600)}`);
    assert.equal(round2.filter(lane => lane === 'test-coverage').length, 1, `[${tag}] the raising lane ran once in round 2 (its evidence kept): ${round2.join(', ')}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NSL (run 131 RR-004 / RR-010): one round-1 lane stalls (no item) while its siblings run; it is relaunched before they end. */
function scenarioNSL(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NSL';
  const name = 'NSL lab run131 fix 7: a lane that stalls before its first item is killed by the no-item window and relaunched (framework step) while its sibling lanes still run';
  const o = new Owner(tag, 'B-131h', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const seen: Array<{ reason: string; kind: string; at: number }> = [];
  try {
    o.env.PROOF_OR_STOP_MANAGED_PROVIDER_FIRST_ITEM_MS = '3000';
    o.env.PROOF_OR_STOP_MANAGED_PROVIDER_STALL_MS = '60000';
    devSetup(o, true);
    driveWithNext(o, { findingRound1: false, run: false, laneStall: { lane: 'quality', ms: 120_000 }, laneLatencyFor: { concept: { baseMs: 12_000, perDimensionMs: 0, fromRound: 1, itemFirst: true }, 'test-coverage': { baseMs: 12_000, perDimensionMs: 0, fromRound: 1, itemFirst: true } } }, lines,
      next => { seen.push({ reason: next.reason, kind: next.kind, at: Date.now() }); });
    const store = new StoryStore(o.root);
    const runs = store.readReviewRuns(o.storyId).runs.filter(run => run.reviewPurpose !== 'inventory-completeness');
    const quality = runs.filter(run => run.lane === 'proof-or-stop-review-quality');
    lines.push(`steps: ${seen.map(row => `${row.reason}(${row.kind})`).join(' > ').slice(0, 900)}`);
    assert.ok(quality.length >= 2, `[${tag}] the stalled lane was relaunched: ${quality.length}`);
    const hostRuns = listHostRunsOnDisk(o);
    const stalled = hostRuns.find(row => row.reviewRunId === quality[0]!.reviewRunId);
    assert.match(String(stalled?.reason ?? ''), /^provider_stalled:/, `[${tag}] the first quality run stalled: ${JSON.stringify(stalled)}`);
    const relaunch = hostRuns.find(row => row.reviewRunId === quality[1]!.reviewRunId);
    const siblingsEnd = Math.max(...hostRuns.filter(row => runs.some(run => run.reviewRunId === row.reviewRunId && run.reviewRound === quality[0]!.reviewRound && run.lane !== 'proof-or-stop-review-quality')).map(row => row.endedAt));
    assert.ok(relaunch && relaunch.createdAt < siblingsEnd, `[${tag}] relaunched while the siblings still ran (relaunch ${relaunch?.createdAt}, siblings end ${siblingsEnd})`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

// ---------------------------------------------------------------------------
// Lab run132 (bench-staging/oldpos/run132-analysis.md): NUA (an INIT story_update with a key it does not declare is
// refused with the owning command), NAB (a bare-valued [intent-conflict] gets a ready amend and the framework verifies the
// adopted amendment), NBP (a pinned message the base format prints differently, listed at INIT and PLAN with a ready patch).

const NUA_BACKGROUND = ['## Trigger Event', 'On 2026-10-21 (B-132a) the docs promised upper-casing and rune reversal while strs returned its input unchanged.', '',
  '## Key Insights', 'The helpers live in strs/strs.go; both are pure functions over a Go string, so a focused go test pins each one exactly.', '',
  '## Solution Tradeoffs', 'Upper uses strings.ToUpper and Reverse reverses a rune slice; no new package, no change to the docs, which already describe the result.', '',
  '## Conversational Texture', 'The request is short and exact: each helper must do what docs/types/string.md says, verified by its own focused test.', ''].join('\n');

/** NUA (run 132 I1): story_update {background} printed "Story ... updated" and wrote nothing; the owner reran the INIT reviewers on the old text. */
function scenarioNUA(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NUA';
  const name = 'NUA lab run132 fix 1: story_update with a key it does not declare (background) is refused, nothing written, its ONE Next the owning command (background_set), which applies';
  const o = new Owner(tag, 'B-132a', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true });
  const lines: string[] = [];
  try {
    const store = new StoryStore(o.worktree);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'INIT' });
    const before = store.readStory(o.storyId);
    const refused = o.cli('story_update', { storyId: o.storyId, background: NUA_BACKGROUND, title: before.title }, { label: 'story_update (background)' });
    lines.push(`story_update: exit ${refused.status}: ${refused.out.trim().split('\n').at(-1)?.slice(0, 200)}`);
    assert.notEqual(refused.status, 0, `[${tag}] refused, not "updated":\n${refused.out.slice(-1500)}`);
    assert.match(refused.out, /\[unknown_argument\]/, `[${tag}] the refusal code:\n${refused.out.slice(-1500)}`);
    assert.doesNotMatch(refused.out, /Story B-132a updated/, `[${tag}] no success line`);
    assert.ok(!existsSync(store.storyFilePath(o.storyId, 'background.md')), `[${tag}] nothing was written`);
    const nextLine = refused.out.split('\n').find(row => row.startsWith('Next: proof-or-stop background_set ')) ?? '';
    assert.ok(nextLine, `[${tag}] the ONE Next is the owning command:\n${refused.out.slice(-1500)}`);
    const argv = nextLine.slice('Next: proof-or-stop background_set '.length).trim();
    const payload = argv.startsWith('@') ? JSON.parse(readFileSync(argv.slice(1), 'utf8')) as Record<string, unknown>
      : JSON.parse(argv.replace(/^'|'$/g, '').replace(/'\\''/g, "'")) as Record<string, unknown>;
    o.mustCli('background_set', payload, { label: 'background_set (the Next)' });
    assert.equal(readFileSync(store.storyFilePath(o.storyId, 'background.md'), 'utf8').trim(), NUA_BACKGROUND.trim(), `[${tag}] the background the owner meant`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NAB (run 132 D1): the implementer's [intent-conflict] names two unbackticked variants of one error text. */
const NAB_PINNED = 'upper: unsupported operand "42" for UPPER';
const NAB_IMPLIED = 'upper: unsupported operand 42 for UPPER';
const NAB_CONFLICT_LINE = `[intent-conflict] CHK-001:happy:0 | request: "A non-string operand keeps the existing operand error format" | request implies: ${NAB_IMPLIED} | intent pins: ${NAB_PINNED}`;
const NAB_REQUEST = ['Implement the string helpers documented in docs/types/string.md:', '', '- `strs.Upper(s)` returns the upper-case form of `s`.',
  '- A non-string operand keeps the existing operand error format.', ''].join('\n');

function scenarioNAB(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NAB';
  const name = 'NAB lab run132 fix 3: a bare-valued [intent-conflict] gets a ready intent_conflict_amend; after it, next verifies the pinned test itself (no implementer relaunch)';
  const o = new Owner(tag, 'B-132b', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NAB_REQUEST });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  const implementerRuns = () => managedPrompts(o, IMPLEMENTER).filter(row => row.target?.itemId === 'CHK-001').length;
  try {
    const store = new StoryStore(o.worktree);
    const cl = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => item.id === 'CHK-001' ? { ...item, verificationIntent: { ...item.verificationIntent!,
      happy: [{ ...item.verificationIntent!.happy[0]!, desc: `Upper(42) -> ${NAB_PINNED}`,
        derivation: { requestQuote: 'A non-string operand keeps the existing operand error format.', computation: 'the operand 42 is quoted in the error' } }] } } : item) } as never);
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} pinned error row`);
    devSetup(o, false);
    const launch = ask('next (DEV start)');
    assert.equal(launch.reason, 'implement_item', `[${tag}] ${launch.reason}: ${launch.why.slice(0, 300)}`);
    o.script(IMPLEMENTER, { commands: pinnedImplementerCommands(o.storyId, 'CHK-001'), final: `Implemented Upper; CHK-001 marked done.\n${NAB_CONFLICT_LINE}` });
    launchManaged(o, tag, launch, 'host_run implementer (bare conflict)');
    o.unscript(IMPLEMENTER);
    const blocked = ask('next (conflict declared)');
    assert.equal(blocked.reason, 'intent_conflict', `[${tag}] ${blocked.reason}: ${blocked.why.slice(0, 300)}`);
    o.mustCli('story_advance', blocked.cli!.payload, { label: 'story_advance PLAN (intent conflict)' });
    const amend = ask('next (PLAN, conflict open)');
    assert.equal(amend.reason, 'intent_conflict_amend', `[${tag}] ${amend.reason}`);
    assert.deepEqual(amend.placeholders ?? [], [], `[${tag}] the amend is ready for bare values: ${JSON.stringify(amend.cli?.payload).slice(0, 600)}`);
    const rows = amend.cli!.payload.intentRows as Array<{ ref: string; desc: string }>;
    assert.equal(rows?.[0]?.desc, `Upper(42) -> ${NAB_IMPLIED}`, `[${tag}] the row re-pinned to the implied text: ${JSON.stringify(rows)}`);
    o.mustCli(amend.cli!.command, amend.cli!.payload, { label: 'checklist_update CHK-001 (ready amend)' });
    // PLAN re-approval is outside this harness: re-enter DEV as NAV does.
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'DEV' });
    commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} re-enter DEV after the amendment (fixture)`);
    let step = ask('next (DEV, after amendment)');
    if (step.reason === 'checklist_item_start') { o.mustCli(step.cli!.command, step.cli!.payload, { label: 'f:checklist_item_start' }); step = ask('next (item restarted)'); }
    assert.equal(step.reason, 'intent_amend_verify', `[${tag}] the adopted amendment is verified by the framework (run 132: a no-op implementer re-verified it): ${step.reason}: ${step.why.slice(0, 400)}`);
    assert.equal(step.kind, 'framework');
    o.mustCli(step.cli!.command, step.cli!.payload, { label: 'f:intent_amend_verify' });
    const done = ask('next (verified)');
    assert.equal(done.reason, 'intent_amend_done', `[${tag}] ${done.reason}: ${done.why.slice(0, 300)}`);
    assert.equal(implementerRuns(), 1, `[${tag}] one implementer run of CHK-001`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NBP (run 132 D2): the base formats the operand error with a bare %s; its tests show a quoted string input printed bare. */
const NBP_BASE_FILES = {
  'strs/operand.go': 'package strs\n\nimport "fmt"\n\nfunc operandError(v string, kind string) error {\n\treturn fmt.Errorf("unsupported operand: %s for %s", v, kind)\n}\n',
  'strs/operand_test.go': ['package strs', '', 'import "testing"', '', 'var operandCases = []struct {', '\tinput    string', '\texpected string', '}{',
    '\t{`Upper(["q"])`, "unsupported operand: q for LIST"},', '}', '', 'func TestOperandCases(t *testing.T) { _ = operandCases }', ''].join('\n'),
};
const NBP_PINNED_ROW = 'Upper(["k"]) -> unsupported operand: "k" for LIST';
const NBP_BASE_ROW = 'Upper(["k"]) -> unsupported operand: k for LIST';

function scenarioNBP(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NBP';
  const name = 'NBP lab run132 fix 4: a pinned message a Story base format prints differently is listed at INIT and PLAN [pin_base_print] with ONE ready row patch to the base form';
  const o = new Owner(tag, 'B-132c', machineEnv, steps, false, { trackedGateFailureCounts: true, unimplemented: true, request: NAB_REQUEST, baseFiles: NBP_BASE_FILES });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    const store = new StoryStore(o.worktree);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'INIT' });
    const added = o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', intentRows: [{ ref: 'CHK-001:adversarial:+', desc: NBP_PINNED_ROW, type: 'logic', priority: 'must',
      scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story', derivation: { requestQuote: 'A non-string operand keeps the existing operand error format.', computation: 'a list operand is not a string' },
      verification: { command: 'go test -v ./strs -run ^TestUpperList$', selector: '--- PASS: TestUpperList' } }],
      reason: 'adversarial operand row' }, { label: 'checklist_update CHK-001 (quoted operand pin)' });
    assert.match(added.out, /CHK-001:adversarial:0[^\n]*\[pin_base_print\]/, `[${tag}] the INIT pre-check lists the row: ${added.out.slice(-1500)}`);
    store.writeStory(o.storyId, { ...store.readStory(o.storyId), phase: 'PLAN' });
    o.mustCli('dev_memory_preflight_ack', { storyId: o.storyId });
    const step = ask('next (PLAN, quoted operand pin)');
    assert.match(step.why, /\[pin_base_print\]/, `[${tag}] PLAN's lint step names the pin: ${step.reason}: ${step.why.slice(0, 600)}`);
    assert.match(step.why, /strs\/operand\.go:\d+/, `[${tag}] with the base format line`);
    const calls = step.batch?.length ? step.batch.map(call => call.cli) : step.cli ? [step.cli] : [];
    const patch = calls.flatMap(call => call.command === 'checklist_update' && call.payload.itemId === 'CHK-001' ? (call.payload.intentRows as Array<Record<string, unknown>> | undefined) ?? [] : [])
      .find(row => row.ref === 'CHK-001:adversarial:0');
    assert.ok(patch, `[${tag}] a row patch of CHK-001:adversarial:0: ${JSON.stringify(calls).slice(0, 800)}`);
    assert.equal(patch!.desc, NBP_BASE_ROW, `[${tag}] the patch states the base form`);
    assert.doesNotMatch(JSON.stringify(patch), /"<[^"]*>"/, `[${tag}] nothing for the owner to author`);
    o.mustCli('checklist_update', { storyId: o.storyId, itemId: 'CHK-001', intentRows: [patch], reason: 'pin re-derived from the base format' }, { label: 'checklist_update CHK-001 (base form)' });
    const after = ask('next (PLAN, base form)');
    assert.doesNotMatch(after.why, /\[pin_base_print\]/, `[${tag}] not offered again: ${after.why.slice(0, 400)}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * NIC (run 132 I2): both INIT reviewers PASS, then a signed INIT input outside story-init's judged slice changes (the
 * request is re-recorded); init-check.json no longer verifies [init_check_tampered]. NIC: only the product reviewer
 * reruns, story-init's signed PASS is carried into the next signed record and INIT_CHECK is entered. NIC-F: the stale
 * record was hand-edited (a reviewer row changed): nothing is carried, both rerun. NIC-OFF: init.reviewerCarryForward=off,
 * both rerun (rollback).
 */
const NIC_REQUEST = ['Implement the string helpers documented in docs/types/string.md:', '', '- `strs.Upper(s)` returns the upper-case form of `s`.',
  '- `strs.Reverse(s)` returns `s` with its runes in reverse order.', '- Both helpers must accept the empty string.', ''].join('\n');

function scenarioNIC(machineEnv: NodeJS.ProcessEnv, steps: Step[], variant: 'on' | 'forged' | 'off'): Outcome {
  const tag = variant === 'on' ? 'NIC' : variant === 'forged' ? 'NIC-F' : 'NIC-OFF';
  const name = variant === 'on'
    ? 'NIC lab run132 fix 2: after a request re-record (outside story-init\'s judged slice) only the product reviewer reruns; story-init\'s signed PASS is carried and INIT_CHECK is entered'
    : variant === 'forged'
      ? 'NIC-F lab run132 fix 2: a hand-edited stale init-check.json carries nothing; both INIT reviewers rerun'
      : 'NIC-OFF lab run132 fix 2: init.reviewerCarryForward=off (rollback): both INIT reviewers rerun after the request re-record';
  const o = new Owner(tag, 'B-0000', machineEnv, steps, false, { fromScratch: true, ...(variant === 'off' ? { config: { init: { reviewerCarryForward: 'off' } } } : {}) });
  const lines: string[] = [];
  const launchesOf = (agentType: string) => managedPrompts(o, agentType).length;
  /** next --run one step at a time until next proposes enter_init_check (not run), at most `limit` steps. */
  const untilInitCheck = (limit: number): string[] => {
    const ran: string[] = [];
    for (let call = 0; call < limit; call += 1) {
      const step = parseJson(o.cli('next', { storyId: o.storyId, json: true }, { label: 'next' }).stdout) as unknown as NextStepJson | null;
      assert.ok(step, `[${tag}] next answered`);
      // A --run step may also have entered INIT_CHECK itself (a launch, its wait and the gate step in one call).
      if (step!.reason === 'enter_init_check' || step!.phase !== 'INIT') return ran;
      ran.push(step!.reason);
      const asked = o.cli('next', { storyId: o.storyId, run: true, json: true, maxSteps: 1 }, { label: `next --run (${step!.reason})` });
      const stopped = parseJson(asked.stdout)?.stopped;
      assert.ok(stopped === undefined || stopped === null || /^maxSteps=/.test(String(stopped)), `[${tag}] next --run stopped:\n${asked.out.slice(-1500)}`);
    }
    assert.fail(`[${tag}] INIT did not settle in ${limit} steps (ran: ${ran.join(' > ')})`);
  };
  try {
    const first = o.cli('next', { json: true }, { label: 'next (no Story)' });
    const template = parseJson(first.stdout) as unknown as NextStepJson | null;
    const created = o.mustCli('story_create', fillStoryCreateTemplate(template!.cli!.payload), { label: 'story_create' });
    o.storyId = created.stdout.match(/Story (B-[a-f0-9]+) created/)![1]!;
    writeFileSync(join(o.scriptsDir, 'resolver.json'), JSON.stringify({ argv: [process.execPath, SELF, '--provide-script', o.root, o.storyId, o.scriptsDir, JSON.stringify({ findingRound1: false })] }));
    untilInitCheck(12);
    const store = new StoryStore(o.root);
    assert.equal(store.readStory(o.storyId).phase, 'INIT', `[${tag}] both verdicts recorded, INIT_CHECK not entered yet`);
    const before = store.readInitCheck(o.storyId)!;
    const storyInitRow = (before.agentResults ?? []).find(row => row.agentId === 'proof-or-stop-review-story-init');
    if (variant === 'on') assert.ok(storyInitRow?.judgedSliceHash, `[${tag}] the story-init row records its judged slice: ${JSON.stringify(before.agentResults).slice(0, 600)}`);
    assert.deepEqual([launchesOf('proof-or-stop-review-story-init'), launchesOf('proof-or-stop-product-reviewer')], [1, 1], `[${tag}] one run of each reviewer`);
    o.mustCli('story_request_set', { storyId: o.storyId, request: NIC_REQUEST, amendmentReason: 'The user clarified that both helpers must accept the empty string.' }, { label: 'story_request_set (clarified request)' });
    if (variant === 'forged') {
      const path = store.storyFilePath(o.storyId, 'init-check.json');
      const data = JSON.parse(readFileSync(path, 'utf8')) as NonNullable<ReturnType<StoryStore['readInitCheck']>>;
      data.agentResults = (data.agentResults ?? []).map(row => row.agentId === 'proof-or-stop-product-reviewer' ? { ...row, issues: [] } : { ...row, checkedAt: new Date().toISOString() });
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
    }
    const stale = parseJson(o.cli('next', { storyId: o.storyId, json: true }, { label: 'next (request re-recorded)' }).stdout) as unknown as NextStepJson | null;
    assert.equal(stale?.reason, 'init_review_launch', `[${tag}] ${stale?.reason}: ${stale?.why.slice(0, 300)}`);
    lines.push(`after the request change: ${stale!.reason} (${stale!.parallel?.length ?? 1} launch${(stale!.parallel?.length ?? 1) > 1 ? 'es' : ''}): ${stale!.why.slice(0, 200)}`);
    untilInitCheck(8);
    const expected = variant === 'on' ? [1, 2] : [2, 2];
    assert.deepEqual([launchesOf('proof-or-stop-review-story-init'), launchesOf('proof-or-stop-product-reviewer')], expected,
      `[${tag}] reviewer runs (story-init, product) after the request change`);
    const after = store.readInitCheck(o.storyId)!;
    const carried = (after.agentResults ?? []).find(row => row.agentId === 'proof-or-stop-review-story-init');
    if (variant === 'on') assert.equal(carried?.deliveryRunId, storyInitRow!.deliveryRunId, `[${tag}] story-init's signed PASS carried as recorded`);
    else assert.notEqual(carried?.deliveryRunId, storyInitRow!.deliveryRunId, `[${tag}] story-init's verdict is a new run's`);
    if (store.readStory(o.storyId).phase === 'INIT') o.mustCli('story_advance', { storyId: o.storyId, phase: 'INIT_CHECK' }, { label: 'story_advance INIT_CHECK' });
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** Host runs on disk: review run binding, terminal reason, created / ended (ms). */
function listHostRunsOnDisk(o: Owner): Array<{ runId: string; reviewRunId: string | null; reason: string; createdAt: number; endedAt: number }> {
  const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot).flatMap(runId => {
    try {
      const spec = JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as Record<string, unknown>;
      const terminalPath = join(runsRoot, runId, 'terminal.json');
      const terminal = existsSync(terminalPath) ? JSON.parse(readFileSync(terminalPath, 'utf8')) as Record<string, unknown> : {};
      return [{ runId, reviewRunId: typeof spec.reviewRunId === 'string' ? spec.reviewRunId : null,
        reason: String(terminal.reason ?? ''), createdAt: Date.parse(String(spec.createdAt ?? '')) || 0, endedAt: Date.parse(String(terminal.terminalAt ?? '')) || Number.MAX_SAFE_INTEGER }];
    } catch { return []; }
  });
}

// ---------------------------------------------------------------------------
// Lab run137 (bench-staging/oldpos/run137-analysis.md): NRR / NRR-OFF (a repair that breaks a resolved finding's test is
// handed back to its own session before it seals), NCK (a repair in a shared helper owes one [caller-check] line per
// caller), NCP (a finding conflict no row pins, decided by the finding-stated Story base value without a PLAN trip),
// NCP-F / NCP-X (the security controls: no evaluator, a self-confirming case: no framework pin), NCP-P (an undeterminable one: the PLAN trip pins first), NGX (a failed grouped repair splits as a framework step),
// NCL / NCL-OFF (EXPERIMENTAL review.classEnumeration). Synthetic `strs` helpers only.

/** A shared helper (made-up): clamp, called by Head and Tail, all added by the Story. */
const SHARED_SRC = `${IMPL}\n// clamp bounds n into [0, len(s)].\nfunc clamp(s string, n int) int {\n\tif n > len(s) {\n\t\treturn len(s)\n\t}\n\treturn n\n}\n\n// Head returns the first n bytes of s.\nfunc Head(s string, n int) string { return s[:clamp(s, n)] }\n\n// Tail returns s from byte n on.\nfunc Tail(s string, n int) string { return s[clamp(s, n):] }\n`;
const SHARED_CLAMP_LINE = SHARED_SRC.split('\n').findIndex(line => line.startsWith('func clamp(')) + 1;
const SHARED_FIXED = SHARED_SRC.replace('\tif n > len(s) {', '\tif n < 0 {\n\t\treturn 0\n\t}\n\tif n > len(s) {');
/** A shell command writing `text` to `path` (heredoc: tabs and quotes kept). */
const writeFileCommand = (path: string, text: string): string => `cat > ${path} <<'POS_EOF'\n${text}POS_EOF\n`;
const commitAll = (storyId: string, subject: string): string => `git add -A strs && git -c user.name=${FINDING_REPAIR} commit -qm '${storyId} ${subject}' && git log --format=%h -1`;

function commitShared(o: Owner): void {
  writeFileSync(join(o.worktree, 'strs/strs.go'), SHARED_SRC);
  git(o.worktree, ['add', 'strs/strs.go']);
  git(o.worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'add clamp, Head and Tail']);
}

/** Run the framework steps next returns (finding_resolve, evidence chain) until an agent step or a non-finding step. */
function runFrameworkResolves(o: Owner, ask: (label: string) => NextStepJson, max = 4): NextStepJson {
  let next = ask('next (after the repair)');
  for (let index = 0; index < max && next.kind === 'framework' && /^(?:finding_resolve|evidence_chain|finding_conflict)/.test(next.reason); index += 1) {
    const calls = next.batch?.length ? next.batch.map(call => call.cli) : next.cli ? [next.cli] : [];
    for (const call of calls) o.cli(call.command, call.payload, { label: `${call.command} (${next.reason})` });
    next = ask(`next (after ${next.reason})`);
  }
  return next;
}

const NRR_G = 'strs/strs.go:9 Reverse of a two-rune string must swap them. Repro: `Reverse("ab")`';
const NRR_F = 'strs/strs.go:9 Reverse of a one-rune string allocates a rune slice; return short input unchanged. Repro: `Reverse("a")`';
const NRR_G_TEST = '\nfunc TestReverseTwo(t *testing.T) {\n\tif Reverse("ab") != "ba" {\n\t\tt.Fatal("two runes")\n\t}\n}\n';
/** The F repair that breaks G: a two-rune string is returned unchanged; the resumed turn narrows it to one rune. */
const NRR_BROKEN = IMPL.replace('\tr := []rune(s)\n', '\tr := []rune(s)\n\tif len(r) <= 2 {\n\t\treturn s\n\t}\n');
const NRR_FIXED = IMPL.replace('\tr := []rune(s)\n', '\tr := []rune(s)\n\tif len(r) <= 1 {\n\t\treturn s\n\t}\n');

/**
 * NRR / NRR-OFF (run 137 F-006 -> F-008, fix M): the repair of an open finding breaks a resolved finding's covering
 * test. NRR: the worker re-runs that test before the run seals and hands the failure back to the SAME session, whose
 * resumed turn fixes it: finding_resolve accepts, no `[regression-of]` finding. NRR-OFF (remediation.regressionCheck=off,
 * the base behaviour): the run seals broken and a later gate refuses it (here the evidence chain's pinned CHK-002 check).
 */
function scenarioNRR(machineEnv: NodeJS.ProcessEnv, steps: Step[], tag: 'NRR' | 'NRR-OFF'): Outcome {
  const on = tag === 'NRR';
  const name = on
    ? 'NRR lab run137 fix M: a repair that breaks a resolved finding\'s covering test is handed back to its own session before it seals (failing output in the resumed prompt); no regression finding'
    : 'NRR-OFF lab run137 fix M control: remediation.regressionCheck=off: the broken repair seals and a later gate refuses it outside its session (the evidence chain\'s pinned check or finding_resolve\'s guard)';
  const o = new Owner(tag, on ? 'B-137a' : 'B-137c', machineEnv, steps, false, { trackedGateFailureCounts: true, codexHome: true, ...(on ? {} : { config: { remediation: { regressionCheck: 'off' } } }) });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    devSetup(o);
    write(o.worktree, 'strs/strs_test.go', `${readFileSync(join(o.worktree, 'strs/strs_test.go'), 'utf8')}${NRR_G_TEST}`);
    git(o.worktree, ['add', 'strs/strs_test.go']);
    git(o.worktree, ['-c', `user.name=${FINDING_REPAIR}`, 'commit', '-qm', `${o.storyId} F-001: test two runes`]);
    const gRepair = git(o.worktree, ['rev-parse', 'HEAD']);
    seedFindings(o, [{ desc: NRR_G, status: 'resolved', resolutionType: 'fixed', resolvedAt: '2026-10-15T00:10:00.000Z', resolvedReason: `Repaired [repair commit ${gRepair.slice(0, 12)}]` }, { desc: NRR_F }]);
    const launch = ask('next (open finding)');
    assert.equal(launch.reason, 'finding_repair', `[${tag}] ${launch.reason}: ${launch.why.slice(0, 300)}`);
    const report = 'Return one-rune input unchanged; committed.\n[family] one rune: fixed\n[intent-conflict] none';
    o.script(FINDING_REPAIR, { commands: [['/bin/sh', '-c', `${writeFileCommand('strs/strs.go', NRR_BROKEN)}${commitAll(o.storyId, 'F-002: short input unchanged')}`]], final: report,
      resume: { commands: [['/bin/sh', '-c', `${writeFileCommand('strs/strs.go', NRR_FIXED)}${commitAll(o.storyId, 'F-002: only one rune is unchanged')}`]], final: `${report}\nFixed the two-rune regression the framework reported.` } });
    const run = launchManaged(o, tag, launch, 'host_run finding-repair (breaks a resolved test)');
    o.unscript(FINDING_REPAIR);
    const resumePrompt = join(o.scriptsDir, 'prompts', `${run.runId}.resume.txt`);
    const events = runEvents(o, run.runId).map(row => row.type);
    lines.push(`run events: ${events.filter(type => /regression|follow_up/.test(String(type))).join(', ') || 'none'}`);
    if (on) {
      assert.ok(existsSync(resumePrompt), `[${tag}] the worker handed the regression back to the session: ${JSON.stringify(events)}`);
      const asked = readFileSync(resumePrompt, 'utf8');
      assert.match(asked, /Regression check \(framework/, `[${tag}] ${asked.slice(0, 400)}`);
      assert.match(asked, /F-001/, `[${tag}] names the resolved finding`);
      assert.match(asked, /TestReverseTwo/, `[${tag}] names its covering test`);
      assert.ok(events.includes('managed_repair_regression_check') && runEvents(o, run.runId).some(row => row.type === 'managed_repair_regression_check_outcome' && (row.detail as { outcome?: string } | undefined)?.outcome === 'passed'),
        `[${tag}] journaled, and passing after the resumed turn: ${JSON.stringify(events)}`);
    } else {
      assert.ok(!existsSync(resumePrompt), `[${tag}] no in-session regression check when off`);
    }
    const last = runFrameworkResolves(o, ask);
    const findings = new StoryStore(o.worktree).readFindings(o.storyId).findings;
    const regression = findings.filter(row => /^\[regression-of F-001\]/.test(row.desc));
    lines.push(`findings: ${findings.map(row => `${row.id.split(':')[1]} ${row.status}`).join(', ')}`);
    if (on) {
      assert.equal(regression.length, 0, `[${tag}] no regression finding: ${regression.map(row => row.desc.slice(0, 200)).join(' | ')}`);
      assert.equal(findings.find(row => row.desc === NRR_F)?.status, 'resolved', `[${tag}] the repair is accepted`);
    } else {
      // The base behaviour: the broken repair sealed, and a later gate refuses it outside the repair's session (the
      // evidence chain's pinned CHK-002 check, or finding_resolve's guard opening the [regression-of] finding).
      assert.notEqual(findings.find(row => row.desc === NRR_F)?.status, 'resolved', `[${tag}] the broken repair is not accepted`);
      assert.ok(regression.length === 1 || /^evidence_chain/.test(last.reason), `[${tag}] refused by a later gate: ${last.reason}: ${last.why.slice(0, 300)}`);
    }
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NCK (run 137 F-004 -> F-006, fix M second half): the repair of a finding in a shared helper (clamp: Head and Tail call it). */
function scenarioNCK(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NCK';
  const name = 'NCK lab run137 fix M: a finding in a shared helper gets every caller in its repair prompt, and the repair that changed it is asked in the same session for one [caller-check] line per caller';
  const o = new Owner(tag, 'B-137b', machineEnv, steps, false, { trackedGateFailureCounts: true, codexHome: true });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    commitShared(o);
    devSetup(o);
    seedFindings(o, [{ desc: `strs/strs.go:${SHARED_CLAMP_LINE} clamp lets a negative n through, so Head panics. Repro: \`Head("abc", -1)\`` }]);
    const launch = ask('next (open finding)');
    assert.equal(launch.reason, 'finding_repair', `[${tag}] ${launch.reason}: ${launch.why.slice(0, 300)}`);
    const test = '\nfunc TestHeadNegative(t *testing.T) {\n\tif Head("abc", -1) != "" {\n\t\tt.Fatal("negative")\n\t}\n}\n';
    const report = 'Clamped a negative n to 0; committed.\n[family] negative n: fixed\n[branch-test] clamp n=-1: TestHeadNegative -> ""';
    o.script(FINDING_REPAIR, { commands: [['/bin/sh', '-c', `${writeFileCommand('strs/strs.go', SHARED_FIXED)}printf '%s' '${test}' >> strs/strs_test.go && ${commitAll(o.storyId, 'F-001: clamp a negative n')}`]],
      final: `${report}\n[intent-conflict] none`,
      resume: { final: `${report}\n[caller-check] Head -> clamp: Head("abc", -1) base=panic HEAD="" changed: the finding\n[caller-check] Tail -> clamp: Tail("abc", -1) base=panic HEAD=abc changed: the finding\n[intent-conflict] none` } });
    const run = launchManaged(o, tag, launch, 'host_run finding-repair (shared helper)');
    o.unscript(FINDING_REPAIR);
    const prompt = managedPrompts(o, FINDING_REPAIR)[0]!.prompt;
    assert.match(prompt, /Shared helpers \(framework, from the Story diff\)/, `[${tag}] the repair prompt lists the shared helper`);
    assert.match(prompt, /in Head: /, `[${tag}] with its Head call site`);
    assert.match(prompt, /in Tail: /, `[${tag}] and its Tail call site`);
    const resumePrompt = join(o.scriptsDir, 'prompts', `${run.runId}.resume.txt`);
    assert.ok(existsSync(resumePrompt), `[${tag}] the worker asked the session for the caller lines: ${JSON.stringify(runEvents(o, run.runId).map(row => row.type))}`);
    const asked = readFileSync(resumePrompt, 'utf8');
    assert.match(asked, /Head -> clamp/, `[${tag}] ${asked.slice(0, 600)}`);
    assert.match(asked, /Tail -> clamp/, `[${tag}] the other caller too`);
    assert.match(asked, /\[caller-check\] <caller> -> <helper>/, `[${tag}] with the exact line form`);
    const after = ask('next (repaired)');
    assert.match(after.reason, /^(?:evidence_chain|finding_resolve)/, `[${tag}] accepted: ${after.reason}: ${after.why.slice(0, 300)}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

const NCP_CASE = 'Reverse("")';
const NCP_G = `strs/strs.go:9 Reverse of an empty string must return the error marker. Repro: \`${NCP_CASE}\``;
/** Run 137 F-006's shape: the finding states the Story base value and the HEAD value of the case. */
const NCP_F = `strs/strs.go:9 Reverse of an empty string now returns the error marker. On the base \`${NCP_CASE}\` returns \`\` (the empty string); HEAD returns \`error\`.`;
const NCP_F_UNSTATED = `strs/strs.go:9 Reverse of an empty string should return the empty string, like an omitted input. Repro: \`${NCP_CASE}\``;

/** A resolved G whose repair test pins the case, an open F whose repair the G guard rejected, and (stated) the framework's R. */
function seedConflict(o: Owner, fDesc: string, withRegression: boolean): void {
  write(o.worktree, 'strs/strs_test.go', `${readFileSync(join(o.worktree, 'strs/strs_test.go'), 'utf8')}${NFC_TEST}`);
  git(o.worktree, ['add', 'strs/strs_test.go']);
  git(o.worktree, ['-c', `user.name=${FINDING_REPAIR}`, 'commit', '-qm', `${o.storyId} F-001: test the empty-string marker`]);
  const gRepair = git(o.worktree, ['rev-parse', 'HEAD']);
  write(o.worktree, 'strs/strs.go', `${readFileSync(join(o.worktree, 'strs/strs.go'), 'utf8')}\n// empty input handled\n`);
  git(o.worktree, ['add', 'strs/strs.go']);
  git(o.worktree, ['-c', `user.name=${FINDING_REPAIR}`, 'commit', '-qm', `${o.storyId} F-002: empty input returns empty`]);
  const fRepair = git(o.worktree, ['rev-parse', 'HEAD']);
  const command = 'go test -v ./strs -run ^(TestReverseEmptyMarker)$';
  seedFindings(o, [{ desc: NCP_G, status: 'resolved', resolutionType: 'fixed', resolvedAt: '2026-10-15T00:10:00.000Z', resolvedReason: `Repaired [repair commit ${gRepair.slice(0, 12)}]` }, { desc: fDesc },
    ...(withRegression ? [{ agent: 'main', desc: `[regression-of F-001] the repair of F-002 (commit ${fRepair.slice(0, 12)}) broke resolved finding F-001: its covering verification as recorded at its resolution now fails (\`${command}\`). Repro: \`${NCP_CASE}\`. Resolved finding: ${NCP_G}` }] : [])]);
  new StoryStore(o.worktree).appendProcessEvent(o.storyId, { type: 'resolved_finding_guard_checked', storyId: o.storyId, findingId: `${o.storyId}:F-001`, passed: false, inconclusive: false,
    command, scope: 'repro', outputTail: '--- FAIL: TestReverseEmptyMarker', rejectedRepairs: [{ findingId: `${o.storyId}:F-002`, commit: fRepair }] } as never);
  commitFixtureMetadata(o, `proof-or-stop: ${o.storyId} guard rejected F-002's repair`);
}

/** The project's declared base evaluator (pinOracle) for NCP: Reverse at the Story base, by rune. */
const NCP_EVAL = [
  "const src = require('fs').readFileSync(process.argv[2], 'utf8').trim();",
  'const call = src.match(/^Reverse\\((".*")\\)$/);',
  "if (!call) { console.error('undefined: ' + src); process.exit(1); }",
  'console.log(JSON.stringify([...JSON.parse(call[1])].reverse().join("")));',
  '',
].join('\n');

/**
 * NCP (run 137 F-004 vs F-006, fix N): no row pins the case; the finding states the Story base value, which the project's
 * declared base evaluator confirms (it ran and printed it); the request is silent. NCP-F (security control): the same
 * conflict without an evaluator: the finding's own statement is no evidence, so the PLAN pin stays and the framework
 * regression finding is not settled. NCP-X (security control): an eval-style evaluator and a finding whose stated case
 * `"" && Reverse("ab")` prints the claimed value on any base: the expression is not trusted, so it is never probed.
 */
function scenarioNCP(machineEnv: NodeJS.ProcessEnv, steps: Step[], tag: 'NCP' | 'NCP-F' | 'NCP-X' = 'NCP'): Outcome {
  if (tag !== 'NCP') return scenarioNCPF(machineEnv, steps, tag);
  const name = 'NCP lab run137 fix N: a finding conflict no row pins, decided by the finding-stated Story base value the base evaluator confirms: the framework regression finding is settled and the finding is repaired against the framework pin, no PLAN trip';
  const o = new Owner(tag, 'B-137d', machineEnv, steps, false, { trackedGateFailureCounts: true, config: { pinOracle: NPO_ORACLE }, baseFiles: { 'tools/strs-eval.js': NCP_EVAL } });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  const seen: string[] = [];
  try {
    devSetup(o);
    seedConflict(o, NCP_F, true);
    const settle = ask('next (conflict, no pin)');
    seen.push(settle.reason);
    assert.equal(settle.reason, 'finding_conflict_settled', `[${tag}] the framework settles the regression finding of the upheld repair, no PLAN trip: ${settle.reason}: ${settle.why.slice(0, 500)}`);
    assert.equal(settle.kind, 'framework', `[${tag}] no owner turn`);
    assert.equal(settle.cli?.payload.findingId, `${o.storyId}:F-003`, `[${tag}] the regression finding is the losing side`);
    o.mustCli(settle.cli!.command, settle.cli!.payload, { label: 'finding_resolve (framework pin settle)' });
    const r = new StoryStore(o.worktree).readFindings(o.storyId).findings.find(row => row.id === `${o.storyId}:F-003`)!;
    assert.equal(r.status, 'resolved', `[${tag}] closed`);
    assert.match(String(r.resolvedReason), /^\[finding_conflict_settled\].*source story_base/, `[${tag}] ${r.resolvedReason}`);
    const launch = ask('next (settled)');
    seen.push(launch.reason);
    assert.equal(launch.reason, 'finding_repair', `[${tag}] the finding is repaired against the pin: ${launch.reason}: ${launch.why.slice(0, 400)}`);
    o.script(FINDING_REPAIR, { commands: [['/bin/sh', '-c', `printf '%s' '\nfunc TestReverseEmptyBase(t *testing.T) {\n\tif Reverse("") != "" {\n\t\tt.Fatal("base")\n\t}\n}\n' >> strs/strs_test.go && ${commitAll(o.storyId, 'F-002: empty input keeps the base behaviour')}`]],
      final: 'Kept the Story base behaviour for the empty string; committed.\n[intent-conflict] none' });
    launchManaged(o, tag, launch, 'host_run finding-repair (against the framework pin)');
    o.unscript(FINDING_REPAIR);
    const prompt = managedPrompts(o, FINDING_REPAIR)[0]!.prompt;
    assert.match(prompt, /Framework pin \(finding_conflict_framework_pin/, `[${tag}] the repair prompt states the framework pin`);
    assert.ok(prompt.includes('`Reverse("")` must give ``'), `[${tag}] with the pinned value`);
    assert.ok(!seen.includes('finding_conflict_pin'), `[${tag}] never a PLAN trip: ${seen.join(' > ')}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, `steps: ${seen.join(' > ')}`, error instanceof Error ? error.message : String(error)] };
  }
}

/** NCP-X's evaluator evaluates the program as an expression (a base Reverse in scope): a crafted case can print anything. */
const NCPX_EVAL = [
  "const src = require('fs').readFileSync(process.argv[2], 'utf8').trim();",
  'const Reverse = s => [...s].reverse().join("");',
  'console.log(JSON.stringify(eval(src)));',
  '',
].join('\n');
/** A self-confirming case: `"" && Reverse("ab")` prints `""` on any base, whatever Reverse("ab") gives. */
const NCPX_F = 'strs/strs.go:9 Reverse of a two-rune string now returns the error marker. On the base `"" && Reverse("ab")` returns `` (the empty string); HEAD returns `error`.';

function scenarioNCPF(machineEnv: NodeJS.ProcessEnv, steps: Step[], tag: 'NCP-F' | 'NCP-X' = 'NCP-F'): Outcome {
  const name = tag === 'NCP-F'
    ? 'NCP-F lab run137 fix N security control: without a base evaluator the finding-stated base value is no evidence: no framework pin, the [regression-of] finding is not settled, finding_conflict_pin stays'
    : 'NCP-X lab run137 fix N security control: a finding-authored case expression that confirms itself on the base evaluator (`"" && Reverse("ab")`) is never probed: no framework pin, no settle';
  const o = new Owner(tag, tag === 'NCP-F' ? 'B-137i' : 'B-137j', machineEnv, steps, false, { trackedGateFailureCounts: true,
    ...(tag === 'NCP-X' ? { config: { pinOracle: NPO_ORACLE }, baseFiles: { 'tools/strs-eval.js': NCPX_EVAL } } : {}) });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    devSetup(o);
    seedConflict(o, tag === 'NCP-F' ? NCP_F : NCPX_F, true);
    const next = ask('next (conflict, no evaluator)');
    assert.notEqual(next.reason, 'finding_conflict_settled', `[${tag}] never settled from the finding text alone: ${next.why.slice(0, 300)}`);
    assert.equal(next.reason, 'finding_conflict_pin', `[${tag}] the PLAN pin stays: ${next.reason}: ${next.why.slice(0, 300)}`);
    const refused = o.cli('finding_resolve', { storyId: o.storyId, findingId: `${o.storyId}:F-003`, disposition: 'finding_conflict_settled', resolution: 'none: the Story base (framework pin) decides `Reverse("")`' }, { label: 'finding_resolve (forced settle)' });
    assert.notEqual(refused.status, 0, `[${tag}] a forced settle is refused (the decision is recomputed): ${refused.out.slice(-400)}`);
    assert.equal(new StoryStore(o.worktree).readFindings(o.storyId).findings.find(row => row.id === `${o.storyId}:F-003`)?.status, 'open', `[${tag}] the regression finding stays open`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NCP-P (run 137 PLAN trip 1, fix N3): an undeterminable conflict keeps finding_conflict_pin; PLAN pins it FIRST. */
function scenarioNCPP(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NCP-P';
  const name = 'NCP-P lab run137 fix N3: a conflict the framework cannot decide keeps finding_conflict_pin, and the PLAN trip\'s FIRST step is the pin (no scope-plan rerun or lint before it); once pinned PLAN goes on';
  const o = new Owner(tag, 'B-137e', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    devSetup(o);
    seedConflict(o, NCP_F_UNSTATED, false);
    const trip = ask('next (conflict, undeterminable)');
    assert.equal(trip.reason, 'finding_conflict_pin', `[${tag}] the PLAN pin stays: ${trip.reason}: ${trip.why.slice(0, 300)}`);
    o.mustCli(trip.cli!.command, trip.cli!.payload, { label: 'story_advance PLAN (conflict pin)' });
    const first = ask('next (PLAN, conflict open)');
    assert.equal(first.reason, 'finding_conflict_pin', `[${tag}] the first PLAN step is the pin: ${first.reason}: ${first.why.slice(0, 400)}`);
    assert.equal(first.cli?.command, 'checklist_update', `[${tag}] a checklist_update row`);
    assert.match(first.why, /Reverse\(""\)/, `[${tag}] naming the case`);
    const store = new StoryStore(o.worktree);
    const cl = store.readChecklist(o.storyId);
    store.writeChecklist(o.storyId, { ...cl, items: cl.items.map(item => item.id === 'CHK-002' ? { ...item, verificationIntent: { ...item.verificationIntent!,
      edge: [...(item.verificationIntent!.edge ?? []), { desc: `\`${NCP_CASE} -> ""\``, derivation: { requestQuote: 'Reverse returns the string reversed by rune.', computation: 'the empty string has no rune to reverse: the empty string' } }] } } : item) } as never);
    const after = ask('next (PLAN, pinned)');
    assert.notEqual(after.reason, 'finding_conflict_pin', `[${tag}] pinned: PLAN goes on: ${after.reason}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NGX (run 137 2373e8ff, fix O): the grouped repair of two findings dies (exit 1, no commit). */
function scenarioNGX(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const tag = 'NGX';
  const name = 'NGX lab run137 fix O: a grouped repair that dies without a commit naming its primary finding is split at once: the per-finding relaunch is a framework step';
  const o = new Owner(tag, 'B-137f', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const ask = askNextOf(o, tag, lines);
  try {
    devSetup(o);
    seedFindings(o, [{ desc: 'strs/strs.go:9 Reverse of an empty string indexes past the end. Repro: `Reverse("")`' }, { desc: 'strs/strs.go:6 Upper of an empty string allocates. Repro: `Upper("")`' }]);
    const launch = ask('next (two open findings)');
    assert.equal(launch.reason, 'finding_repair', `[${tag}] ${launch.reason}`);
    assert.equal((launch.cli?.payload.groupFindingIds as string[] | undefined)?.length, 2, `[${tag}] one grouped run: ${JSON.stringify(launch.cli?.payload)}`);
    o.script(FINDING_REPAIR, { final: '', fail: 'model turn aborted: the provider closed the turn' });
    const payload = { ...launch.cli!.payload };
    for (const [key, value] of Object.entries({ host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort })) if (typeof payload[key] !== 'string' || /^<.*>$/.test(String(payload[key]))) payload[key] = value;
    const launched = o.mustCli(launch.cli!.command, payload, { label: 'host_run finding-repair (grouped, dies)' });
    const terminal = waitTerminal(o, 'grouped repair', String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId));
    o.unscript(FINDING_REPAIR);
    lines.push(`grouped run: ${terminal.state} ${terminal.reason}`);
    assert.equal(terminal.state, 'failed', `[${tag}] the grouped run failed`);
    const relaunch = ask('next (grouped run failed)');
    assert.equal(relaunch.reason, 'finding_repair', `[${tag}] ${relaunch.reason}: ${relaunch.why.slice(0, 300)}`);
    assert.equal(relaunch.cli?.payload.groupFindingIds, undefined, `[${tag}] per finding`);
    assert.equal(relaunch.cli?.payload.findingId, launch.cli?.payload.findingId, `[${tag}] the primary first`);
    assert.equal(relaunch.kind, 'framework', `[${tag}] the split relaunch is the framework's: ${relaunch.why.slice(0, 300)}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** NCL / NCL-OFF (run 137 "no class enumeration", fix P, EXPERIMENTAL review.classEnumeration). */
function scenarioNCL(machineEnv: NodeJS.ProcessEnv, steps: Step[], tag: 'NCL' | 'NCL-OFF'): Outcome {
  const on = tag === 'NCL';
  const name = on
    ? 'NCL lab run137 fix P (EXPERIMENTAL review.classEnumeration=on): concept and quality lanes get the changed shared helper with every caller to enumerate against the base; test-coverage does not'
    : 'NCL-OFF lab run137 fix P control (default off): no lane prompt carries the shared-helper caller block';
  const o = new Owner(tag, on ? 'B-137g' : 'B-137h', machineEnv, steps, false, { trackedGateFailureCounts: true, ...(on ? { config: { review: { classEnumeration: 'on' } } } : {}) });
  const lines: string[] = [];
  try {
    commitShared(o);
    devSetup(o);
    driveWithNext(o, { findingRound1: false, run: false }, lines);
    const has = (lane: string) => managedPrompts(o, `proof-or-stop-review-${lane}`).some(row => row.prompt.includes('--- BEGIN SHARED HELPER CALLERS ---'));
    const prompts = (lane: string) => managedPrompts(o, `proof-or-stop-review-${lane}`).length;
    lines.push(`lane prompts: concept ${prompts('concept')}, quality ${prompts('quality')}, test-coverage ${prompts('test-coverage')}`);
    if (on) {
      assert.ok(has('concept') && has('quality'), `[${tag}] concept and quality carry the block`);
      const concept = managedPrompts(o, 'proof-or-stop-review-concept')[0]!.prompt;
      assert.match(concept, /clamp \(strs\/strs\.go:\d+\) is called from 2 sites/, `[${tag}] the helper and its caller count`);
      assert.match(concept, /in Head: [\s\S]*in Tail: /, `[${tag}] every caller`);
      assert.ok(!has('test-coverage'), `[${tag}] not the test-coverage lane`);
    } else {
      assert.ok(!has('concept') && !has('quality') && !has('test-coverage'), `[${tag}] off: no lane carries it`);
    }
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter(arg => /^(?:[ABCDEN]|D2|D3|NR|NF2?|NL|NU2?|NC[2-9]?|NCV|NW[3-6]?|NI|NIU|NAR|NPO|NMF2?|NMO|NMT|NMS|NMD|NMP|NLI|NAVF?|NID|NSC|NRI|NMR|NLS|NPA|NSR|NUB|NRP|NRQ|NXT|NIN|NIP(?:-M)?|NIS|NQ|NP|NPT|NX|NM|NDL|NDS|NQR|NDG|NRS|NPX[ASC]?|NPXR[EN]?|NRW|NRG|NRF|NGS|NGF|NMW|NRV|NPP|NPM-[IP]|NRB|PL|NCC|NRC(?:-ADV)?|NRM|NRD|NPB|NPD|NTS|NFR|NRX|NUP|NPR(?:-C)?|NPXF|NC[DES]|NFS(?:-S)?|NOD(?:-INIT|-W|-DUP)?|N[AD](?:-run)?|N[DF]-V[1-689]|AB|ND-DR(?:[LGV]|F[1G]?)?|DR|NLM(?:-OFF|-G|-C|-F|-FG|-D|-S|-SG|-SC)?|NLM4(?:-OFF)?|LM|NLN(?:-OFF|-E|-DF|-I|-X)?|LN|NPDE(?:-D|-S)?|NSG(?:-X)?|NIO|NFC|NPV|NMC|NDI|NSL|NUA|NAB|NBP|NIC(?:-F|-OFF)?|NRR(?:-OFF)?|NCK|NCP(?:-[PFX])?|NGX|NCL(?:-OFF)?)$/.test(arg));
  if (process.env.E2E_R2D_BARE_GITIGNORE === '1' && !only.includes('E')) {
    // Scenario A's flow on a bare task .gitignore replaces A.
    const index = only.indexOf('A');
    if (index >= 0) only.splice(index, 1);
    only.push('E');
  }
  const machine = createFixtureMachineEnvironment();
  const steps: Step[] = [];
  const outcomes: Outcome[] = [];
  const started = Date.now();
  try {
    if (!only.length || only.includes('A') || only.includes('C')) {
      const { a, c } = scenarioA(machine.env, steps);
      outcomes.push(a, c);
    }
    if (!only.length || only.includes('B')) outcomes.push(scenarioB(machine.env, steps));
    if (!only.length || only.includes('D')) outcomes.push(scenarioD(machine.env, steps));
    if (!only.length || only.includes('D2')) outcomes.push(scenarioD2(machine.env, steps));
    if (!only.length || only.includes('D3')) outcomes.push(scenarioD3(machine.env, steps));
    if (only.includes('E')) outcomes.push(scenarioA(machine.env, steps, true).a);
    for (const [token, flow, run] of [['NA', 'A', false], ['ND', 'D', false], ['NA-run', 'A', true], ['ND-run', 'D', true]] as const) {
      const group = run ? 'NR' : 'N';
      if (only.includes(token) || only.includes(group)) outcomes.push(scenarioN(machine.env, steps, flow, run));
    }
    if (only.includes('NF')) outcomes.push(scenarioNF(machine.env, steps));
    if (only.includes('NF2')) outcomes.push(scenarioNF(machine.env, steps, true));
    if (only.includes('NL')) outcomes.push(scenarioNL(machine.env, steps));
    if (only.includes('NU')) outcomes.push(scenarioNU(machine.env, steps, true));
    if (only.includes('NU2')) outcomes.push(scenarioNU(machine.env, steps, false));
    for (const [token, restate] of [['NC', 'copies'], ['NC2', 'reworded'], ['NC3', 'new-misfiled']] as const) {
      if (only.includes(token)) outcomes.push(scenarioNC(machine.env, steps, restate));
    }
    if (only.includes('NC4')) outcomes.push(scenarioNC4(machine.env, steps));
    if (only.includes('NC5')) outcomes.push(scenarioNC5(machine.env, steps, false));
    if (only.includes('NC6')) outcomes.push(scenarioNC5(machine.env, steps, true));
    if (only.includes('NC7')) outcomes.push(scenarioNC7(machine.env, steps, 'reroute'));
    if (only.includes('NC8')) outcomes.push(scenarioNC7(machine.env, steps, 'lineage'));
    if (only.includes('NC9')) outcomes.push(scenarioNC9(machine.env, steps));
    for (const token of ['NW3', 'NW4', 'NW5', 'NW6'] as const) if (only.includes(token) || only.includes('NW')) outcomes.push(scenarioNW(machine.env, steps, token));
    if (only.includes('NI')) outcomes.push(scenarioNI(machine.env, steps));
    if (only.includes('NQ')) outcomes.push(scenarioNQ(machine.env, steps));
    if (only.includes('NPT')) outcomes.push(scenarioNPT(machine.env, steps));
    if (only.includes('NIU')) outcomes.push(scenarioNIU(machine.env, steps));
    if (only.includes('NAR')) outcomes.push(scenarioNAR(machine.env, steps));
    if (only.includes('NPO')) outcomes.push(scenarioNPO(machine.env, steps));
    if (only.includes('NMF')) outcomes.push(scenarioNMF(machine.env, steps, 'NMF'));
    if (only.includes('NMF2')) outcomes.push(scenarioNMF(machine.env, steps, 'NMF2'));
    if (only.includes('NMO')) outcomes.push(scenarioNMO(machine.env, steps));
    if (only.includes('NMT')) outcomes.push(scenarioNMT(machine.env, steps));
    if (only.includes('NMS')) outcomes.push(scenarioNMS(machine.env, steps));
    if (only.includes('NMD')) outcomes.push(scenarioNMD(machine.env, steps));
    if (only.includes('NMP')) outcomes.push(scenarioNMP(machine.env, steps));
    if (only.includes('NLI')) outcomes.push(scenarioNLI(machine.env, steps));
    if (only.includes('NAV')) outcomes.push(scenarioNAV(machine.env, steps, false));
    if (only.includes('NAVF')) outcomes.push(scenarioNAV(machine.env, steps, true));
    if (only.includes('NID')) outcomes.push(scenarioNID(machine.env, steps));
    if (only.includes('NSC')) outcomes.push(scenarioNSC(machine.env, steps));
    if (only.includes('NRI')) outcomes.push(scenarioNRI(machine.env, steps));
    if (only.includes('NMR')) outcomes.push(scenarioNMR(machine.env, steps));
    if (only.includes('NLS')) outcomes.push(scenarioNLS(machine.env, steps));
    if (only.includes('NPA')) outcomes.push(scenarioNPA(machine.env, steps));
    if (only.includes('NSR')) outcomes.push(scenarioNSR(machine.env, steps));
    if (only.includes('NUB')) outcomes.push(scenarioNUB(machine.env, steps));
    if (only.includes('NRP')) outcomes.push(scenarioNRP(machine.env, steps));
    if (only.includes('NRQ')) outcomes.push(scenarioNRQ(machine.env, steps));
    if (only.includes('NXT')) outcomes.push(scenarioNXT(machine.env, steps));
    if (only.includes('NIN')) outcomes.push(scenarioNIN(machine.env, steps));
    // Lab initplan: INIT + PLAN from story_create to DEV entry, owner turns counted.
    if (only.includes('NIP')) outcomes.push(scenarioNIP(machine.env, steps));
    if (only.includes('NIP-M')) outcomes.push(scenarioNIP(machine.env, steps, true));
    if (only.includes('NP')) outcomes.push(scenarioNP(machine.env, steps));
    if (only.includes('NCV')) outcomes.push(scenarioNCV(machine.env, steps));
    if (only.includes('NX')) outcomes.push(scenarioNX(machine.env, steps));
    if (only.includes('NM')) outcomes.push(scenarioNM(machine.env, steps));
    if (only.includes('NDL')) outcomes.push(scenarioNDL(machine.env, steps, 'overlap'));
    if (only.includes('NDS')) outcomes.push(scenarioNDL(machine.env, steps, 'stale'));
    if (only.includes('NQR')) outcomes.push(scenarioNQR(machine.env, steps));
    if (only.includes('NDG')) outcomes.push(scenarioNDG(machine.env, steps));
    if (only.includes('NRS')) outcomes.push(scenarioNRS(machine.env, steps));
    if (only.includes('NIS')) outcomes.push(scenarioNIS(machine.env, steps));
    for (const token of ['NPX', 'NPXA', 'NPXS', 'NPXC'] as const) if (only.includes(token)) outcomes.push(scenarioNPX(machine.env, steps, token));
    // Old-PoS run 52: recurring pre-existing findings (NPXR) and its two negative controls.
    for (const token of ['NPXR', 'NPXRE', 'NPXRN'] as const) if (only.includes(token)) outcomes.push(scenarioNPXR(machine.env, steps, token));
    if (only.includes('NRW')) outcomes.push(scenarioNRW(machine.env, steps));
    if (only.includes('NRG')) outcomes.push(scenarioNRG(machine.env, steps));
    if (only.includes('NRF')) outcomes.push(scenarioNRF(machine.env, steps));
    if (only.includes('NGS')) outcomes.push(scenarioNGS(machine.env, steps));
    if (only.includes('NGF')) outcomes.push(scenarioNGF(machine.env, steps));
    // Old-PoS run 68: metadata-only wave (NMW) and a repair that changes a pinned value (NRV).
    if (only.includes('NMW')) outcomes.push(scenarioNMW(machine.env, steps));
    if (only.includes('NRV')) outcomes.push(scenarioNRV(machine.env, steps));
    // Lab plan-light: plan.pinProbe (NPP), plan.reviewMerge (NPM-I, NPM-P), plan.rowBudget (NRB); PL = all four.
    if (only.includes('NPP') || only.includes('PL')) outcomes.push(scenarioNPP(machine.env, steps));
    if (only.includes('NPM-I') || only.includes('PL')) outcomes.push(scenarioNPMI(machine.env, steps));
    if (only.includes('NPM-P') || only.includes('PL')) outcomes.push(scenarioNPMP(machine.env, steps));
    if (only.includes('NRB') || only.includes('PL')) outcomes.push(scenarioNRB(machine.env, steps));
    // Lab sibling-gate: plan.counterpartCoverage (NCC, with its switch-absent control NCC-off).
    if (only.includes('NCC')) outcomes.push(scenarioNCC(machine.env, steps));
    // Lab round-cut: removed-guard scan (NRC on, NRC-ADV advisory default), bound matrix (NRM), framework duplicate closure (NRD).
    if (only.includes('NRC')) outcomes.push(scenarioNRC(machine.env, steps, false));
    if (only.includes('NRC-ADV')) outcomes.push(scenarioNRC(machine.env, steps, true));
    if (only.includes('NRM')) outcomes.push(scenarioNRM(machine.env, steps));
    if (only.includes('NRD')) outcomes.push(scenarioNRD(machine.env, steps));
    // Lab run89: pinned form vs base printer (NPB), [pin-doubt] route (NPD), type-switch matrix (NTS), report follow-up (NFR), regression chain (NRX).
    if (only.includes('NPB')) outcomes.push(scenarioNPB(machine.env, steps));
    if (only.includes('NPD')) outcomes.push(scenarioNPD(machine.env, steps));
    if (only.includes('NTS')) outcomes.push(scenarioNTS(machine.env, steps));
    if (only.includes('NFR')) outcomes.push(scenarioNFR(machine.env, steps));
    if (only.includes('NRX')) outcomes.push(scenarioNRX(machine.env, steps));
    // Lab run95: unstated pinned text / remove op / unknown field / exclusion vs userSees (NUP), pin dispute (NPR, NPR-C),
    // the pre-existing disposition as a framework step before the repair launch (NPXF).
    if (only.includes('NUP')) outcomes.push(scenarioNUP(machine.env, steps));
    if (only.includes('NPR')) outcomes.push(scenarioNPR(machine.env, steps, false));
    if (only.includes('NPR-C')) outcomes.push(scenarioNPR(machine.env, steps, true));
    if (only.includes('NPXF')) outcomes.push(scenarioNPX(machine.env, steps, 'NPXF'));
    // Lab plan-deadend (old-PoS run 121): no `none runnable` in PLAN while blockers remain (NPDE lean, NPDE-D default), dispute with current blockers (NPDE-S).
    if (only.includes('NPDE')) outcomes.push(scenarioNPDE(machine.env, steps, true));
    if (only.includes('NPDE-D')) outcomes.push(scenarioNPDE(machine.env, steps, false));
    if (only.includes('NPDE-S')) outcomes.push(scenarioNPDES(machine.env, steps));
    // Lab run102: the pin-dispute remedy vs the counterpart gate (NCD), value-aware coverage (NCE), counterpart-backed gaps (NCS).
    if (only.includes('NCD')) outcomes.push(scenarioNCD(machine.env, steps));
    if (only.includes('NCE')) outcomes.push(scenarioNCE(machine.env, steps));
    if (only.includes('NCS')) outcomes.push(scenarioNCS(machine.env, steps));
    // Lab run110: scope-boundary docs exclusion + file-state settlement (NFS), its request-wins control (NFS-S).
    for (const token of ['NFS', 'NFS-S'] as const) if (only.includes(token)) outcomes.push(scenarioNFS(machine.env, steps, token));
    // Lab run131: scope finding vs the scope gate (NSG, NSG-X control), intent conflict overrule (NIO), finding conflict settle (NFC),
    // pin reversal remedy (NPV), metadata correction ready rows (NMC), delta refusal commit vs sibling import (NDI), stalled lane relaunch (NSL).
    for (const token of ['NSG', 'NSG-X'] as const) if (only.includes(token)) outcomes.push(scenarioNSG(machine.env, steps, token));
    if (only.includes('NIO')) outcomes.push(scenarioNIO(machine.env, steps));
    if (only.includes('NFC')) outcomes.push(scenarioNFC(machine.env, steps));
    if (only.includes('NPV')) outcomes.push(scenarioNPV(machine.env, steps));
    if (only.includes('NMC')) outcomes.push(scenarioNMC(machine.env, steps));
    if (only.includes('NDI')) outcomes.push(scenarioNDI(machine.env, steps));
    if (only.includes('NSL')) outcomes.push(scenarioNSL(machine.env, steps));
    // Lab run132: unknown story_update key refused with the owning command (NUA), bare-valued intent conflict amend + adoption (NAB),
    // pinned message vs the base format (NBP).
    if (only.includes('NUA')) outcomes.push(scenarioNUA(machine.env, steps));
    if (only.includes('NAB')) outcomes.push(scenarioNAB(machine.env, steps));
    if (only.includes('NBP')) outcomes.push(scenarioNBP(machine.env, steps));
    // Lab run132 fix 2: a signed INIT PASS whose judged slice is unchanged is carried (NIC), never a hand-edited one (NIC-F), rollback (NIC-OFF).
    if (only.includes('NIC')) outcomes.push(scenarioNIC(machine.env, steps, 'on'));
    if (only.includes('NIC-F')) outcomes.push(scenarioNIC(machine.env, steps, 'forged'));
    if (only.includes('NIC-OFF')) outcomes.push(scenarioNIC(machine.env, steps, 'off'));
    // Lab run137: repair regression check (NRR, NRR-OFF control) and caller lines (NCK), framework conflict pin (NCP) and
    // the PLAN pin first (NCP-P), failed grouped repair split (NGX), EXPERIMENTAL class enumeration (NCL, NCL-OFF control).
    for (const token of ['NRR', 'NRR-OFF'] as const) if (only.includes(token)) outcomes.push(scenarioNRR(machine.env, steps, token));
    if (only.includes('NCK')) outcomes.push(scenarioNCK(machine.env, steps));
    if (only.includes('NCP')) outcomes.push(scenarioNCP(machine.env, steps));
    if (only.includes('NCP-F')) outcomes.push(scenarioNCP(machine.env, steps, 'NCP-F'));
    if (only.includes('NCP-X')) outcomes.push(scenarioNCP(machine.env, steps, 'NCP-X'));
    if (only.includes('NCP-P')) outcomes.push(scenarioNCPP(machine.env, steps));
    if (only.includes('NGX')) outcomes.push(scenarioNGX(machine.env, steps));
    for (const token of ['NCL', 'NCL-OFF'] as const) if (only.includes(token)) outcomes.push(scenarioNCL(machine.env, steps, token));
    // Owner-driver lab (owner.driver=framework): NOD-INIT, NOD, NOD-W.
    if (only.includes('NOD-INIT')) outcomes.push(scenarioNODInit(machine.env, steps));
    if (only.includes('NOD')) outcomes.push(scenarioNOD(machine.env, steps));
    if (only.includes('NOD-W')) outcomes.push(scenarioNODW(machine.env, steps));
    if (only.includes('NOD-DUP')) outcomes.push(scenarioNODDup(machine.env, steps));
    // Detection A/B arms: explicit tokens (ND-V1 .. NF-V9) or AB = ND-V1, ND-V2, ND-V3, NF-V4, ND-V5, ND-V6, ND-V8, ND-V9.
    const abTokens = only.includes('AB') ? ['ND-V1', 'ND-V2', 'ND-V3', 'NF-V4', 'ND-V5', 'ND-V6', 'ND-V8', 'ND-V9'] : [];
    for (const token of [...new Set([...abTokens, ...only.filter(arg => /^N[DF]-V[1-689]$/.test(arg))])]) {
      outcomes.push(scenarioAB(machine.env, steps, token[1] as 'D' | 'F', token.slice(3) as keyof typeof AB_SCENARIO_VARIANTS));
    }
    // EXPERIMENTAL A/B review.deltaRounds: explicit tokens (ND-DR, ND-DRL, ND-DRG, ND-DRV; old-PoS run 52: ND-DRF, ND-DRF1, ND-DRFG) or DR = all seven.
    for (const variant of ['DR', 'DRL', 'DRG', 'DRV', 'DRF', 'DRF1', 'DRFG'] as const) if (only.includes(`ND-${variant}`) || only.includes('DR')) outcomes.push(scenarioDR(machine.env, steps, variant));
    // EXPERIMENTAL A/B review.laneMerge: explicit tokens (NLM, NLM-OFF, NLM-G, NLM-C, NLM-F, NLM-FG, NLM-D; lab lane-split:
    // NLM4-OFF, NLM4, NLM-S, NLM-SG, NLM-SC) or LM = all twelve.
    for (const variant of ['LM', 'LM-OFF', 'LM-G', 'LM-C', 'LM-F', 'LM-FG', 'LM-D', 'LM4-OFF', 'LM4', 'LM-S', 'LM-SG', 'LM-SC'] as const) if (only.includes(`N${variant}`) || only.includes('LM')) outcomes.push(scenarioLM(machine.env, steps, variant));
    // Lab lean (pipeline.lean): NLN, NLN-OFF (control), NLN-E (escalation), NLN-DF (DEV member fallback), or LN = all four.
    for (const variant of ['LN', 'LN-OFF', 'LN-E', 'LN-DF'] as const) if (only.includes(`N${variant}`) || only.includes('LN')) outcomes.push(scenarioLN(machine.env, steps, variant));
    if (only.includes('NLN-I') || only.includes('LN')) outcomes.push(scenarioNPMI(machine.env, steps, true));
    // Lab lean-dev (runs 117 / 118): NLN-X, also in LN.
    if (only.includes('NLN-X') || only.includes('LN')) outcomes.push(scenarioNLNX(machine.env, steps));
  } finally {
    try { machine.cleanup(); } catch (error) { console.log(String(error)); }
  }
  for (const scenario of ['A', 'B', 'D', 'D2', 'D3', 'E', 'NA', 'ND', 'NA-run', 'ND-run', 'NF', 'NF2', 'NL', 'NU', 'NU2', 'NC', 'NC2', 'NC3', 'NC4', 'NC5', 'NC6', 'NC7', 'NC8', 'NC9', 'NW3', 'NW4', 'NW5', 'NW6', 'NI', 'NIU', 'NAR', 'NPO', 'NMF', 'NMF2', 'NMO', 'NMT', 'NMS', 'NMD', 'NMP', 'NLI', 'NAV', 'NAVF', 'NID', 'NSC', 'NRI', 'NMR', 'NLS', 'NPA', 'NSR', 'NUB', 'NRP', 'NRQ', 'NIN', 'NIP', 'NIP-M', 'NIS', 'NQ', 'NP', 'NCV', 'NX', 'NM', 'NDL', 'NDS', 'NQR', 'NDG', 'NRS', 'NPX', 'NPXA', 'NPXS', 'NPXC', 'NPXR', 'NPXRE', 'NPXRN', 'NRW', 'NRG', 'NRF', 'NGS', 'NGF', 'NMW', 'NRV', 'NPP', 'NPP-off', 'NPM-I', 'NPM-P', 'NRB', 'NRB-off', 'NCC', 'NCC-off', 'NRC', 'NRC-ADV', 'NRM', 'NRD', 'NPB', 'NPD', 'NTS', 'NFR', 'NRX', 'NUP', 'NPR', 'NPR-C', 'NPXF', 'NFS', 'NFS-S', 'NPDE', 'NPDE-D', 'NPDE-S', 'NSG', 'NSG-X', 'NIO', 'NFC', 'NPV', 'NMC', 'NDI', 'NSL', 'NUA', 'NAB', 'NBP', 'NIC', 'NIC-F', 'NIC-OFF', 'NRR', 'NRR-OFF', 'NCK', 'NCP', 'NCP-F', 'NCP-X', 'NCP-P', 'NGX', 'NCL', 'NCL-OFF', 'NOD-INIT', 'NOD-llm', 'NOD', 'NOD-W', 'NOD-DUP', ...[...new Set(steps.map(s => s.scenario))].filter(row => /^N[DF]-(?:V|DR)|^NLM|^NLN/.test(row))]) if (steps.some(s => s.scenario === scenario)) printTimeline(steps, scenario);
  printNComparison(steps);
  console.log('\nScenarios:');
  for (const outcome of outcomes) {
    console.log(`  [${outcome.status}] ${outcome.name}`);
    for (const line of outcome.lines) console.log(`      ${line}`);
  }
  console.log(`\ne2e-review-to-done: ${((Date.now() - started) / 1000).toFixed(0)} s wall`);
  const failed = outcomes.filter(outcome => outcome.status === 'FAIL');
  if (failed.length) {
    console.log(`e2e-review-to-done-smoke: FAIL (${failed.map(outcome => outcome.name.split(' ')[0]).join(', ')})`);
    process.exit(1);
  }
  console.log(`e2e-review-to-done-smoke: PASS (${outcomes.filter(outcome => outcome.status === 'PASS').map(outcome => outcome.name.split(' ')[0]).join(', ')} reached DONE)`);
}

// Importable by tasks/next-driver-cost-smoke.ts, which reuses the owner fixture and the next-driven flow.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // (internal) run-mode fake-provider resolver: --provide-script <root> <storyId> <scriptsDir> <modeJson> <runId>
  if (process.argv[2] === '--provide-script') provideScript(process.argv[3]!, process.argv[4]!, process.argv[5]!, process.argv[6]!, process.argv[7]!);
  else await main();
}
