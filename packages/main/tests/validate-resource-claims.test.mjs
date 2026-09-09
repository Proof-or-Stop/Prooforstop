#!/usr/bin/env node
/**
 * B-7dff CHK-002 — resource claims for routine validate commands.
 *
 * Proves the three properties the claim vocabulary has to have BEFORE the plan
 * is ever handed to the scheduler (CHK-003):
 *
 *   1. Two commands with disjoint DECLARED claims are admitted concurrently.
 *   2. A command with NO declared claim resolves to a single EXCLUSIVE claim on
 *      the synthetic barrier key and never overlaps any other command — the
 *      fail-closed default. Nothing in a plan is silently parallelised.
 *   3. A claim naming an unrecognised resource class is REFUSED at declaration
 *      time (both in `resolveValidationCommandResources` and in the
 *      `proof-or-stop.config.json` parser), never dropped into a shared key.
 *
 * Concurrency is proven by driving the real `runScheduled`, not by asserting on
 * `claimsConflict` alone: an entry records which other entries were live while
 * it ran. The scheduler launches every compatible entry synchronously before it
 * awaits, so the observation is deterministic rather than timing-dependent.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const distDir = resolve(repoRoot, 'packages/main/dist');

for (const required of ['core/validation-executor.js', 'core/keyed-scheduler.js', 'handlers/verifier.js']) {
  if (!existsSync(join(distDir, required))) {
    console.error(`validate-resource-claims: missing build artifact ${join(distDir, required)}; run npm --prefix packages/main run build first`);
    process.exit(1);
  }
}

const load = (rel) => import(pathToFileURL(join(distDir, rel)).href);
const {
  VALIDATE_PLAN_BARRIER_CLAIM_CLASS,
  VALIDATE_PLAN_BARRIER_CLAIM_KEY,
  resolveValidationCommandResources,
  resolveValidationPlanEntries,
} = await load('core/validation-executor.js');
const { canonicalizeEntries, claimsConflict, runScheduled } = await load('core/keyed-scheduler.js');
const { configuredValidationCommands } = await load('handlers/verifier.js');

let assertions = 0;
const ok = (message, condition = true) => {
  assert.ok(condition, message);
  assertions++;
};

const REPO_READ = { class: 'git-common-dir', key: '.', access: 'shared' };
const command = (label, resources) => ({
  label,
  command: process.execPath,
  args: ['-e', 'process.exit(0)'],
  ...(resources ? { resources } : {}),
});

const isBarrier = (claim, access) => claim.class === VALIDATE_PLAN_BARRIER_CLAIM_CLASS
  && claim.key === VALIDATE_PLAN_BARRIER_CLAIM_KEY
  && claim.access === access;

/**
 * Run a plan through the real scheduler and report, per entry, which other
 * entries were live at the same time.
 */
async function observeOverlap(plan, jobs) {
  const entries = canonicalizeEntries(resolveValidationPlanEntries(plan), repoRoot);
  const live = new Set();
  const coRunners = new Map(entries.map((entry) => [entry.name, new Set()]));
  const results = await runScheduled(entries, jobs, async (entry) => {
    // Record the overlap SYMMETRICALLY at launch: two entries overlap iff both
    // are live at the same instant, which does not depend on which of their
    // timers fires first.
    for (const other of live) {
      coRunners.get(entry.name).add(other);
      coRunners.get(other).add(entry.name);
    }
    live.add(entry.name);
    await new Promise((done) => { setTimeout(done, 25); });
    live.delete(entry.name);
    return { name: entry.name, status: 'PASS' };
  }, { cancellation: 'run-all' });
  return { entries, results, coRunners };
}

