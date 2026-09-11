/** Signed-ledger reader defense for imported/historical decision attribution.
 * This is not a demonstrated bypass of the current reviewer-owned producer. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { withMkdirLock, captureMkdirLockFence } from '../core/mkdir-lock.js';
import { appendFindingLedger, findingLedgerSignerFromWorkspace, exactLedgerRecordHash } from '../handlers/finding-ledger.js';
import { collectQualificationSubjectAdjudications, qualificationSubjectProjection } from '../handlers/finding-qualification-adjudication.js';
import { seedCurrentReviewFixture, bindCurrentFixtureFinding } from './current-review-fixture.js';
import { nativeReviewFixtureBrokers } from './native-review-fixture.js';
import { runIsolatedFindingFixture } from './isolated-finding-fixture.js';
if (await runIsolatedFindingFixture(import.meta.url)) process.exit(0);
const root = mkdtempSync(join(tmpdir(), 'finding-independent-gold-')); const cwd = process.cwd();
let failures = 0;
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ storyDir: '.proof-or-stop/story/actives', workflow: { profile: 'balanced' },
    nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() } }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Isolated qualification reader'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', 'proof-or-stop.config.json'); git('commit', '-m', 'isolated fixture'); process.chdir(root); resetConfigCache();
  const storyId = 'B-gold'; const findingId = 'B-gold:F-001'; const store = new StoryStore(root); const ctx = { root, store, scanRoot: root };
  store.writeStory(storyId, { storyId, name: storyId, title: 'Isolated reader attribution fixture', description: 'Not operational qualification.',
    phase: 'REVIEW', type: 'feature', priority: 'low', currentReviewRound: new Date().toISOString(), createdAt: new Date().toISOString(), startedAt: null, endedAt: null, events: [] });
  const observer = 'proof-or-stop-review-concept'; const author = 'proof-or-stop-review-quality'; const independent = 'proof-or-stop-review-test-coverage';
  store.writeChecklist(storyId, { items: [] });
  const signer = findingLedgerSignerFromWorkspace(root);
  const append = (recordType: string, payload: Record<string, unknown>) => {
    const lock = store.runtimeLockDirPath(storyId, 'finding', 'findings');
    withMkdirLock(lock, () => { const fence = captureMkdirLockFence(lock); appendFindingLedger({ storyId, store, operation: recordType === 'finding' ? 'append_finding' : 'append_assessment',
      idempotencyKey: recordType, records: [{ recordType, payload: payload as never }], signer, fence,
      writerSessionId: 'fixture', writerLeaseId: 'fixture', writerFenceToken: fence.writerFenceToken }); }, { requireHolderToken: true });
    return store.readFindingLedger(storyId).records.at(-1)!;
  };
  const reviewRunId = seedCurrentReviewFixture(root, store, storyId, [observer]).get(observer)!;
  append('finding', bindCurrentFixtureFinding({ id: findingId, desc: 'Isolated observation', agent: observer, severity: 'low', category: 'edge',
    status: 'open', evidenceState: 'verified', createdAt: new Date().toISOString(), reviewRunId }) as unknown as Record<string, unknown>);
  const proposal = append('assessment_proposal', { assessedBy: author, verdict: 'applicable', owner: 'current_story', findingRef: { storyId, findingId } });
  const assessmentId = 'assessment-gold';
  const assessment = append('finding_applicability_assessment', { findingId, assessmentId, verdict: 'applicable', dispositionPlan: 'repair_current', gateImpact: 'blocks',
    proposalRef: { storyId, recordId: proposal.recordId, recordHash: exactLedgerRecordHash(proposal) } });
  const deferral = append('finding_deferral_disposition', { findingId, assessmentId, state: 'invalid', lineageState: 'invalid', ownerStoryId: 'B-target',
    expiresAt: new Date(Date.now() + 60000).toISOString(), renewalCount: 0 });
  const mandatory = append('mandatory_repair', { findingId, assessmentId, state: 'required' });
  for (const record of [assessment, deferral, mandatory]) {
    const input = { ref: { storyId, recordId: record.recordId, recordHash: exactLedgerRecordHash(record) },
      expected: qualificationSubjectProjection(record.recordType, record.payload as Record<string, unknown>),
      rationale: 'Isolated attribution test: a separate reader may grade this record, but its own decision author must not self-adjudicate.' };
    try {
      assert.equal(collectQualificationSubjectAdjudications(ctx, [input], independent)[0]!.correct, true);
      assert.throws(() => collectQualificationSubjectAdjudications(ctx, [input], observer), /self-adjudicate/);
      assert.throws(() => collectQualificationSubjectAdjudications(ctx, [input], author), /self-adjudicate/);
      console.log(`QUAL_INDEPENDENCE ${record.recordType} PASS`);
    } catch (error) { failures++; console.error(`QUAL_INDEPENDENCE ${record.recordType} FAIL ${String(error)}`); }
  }
  console.log(`FINDING_QUALIFICATION_INDEPENDENCE ${failures ? 'FAIL' : 'PASS'} ${3 - failures} passed ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
} finally { process.chdir(cwd); resetConfigCache(); rmSync(root, { recursive: true, force: true }); }
