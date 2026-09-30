/**
 * Table-driven regression for the managed live-binding lineage across every
 * TEST/DONE-phase metadata writer. Run 13 (2026-10-01): the owner satisfied the
 * review assurance floor with quorum_submit; its lifecycle commit subject
 * `quorum-submit` was not an authenticated publisher, so done_prepare refused
 * every managed pass, and the printed Next (review_round_prepare) was invalid
 * in TEST. Positive rows keep a managed pass live; negative rows (review
 * evidence, material, rewritten or foreign rows) still break it and name the
 * rule; the recovery Next is valid in the Story's phase.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {currentGitHead, currentMaterialHash, currentStoryFilesHash} from '../dist/core/evidence-freshness.js';
import {verifyManagedReviewLiveBinding} from '../dist/core/managed-review-evidence.js';
import {managedLineageRecoveryNext} from '../dist/core/review-run.js';

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
    'review_host_availability_probe', 'review_escalation_fallback_set', 'review_escalation_policy_set'];
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
    ['unlisted subject', 'checklist_update', f => appendFileSync(join(f.storyDir, 'process-events.jsonl'), event('x')), /not an authenticated review-maintenance publisher/],
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
  console.log('BOOKKEEPING_SUBJECT_LINEAGE_GREEN');
} finally {
  for (const root of roots) rmSync(root, {recursive: true, force: true});
}