// ── 1. HAPPY: disjoint declared claims are admitted concurrently ────────────
{
  const plan = {
    provider: 'b7dff-disjoint-declared',
    commands: [
      command('declared A', [REPO_READ, { class: 'fixed-path', key: '.proof-or-stop/runtime/b7dff-probe-a', access: 'exclusive' }]),
      command('declared B', [REPO_READ, { class: 'fixed-path', key: '.proof-or-stop/runtime/b7dff-probe-b', access: 'exclusive' }]),
    ],
  };
  const [a, b] = resolveValidationPlanEntries(plan);
  ok('declared command keeps its declared claims plus a SHARED barrier claim',
    isBarrier(a.resources[0], 'shared') && a.resources.length === 3 && a.exclusiveByDefault === false);
  const { results, coRunners } = await observeOverlap(plan, 2);
  ok('both declared probes ran', results.length === 2 && results.every((r) => r.status === 'PASS'));
  ok(`declared A and declared B overlapped (A saw ${[...coRunners.get(a.name)].join(',') || 'nobody'})`,
    coRunners.get(a.name).has(b.name) && coRunners.get(b.name).has(a.name));
  console.log('VI-OK B7DFF-CHK002-DISJOINT-DECLARED-CONCURRENT two commands with disjoint declared claims are admitted concurrently');
}

// ── 2. EDGE: the fail-closed default is a single exclusive barrier claim ────
{
  const resolved = resolveValidationCommandResources(command('no declaration'), 'probe');
  ok('an undeclared command resolves to exactly one claim', resolved.length === 1);
  ok(`that claim is exclusive on the synthetic key ${VALIDATE_PLAN_BARRIER_CLAIM_KEY}`, isBarrier(resolved[0], 'exclusive'));
  const emptyArray = resolveValidationCommandResources({ ...command('empty declaration'), resources: [] }, 'probe');
  ok('an EMPTY resources array is treated as undeclared, not as "touches nothing"',
    emptyArray.length === 1 && isBarrier(emptyArray[0], 'exclusive'));
  console.log('VI-OK B7DFF-CHK002-UNDECLARED-SINGLE-EXCLUSIVE-CLAIM an undeclared command resolves to a single exclusive claim on a synthetic key');
}

// ── 3. EDGE: an undeclared command never overlaps ANY other command ─────────
{
  const plan = {
    provider: 'b7dff-undeclared-never-overlaps',
    commands: [
      command('declared A', [REPO_READ]),
      command('undeclared U'),
      command('declared B', [REPO_READ]),
      command('declared C', [REPO_READ]),
    ],
  };
  const entries = resolveValidationPlanEntries(plan);
  const undeclared = entries[1];
  ok('the undeclared entry is marked exclusiveByDefault', undeclared.exclusiveByDefault === true);
  const canonical = canonicalizeEntries(entries, repoRoot);
  const conflictsWithEveryone = canonical
    .filter((entry) => entry.name !== canonical[1].name)
    .every((entry) => claimsConflict(canonical[1], entry) && claimsConflict(entry, canonical[1]));
  ok('the undeclared entry conflicts with every other entry in the plan (both directions)', conflictsWithEveryone);

  const { results, coRunners } = await observeOverlap(plan, 4);
  ok('every command in the mixed plan ran', results.length === 4 && results.every((r) => r.status === 'PASS'));
  ok(`the undeclared command saw no co-runner (saw: ${[...coRunners.get(undeclared.name)].join(',') || 'nobody'})`,
    coRunners.get(undeclared.name).size === 0);
  ok('no other command saw the undeclared one either',
    [...coRunners.entries()].every(([name, seen]) => name === undeclared.name || !seen.has(undeclared.name)));
  // Without this the previous assertion would also hold on a scheduler that
  // simply ran everything one at a time.
  ok('the declared commands in the SAME plan did overlap, so >1 worker really was available',
    coRunners.get(canonical[0].name).size > 0);
  console.log('VI-OK B7DFF-CHK002-UNDECLARED-NEVER-OVERLAPS an undeclared command never overlaps any other command while declared ones do');
}

