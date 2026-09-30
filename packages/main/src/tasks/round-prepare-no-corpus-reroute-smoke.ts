#!/usr/bin/env node
/**
 * review_round_prepare reroutes a stale automatic no-corpus route without an
 * owner reason (round-prepare-no-corpus-reroute).
 *
 * After a rework round the persisted route is stale (material moved). A stale
 * full-scan route used to demand a new owner fullScanReason even when its
 * full scan was the framework's automatic no-corpus choice, so round 2 of
 * every rework refused again. The reroute must re-derive the automatic
 * reason; a stale full-scan route whose reason came from the owner still
 * needs the owner.
 *
 * Base contract (still asserted): review_round_prepare in a project with no requirements corpus.
 *
 * A benchmark task repo (e.g. a Go project) has no docs/requirements. Routing
 * then always escalates with requirements_corpus_missing, and
 * review_round_prepare used to refuse every round until the owner retried with
 * --fullScanReason (~5 s + one owner turn per round). With no corpus there is
 * nothing to route against, so the framework must take the full-scan path
 * itself and record an automatic reason. Controls: a project that HAS a corpus
 * but whose routing escalates (zero candidates) must still refuse without an
 * explicit fullScanReason, and an explicit reason still wins.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';

const storyId = 'B-rpnr';
const round = '2026-09-30T00:00:00.000Z';
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const MARKER = 'ROUND_PREPARE_REFUSED_WITHOUT_CORPUS';
const REROUTE_MARKER = 'ROUND_PREPARE_STALE_AUTOMATIC_ROUTE_REFUSED';

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** Go task repo; `corpus` adds a requirements corpus unrelated to the Story. */
function fixture(corpus: boolean): { root: string; store: StoryStore } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `round-prepare-${corpus ? 'corpus' : 'no-corpus'}-`)));
  write(root, 'go.mod', 'module example.com/strs\n\ngo 1.22\n');
  write(root, 'strs/strs.go', 'package strs\n\nfunc Upper(s string) string { return s }\n');
  write(root, '.gitignore', '');
  write(root, 'proof-or-stop.config.json', JSON.stringify({ artifactContract: 'none', storyDir: '.proof-or-stop/story/actives' }));
  if (corpus) write(root, 'docs/requirements/decisions/billing.md', '# Invoice ledger\nquarterly invoice ledger reconciliation\n');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Owner']);
  git(['config', 'user.email', 'owner@noreply.local']);
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'rpnc', title: 'Upper string helper', description: 'Implement strs.Upper',
    type: 'bug', phase: 'REVIEW', priority: 'medium', createdAt: round, startedAt: round, endedAt: null,
    currentReviewRound: round, events: [{ phase: 'REVIEW', action: 'advance', timestamp: round }],
  } as never);
  store.writeChecklist(storyId, { items: [
    { id: 'CHK-001', title: 'Upper', context: 'fixture', status: 'done', files: ['strs/strs.go'] },
  ] } as never);
  git(['add', '-A']);
  git(['commit', '-qm', 'proof-or-stop: story metadata']);
  return { root, store };
}

function cli(root: string, payload: Record<string, unknown>): { status: number; out: string; stdout: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROOF_OR_STOP_AGENT: 'main',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'claude-code',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'round-prepare-no-corpus-owner',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: 'main',
  };
  delete env.PROOF_OR_STOP_SESSION_ID;
  delete env.LATTICE_SESSION_ID;
  const run = spawnSync(process.execPath, [CLI, '--root', root, 'review_round_prepare', JSON.stringify(payload)], {
    cwd: root, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024,
  });
  return { status: run.status ?? -1, out: `${run.stdout ?? ''}${run.stderr ?? ''}`, stdout: run.stdout ?? '' };
}

function main(): void {
  const noCorpus = fixture(false);
  const withCorpus = fixture(true);
  try {
    // 1. No corpus: one call routes with an automatic full scan and starts the lanes.
    const first = cli(noCorpus.root, { storyId, json: true });
    assert.equal(first.status, 0, `${MARKER}: review_round_prepare refused in a project with no requirements corpus:\n${first.out.slice(-1500)}`);
    const route = noCorpus.store.readCandidateSpecSet(storyId);
    assert.ok(route, 'candidate route persisted');
    assert.equal(route!.corpusStatus, 'missing');
    assert.equal(route!.fullScan, true, 'no-corpus routing takes the full-scan path');
    assert.match(route!.scanEscalationReason ?? '', /^automatic: no requirements corpus in project /, 'automatic reason recorded');
    assert.match(route!.scanEscalationReason ?? '', /requirements_corpus_missing/, 'the reason names the escalation it resolves');
    const report = JSON.parse(first.stdout) as { reviewRuns: Record<string, string> };
    assert.ok(Object.keys(report.reviewRuns).length >= 1, 'lanes started in the same call');

    // 1b. Rework: material moves, the automatic route is stale; the next round
    //     must reroute (automatic reason again) without an owner reason.
    const commitMaterial = (root: string, body: string) => {
      write(root, 'strs/strs.go', body);
      execFileSync('git', ['add', '-A'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'rework'], { cwd: root });
    };
    commitMaterial(noCorpus.root, 'package strs\n\nimport "strings"\n\nfunc Upper(s string) string { return strings.ToUpper(s) }\n');
    const staleDigest = noCorpus.store.readCandidateSpecSet(storyId)!.artifactDigest;
    const second = cli(noCorpus.root, { storyId, json: true });
    assert.equal(second.status, 0, `${REROUTE_MARKER}: stale automatic no-corpus route demanded an owner reason:\n${second.out.slice(-1500)}`);
    const rerouted = noCorpus.store.readCandidateSpecSet(storyId)!;
    assert.notEqual(rerouted.artifactDigest, staleDigest, 'the route was recomputed for the new material');
    assert.match(rerouted.scanEscalationReason ?? '', /^automatic: no requirements corpus in project /, 'reroute re-derived the automatic reason');

    // 2. Corpus present but routing escalates: the explicit reason is still required.
    const refused = cli(withCorpus.root, { storyId, json: true });
    assert.notEqual(refused.status, 0, 'a present corpus whose routing escalates still refuses without fullScanReason');
    assert.match(refused.out, /fullScanReason/, 'refusal names the missing fullScanReason');
    assert.equal(withCorpus.store.readReviewRuns(storyId).runs.length, 0, 'no ReviewRun started');
    const reason = 'fixture corpus has no document for strs.Upper; scan every decision doc';
    const explicit = cli(withCorpus.root, { storyId, json: true, fullScanReason: reason });
    assert.equal(explicit.status, 0, explicit.out.slice(-1500));
    assert.equal(withCorpus.store.readCandidateSpecSet(storyId)?.scanEscalationReason, reason, 'explicit reason recorded verbatim');
    // 2b. A stale owner-reasoned full-scan route still needs the owner.
    commitMaterial(withCorpus.root, 'package strs\n\nfunc Upper(s string) string { return s + "" }\n');
    const staleOwner = cli(withCorpus.root, { storyId, json: true });
    assert.notEqual(staleOwner.status, 0, 'a stale owner-reasoned full-scan route still requires an explicit fullScanReason');
    assert.match(staleOwner.out, /fullScanReason/);
    console.log('round-prepare-no-corpus-reroute-smoke: PASS (stale automatic route rerouted without owner reason; owner-reasoned stale route still needs the owner)');
  } finally {
    rmSync(noCorpus.root, { recursive: true, force: true });
    rmSync(withCorpus.root, { recursive: true, force: true });
  }
}

main();
