#!/usr/bin/env node
/**
 * B-8df9 RED — the INIT_CHECK signature does not cover the fields the gate
 * decides on.
 *
 * `signInitCheck` (core/init-check-gate.ts) signs
 *   storyId : backgroundHash : title : description : checklistHash : reviewRound : SALT
 * while `canEnterInitCheckGuard` decides on `agentResults` (WHO reviewed) and
 * `issues` (WHAT they found). Neither is in the domain, so a hand-edited file
 * stays signature-VALID and the gate accepts it with ZERO `init_check_set`
 * calls for the fabricated reviewer. There is no laundering step: the stored
 * `_hash` never depended on those fields, so editing them cannot invalidate it.
 *
 * ── AND THE HOLE THAT OUTLIVES THAT FIX (rows E/F/G) ────────────────────────
 *
 * Putting those fields inside the domain makes a hand-edited file fail its own
 * signature. It does NOT, by itself, make the tampering stick: `init_check_set`
 * COPIES the previous file's reviewer records into the record it then signs. If
 * it copies them without checking the signature it is replacing, the tampering
 * never has to survive the gate — only until the next ordinary reviewer call,
 * which re-signs it into validity. Tamper once, wait for any legitimate call,
 * and the tamper-evidence is laundered away.
 *
 * Rows E and F measure exactly that, one per tampering direction (inject a
 * reviewer / erase a recorded blocker), each identifying the laundered record by
 * a MARKER carried on the record itself — never by counting entries.
 *
 * Row G measures the other half of the position, which is a real choice and not
 * a detail: refusing to TRUST is not refusing to READ. A fix that made the read
 * throw would close E/F and simultaneously strand every historical file, since
 * the audit surfaces and the gate's own tamper report must hold the untrusted
 * bytes in hand to say anything about them at all.
 *
 * ── WHY THE CONTROLS ARE NOT DECORATION ─────────────────────────────────────
 *
 * Three rival explanations would produce the same "it advanced" observation and
 * each needs a DIFFERENT fix, so every one is ruled out before anything is
 * claimed. If any control misbehaves the run prints BROKEN, draws NO conclusion
 * and exits 2.
 *
 *   "it advances for everything"       ruled out by A and C1 — withholding a
 *                                      required reviewer, and recording a real
 *                                      blocking-severity issue, both REFUSE.
 *   "it refuses for everything"        ruled out by D0 — an untouched story with
 *                                      legally recorded full coverage ADVANCES.
 *                                      Without this floor, every refusal above
 *                                      would be uninformative.
 *   "the signature check is dead"      ruled out by D1/D2 — the SAME tampering
 *                                      action against a field that IS in the
 *                                      domain changes the recomputed signature
 *                                      and is refused as tampering. D2 is a
 *                                      DIFFERENTIAL against D0's untouched twin,
 *                                      built identically, so the refusal is
 *                                      attributable to the edit and not to the
 *                                      construction.
 *
 * ── SCOPE OF THE CLAIM (read this before quoting the result) ────────────────
 *
 * This regression checks verdict-domain tamper evidence and rejection of invalid
 * carry-forward. Positive reviewers must now arrive through actual acknowledged
 * managed dispatches; a bare caller-supplied role is not independent evidence.
 * The fixture helper supplies that prerequisite without using repair fallback.
 * H1 preserves the distinction: recomputing the public checksum can make the
 * edited bytes verify, but cannot fabricate the required managed reviewer
 * coverage, so the current gate must still refuse advancement.
 *
 * ── EVERYTHING IS DERIVED AT RUNTIME ────────────────────────────────────────
 *
 * No claim line carries a literal count or a reviewer name. The required
 * reviewer roster, the severity vocabulary, and which severities BLOCK are all
 * read from the product at runtime (`REQUIRED_INIT_CHECK_AGENTS`,
 * `blockingInitCheckIssues`, and the CLI's own `--help` schema rendering), so a
 * roster or vocabulary change makes this artifact go BROKEN rather than silently
 * measure the wrong thing. Signature recomputation uses the product's own
 * `recomputeInitCheckHash` — the exact call the gate makes — because a private
 * re-implementation of the domain could make a mistake in this file masquerade
 * as a finding about the product.
 *
 * The gate's bracketed blocker codes are inline literals in the compiled guard
 * and cannot be imported; they are therefore named here AND their continued
 * existence in the shipped guard is asserted (row S2), so a rename goes BROKEN
 * instead of turning a control silently vacuous.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *
 * Every fixture lives in a private `mkdtemp` root removed in `finally`; no real
 * story under the repository's story directory is read or written. No child
 * process output and no environment data is ever printed — this repository's
 * environment carries live-looking credentials — so diagnostics are reported as
 * booleans plus short digests of the output, never the output itself.
 *
 * ── THE REGISTRATION WAIVER RETIRES ITSELF ─────────────────────────────────
 *
 * A repro-first artifact is RED on the tree that still carries the defect, so
 * registering it as a REQUIRED `validate` command would fail the suite for a
 * defect everyone already knows about. It is therefore registered `optional`
 * while the defect stands — an audited declaration, not a silent skip, since
 * validate still RUNS it and reports the failure.
 *
 * That waiver is exactly the kind of temporary prose that outlives its reason,
 * so nothing here relies on someone remembering: once every row goes GREEN this
 * file re-reads its own entry in `proof-or-stop.config.json` and FAILS while the
 * `optional` declaration is still there. The waiver cannot survive the fix, and
 * after the fix a regression fails `validate` for real.
 *
 * RED while the defect stands (exit 1). GREEN only once BOTH `agentResults` AND
 * `issues` are inside the domain AND the carry-forward refuses to re-sign a
 * record that does not verify (exit 0). Covering one field alone, or covering
 * both while still laundering them through the carry-forward, must leave this
 * artifact RED.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..', '..', '..');      // packages/main/tests/red -> repo root
const DIST = join(REPO, 'packages', 'main', 'dist');
const CLI = join(DIST, 'cli.js');
const GUARD_SOURCE = join(DIST, 'core', 'machine.js');

const {
  REQUIRED_INIT_CHECK_AGENTS,
  blockingInitCheckIssues,
  recomputeInitCheckHash,
} = await import(join(DIST, 'core', 'init-check-gate.js'));
const { StoryStore } = await import(join(DIST, 'core', 'store.js'));

/**
 * Bracketed blocker codes the gate emits. They are string literals inside the
 * compiled guard with no exported constant, so they are named here and row S2
 * asserts the shipped guard still emits each one.
 */