// ── 4. ADVERSARIAL: an unrecognised class is refused at declaration time ────
{
  const bogus = { ...command('bogus class'), resources: [{ class: 'not-a-resource-class', key: '.', access: 'shared' }] };
  assert.throws(
    () => resolveValidationCommandResources(bogus, 'probe'),
    /unknown resource class for probe: not-a-resource-class/,
    'an unrecognised resource class must be refused, not dropped',
  );
  assertions++;
  assert.throws(
    () => resolveValidationCommandResources({ ...command('bogus access'), resources: [{ class: 'fixed-path', key: 'x', access: 'sometimes' }] }, 'probe'),
    /unknown resource access for probe: sometimes/,
  );
  assertions++;
  assert.throws(
    () => resolveValidationCommandResources({ ...command('empty key'), resources: [{ class: 'fixed-path', key: '  ', access: 'shared' }] }, 'probe'),
    /empty resource key for probe/,
  );
  assertions++;
  assert.throws(
    () => resolveValidationCommandResources({ ...command('not an array'), resources: 'git-common-dir' }, 'probe'),
    /declared a non-array resources field/,
  );
  assertions++;
  assert.throws(
    () => resolveValidationPlanEntries({ provider: 'p', commands: [command('ok', [REPO_READ]), bogus] }),
    /unknown resource class for 1:bogus class/,
    'plan resolution must fail closed on ONE bad claim rather than resolving the rest',
  );
  assertions++;
  // A rejected claim must not degrade into "no declaration and therefore shared":
  // the fail-closed default is exclusive, and the refusal happens before it.
  const forged = resolveValidationCommandResources(
    { ...command('forged canonical key'), resources: [{ ...REPO_READ, canonicalKey: 'git-common-dir:/somewhere/else' }] },
    'probe',
  );
  ok('a canonicalKey supplied by the caller/config is discarded, so the scheduler must canonicalize',
    forged.every((claim) => claim.canonicalKey === undefined));
  console.log('VI-OK B7DFF-CHK002-UNKNOWN-CLASS-REFUSED an unrecognised resource class is rejected at declaration time');
}

