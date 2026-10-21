#!/usr/bin/env node
/**
 * Lab run132 (old-PoS run 135 item L, bench-staging/oldpos/run135-analysis.md; new-PoS ADR-056 / ADR-070 direction;
 * switch remediation.baseClaimEvidence, default on, `off` = rollback). Run 135 F-009: F-008's repair report said the
 * empty-range alias "already matched the base"; it did not, and the next round found F-009. A repair report claiming a
 * boundary case behaves as on the Story base owes a `[base-evidence] <case> :: <command run on the Story base> ->
 * <output>` line: asked for in the repair's own resumed session (core/repair-report-lines.ts repairReportFollowUp, the
 * managed worker), and a report that still lacks it is no accepted repair (handlers/next-driver.ts repairRunTestProblem).
 * Made-up reports only.
 *
 *   L1 the claim detector: boundary + "matches / unchanged / same as ... base" without evidence of that case class.
 *   L2 the follow-up asks for exactly the [base-evidence] line (switch on), nothing when off or proven.
 *   L3 the acceptance problem names [repair_base_claim_unproven]; the switch is a known flag, malformed = on.
 *   L4 the finding-repair prompt states the rule (on) and not (off); an earlier unaccepted run's claim is named.
 *
 * Usage: node packages/main/dist/tasks/run135-l-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Fn = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
async function load(path: string, name: string): Promise<Fn> {
  let module: Record<string, unknown> = {};
  try { module = await import(path) as Record<string, unknown>; } catch { module = {}; }
  const fn = module[name];
  assert.ok(fn !== undefined, `${path} exports ${name}`);
  return fn as Fn;
}
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

const CLAIM = 'Fixed the two-part read to alias the source. The empty-range alias already matches the Story base, so no test was added for it.';
const EVIDENCE_EMPTY = '[base-evidence] empty range a[2:2] :: git worktree add /tmp/b <base> && go run ./cmd a[2:2] -> []';

await check('L1 a boundary "already matches the base" claim without base evidence is found; evidence of the same case class, or no boundary class, is none', async () => {
  const claims = await load('../core/repair-report-lines.js', 'unprovenBaseClaims');
  assert.deepEqual(claims(CLAIM), ['The empty-range alias already matches the Story base, so no test was added for it.']);
  assert.deepEqual(claims(`${CLAIM}\n${EVIDENCE_EMPTY}`), [], 'the [base-evidence] line of the same case class proves it');
  assert.equal(claims('A negative start is unchanged from the base behaviour.\n' + EVIDENCE_EMPTY).length, 1, 'evidence of another case class does not');
  assert.deepEqual(claims('The printer output matches the base formatting.'), [], 'no boundary case: no claim');
  assert.deepEqual(claims('The base raises an error for an empty range; the repair now does too (TestEmptyRange).'), [], 'no "matches the base" claim');
  assert.equal(claims('Out-of-range ends stay unchanged; base behaviour preserved for out of range indexes.').length, 1);
  assert.deepEqual(claims(null), []);
});

await check('L2 the in-session follow-up asks for the [base-evidence] line (switch on); nothing when off or proven', async () => {
  const followUp = await load('../core/repair-report-lines.js', 'repairReportFollowUp');
  const on = followUp({ report: CLAIM, matrices: [], mechanisms: [], baseClaims: true }) as string | null;
  assert.ok(on, 'asked');
  assert.match(on!, /\[base-evidence\] <case> :: <command run on the Story base> -> <output>/);
  assert.match(on!, /empty-range alias already matches/);
  assert.match(on!, /fix the repair/i, 'a wrong claim is fixed, not only reported');
  assert.equal(followUp({ report: CLAIM, matrices: [], mechanisms: [], baseClaims: false }), null, 'off: nothing');
  assert.equal(followUp({ report: `${CLAIM}\n${EVIDENCE_EMPTY}`, matrices: [], mechanisms: [], baseClaims: true }), null, 'proven: nothing');
});

await check('L3 the acceptance problem names [repair_base_claim_unproven]; remediation.baseClaimEvidence is a known flag (default on, malformed = on)', async () => {
  const problem = await load('../core/repair-report-lines.js', 'repairBaseClaimProblem');
  assert.match(String(problem(CLAIM)), /\[repair_base_claim_unproven\]/);
  assert.equal(problem(`${CLAIM}\n${EVIDENCE_EMPTY}`), null);
  const on = await load('../core/ab-variants.js', 'baseClaimEvidenceOn');
  assert.equal(on({}), true);
  assert.equal(on({ remediation: { baseClaimEvidence: 'off' } }), false);
  assert.equal(on({ remediation: { baseClaimEvidence: 'maybe' } }), true);
  const flags = await import('../core/ab-variants.js') as { AB_VARIANT_FLAGS: Record<string, readonly string[]> };
  assert.deepEqual([...(flags.AB_VARIANT_FLAGS['remediation.baseClaimEvidence'] ?? [])], ['on', 'off']);
});

await check('L4 the finding-repair prompt states the base-evidence rule (on) and not (off)', async () => {
  const { createStoryDispatchHandlers } = await import('../handlers/story-dispatch.js');
  const { StoryStore } = await import('../core/store.js');
  const { resetConfigCache } = await import('../core/config.js');
  const { writeStoryRequest } = await import('../core/story-request.js');
  const promptOf = (config: Record<string, unknown>): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'run135-l-')));
    try {
      git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'user.name', 'Bench Owner']); git(root, ['config', 'user.email', 'owner@bench.invalid']);
      write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', ...config }, null, 2));
      write(root, 'lang/slice.go', 'package lang\n\nfunc Slice() string { return "" }\n');
      git(root, ['add', '-A']); git(root, ['commit', '-qm', 'base']);
      resetConfigCache();
      const store = new StoryStore(root);
      const storyId = 'B-1351';
      const now = '2026-10-22T05:00:00.000Z';
      store.writeStory(storyId, { storyId, name: 'slices', title: 'Slices', description: 'Slices.', type: 'feature', phase: 'DEV', priority: 'medium', createdAt: now, startedAt: now, endedAt: null, events: [] } as never);
      store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Two-part read', status: 'done', context: 'lang', userSees: 'a[1:2] aliases a', files: { modify: ['lang/slice.go'], create: [], test: ['lang/slice_test.go'] },
        verificationIntent: { happy: [], edge: [], adversarial: [] }, startTime: null, endTime: null }] } as never);
      writeStoryRequest(store, { storyId, phase: 'INIT', request: 'A two-part read aliases its source.', source: 'smoke', now });
      store.writeFindings(storyId, { findings: [{ id: `${storyId}:F-001`, severity: 'medium', category: 'edge', files: ['lang/slice.go'], evidenceState: 'verified', agent: 'proof-or-stop-review-concept', createdAt: now,
        desc: 'lang/slice.go:3 a two-part read copies instead of aliasing. Repro: `a=[1,2]; b=a[0:1]; b[0]=9; a`', status: 'open' }] } as never);
      return (createStoryDispatchHandlers({ store, root, scanRoot: root } as never).dispatch({ storyId, agentType: 'proof-or-stop-finding-repair', findingId: 'F-001' }) as { prompt: string }).prompt;
    } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
  };
  const on = promptOf({});
  assert.match(on, /already matches \/ is unchanged from the Story base owes one line per case: `\[base-evidence\]/);
  assert.match(on, /\[repair_base_claim_unproven\]/);
  assert.doesNotMatch(promptOf({ remediation: { baseClaimEvidence: 'off' } }), /\[base-evidence\]/, 'off: the prompt as before');
});

if (failures.length) {
  console.log(`run135-l-smoke: ${failures.length} check(s) FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('run135-l-smoke: all checks passed');
