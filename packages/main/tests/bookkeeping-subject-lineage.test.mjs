/**
 * Table-driven regression for the managed live-binding lineage across every
 * REVIEW/TEST/DONE-phase metadata writer. Run 13 (2026-10-01): the owner satisfied the
 * review assurance floor with quorum_submit; its lifecycle commit subject
 * `quorum-submit` was not an authenticated publisher, so done_prepare refused
 * every managed pass, and the printed Next (review_round_prepare) was invalid
 * in TEST. Positive rows keep a managed pass live; negative rows (review
 * evidence, material, rewritten or foreign rows) still break it and name the
 * rule; the recovery Next is valid in the Story's phase.
 *
 * Old-PoS run 25 (F3, B-2b04 1faa99b): the framework's own
 * `verification_evidence_refresh_stale` restamp in REVIEW was not an
 * authenticated publisher, so it staled the managed passes it had just
 * imported (23 ReviewRuns on 9 heads for two material states). Every writer
 * reachable in REVIEW is now classified too: a content-authenticated
 * lineage-neutral publisher (REVIEW_MAINTENANCE_PUBLISHERS, PRE_CERT
 * bookkeeping, the importer) or deliberately refused because it changes what
 * the reviewers bound. A new unclassified writer fails this table.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {currentGitHead, currentMaterialHash, currentStoryFilesHash} from '../dist/core/evidence-freshness.js';
import {PRECERT_METADATA_COMMANDS, verifyManagedReviewLiveBinding} from '../dist/core/managed-review-evidence.js';
import {managedLineageRecoveryNext} from '../dist/core/review-run.js';
import {REVIEW_MAINTENANCE_PUBLISHERS} from '../dist/core/review-maintenance-lineage.js';

const storyId = 'B-bookkeep';
const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bookkeeping-subject-lineage-'));
  roots.push(root);
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'lab@example.test'); git('config', 'user.name', 'lab');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({storyDir: '.proof-or-stop/story/actives', storyPrefix: 'B'}));
  writeFileSync(join(root, 'main.go'), 'package main\n');
  const storyDir = join(root, '.proof-or-stop', 'story', 'actives', storyId);
  mkdirSync(storyDir, {recursive: true});
  writeFileSync(join(storyDir, 'story.json'), '{}\n');
  writeFileSync(join(storyDir, 'process-events.jsonl'), `${JSON.stringify({type: 'phase_transition', to: 'TEST'})}\n${JSON.stringify({type: 'host_verdict', runId: 'r0'})}\n`);
  writeFileSync(join(storyDir, 'review-passes.json'), '{"passes":[]}\n');
  writeFileSync(join(storyDir, 'review-runs.json'), '{"runs":[{"reviewRunId":"RR-001"}]}\n');
  writeFileSync(join(storyDir, 'checklist.json'), `${JSON.stringify({items: [{id: 'CHK-001', title: 'x', status: 'done', verificationIntent: {happy: [{id: 'CHK-001:happy:0', desc: 'x'}]}, verificationEvidence: []}]})}\n`);
  git('add', '-A'); git('commit', '-qm', 'reviewed candidate');
  const expected = {headHash: currentGitHead(root), materialHash: currentMaterialHash(root, 'HEAD', root), storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)};
  const commit = (subject) => { git('add', '-A'); git('commit', '-qm', `proof-or-stop: record ${storyId} ${subject} metadata`); return git('rev-parse', 'HEAD'); };
  const live = () => verifyManagedReviewLiveBinding({gitCwd: root, metadataRoot: root, storyId, expected});
  return {root, storyDir, commit, live};
}
const event = (type) => `${JSON.stringify({type, at: new Date().toISOString()})}\n`;

try {
  // Positive: every TEST/DONE bookkeeping writer that may commit story metadata.
  const bookkeeping = ['TEST', 'DONE', 'delivery_check_set', 'delivery_waiver_add', 'summary_set', 'evaluate_save', 'live_smoke_transcript',
    'done_prepare', 'done_required_validate', 'certification_window_cancel',
    'review_host_availability_probe', 'review_escalation_fallback_set', 'review_escalation_policy_set', 'delivery_context_pack'];
  for (const subject of bookkeeping) {
    const f = fixture();
    appendFileSync(join(f.storyDir, 'process-events.jsonl'), event('bookkeeping'));
    writeFileSync(join(f.storyDir, 'delivery-check.json'), `{"subject":"${subject}"}\n`);
    f.commit(subject);
    const verdict = f.live();
    assert.equal(verdict.valid, true, `${subject}: bookkeeping commit invalidated a managed pass: ${verdict.reason} ${JSON.stringify(verdict.lineageRefusal)}`);
  }
  // Positive: host-verdict writers append only their host_verdict rows.
  for (const subject of ['autopilot_review_submit', 'quorum-submit']) {
    const f = fixture();
    appendFileSync(join(f.storyDir, 'process-events.jsonl'), event('host_verdict') + event('host_verdict'));
    f.commit(subject);
    assert.equal(f.live().valid, true, `${subject}: appended host_verdict rows must keep the pass live (QUORUM_SUBMIT_LINEAGE_RED)`);
  }
  // Positive: the Codex command terminal (validate / story_advance TEST) appends only its codex_cli row.
  {
    const f = fixture();
    appendFileSync(join(f.storyDir, 'process-events.jsonl'), event('codex_cli'));
    f.commit('codex-command-terminal');
    assert.equal(f.live().valid, true, 'codex-command-terminal: an appended codex_cli row keeps the pass live');
  }
  // Positive: quorum_prune (same subject) drops a duplicate host_verdict row.
  {
    const f = fixture();
    writeFileSync(join(f.storyDir, 'process-events.jsonl'), `${JSON.stringify({type: 'phase_transition', to: 'TEST'})}\n`);
    f.commit('quorum-submit');
    assert.equal(f.live().valid, true, 'quorum_prune dropping a host_verdict row keeps the pass live');
  }

  // Negatives: host-verdict writers.
  const negatives = [
    ['autopilot_review_submit touching review-passes', 'autopilot_review_submit', f => writeFileSync(join(f.storyDir, 'review-passes.json'), '{"passes":[{"id":"forged"}]}\n'), /commits only process-events\.jsonl/],
    ['quorum-submit touching findings', 'quorum-submit', f => writeFileSync(join(f.storyDir, 'findings.json'), '{"findings":[]}\n'), /commits only process-events\.jsonl/],
    ['quorum-submit appending a non-verdict row', 'quorum-submit', f => appendFileSync(join(f.storyDir, 'process-events.jsonl'), event('phase_transition')), /beyond its own host_verdict rows/],
    ['quorum-submit rewriting an earlier row', 'quorum-submit', f => writeFileSync(join(f.storyDir, 'process-events.jsonl'), `${JSON.stringify({type: 'phase_transition', to: 'DONE'})}\n${JSON.stringify({type: 'host_verdict', runId: 'r0'})}\n`), /beyond its own host_verdict rows/],
    ['autopilot_review_submit dropping a row', 'autopilot_review_submit', f => writeFileSync(join(f.storyDir, 'process-events.jsonl'), `${JSON.stringify({type: 'phase_transition', to: 'TEST'})}\n`), /beyond its own host_verdict rows/],
    ['quorum-submit changing material', 'quorum-submit', f => writeFileSync(join(f.root, 'main.go'), 'package main\n// changed\n'), /./],
    ['summary_set touching review-passes', 'summary_set', f => writeFileSync(join(f.storyDir, 'review-passes.json'), '{"passes":[{"id":"forged"}]}\n'), /review evidence .*review-passes\.json/],
    ['review_escalation_fallback_set touching findings', 'review_escalation_fallback_set', f => writeFileSync(join(f.storyDir, 'findings.json'), '{"findings":[]}\n'), /review evidence .*findings\.json/],
    ['codex-command-terminal appending a host_verdict row', 'codex-command-terminal', f => appendFileSync(join(f.storyDir, 'process-events.jsonl'), event('host_verdict')), /beyond its own codex_cli rows/],
    ['codex-command-terminal touching story.json', 'codex-command-terminal', f => writeFileSync(join(f.storyDir, 'story.json'), '{"phase":"DONE"}\n'), /commits only process-events\.jsonl/],
    ['quorum-submit pruning a non-verdict row', 'quorum-submit', f => writeFileSync(join(f.storyDir, 'process-events.jsonl'), `${JSON.stringify({type: 'host_verdict', runId: 'r0'})}\n`), /beyond its own host_verdict rows/],
    ['delivery_context_pack touching review-passes', 'delivery_context_pack', f => writeFileSync(join(f.storyDir, 'review-passes.json'), '{"passes":[{"id":"forged"}]}\n'), /review evidence .*review-passes\.json/],
    ['unlisted subject', 'checklist_update', f => appendFileSync(join(f.storyDir, 'process-events.jsonl'), event('x')), /not an authenticated review-maintenance publisher/],
    // Run 25 F3: the restamp is authenticated by content, never by subject alone.
    ['refresh_stale touching only process events', 'verification_evidence_refresh_stale', f => appendFileSync(join(f.storyDir, 'process-events.jsonl'), event('x')), /verification_evidence_refresh_stale publication is not an exact evidence restamp/],
    ['refresh_stale touching review-passes', 'verification_evidence_refresh_stale', f => writeFileSync(join(f.storyDir, 'review-passes.json'), '{"passes":[{"id":"forged"}]}\n'), /verification_evidence_refresh_stale publication is not an exact evidence restamp/],
    ['refresh_stale changing an intent', 'verification_evidence_refresh_stale', f => writeFileSync(join(f.storyDir, 'checklist.json'), `${JSON.stringify({items: [{id: 'CHK-001', title: 'x', status: 'done', verificationIntent: {happy: [{id: 'CHK-001:happy:0', desc: 'changed'}]}, verificationEvidence: []}]})}\n`), /verification_evidence_refresh_stale publication is not an exact evidence restamp/],
    ['refresh_stale rewriting a swept launch record', 'verification_evidence_refresh_stale', f => {
      writeFileSync(join(f.storyDir, 'checklist.json'), `${JSON.stringify({items: [{id: 'CHK-001', title: 'x', status: 'done', verificationIntent: {happy: [{id: 'CHK-001:happy:0', desc: 'x'}]}, verificationEvidence: [{intentRef: 'CHK-001:happy:0', kind: 'logic_test', result: 'pass'}]}]})}\n`);
      writeFileSync(join(f.storyDir, 'review-runs.json'), '{"runs":[{"reviewRunId":"forged"}]}\n');
    }, /verification_evidence_refresh_stale publication is not an exact evidence restamp/],
    ['refresh_stale changing material', 'verification_evidence_refresh_stale', f => writeFileSync(join(f.root, 'main.go'), 'package main\n// changed\n'), /./],
  ];
  for (const [label, subject, mutate, rule] of negatives) {
    const f = fixture();
    mutate(f);
    const sha = f.commit(subject);
    const verdict = f.live();
    assert.equal(verdict.valid, false, `${label}: must invalidate the managed pass`);
    if (verdict.lineageRefusal) {
      assert.equal(verdict.lineageRefusal.commit, sha, `${label}: names the refused commit`);
      assert.match(verdict.lineageRefusal.rule, rule, `${label}: names the rule`);
    } else {
      assert.match(verdict.reason, /managed_review_live_material_stale/, `${label}: material change is refused as stale material`);
    }
  }

  // Recovery Next is valid in the Story's phase; never REVIEW-only outside REVIEW.
  assert.match(managedLineageRecoveryNext(storyId, 'REVIEW'), /^Next: proof-or-stop review_round_prepare --storyId=B-bookkeep$/);
  assert.match(managedLineageRecoveryNext(storyId, 'TEST'), /^Next: proof-or-stop story_advance --storyId=B-bookkeep --phase=DEV; why: /);
  assert.match(managedLineageRecoveryNext(storyId, 'DEV'), /^Next: proof-or-stop story_advance --storyId=B-bookkeep --phase=REVIEW; why: /);
  for (const phase of ['TEST', 'DEV', 'DONE', undefined]) assert.doesNotMatch(managedLineageRecoveryNext(storyId, phase), /review_round_prepare --storyId=\S+$/);
  // Writer audit: every story-metadata commit subject emitted by src/ whose
  // command can run in TEST or DONE is classified here. A new TEST/DONE writer
  // fails this table until it is either authenticated (PRECERT bookkeeping or a
  // review-maintenance publisher) or deliberately refused with a reason.
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  // Content-authenticated review-maintenance publishers (core/review-maintenance-lineage.ts).
  const reviewMaintenance = new Set(REVIEW_MAINTENANCE_PUBLISHERS);
  for (const subject of ['verification_evidence_add', 'verification_evidence_refresh_stale', 'finding_resolve', 'review epoch', 'certification_window_begin', 'validate', 'test-transition']) {
    assert.ok(reviewMaintenance.has(subject), `${subject} is a content-authenticated review-maintenance publisher`);
  }
  const refusedInTest = {
    // These change the acceptance basis / reviewed story files the managed pass bound;
    // the refusal Next sends a TEST Story back through DEV to REVIEW.
    artifact_declare: 'declares delivery artifacts the reviewers bound', candidate_spec_route: 'reroutes candidate specs',
    parent_ledger_rollup_set: 'rewrites the parent ledger', scope_shrinkage_decision_set: 'changes the reviewed scope',
    verification_evidence_batch_add: 'adds verification evidence outside the authenticated single-add refresh',
    verification_intent_repair: 'changes verification intent',
    verification_pin_narrow: 'narrows verification pins', verification_run: 'records new verification runs',
    test_add: 'adds test cases', test_story: 'records story tests',
  };
  // TEST/DONE-phase commands that never create a Story-metadata commit.
  const nonCommitting = {
    done_closure: ['handlers/done-closure.ts', 'readOnly DONE oracle projection'],
    dev_memory_finish_decision: ['handlers/playbook-runtime-memory.ts', 'writes dev-memory runtime storage, not story metadata'],
    done_recover: ['handlers/done-recover.ts', 'post-DONE recovery merge on the integration branch; no managed pass is re-checked after it'],
  };
  const policy = readFileSync(join(src, 'core', 'command-policy.ts'), 'utf8');
  const phasesOf = (command) => {
    const line = policy.split('\n').find(row => row.startsWith(`  ${command}: {`));
    if (!line) return null;
    const match = line.match(/allowedPhases: (\[[^\]]*\]|'all')/);
    return match ? (match[1] === "'all'" ? 'all' : match[1]) : 'all';
  };
  const reachableInTestOrDone = (command) => { const phases = phasesOf(command); return phases === null || phases === 'all' || /'TEST'|'DONE'/.test(phases); };
  const walk = (dir) => readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? (entry.name === 'tasks' ? [] : walk(join(dir, entry.name))) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
  const subjects = new Set();
  for (const file of walk(src)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/autoCommitStoryMetadata\([^,]+,\s*[^,]+,\s*'([a-z_]+)'/g)) subjects.add(match[1]);
    for (const match of text.matchAll(/kind: '([a-z-]+)',/g)) if (/captureLifecycleMetadataTransaction/.test(text)) subjects.add(match[1]);
  }
  assert.ok(subjects.has('quorum-submit') && subjects.has('codex-command-terminal') && subjects.has('summary_set'), `writer scan found the known writers: ${[...subjects].join(', ')}`);
  const authenticated = new Set([...PRECERT_METADATA_COMMANDS, ...reviewMaintenance]);
  const unclassified = [...subjects].filter(subject => (subject.includes('-') || reachableInTestOrDone(subject))
    && !authenticated.has(subject) && !Object.hasOwn(refusedInTest, subject));
  assert.deepEqual(unclassified, [], `TEST/DONE metadata writers neither authenticated nor deliberately refused: ${unclassified.join(', ')}`);
  for (const subject of Object.keys(refusedInTest)) {
    assert.ok(!authenticated.has(subject), `${subject} is listed as refused but is authenticated`);
    const f = fixture();
    appendFileSync(join(f.storyDir, 'process-events.jsonl'), event('x'));
    f.commit(subject);
    assert.match(f.live().lineageRefusal?.rule ?? '', /not an authenticated review-maintenance publisher/, `${subject}: refused in TEST`);
  }
  // REVIEW-phase writer audit (run 25 F3). Besides the literal writers above,
  // the review-result batch (commitReviewResultMetadata reason), the
  // certification persistHint commands and the lifecycle phase records commit
  // story metadata in REVIEW.
  const reviewSubjects = new Set(subjects);
  for (const file of walk(src)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/commitReviewResultMetadata\(\{[^}]*reason: '([a-z_]+)'/g)) reviewSubjects.add(match[1]);
    for (const match of text.matchAll(/persistHint\([^,]+,\s*[^,]+,\s*'([a-z_]+)'/g)) reviewSubjects.add(match[1]);
  }
  for (const phase of ['REVIEW', 'DEV', 'TEST', 'DONE']) reviewSubjects.add(phase);
  assert.ok(reviewSubjects.has('managed_review_evidence_import') && reviewSubjects.has('certification_window_begin'), `REVIEW writer scan found the batch writers: ${[...reviewSubjects].join(', ')}`);
  const reachableInReview = (command) => { const phases = phasesOf(command); return phases === null || phases === 'all' || /'REVIEW'/.test(phases); };
  // Lineage-neutral in REVIEW without a subject rule of its own: the importer (importerCommitRefusal).
  const importer = new Set(['managed_review_evidence_import']);
  const refusedInReview = {
    ...Object.fromEntries(Object.entries(refusedInTest).filter(([subject]) => reachableInReview(subject))),
    acceptance_basis_generate: 'regenerates the signed acceptance basis the reviewers bound',
    topology_critic_receipt_set: 'records the topology critic verdict the reviewers bound',
    topology_exclusion_approval_set: 'approves a topology exclusion the reviewers bound',
    stall_resolution_set: 'owner adjudication of a stalled round: a decision, not framework bookkeeping',
    finding_add: 'records new reviewer evidence (native path); a newer lane run supersedes it',
    review_pass_set: 'records new reviewer evidence (native path); a newer lane run supersedes it',
    REVIEW: 'phase entry opens a new review round; its lanes bind after this commit',
    DEV: 'phase record: remediation leaves REVIEW',
  };
  const unclassifiedReview = [...reviewSubjects].filter(subject => (subject.includes('-') || /^[A-Z]+$/.test(subject) || reachableInReview(subject))
    && !authenticated.has(subject) && !importer.has(subject) && !Object.hasOwn(refusedInReview, subject));
  assert.deepEqual(unclassifiedReview, [], `REVIEW metadata writers neither authenticated (lineage-neutral) nor deliberately refused: ${unclassifiedReview.join(', ')}`);
  for (const subject of Object.keys(refusedInReview)) {
    assert.ok(!authenticated.has(subject), `${subject} is listed as refused in REVIEW but is authenticated`);
    const f = fixture();
    appendFileSync(join(f.storyDir, 'process-events.jsonl'), event('x'));
    f.commit(subject);
    assert.match(f.live().lineageRefusal?.rule ?? '', /not an authenticated review-maintenance publisher/, `${subject}: refused in REVIEW`);
  }
  for (const [command, [file, why]] of Object.entries(nonCommitting)) {
    const text = readFileSync(join(src, file), 'utf8');
    assert.doesNotMatch(text, /autoCommitStoryMetadata|commitLifecycleMetadataTransaction/, `${command} (${why}) must not commit story metadata`);
  }
  assert.match(policy.split('\n').find(row => row.startsWith('  done_closure: {')) ?? '', /ownershipClass: 'readOnly'/, 'done_closure stays readOnly');
  console.log('BOOKKEEPING_SUBJECT_LINEAGE_GREEN');
} finally {
  for (const root of roots) rmSync(root, {recursive: true, force: true});
}
