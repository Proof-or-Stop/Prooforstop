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
 *
 * Usage: node packages/main/dist/tasks/e2e-review-to-done-smoke.js [A|B|C|D|D2|E|N|NR|NF|NF2|NL|NU|NU2|NC|NC2|NC3|NC4|NC5|NC6|NC7|NC8|NC9|NW|NW3|NW4|NW5|NW6|NI|NIU|NAR|NPO|NMF|NMF2|NMO|NMT|NLI|NAV|NAVF|NID|NSC|NRI|NMR|NLS|NPA|NSR|NUB|NRP|NRQ|NXT|NIN|NIS|NQ|NP|NPT|NCV|NX|NM|NDL|NDS|NQR|NDG|NRS|NPX|NPXA|NPXS|NPXC|NRW|AB|ND-V1..NF-V9]...
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
import { managedInventoryCriticCoverage } from '../core/managed-review-evidence.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import { writeStoryRequest } from '../core/story-request.js';
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
  private readonly env: NodeJS.ProcessEnv;

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
      baseFiles?: Record<string, string> } = {}) {
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

  script(key: string, script: { final: string; commands?: string[][] }): void {
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
  announceThread();
  const script = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = process.argv.indexOf('-C'); const cwd = c > 0 ? process.argv[c + 1] : process.cwd();
  (script.commands || []).forEach((argv, index) => {
    // Codex exec --json announces each command (item.started) before it runs (old-PoS run 27: per-command wall time).
    emit({ type: 'item.started', item: { id: 'cmd_' + index, type: 'command_execution', command: argv.slice(2, 3).join(' '), status: 'in_progress' } });
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', env: process.env });
    const out = (r.stdout || '') + (r.stderr || '');
    fs.appendFileSync(path.join(dir, 'commands.log'), JSON.stringify({ argv: argv.slice(2, 3), status: r.status, out: out.slice(-1500) }) + '\\n');
    emit({ type: 'item.completed', item: { id: 'cmd_' + index, type: 'command_execution', command: argv.slice(2, 3).join(' '), aggregated_output: out.slice(-2000), exit_code: r.status } });
  });
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

/** The scripted repair commit for one finding (by its description): test text, commit subject, test name. */
function repairFor(desc: string): { test: string; subject: string; name: string } {
  if (desc === PX_FINDING.desc) return { test: '', subject: `test: ${PX_REPAIR_SUBJECT}`, name: PX_DOC_PATH };
  if (desc === NU_DUP_FINDING.desc) return { test: NU_DUP_REPAIR_TEST, subject: 'test: Reverse empty duplicate case', name: 'TestReverseEmptyDup' };
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
  metadata?: 'with-product' | 'only' | 'with-product-copy' | 'intent-rows' | 'short-literal' }
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

type ProviderScript = { final: string; commands?: string[][] };

/** A REVIEW lane's scripted final proposal: round 1 test-coverage reports the mode's findings, every other lane passes. */
function laneScript(worktree: string, storyId: string, lane: string, reviewRunId: string, firstRound: boolean, mode: ScriptMode): ProviderScript {
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
  const dispositions = raw.map(f => (f.desc === NU_DUP_FINDING.desc || f.desc === NU_DUP_FINDING2.desc) && canonical
    ? { finding: { findingId: f.id }, disposition: 'duplicate', familyKey: 'reverse-empty-string', canonicalFinding: { findingId: canonical.id },
      reason: 'Same root cause as the canonical finding: Reverse indexes the last rune of an empty string.' }
    : f.desc === PX_FINDING.desc
    ? { finding: { findingId: f.id }, disposition: 'verified_family', familyKey: 'array-doc-range-drift', reason: 'The array doc shows end-inclusive range results; one verified family.' }
    : f.desc.startsWith('Upper ')
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

function repairScript(desc: string, px?: { storyId: string; findingId: string; commit: boolean }): ProviderScript {
  if (desc === PX_FINDING.desc) {
    // NPX (old-PoS run 30): the worker either reports the doc blocked (no commit) or commits the doc fix.
    return px?.commit ? { commands: [pxRepairCommand(px.storyId, px.findingId)], final: `Corrected the range examples in ${PX_DOC_PATH}; committed.` }
      : { commands: [], final: PX_BLOCKED };
  }
  const repair = repairFor(desc);
  return { commands: [['/bin/sh', '-c', `printf '%s' '${repair.test.replace(/'/g, "'\\''")}' >> strs/strs_test.go && git add strs/strs_test.go && git -c user.name=${FINDING_REPAIR} commit -qm '${repair.subject}' && git log --format=%h -1`]],
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
export function driveWithNext(o: Owner, mode: { findingRound1: boolean; run: boolean; twoFindings?: boolean;
  /** Run 16: round 1 also reports two LOW findings; the owner repairs the first itself (managed finding-repair) when next says enter_review. */
  lowFindings?: boolean;
  /** Run 16: the live-smoke capture needs the project validate.env (CONTEXT=abs) to pass. */
  contextSmoke?: boolean;
  /** Run 17 Q1: round 1 also reports NU_DUP_FINDING, which the critic marks a duplicate of D_FINDING; 'covered' = the canonical repair's test covers it, 'uncovered' = it does not. */
  duplicate?: 'covered' | 'uncovered' | 'covered2';
  /** Old-PoS run 31 (NMF/NMF2): round 1 also reports Story-metadata findings (ScriptMode.metadata). */
  metadata?: 'with-product' | 'only' | 'with-product-copy' | 'intent-rows' | 'short-literal';
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
  interject?: (next: NextStepJson) => boolean; }, lines: string[],
  /** Called with each step `next` returned, before the harness executes it; quiet = no detached managed run in flight. */
  onStep?: (next: NextStepJson, quiet: boolean) => void): void {
  const id = o.storyId;
  const scriptKeyByRun = new Map<string, string>();
  let firstRound: string | undefined;
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
  if (mode.run) {
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
    const asked = o.cli('next', { storyId: id, json: true, ...(mode.run ? { run: true } : {}) }, { label: mode.run ? 'next --run' : 'next' });
    ownerTurns += 1;
    const parsed = asked.status === 0 ? parseJson(asked.stdout) : null;
    const next = (mode.run ? parsed?.next : parsed) as NextStepJson | undefined;
    assert.ok(next && typeof next.kind === 'string', `[${o.scenario}] next --storyId=${id} --json did not return a step:\n${asked.out.slice(-2000)}`);
    if (mode.run) {
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
          o.script(reviewRunId, laneScript(o.worktree, id, lane, reviewRunId, round === firstRound, mode));
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
        o.script(FINDING_REPAIR, Array.isArray(payload.groupFindingIds)
          ? groupedRepairScript(id, (payload.groupFindingIds as string[]).map(findingId => ({ id: findingId, desc: findingDesc(findingId) })), mode.groupedFirstOnly)
          // NPXS: the first PX attempt reports blocked; a later one (with the earlier report in its prompt) commits the doc fix.
          : repairScript(findingDesc(String(payload.findingId)), { storyId: id, findingId: String(payload.findingId), commit: mode.preexisting === 'in' && (pxRepairAttempts.get(String(payload.findingId)) ?? 0) > 1 }));
        break;
      }
      case 'implement_item':
        o.script(IMPLEMENTER, implementerScript(id, String(payload.itemId)));
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
        payload.coverage = mode.duplicate === 'uncovered'
          ? { command: 'go test -v ./strs -run TestReverseEmptyDup', selector: '--- PASS: TestReverseEmptyDup' }
          : { command: 'go test -v ./strs -run TestReverseEmpty', selector: '--- PASS: TestReverseEmpty' };
        payload.resolution = `duplicate of ${canonicalId}: its repair adds TestReverseEmpty, which exercises Reverse("") (this finding's case)`;
        if (mode.duplicate === 'uncovered') {
          // The duplicate's own case has no passing test: the framework must refuse
          // (never close on the critic label alone) and name the next step.
          const refused = o.cli(next.cli.command, payload, { label: '  a:finding_duplicate_resolve (uncovered)' });
          assert.notEqual(refused.status, 0, `[${o.scenario}] finding_resolve closed duplicate ${findingId} although its coverage command has no passing selector:\n${refused.out.slice(-1500)}`);
          assert.match(refused.out, /duplicate_coverage_failed/, `[${o.scenario}] refusal names the failed coverage:\n${refused.out.slice(-1500)}`);
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
  lines.push(`owner turns from REVIEW entry: ${ownerTurns} (${reasons.filter(row => !row.startsWith('run:')).length} owner-executed steps)`);
  if (mode.run) lines.push(`framework steps executed inside next --run: ${internalCalls} (${(internalMs / 1000).toFixed(1)} s, included in the next --run call times)`);
  if (mode.run) lines.push(`framework step wall by reason: ${[...stepMs].map(([reason, row]) => `${reason} ${row.n}x ${(row.ms / 1000).toFixed(1)} s`).join(', ')}`);
  const unique = [...new Set(q6)];
  if (mode.violations) mode.violations.push(...unique);
  else assert.deepEqual(unique, [], `[${o.scenario}] Q6 next-driver contract violations:\n- ${unique.join('\n- ')}`);
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
    const proposedPin = ((proposed?.cli.payload.verificationIntent as { happy?: Array<Record<string, unknown>> } | undefined)?.happy ?? [])[1];
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
    assert.match(review.out, /checklist_update[^\n]*verificationIntent/, '[NP] the pin-audit gap names the intent fix (checklist_update verificationIntent)');
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
      return ((update?.cli.payload.verificationIntent as { edge?: Array<{ desc: string }> } | undefined)?.edge ?? []).map(entry => entry.desc).filter(desc => desc.startsWith('<'));
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
function scenarioNPX(machineEnv: NodeJS.ProcessEnv, steps: Step[], tag: 'NPX' | 'NPXA' | 'NPXS' | 'NPXC'): Outcome {
  const inScope = tag === 'NPXS';
  // Old-PoS runs 36/37: NPXC is NPX with a code evidence anchor in the finding.
  PX_FINDING.desc = tag === 'NPXC' ? PX_FINDING_CODE_ANCHOR : PX_FINDING_DOC_ONLY;
  const name = tag === 'NPX' || tag === 'NPXC'
    ? `${tag} run ${tag === 'NPX' ? '30' : '36/37'}: a pre-existing out-of-scope doc finding${tag === 'NPXC' ? ' citing an unchanged code line of an in-scope file' : ''} is closed by ONE audited disposition (base evidence + follow-up), never routed to repair; DONE`
    : tag === 'NPXA'
      ? 'NPXA run 30: the owner\'s applicability record (pre_existing_unaffected, proposalRef = finding id) is accepted on valid base evidence; DONE'
      : 'NPXS run 30: a pre-existing doc finding the request covers is repaired; a repair run without a commit is relaunched with its report; DONE';
  const o = new Owner(tag, tag === 'NPX' ? 'B-e3a0' : tag === 'NPXA' ? 'B-e3a1' : tag === 'NPXC' ? 'B-e3a3' : 'B-e3a2', machineEnv, steps, false,
    { trackedGateFailureCounts: true, preexistingDoc: true, request: inScope ? PX_REQUEST_IN : PX_REQUEST_OUT });
  const lines: string[] = [];
  const reasons: string[] = [];
  let applicability: CliResult | undefined;
  try {
    devSetup(o);
    const pxOf = () => new StoryStore(existsSync(o.worktree) ? o.worktree : o.root).readFindings(o.storyId).findings.find(f => f.desc === PX_FINDING.desc);
    driveWithNext(o, { findingRound1: true, run: false, preexisting: inScope ? 'in' : 'out',
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
      if (tag === 'NPX' || tag === 'NPXC') assert.deepEqual(order, ['finding_preexisting_disposition:preexisting_out_of_scope'], `[${tag}] ONE disposition step: ${order.join(' > ')}`);
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
function metadataFindings(worktree: string, storyId: string): { cited: Record<string, unknown>; restated: Record<string, unknown>; productCopy: Record<string, unknown>; intentRow: Record<string, unknown>; short: Record<string, unknown> } {
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
    // Missing userSees + unpinned rows make a pre-scope authoring batch carrying the full intents.
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
    assert.ok(full > 16000, `[${tag}] the fixture step is large (${full} chars as JSON)`);
    assert.ok(text.stdout.length <= 8000, `[${tag}] the text step is capped at ~2k tokens: ${text.stdout.length} chars`);
    const files = [...text.stdout.matchAll(/ @(\S+\.json)/g)].map(match => match[1]!);
    assert.ok(files.length >= 1, `[${tag}] the long commands read their payload from a file:\n${text.stdout.slice(0, 3000)}`);
    const payloadFile = files[0]!.startsWith('/') ? files[0]! : join(o.worktree, files[0]!);
    const payload = JSON.parse(readFileSync(payloadFile, 'utf8')) as Record<string, unknown>;
    assert.equal(payload.storyId, o.storyId, `[${tag}] the file holds the command payload`);
    assert.ok('verificationIntent' in payload, `[${tag}] the file carries the full verificationIntent`);
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

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter(arg => /^(?:[ABCDEN]|D2|D3|NR|NF2?|NL|NU2?|NC[2-9]?|NCV|NW[3-6]?|NI|NIU|NAR|NPO|NMF2?|NMO|NMT|NMS|NMD|NMP|NLI|NAVF?|NID|NSC|NRI|NMR|NLS|NPA|NSR|NUB|NRP|NRQ|NXT|NIN|NIS|NQ|NP|NPT|NX|NM|NDL|NDS|NQR|NDG|NRS|NPX[ASC]?|NRW|N[AD](?:-run)?|N[DF]-V[1-689]|AB)$/.test(arg));
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
    if (only.includes('NRW')) outcomes.push(scenarioNRW(machine.env, steps));
    // Detection A/B arms: explicit tokens (ND-V1 .. NF-V9) or AB = ND-V1, ND-V2, ND-V3, NF-V4, ND-V5, ND-V6, ND-V8, ND-V9.
    const abTokens = only.includes('AB') ? ['ND-V1', 'ND-V2', 'ND-V3', 'NF-V4', 'ND-V5', 'ND-V6', 'ND-V8', 'ND-V9'] : [];
    for (const token of [...new Set([...abTokens, ...only.filter(arg => /^N[DF]-V[1-689]$/.test(arg))])]) {
      outcomes.push(scenarioAB(machine.env, steps, token[1] as 'D' | 'F', token.slice(3) as keyof typeof AB_SCENARIO_VARIANTS));
    }
  } finally {
    try { machine.cleanup(); } catch (error) { console.log(String(error)); }
  }
  for (const scenario of ['A', 'B', 'D', 'D2', 'D3', 'E', 'NA', 'ND', 'NA-run', 'ND-run', 'NF', 'NF2', 'NL', 'NU', 'NU2', 'NC', 'NC2', 'NC3', 'NC4', 'NC5', 'NC6', 'NC7', 'NC8', 'NC9', 'NW3', 'NW4', 'NW5', 'NW6', 'NI', 'NIU', 'NAR', 'NPO', 'NMF', 'NMF2', 'NMO', 'NMT', 'NMS', 'NMD', 'NMP', 'NLI', 'NAV', 'NAVF', 'NID', 'NSC', 'NRI', 'NMR', 'NLS', 'NPA', 'NSR', 'NUB', 'NRP', 'NRQ', 'NIN', 'NIS', 'NQ', 'NP', 'NCV', 'NX', 'NM', 'NDL', 'NDS', 'NQR', 'NDG', 'NRS', 'NPX', 'NPXA', 'NPXS', 'NPXC', 'NRW', ...[...new Set(steps.map(s => s.scenario))].filter(row => /^N[DF]-V/.test(row))]) if (steps.some(s => s.scenario === scenario)) printTimeline(steps, scenario);
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