// ── 5. ADVERSARIAL: the config parser refuses it too ────────────────────────
{
  const roots = [];
  // A fresh root per case: loadConfig caches per project root.
  const withConfig = (resources, assertion) => {
    const root = mkdtempSync(join(tmpdir(), 'b7dff-claim-config-'));
    roots.push(root);
    writeFileSync(
      join(root, 'proof-or-stop.config.json'),
      JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', validate: { commands: [{ command: 'node', args: ['x.js'], resources }] } }),
    );
    assertion(root);
  };
  try {
    withConfig([{ class: 'git-common-dir-ish', key: '.', access: 'shared' }], (root) => {
      assert.throws(
        () => configuredValidationCommands(root),
        /unknown resource class for configured validate\.commands\[0\]: git-common-dir-ish/,
        'proof-or-stop.config.json must not be able to register an unrecognised resource class',
      );
      assertions++;
    });
    withConfig([{ key: '.', access: 'shared' }], (root) => {
      assert.throws(() => configuredValidationCommands(root), /must be an object with class, key and access/);
      assertions++;
    });
    withConfig('git-common-dir', (root) => {
      assert.throws(() => configuredValidationCommands(root), /resources must be an array of resource claims/);
      assertions++;
    });
    withConfig([REPO_READ], (root) => {
      const [parsed] = configuredValidationCommands(root);
      ok('a well-formed config claim survives parsing unchanged',
        parsed.resources.length === 1 && parsed.resources[0].class === 'git-common-dir' && parsed.resources[0].access === 'shared');
    });
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
  console.log('VI-OK B7DFF-CHK002-UNKNOWN-CLASS-REFUSED-IN-CONFIG proof-or-stop.config.json cannot register an unrecognised resource class');
}

// ── 6. The real configured plan: every entry is classified ─────────────────
{
  const commands = configuredValidationCommands(repoRoot);
  ok('the repository declares a non-trivial validate plan', commands.length > 50);
  const entries = resolveValidationPlanEntries({ provider: 'configured', commands });
  ok('every configured command resolves to at least one claim', entries.every((entry) => entry.resources.length >= 1));
  const declared = entries.filter((entry) => !entry.exclusiveByDefault);
  const byDefault = entries.filter((entry) => entry.exclusiveByDefault);
  ok('every configured command has an explicit declaration for cross-worktree capacity', declared.length === commands.length && byDefault.length === 0);
  ok('every undeclared configured command is a single exclusive barrier claim',
    byDefault.every((entry) => entry.resources.length === 1 && isBarrier(entry.resources[0], 'exclusive')));
  ok('every declared configured command carries the shared barrier plus its own claims',
    declared.every((entry) => isBarrier(entry.resources[0], 'shared') && entry.resources.length > 1));
  ok('entry names are unique, so scheduler results cannot collapse two commands',
    new Set(entries.map((entry) => entry.name)).size === entries.length);

  const canonical = canonicalizeEntries(entries, repoRoot);
  const overlappable = canonical.filter((entry) => !entry.resources.some(claim => isBarrier(claim, 'exclusive')));
  const barriers = canonical.filter((entry) => entry.resources.some(claim => isBarrier(claim, 'exclusive')));
  ok('no configured command may overlap an undeclared one',
    barriers.every((barrier) => canonical.every((other) => other.name === barrier.name || claimsConflict(barrier, other))));
  ok('the declared configured commands are mutually compatible',
    overlappable.every((entry, i) => overlappable.slice(i + 1).every((other) => !claimsConflict(entry, other))));
  console.log(`VI-OK B7DFF-CHK002-CONFIGURED-PLAN-CLASSIFIED configured plan: ${commands.length} commands, ${declared.length} declared, ${byDefault.length} exclusive by fail-closed default`);
}

// ── 7. B-e40f: quorum smoke has one exact shared-read declaration ───────────
{
  const configured = configuredValidationCommands(repoRoot);
  const quorumRows = configured.filter((entry) => entry.command === 'node'
    && Array.isArray(entry.args)
    && entry.args.includes('packages/main/dist/tasks/quorum-submit-smoke.js'));
  ok('the configured plan contains exactly one quorum-submit smoke row', quorumRows.length === 1);
  const quorum = quorumRows[0];
  const exactDeclaration = (entry) => entry.command === 'node'
    && JSON.stringify(entry.args) === JSON.stringify([
      'packages/main/dist/tasks/quorum-submit-smoke.js',
      '--jobs=2',
    ])
    && JSON.stringify(entry.resources) === JSON.stringify([REPO_READ]);
  ok('quorum smoke selects jobs=2 and declares only the raw shared git-common-dir claim',
    exactDeclaration(quorum));
  const [resolved] = resolveValidationPlanEntries({ provider: 'b-e40f-quorum', commands: [quorum] });
  ok('the quorum claim resolves as non-barrier shared access',
    resolved.exclusiveByDefault === false
      && resolved.resources.length === 2
      && isBarrier(resolved.resources[0], 'shared')
      && resolved.resources[1].class === REPO_READ.class
      && resolved.resources[1].key === REPO_READ.key
      && resolved.resources[1].access === REPO_READ.access);
  ok('a wrong or extra quorum claim is rejected by the exact declaration guard',
    !exactDeclaration({ ...quorum, resources: [{ ...REPO_READ, access: 'exclusive' }] })
      && !exactDeclaration({ ...quorum, resources: [REPO_READ, { class: 'fixed-path', key: 'extra', access: 'exclusive' }] }));
  console.log('VI-OK B-E40F-CHK005-QUORUM-EXACT-SHARED-CLAIM quorum smoke has one jobs=2 row and one raw shared repository-read claim');
}

// ── 8. Audited local writers retain an effective exclusive barrier ──────
// Explicit writer claims preserve local serialization and cross-worktree capacity.
{
  const PROVEN_UNSAFE_TO_SHARE = new Map([
    ['npm --prefix packages/main run build',
      'rewrites packages/main/dist, the artifact every other node command in this plan executes'],
    ['node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js',
      'runs the real dist/cli.js with cwd=repoRoot, so cli-engine writeLog appends to the repository .proof-or-stop/activity.jsonl'],
    ['node packages/main/dist/tasks/command-catalog-smoke.js',
      'runs the real dist/cli.js with --root <repoRoot>, so cli-engine writeLog appends to the repository .proof-or-stop/activity.jsonl'],
    ['node packages/main/tests/red/red-b49d4-registration-derivation.mjs',
      'sweepLegacyProbeDebris rmSync-es marker-gated paths under repoRoot and BLOCK D asserts whole-tree git status'],
    ['node packages/main/tests/red/red-b49d4-chk002-receipt.mjs',
      'plants probe files at join(repoRoot, RED_PROBE_REL) and join(repoRoot, DIST_PROBE_REL) inside the repository'],
    ['node packages/main/tests/red/red-1734-lock-liveness.mjs',
      'creates and removes the real repository build lock directory and build lock target'],
    ['node packages/main/tests/red/red-1734-content-binding.mjs',
      'writes/removes repository sources and rmSync-es join(repoRoot, BUILD_MANIFEST)'],
    ['node packages/main/tests/red/red-1734-reader-race.mjs',
      'renames the repository packages/main/dist to dist.staging/dist.trash-* and takes the real build lock'],
    ['node packages/main/dist/tasks/proofstory-acceptance-rollout-smoke.js --issuer-mutations',
      'readOrCreatePrivateKey writes proof-or-stop-acceptance-rollout-verifier-v1.key into the git common dir with flag wx'],
  ]);

  const argvOf = (command) => [command.command, ...(command.args ?? [])].join(' ');
  /** Every audited repo-shared writer in `commands` that has been given a claim. */
  const auditedBarrierRegressions = (commands) => commands
    .filter((command) => PROVEN_UNSAFE_TO_SHARE.has(argvOf(command)) && !resolveValidationCommandResources(command, argvOf(command)).some(claim => isBarrier(claim, 'exclusive')))
    .map((command) => `${argvOf(command)} — ${PROVEN_UNSAFE_TO_SHARE.get(argvOf(command))}`);

  const configured = configuredValidationCommands(repoRoot);
  const unknown = [...PROVEN_UNSAFE_TO_SHARE.keys()].filter((argv) => !configured.some((c) => argvOf(c) === argv));
  ok(`every audited barrier is still a configured command (missing: ${unknown.join(', ') || 'none'})`, unknown.length === 0);

  const regressed = auditedBarrierRegressions(configured);
  ok(`CHK-005 audited these as repo-shared writers; they must keep the fail-closed barrier: ${regressed.join(' | ') || 'none declared'}`,
    regressed.length === 0);
  console.log(`VI-OK B7DFF-CHK005-AUDITED-BARRIERS-HELD ${PROVEN_UNSAFE_TO_SHARE.size} commands retain an effective exclusive local barrier`);

  // NEGATIVE CONTROL. The assertion above is only worth something if it would
  // actually fire; a guard that cannot fail is decoration. Feed it a plan where
  // one audited repo-shared writer HAS been given the shared claim and prove it
  // is reported, with the reason the audit refused it. Synthetic input on
  // purpose: mutating the real config to prove this would be the very repo-shared
  // write the audit is about.
  const injected = 'node packages/main/tests/red/red-1734-reader-race.mjs';
  const forgedPlan = configured.map((command) => (argvOf(command) === injected ? { ...command, resources: [REPO_READ] } : command));
  const caught = auditedBarrierRegressions(forgedPlan);
  ok(`a declared audited barrier is CAUGHT, not silently accepted (caught: ${caught.join(' | ') || 'nothing'})`,
    caught.length === 1 && caught[0].startsWith(injected));
  ok('the probe reports WHY the audit refused it, so a later author cannot re-declare it by accident',
    caught[0].includes(PROVEN_UNSAFE_TO_SHARE.get(injected)));
  for (const target of PROVEN_UNSAFE_TO_SHARE.keys()) {
    const weakened = configured.map(command => argvOf(command) === target ? { ...command, resources: [REPO_READ] } : command);
    const rejected = auditedBarrierRegressions(weakened);
    ok(`every audited writer retains its own rejection control: ${target}`, rejected.length === 1 && rejected[0].startsWith(target));
  }
  console.log('VI-OK B7DFF-CHK005-COLLISION-PROBE-BITES declaring an audited repo-shared writer is reported by the probe rather than silently accepted');
}

console.log(`validate-resource-claims: PASS (${assertions} assertions)`);