const BLOCKER = {
  missingAgent: 'missing_init_check_agent',
  tampered: 'init_check_tampered',
  blockingIssues: 'init_check_blocking_issues',
};

/** The phase this artifact drives stories into; our own input, not a product string. */
const TARGET_PHASE = 'INIT_CHECK';

/**
 * A `checkedAt` value no legal call can produce — the handler always stamps
 * `new Date()`. Used as the MARKER for "this record was written by hand", so the
 * laundering rows below identify the injected record by a property of the record
 * itself rather than by counting entries (a count would go stale the moment the
 * required roster changes, and could not be re-derived from a later run).
 */
const INJECTED_AT = new Date(0).toISOString();

const digest = (text) => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 12);

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function write(root, p, c) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
function run(root, command, args, allowFailure = false) {
  try {
    return execFileSync(process.execPath, [CLI, '--root', root, command, JSON.stringify(args)], {
      cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    const t = String(e.stdout || '') + String(e.stderr || '') + String(e.message || '');
    if (allowFailure) return t;
    throw new Error(t);
  }
}
function freezeScope(root, sid) {
  run(root, 'scope_boundary_set', {
    storyId: sid, mode: 'correctness_fix',
    allowedScope: ['INIT_CHECK required reviewer records'], excludedScope: ['unrelated expansion'],
    userConfirmed: true, confirmation: 'Synthetic boundary for the B-8df9 signature-domain artifact.',
  });
  run(root, 'execution_boundary_set', {
    storyId: sid, allowedCommands: ['npm --prefix packages/main run build'],
    allowedTools: ['shell'], excludedCommands: ['rm -rf'],
  });
  assert.match(run(root, 'scope_freeze_check', { storyId: sid }), /PASS/);
}
function makeStory(root, name, title) {
  const created = run(root, 'story_create', {
    name, title, description: 'Fixture story for the B-8df9 signature-domain artifact.',
    type: 'chore', priority: 'medium',
    background: [
      '## Trigger Event',
      '2026-07-27 B-8df9 needs a fixture story with enough trigger detail to satisfy background validation.',
      '## Key Insights',
      'The signature domain and the fields the gate decides on are not the same set, which is what this measures.',
      '## Tradeoffs',
      'The artifact edits init-check.json directly on purpose; that edit is the tampering being measured.',
      '## Conversation Texture',
      'A maintainer wants to know whether hand-written reviewer coverage is accepted by the INIT_CHECK gate.',
    ].join('\n\n'),
    checklist: [{ title: 'Fixture item', context: 'Fixture only.' }],
  });
  const sid = created.match(/B-[a-f0-9]+/)?.[0];
  assert.ok(sid, 'story_create should return a story id');
  freezeScope(root, sid);
  return sid;
}

const dirOf = (root, sid) => join(root, '.proof-or-stop/story/actives', sid);
const icPath = (root, sid) => join(dirOf(root, sid), 'init-check.json');
const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJ = (p, d) => writeFileSync(p, JSON.stringify(d, null, 2));
/** The product's own recomputation — the exact call the gate makes. */
const recompute = (root, sid) => recomputeInitCheckHash(sid, new StoryStore(root), root);
/** Record one legal reviewer verdict through the CLI. */
const record = (root, sid, agentId, issues = []) => execFileSync(process.execPath,
  [join(here, '../support/record-managed-init-verdict.mjs'), root, sid, agentId, JSON.stringify(issues)],
  { cwd: root, encoding: 'utf8', timeout: 180000 });
/**
 * Attempt the advance and OBSERVE the outcome on disk rather than by matching a
 * success sentence: the phase the store reports is the ground truth, and the
 * phase we compare against is our own input.
 */
function tryAdvance(root, sid) {
  const out = run(root, 'story_advance', { storyId: sid, phase: TARGET_PHASE }, true);
  let phase = null;
  try { phase = new StoryStore(root).readStory(sid).phase; } catch { phase = '<unreadable>'; }
  return { advanced: phase === TARGET_PHASE, phase, out, outDigest: digest(out) };
}

const rows = [];
const add = (id, claim, verdict, observed) => rows.push({ id, claim, verdict, observed });
const ctl = (id, claim, ok, observed) => add(id, claim, ok ? 'CONTROL-OK' : 'BROKEN', observed);
const red = (id, claim, isRed, observed) => add(id, claim, isRed ? 'RED' : 'GREEN', observed);

// ── DERIVATIONS (never hardcoded; a change here goes BROKEN, not silent) ────
const required = [...REQUIRED_INIT_CHECK_AGENTS];
/** Every required reviewer except the last: the coverage a real caller can hold. */
const partial = required.slice(0, -1);
/** The one whose record the tampering fabricates / whose absence control A tests. */
const withheld = required[required.length - 1];

/** Severity vocabulary read from the CLI's own rendering of its schema. */
function severityVocabulary() {
  let help = '';
  try {
    help = execFileSync(process.execPath, [CLI, 'init_check_set', '--help'], {
      cwd: REPO, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    help = String(e.stdout || '') + String(e.stderr || '');
  }
  const m = /severity:\s*([a-z]+(?:\|[a-z]+)+)/.exec(help);
  return m === null ? [] : m[1].split('|');
}
const severities = severityVocabulary();
/** Which of those the product actually treats as blocking — asked, not assumed. */
const blockingSeverities = severities.filter((severity) => blockingInitCheckIssues({
  agentResults: [{ agentId: 'derivation-probe', checkedAt: '1970-01-01T00:00:00.000Z', issues: [{ severity, desc: 'derivation probe' }] }],
}).length > 0);
const blockingSeverity = blockingSeverities[0] ?? null;

let guardSource = '';
try { guardSource = readFileSync(GUARD_SOURCE, 'utf8'); } catch { guardSource = ''; }
const liveBlockerCodes = Object.entries(BLOCKER).filter(([, code]) => guardSource.includes(code)).map(([k]) => k);

const root = mkdtempSync(join(tmpdir(), 'red-b8df9-'));
try {
  // ── S: the construction's own preconditions ───────────────────────────────
  ctl('S1', 'the required-reviewer roster read from the product supports this construction',
    required.length >= 2,
    `roster size read at runtime=${required.length}; a fabricated record needs at least one reviewer to withhold`);
  ctl('S2', 'the shipped guard still emits every blocker code this artifact keys on',
    liveBlockerCodes.length === Object.keys(BLOCKER).length,
    `codes found in the compiled guard=${liveBlockerCodes.join(', ') || 'none'} of ${Object.keys(BLOCKER).join(', ')}`);
  ctl('S3', 'the product declares a severity vocabulary and treats part of it as blocking',
    severities.length > 0 && blockingSeverity !== null,
    `vocabulary read from the CLI schema=${severities.join('|') || 'none'}; blocking per the product's own predicate=${blockingSeverities.join('|') || 'none'}`);

  const constructible = required.length >= 2
    && liveBlockerCodes.length === Object.keys(BLOCKER).length
    && blockingSeverity !== null;

  // Any throw during fixture construction (a CLI call that stopped succeeding, a
  // freeze precondition that no longer holds) must land as BROKEN rather than as
  // an uncaught error: an uncaught error exits 1, which a consumer cannot tell
  // apart from the RED verdict this artifact exists to report.
  if (constructible) try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'red@example.test']);
    git(root, ['config', 'user.name', 'B-8df9 Red']);
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main', rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
    }, null, 2));
    write(root, 'README.md', 'red\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'init']);

    // ── A: GATE CONTROL — the gate can tell coverage apart ──────────────────
    {
      const sid = makeStory(root, 'ctl-coverage', 'Control partial reviewer coverage');
      for (const agentId of partial) record(root, sid, agentId);
      const r = tryAdvance(root, sid);
      ctl('A', 'GATE CONTROL: withholding one required reviewer refuses the advance and names the missing one',
        !r.advanced && r.out.includes(BLOCKER.missingAgent) && r.out.includes(withheld),
        `advanced=${r.advanced} phase=${r.phase} namesTheMissingReviewer=${r.out.includes(withheld)} blocker=${r.out.includes(BLOCKER.missingAgent)} outDigest=${r.outDigest}`);
    }

    // ── D: SIGNATURE CONTROL — differential against an untouched twin ───────
    // Two stories built IDENTICALLY. One is left alone; the other has one
    // IN-DOMAIN field edited. If the untouched twin advances and the edited one
    // is refused as tampering, the refusal is attributable to the edit, and
    // "the signature check is simply dead" is ruled out.
    {
      const twin = makeStory(root, 'ctl-untouched', 'Control untouched twin');
      for (const agentId of required) record(root, twin, agentId);
      const twinRun = tryAdvance(root, twin);
      ctl('D0', 'FLOOR: an untouched story with legally recorded full coverage ADVANCES',
        twinRun.advanced,
        `advanced=${twinRun.advanced} phase=${twinRun.phase} outDigest=${twinRun.outDigest}`);

      const sid = makeStory(root, 'ctl-indomain', 'Control in domain field');
      for (const agentId of required) record(root, sid, agentId);

      const stored = readJ(icPath(root, sid))._hash;
      const idxPath = join(dirOf(root, sid), 'index.json');
      const idx = readJ(idxPath);
      idx.title = `${idx.title} TAMPERED`;
      writeJ(idxPath, idx);
      // title is also a scope-freeze input; re-freeze so the signature check is
      // what the advance reaches, rather than an unrelated title-sensitive gate.
      run(root, 'scope_freeze_check', { storyId: sid });

      const after = recompute(root, sid);
      ctl('D1', 'SIGNATURE CONTROL: editing an IN-DOMAIN field changes the recomputed signature',
        after !== stored,
        `recomputed signature moved=${after !== stored}`);

      const r = tryAdvance(root, sid);
      ctl('D2', 'SIGNATURE CONTROL: the gate REFUSES that in-domain edit as tampering, where its untouched twin advanced',
        !r.advanced && r.out.includes(BLOCKER.tampered) && twinRun.advanced,
        `advanced=${r.advanced} phase=${r.phase} tamperBlocker=${r.out.includes(BLOCKER.tampered)} untouchedTwinAdvanced=${twinRun.advanced} outDigest=${r.outDigest}`);
    }

    // ── B: THE DEFECT, agentResults ─────────────────────────────────────────
    {
      const sid = makeStory(root, 'red-inject', 'Injected reviewer coverage');
      for (const agentId of partial) record(root, sid, agentId);

      const stored = readJ(icPath(root, sid))._hash;
      const before = recompute(root, sid);
      const ic = readJ(icPath(root, sid));
      ic.agentResults.push({ agentId: withheld, checkedAt: new Date(0).toISOString(), issues: [] });
      writeJ(icPath(root, sid), ic);
      const after = recompute(root, sid);

      red('B1', 'the recomputed signature is UNCHANGED by injecting a fabricated reviewer record',
        after === before,
        `recomputation responded to the injection=${after !== before}`);
      red('B2', 'the tampered file is still signature-VALID (recomputed matches what is stored)',
        after === stored,
        `stored hash still verifies after the edit=${after === stored}`);
      const r = tryAdvance(root, sid);
      red('B3', 'the gate ACCEPTS hand-injected reviewer coverage, with zero init_check_set calls for it',
        r.advanced,
        `advanced=${r.advanced} phase=${r.phase} outDigest=${r.outDigest}`);
    }

    // ── C: THE SAME DEFECT, issues ──────────────────────────────────────────
    {
      const sid = makeStory(root, 'red-erase', 'Erased blocking issue');
      for (const agentId of partial) record(root, sid, agentId);
      record(root, sid, withheld, [{ severity: blockingSeverity, desc: 'Fixture blocking issue that must stop the advance.' }]);

      const blocked = tryAdvance(root, sid);
      ctl('C1', 'GATE CONTROL: a genuinely recorded blocking-severity issue refuses the advance',
        !blocked.advanced && blocked.out.includes(BLOCKER.blockingIssues),
        `advanced=${blocked.advanced} phase=${blocked.phase} blocker=${blocked.out.includes(BLOCKER.blockingIssues)} severityUsed=${blockingSeverity} outDigest=${blocked.outDigest}`);

      const stored = readJ(icPath(root, sid))._hash;
      const ic = readJ(icPath(root, sid));
      for (const r of ic.agentResults) r.issues = [];
      if (Array.isArray(ic.issues)) ic.issues = [];
      writeJ(icPath(root, sid), ic);

      const after = recompute(root, sid);
      red('C2', 'erasing a recorded blocking-severity issue leaves the file signature-VALID',
        after === stored,
        `stored hash still verifies after the erasure=${after === stored}`);
      const r = tryAdvance(root, sid);
      red('C3', 'the gate ADVANCES after that blocker was erased by hand',
        r.advanced,
        `advanced=${r.advanced} phase=${r.phase} outDigest=${r.outDigest}`);
    }

    // ── E: THE LAUNDERING PATH — one legal call must not re-sign what nobody wrote ──
    //
    // Making the file tamper-EVIDENT (B/C above) is not the whole property. The
    // handler COPIES the previous file's reviewer records into the record it is about
    // to sign. If it copies them without first checking the signature it is replacing,
    // tampering does not have to survive the gate — it only has to survive until the
    // next ordinary reviewer call, which re-signs it into validity. Tamper once, wait,
    // and the evidence of tampering is gone.
    //
    // E0 is the FLOOR this whole section rests on: an untouched predecessor MUST still
    // be carried forward. Without it, "never carry anything forward" would turn every
    // row below green while destroying the multi-reviewer flow the gate is built on —
    // a fix that passes the test by breaking the feature.
    {
      const sid = makeStory(root, 'ctl-carryforward', 'Control clean carry forward');
      const first = partial[0];
      record(root, sid, first);
      const firstStamp = (readJ(icPath(root, sid)).agentResults ?? [])
        .find((r) => r.agentId === first)?.checkedAt ?? null;
      record(root, sid, withheld);
      const after = readJ(icPath(root, sid));
      const survived = (after.agentResults ?? []).some((r) => r.agentId === first && r.checkedAt === firstStamp);
      const validAfter = recompute(root, sid) === after._hash;
      const adv = tryAdvance(root, sid);
      ctl('E0', 'CARRY-FORWARD FLOOR: an UNTOUCHED predecessor record survives the next legal call verbatim, still signed, and the gate advances',
        firstStamp !== null && survived && validAfter && adv.advanced,
        `predecessorStampCaptured=${firstStamp !== null} survivedVerbatim=${survived} signedAfter=${validAfter} advanced=${adv.advanced} phase=${adv.phase}`);
    }

    {
      const sid = makeStory(root, 'red-launder-inject', 'Laundered injected coverage');
      // The laundering caller is a reviewer that is ALREADY legally recorded and is NOT
      // the injected one: a call by the injected reviewer would replace that record with
      // its own and mask the defect being measured.
      const caller = partial[0];
      record(root, sid, caller);

      const ic = readJ(icPath(root, sid));
      ic.agentResults.push({ agentId: withheld, checkedAt: INJECTED_AT, issues: [] });
      writeJ(icPath(root, sid), ic);
      const rejectedBefore = recompute(root, sid) !== readJ(icPath(root, sid))._hash;
      const blockedBefore = !tryAdvance(root, sid).advanced;
      ctl('E1', 'PRECONDITION: before any laundering call the injected record is signature-INVALID and the gate refuses it',
        rejectedBefore && blockedBefore,
        `signatureRejectsTheInjection=${rejectedBefore} gateRefuses=${blockedBefore}`);

      // ONE ordinary, fully legal call. Nothing about it is unusual.
      record(root, sid, caller);
      const laundered = readJ(icPath(root, sid));
      const injectedSurvived = (laundered.agentResults ?? [])
        .some((r) => r.agentId === withheld && r.checkedAt === INJECTED_AT);
      const signedAfter = recompute(root, sid) === laundered._hash;

      ctl('E2', 'the record that legal call wrote is itself validly signed, whatever it contains',
        signedAfter,
        `signatureValidAfterTheLegalCall=${signedAfter} (without this, a green E3 could just mean the write broke)`);
      red('E3', 'the hand-injected reviewer record is carried into that newly signed record — one legal call LAUNDERS it into a valid signature',
        injectedSurvived && signedAfter,
        `injectedRecordSurvivedByItsHandWrittenTimestampMarker=${injectedSurvived} underAValidSignature=${signedAfter}`);
      const r = tryAdvance(root, sid);
      red('E4', 'the gate ACCEPTS that laundered coverage: tampering survived by waiting for one legitimate call',
        r.advanced,
        `advanced=${r.advanced} phase=${r.phase} outDigest=${r.outDigest}`);
    }

    // ── F: THE SAME LAUNDERING, applied to an erased blocking issue ────────────
    {
      const sid = makeStory(root, 'red-launder-erase', 'Laundered issue erasure');
      const flagger = partial[0];
      record(root, sid, flagger, [{ severity: blockingSeverity, desc: 'Fixture blocking issue that must stop the advance.' }]);
      record(root, sid, withheld);
      const blockedBefore = tryAdvance(root, sid);
      const stored = readJ(icPath(root, sid))._hash;
      const flaggerStamp = (readJ(icPath(root, sid)).agentResults ?? [])
        .find((r) => r.agentId === flagger)?.checkedAt ?? null;

      const ic = readJ(icPath(root, sid));
      for (const r of ic.agentResults ?? []) if (r.agentId === flagger) r.issues = [];
      writeJ(icPath(root, sid), ic);
      const rejectedBefore = recompute(root, sid) !== stored;
      ctl('F1', 'PRECONDITION: the recorded blocking issue blocks, and hand-erasing it leaves the file signature-INVALID',
        !blockedBefore.advanced && blockedBefore.out.includes(BLOCKER.blockingIssues) && rejectedBefore && flaggerStamp !== null,
        `blockedWhileRecorded=${!blockedBefore.advanced} blocker=${blockedBefore.out.includes(BLOCKER.blockingIssues)} signatureRejectsTheErasure=${rejectedBefore} flaggerStampCaptured=${flaggerStamp !== null} severityUsed=${blockingSeverity}`);

      // ONE ordinary, fully legal call by the OTHER reviewer.
      record(root, sid, withheld);
      const laundered = readJ(icPath(root, sid));
      const erasedSurvived = (laundered.agentResults ?? [])
        .some((r) => r.agentId === flagger && r.checkedAt === flaggerStamp && (r.issues ?? []).length === 0);
      const signedAfter = recompute(root, sid) === laundered._hash;
      const blockersGone = blockingInitCheckIssues(laundered).length === 0;

      ctl('F2', 'the record that legal call wrote is itself validly signed, whatever it contains',
        signedAfter,
        `signatureValidAfterTheLegalCall=${signedAfter} (without this, a green F3 could just mean the write broke)`);
      red('F3', 'the hand-erased verdict is carried into that newly signed record — the recorded blocker is laundered away under a valid signature',
        erasedSurvived && blockersGone && signedAfter,
        `erasedVerdictSurvivedByItsOriginalTimestampMarker=${erasedSurvived} productSeesNoBlockingIssue=${blockersGone} underAValidSignature=${signedAfter}`);
      const r = tryAdvance(root, sid);
      red('F4', 'the gate ADVANCES: a genuinely recorded blocker was removed by tampering plus one legitimate call',
        r.advanced,
        `advanced=${r.advanced} phase=${r.phase} outDigest=${r.outDigest}`);
    }

    // ── G: THE READ SIDE — refusing to TRUST is not refusing to READ ───────────
    //
    // The fix for E/F could have been "make the read itself throw". That would close
    // the hole and simultaneously strand every historical file: the audit surfaces and
    // the gate's OWN tamper report all have to hold the untrusted bytes in hand to say
    // anything about them. This row measures that the chosen position actually holds.
    {
      const sid = makeStory(root, 'ctl-render', 'Control unverifiable record still renders');
      for (const agentId of required) record(root, sid, agentId);
      const ic = readJ(icPath(root, sid));
      ic.agentResults.push({ agentId: withheld, checkedAt: INJECTED_AT, issues: [] });
      writeJ(icPath(root, sid), ic);
      const unverifiable = recompute(root, sid) !== readJ(icPath(root, sid))._hash;

      let rendered = false;
      let renderedVerbatim = false;
      try {
        const view = JSON.parse(run(root, 'story_get', { storyId: sid }));
        rendered = Boolean(view?.initCheck);
        renderedVerbatim = Array.isArray(view?.initCheck?.agentResults)
          && view.initCheck.agentResults.some((r) => r.agentId === withheld && r.checkedAt === INJECTED_AT);
      } catch { /* PROBE: leave both false; the control then reports BROKEN */ }

      const r = tryAdvance(root, sid);
      ctl('G1', 'READ vs TRUST: a record that does NOT verify still RENDERS through story_get, verbatim, while the gate refuses to act on it',
        unverifiable && rendered && renderedVerbatim && !r.advanced && r.out.includes(BLOCKER.tampered),
        `signatureRejectsIt=${unverifiable} storyGetStillRendersIt=${rendered} rendersTheUnverifiedContentVerbatim=${renderedVerbatim} gateRefuses=${!r.advanced} tamperBlocker=${r.out.includes(BLOCKER.tampered)}`);
    }

    // ── H: THE BOUNDARY OF THE CLAIM, MEASURED RATHER THAN ASSERTED ────────────
    //
    // Everything above buys tamper-EVIDENCE. It does not buy secrecy: the salt is a
    // public constant in this repository, so whoever can edit the file can also run
    // the product's own signing function over their edit and produce a record that
    // verifies. That is measured here instead of being written down, because a
    // sentence in a comment cannot go BROKEN when it stops being true.
    // The checksum and managed-coverage authorities remain independently live:
    // re-signing restores only the former, never the missing provider receipt.
    {
      const sid = makeStory(root, 'scope-resign', 'Scope re-signed tampering lacks managed coverage');
      record(root, sid, partial[0]);
      const ic = readJ(icPath(root, sid));
      ic.agentResults.push({ agentId: withheld, checkedAt: INJECTED_AT, issues: [] });
      writeJ(icPath(root, sid), ic);
      const refusedBeforeReSigning = recompute(root, sid) !== readJ(icPath(root, sid))._hash;

      // The editor now runs the product's own signing function over their own edit.
      const resigned = readJ(icPath(root, sid));
      resigned._hash = recompute(root, sid);
      writeJ(icPath(root, sid), resigned);
      const verifiesAfterReSigning = recompute(root, sid) === readJ(icPath(root, sid))._hash;

      const r = tryAdvance(root, sid);
      ctl('H1', 'SCOPE BOUND: public checksum re-signing verifies but cannot fabricate required managed reviewer coverage',
        refusedBeforeReSigning && verifiesAfterReSigning && !r.advanced
          && r.out.includes(BLOCKER.missingAgent) && r.out.includes(withheld),
        `refusedBeforeReSigning=${refusedBeforeReSigning} verifiesAfterReSigning=${verifiesAfterReSigning} gateAdvancesOnTheReSignedRecord=${r.advanced} phase=${r.phase}`);
    }
  } catch (e) {
    // Reported as a digest, never as text: child-process failures carry command
    // lines, and this repository's environment holds live-looking credentials.
    ctl('X', 'the fixture construction ran to completion',
      false,
      `construction threw ${e?.constructor?.name ?? 'Error'}; messageDigest=${digest(e?.message)}; `
      + `rows completed before the throw=${rows.length}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── THE REGISTRATION WAIVER, MEASURED ON EVERY RUN ──────────────────────────
// The `optional` registration exists only to stop a KNOWN pre-fix failure from
// breaking `validate`. Leaving it in place after the fix would turn this file
// into a command that can fail without anyone noticing — the vacuous-coverage
// defect one layer up. So it is measured and REPORTED on every run (which is
// what makes the check itself verifiable on the pre-fix tree, rather than a
// branch nobody has ever executed) and becomes FATAL the moment every row is
// GREEN. Derived from this module's own location, so a rename cannot leave the
// lookup pointing at a path that no longer exists while still reporting success.
const SELF_REL = relative(REPO, fileURLToPath(import.meta.url)).split(sep).join('/');
function registrationState() {
  let config;
  try {
    config = JSON.parse(readFileSync(join(REPO, 'proof-or-stop.config.json'), 'utf8'));
  } catch {
    return { readable: false, found: false, optional: false };
  }
  for (const entry of config?.validate?.commands ?? []) {
    const argv = typeof entry === 'string'
      ? entry.trim().split(/\s+/)
      : [entry?.command, ...(entry?.args ?? [])].map(String);
    if (argv.includes(SELF_REL)) {
      return { readable: true, found: true, optional: (typeof entry === 'object' && entry?.optional === true) };
    }
  }
  return { readable: true, found: false, optional: false };
}
const registration = registrationState();
const waiverWithdrawn = registration.readable && registration.found && !registration.optional;

console.log('=== B-8df9: the INIT_CHECK verdict is outside the signature domain, and the carry-forward re-signs it ===\n');
let redCount = 0;
let brokenCount = 0;
for (const { id, claim, verdict, observed } of rows) {
  if (verdict === 'RED') redCount += 1;
  if (verdict === 'BROKEN') brokenCount += 1;
  console.log(`  ${id.padEnd(3)} [${verdict.padEnd(10)}] ${claim}`);
  console.log(`      observed: ${observed}`);
}
console.log(`\n  ${redCount} RED / ${brokenCount} BROKEN / ${rows.length} rows`);
console.log(
  `  registration in proof-or-stop.config.json: readable=${registration.readable} found=${registration.found} `
  + `optional=${registration.optional} → waiverWithdrawn=${waiverWithdrawn} `
  + '(a surviving waiver is reported while the defect stands and becomes FATAL once every row is GREEN)',
);

if (brokenCount > 0) {
  console.log([
    '',
    '  A CONTROL IS BROKEN. No conclusion may be drawn from any RED row above: the',
    '  construction no longer measures what it claims to. Fix the harness first —',
    '  most likely the required-reviewer roster, the severity vocabulary or a',
    '  blocker code changed, all of which are read from the product at runtime.',
    '',
  ].join('\n'));
  process.exit(2);
}
if (redCount > 0) {
  console.log([
    '',
    '  RED. The signature RESPONDS to an in-domain field (D1/D2, against an untouched',
    '  twin that advanced) yet IGNORES both agentResults (B1/B2) and issues (C2), so',
    '  the gate accepts records no legal caller wrote (B3, C3). "The signature check is',
    '  dead for everything" is ruled out by D, "it advances for everything" by A and C1,',
    '  and "it refuses for everything" by D0.',
    '',
    '  And/or: the carry-forward re-signs a record that does not verify (E3/E4, F3/F4),',
    '  so one ordinary reviewer call launders tampering into a valid signature. E0 rules',
    '  out "just stop carrying anything forward" — an untouched predecessor must still',
    '  survive — and E2/F2 rule out "the write simply broke".',
    '',
    '  This is about AUDIT INTEGRITY, not access control: both outcomes are already',
    '  reachable through legal CLI calls by design. Tampering adds only the absence of',
    '  a trail and a bypass of the actor registry.',
    '',
  ].join('\n'));
  process.exit(1);
}

// ── THE WAIVER RETIRES ITSELF ───────────────────────────────────────────────
// Reached only when the defect is gone, using the state measured above.
if (!waiverWithdrawn) {
  console.log([
    '',
    '  Every row is GREEN, so the defect this artifact was written for is fixed —',
    '  but its registration is still in its pre-fix shape:',
    `    proof-or-stop.config.json readable=${registration.readable} entry found=${registration.found} optional=${registration.optional}`,
    '',
    '  Withdraw the waiver: register this file in proof-or-stop.config.json validate.commands',
    '  WITHOUT `optional`, so that a regression of the signature domain fails validate',
    '  instead of printing a warning nobody reads. Until then this exits non-zero.',
    '',
  ].join('\n'));
  process.exit(1);
}
console.log([
  '',
  '  GREEN: both verdict fields are inside the signature domain, and the carry-forward',
  '  refuses to re-sign a record that does not verify — while an untouched predecessor',
  '  is still carried forward (E0) and an unverifiable record still RENDERS (G1).',
  '',
].join('\n'));
