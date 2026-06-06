#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';

type JsonObject = Record<string, any>;

const taskDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(taskDir, '..', 'cli.js');
const root = mkdtempSync(join(tmpdir(), 'lattice-planner-unattended-'));

function run(args: string[]): JsonObject {
  const out = execFileSync(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as JsonObject;
}

function writeConfig(): void {
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  mkdirSync(join(root, 'docs/requirements/decisions'), { recursive: true });
  writeFileSync(join(root, 'docs/requirements/decisions/lattice-authority-live-integration.md'), '# Requirements\n');
  resetConfigCache();
}

try {
  writeConfig();

  const draft = run(['lattice', 'planner', 'draft', '--request=Add a bounded local autopilot smoke command with validation evidence', '--mode=local', '--until=DONE', '--json']);
  assert.equal(draft.schemaVersion, 'lattice.planner_draft.v1');
  assert.equal(draft.interactionMode, 'autonomous');
  assert.equal(draft.status, 'drafted');
  assert.equal(draft.checklist.length, 2);
  assert.equal(draft.deferredOptimizations.length, 1);

  const reviewed = run(['lattice', 'planner', 'review', `--runId=${draft.plannerRunId}`, '--json']);
  assert.equal(reviewed.status, 'pass');

  const job = run(['lattice', 'planner', 'create-job', `--runId=${draft.plannerRunId}`, '--storyId=B-plan', '--json']);
  assert.equal(job.schemaVersion, 'lattice.job_plan.v1');
  assert.equal(job.status, 'planned');
  assert.equal(job.mode, 'local');
  assert(job.plannedSteps.every((step: JsonObject) => !String(step.type).includes('typescript-rust')), 'root step types must not encode language pairs');
  assert(job.coverageMap.every((row: JsonObject) => row.verificationIntentDigest), 'coverage rows must bind verification intent');

  // typed plannedSteps: every step uses a canonical step kind and carries typed evidence bindings
  const PLANNED_STEP_TYPES = ['lattice.command', 'provider.fake', 'provider.codex', 'provider.claude', 'validate.run', 'codex.verify', 'gate.evaluate', 'story.advance', 'stop.summary'];
  assert(job.plannedSteps.length >= 1, 'job plan must contain at least one planned step');
  assert(job.plannedSteps.every((step: JsonObject) => PLANNED_STEP_TYPES.includes(step.type)), 'every planned step must use a canonical typed step kind');
  assert(job.plannedSteps.every((step: JsonObject) => typeof step.stepId === 'string' && typeof step.evidenceBinding === 'string' && step.args && typeof step.args === 'object'), 'planned steps must be fully typed with stepId, evidenceBinding, and args');
  const baseStepTypes = job.plannedSteps.map((step: JsonObject) => step.type);
  assert(baseStepTypes.includes('validate.run') && baseStepTypes.includes('gate.evaluate') && baseStepTypes.includes('stop.summary'), 'job plan must bind validation, gate, and stop-summary steps');

  // story resolve: the first planned step resolves Story context through a typed lattice.command
  const storyResolveStep = job.plannedSteps.find((step: JsonObject) => step.args?.operation === 'story.resolve');
  assert(storyResolveStep, 'planned steps must include a story.resolve context step');
  assert.equal(storyResolveStep.type, 'lattice.command');
  assert.equal(storyResolveStep.args.storyId, 'B-plan');

  const interview = run(['lattice', 'planner', 'draft', '--request=Create an import workflow for customer CSV files', '--interactionMode=interview', '--json']);
  assert.equal(interview.status, 'paused');
  assert(interview.questions.length >= 5 && interview.questions.length <= 10, 'interview must ask 5-10 questions');

  const decisionGated = run(['lattice', 'planner', 'draft', '--request=Add a database migration for account billing records', '--interactionMode=decision-gated', '--json']);
  assert.equal(decisionGated.status, 'paused');
  assert.equal(decisionGated.pauseReason, 'major_decision_required');
  assert(decisionGated.requiredDecisions.length > 0);

  // autonomous mode asks no questions / requires no decisions and stays mechanically resolvable
  assert.equal(draft.questions.length, 0);
  assert.equal(draft.requiredDecisions.length, 0);
  const autonomousStatus = run(['lattice', 'planner', 'status', `--runId=${draft.plannerRunId}`, '--json']);
  assert.equal(autonomousStatus.finalStatus, 'planned');

  // interview mode resolves only after structured answers + explicit confirmation
  assert.equal(interview.pauseReason, 'interview_questions');
  writeFileSync(join(root, 'interview-answers.json'), JSON.stringify({ 'Q-001': 'CSV importer succeeds end to end', confirmed: true }));
  const interviewAnswer = run(['lattice', 'planner', 'answer', `--runId=${interview.plannerRunId}`, '--answersFile=interview-answers.json', '--json']);
  assert.equal(interviewAnswer.status, 'drafted');
  assert(interviewAnswer.confirmationDigest, 'interview confirmation digest must be recorded before resume');
  const interviewResume = run(['lattice', 'planner', 'resume', `--runId=${interview.plannerRunId}`, '--json']);
  assert.equal(interviewResume.status, 'drafted');

  // decision-gated mode resolves only after structured decision evidence
  writeFileSync(join(root, 'decision.json'), JSON.stringify({ 'D-001': 'approved to mutate Story/job', mutateStory: true }));
  const decisionSubmit = run(['lattice', 'planner', 'decision', 'submit', `--runId=${decisionGated.plannerRunId}`, '--decisionFile=decision.json', '--json']);
  assert.equal(decisionSubmit.status, 'drafted');
  assert(decisionSubmit.decisionReceiptDigest, 'decision-gated run must record a decision receipt digest');
  const decisionResume = run(['lattice', 'planner', 'resume', `--runId=${decisionGated.plannerRunId}`, '--json']);
  assert.equal(decisionResume.status, 'drafted');

  const invalidRedevelopment = run([
    'lattice', 'planner', 'draft',
    '--workflow=source-aligned-redevelopment',
    '--request=Rewrite the source project into Rust with behavior parity',
    '--sourceRepo=source',
    '--targetProject=target',
    '--targetProjectName=target-rs',
    '--sourceLanguage=typescript',
    '--targetLanguage=rust',
    '--json',
  ]);
  const invalidReview = run(['lattice', 'planner', 'review', `--runId=${invalidRedevelopment.plannerRunId}`, '--json']);
  assert.equal(invalidReview.status, 'blocked');
  assert(invalidReview.issues.some((issue: JsonObject) => issue.id === 'SRC-languageAdapterPolicy'));
  assert(invalidReview.issues.some((issue: JsonObject) => issue.id === 'SRC-parityOraclePolicy'));

  mkdirSync(join(root, 'source/src'), { recursive: true });
  writeFileSync(join(root, 'source/src/index.ts'), 'export function add(a:number,b:number){ return a + b; }\n');
  writeFileSync(join(root, 'source/.env'), 'SECRET=must-not-appear\n');
  const manifest = run(['lattice', 'planner', 'source-manifest', '--sourceRepo=source', '--includedPaths=src', '--json']);
  assert.equal(manifest.blocked, false);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].path, 'src/index.ts');
  assert(!JSON.stringify(manifest).includes('must-not-appear'));
  assert(!manifest.files.some((file: JsonObject) => file.path === '.env' || file.path.endsWith('/.env')), 'source manifest must exclude .env secrets by path, not merely omit their contents');

  const validRedevelopment = run([
    'lattice', 'planner', 'draft',
    '--workflow=source-aligned-redevelopment',
    '--request=Rewrite the source project into Rust with behavior parity',
    '--sourceRepo=source',
    '--targetProject=target',
    '--targetProjectName=target-rs',
    '--sourceLanguage=typescript',
    '--targetLanguage=rust',
    '--includedPaths=src',
    '--languageAdapterPolicy={"adapterRegistryRef":"local","requiredAdapters":["typescript","rust"],"adapterUnavailableBehavior":"block"}',
    '--semanticMappingPolicy={"allowedMappingKinds":["1:1","1:N","N:1","mapped_to_gap"],"requiresMappingRationale":true,"forbidOptimizationForItsOwnSake":true}',
    '--parityOraclePolicy={"allowedOracleKinds":["target_build","target_test","cli_golden"],"sourceOnlyBehavior":"gap","requiresTargetRunnableEvidence":true}',
    '--alignmentVerificationIntent=build parity,target runnable tests',
    '--json',
  ]);
  const validReview = run(['lattice', 'planner', 'review', `--runId=${validRedevelopment.plannerRunId}`, '--json']);
  assert.equal(validReview.status, 'pass');
  const redevJob = run(['lattice', 'planner', 'create-job', `--runId=${validRedevelopment.plannerRunId}`, '--storyId=B-redev', '--json']);
  const operations = redevJob.plannedSteps.map((step: JsonObject) => step.args?.operation).filter(Boolean);
  assert(operations.includes('language.resolve_adapters'));
  assert(operations.includes('target.run_parity_oracles'));
  assert(redevJob.plannedSteps.every((step: JsonObject) => ['lattice.command', 'provider.fake', 'validate.run', 'gate.evaluate', 'stop.summary'].includes(step.type)));

  // cross-language proof: the planner is target-agnostic. The same TypeScript source redevelops into
  // multiple targets with identical canonical operations; language ids stay abstract policy strings, no
  // planned step kind hardcodes a single target, and target-runnable parity/gap rules hold per target.
  for (const targetLanguage of ['rust', 'python', 'go', 'swift', 'kotlin']) {
    const xlangDraft = run([
      'lattice', 'planner', 'draft',
      '--workflow=source-aligned-redevelopment',
      `--request=Rewrite the source project into ${targetLanguage} with behavior parity`,
      '--sourceRepo=source',
      '--targetProject=target',
      `--targetProjectName=target-${targetLanguage}`,
      '--sourceLanguage=typescript',
      `--targetLanguage=${targetLanguage}`,
      '--includedPaths=src',
      `--languageAdapterPolicy={"adapterRegistryRef":"local","requiredAdapters":["typescript","${targetLanguage}"],"adapterUnavailableBehavior":"block"}`,
      '--semanticMappingPolicy={"allowedMappingKinds":["1:1","1:N","N:1","mapped_to_gap"],"requiresMappingRationale":true,"forbidOptimizationForItsOwnSake":true}',
      '--parityOraclePolicy={"allowedOracleKinds":["target_build","target_test","cli_golden"],"sourceOnlyBehavior":"gap","requiresTargetRunnableEvidence":true}',
      '--alignmentVerificationIntent=build parity,target runnable tests',
      '--json',
    ]);
    const xlangReview = run(['lattice', 'planner', 'review', `--runId=${xlangDraft.plannerRunId}`, '--json']);
    assert.equal(xlangReview.status, 'pass', `source-aligned redevelopment into ${targetLanguage} must pass review with no target-specific policy`);
    const xlangJob = run(['lattice', 'planner', 'create-job', `--runId=${xlangDraft.plannerRunId}`, `--storyId=B-redev-${targetLanguage}`, '--json']);
    const xlangOps = xlangJob.plannedSteps.map((step: JsonObject) => step.args?.operation).filter(Boolean);
    // canonical operations are identical across targets: adapters resolve, target oracles run, gaps recorded
    assert(xlangOps.includes('language.resolve_adapters'), `language adapters must resolve for ${targetLanguage}`);
    assert(xlangOps.includes('target.run_parity_oracles'), `target-runnable parity oracles must run for ${targetLanguage}`);
    assert(xlangOps.includes('source.record_gaps'), `source-only constructs must record gaps for ${targetLanguage}`);
    // no planned step kind bakes a single target language (or a TS→target pair) into the schema
    assert(xlangJob.plannedSteps.every((step: JsonObject) => !String(step.type).toLowerCase().includes(targetLanguage) && !String(step.type).includes('typescript-')), `planned step types must not hardcode the ${targetLanguage} target`);
    // language ids round-trip as abstract policy strings, not enumerated step kinds
    const adapterStep = xlangJob.plannedSteps.find((step: JsonObject) => step.args?.operation === 'language.resolve_adapters');
    assert.deepEqual(adapterStep.args.sourceAlignedRedevelopmentSpec.languageAdapterPolicy.requiredAdapters, ['typescript', targetLanguage], `language ids must stay abstract strings for ${targetLanguage}`);
    // target-runnable parity + source-only gap rules are asserted, not optimized away
    const parityStep = xlangJob.plannedSteps.find((step: JsonObject) => step.args?.operation === 'target.run_parity_oracles');
    const parityPolicy = parityStep.args.sourceAlignedRedevelopmentSpec.parityOraclePolicy;
    assert.equal(parityPolicy.requiresTargetRunnableEvidence, true, `${targetLanguage} parity must require target-runnable evidence`);
    assert.equal(parityPolicy.sourceOnlyBehavior, 'gap', `${targetLanguage} source-only constructs must become gaps, not silent drops`);
  }

  // block rule remains non-vacuous across targets: a missing policy blocks regardless of target language
  const blockedGo = run([
    'lattice', 'planner', 'draft',
    '--workflow=source-aligned-redevelopment',
    '--request=Rewrite the source project into Go with behavior parity',
    '--sourceRepo=source',
    '--targetProject=target',
    '--targetProjectName=target-go',
    '--sourceLanguage=typescript',
    '--targetLanguage=go',
    '--includedPaths=src',
    '--json',
  ]);
  const blockedGoReview = run(['lattice', 'planner', 'review', `--runId=${blockedGo.plannerRunId}`, '--json']);
  assert.equal(blockedGoReview.status, 'blocked', 'missing redevelopment policies must block any target, not just rust');
  assert(blockedGoReview.issues.some((issue: JsonObject) => issue.id === 'SRC-languageAdapterPolicy'));
  assert(blockedGoReview.issues.some((issue: JsonObject) => issue.id === 'SRC-parityOraclePolicy'));

  const v1 = run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-plan', '--runId=run-1', '--hostId=codex-host', '--provider=codex', '--sessionId=s1', '--decision=pass', '--materialDigest=mat-1', '--json']);
  const v2 = run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-plan', '--runId=run-1', '--hostId=gemini-host', '--provider=gemini', '--sessionId=s2', '--decision=pass', '--materialDigest=mat-1', '--json']);
  const v3 = run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-plan', '--runId=run-1', '--hostId=codex-host', '--provider=codex', '--sessionId=s1', '--decision=pass', '--materialDigest=mat-1', '--json']);
  assert.equal(v1.schemaVersion, 'lattice.host_verdict.v1');
  assert.equal(v2.schemaVersion, 'lattice.host_verdict.v1');
  assert.equal(v3.schemaVersion, 'lattice.host_verdict.v1');
  const localSummary = run(['lattice', 'autopilot', 'review', 'status', '--storyId=B-plan', '--runId=run-1', '--json']);
  assert.equal(localSummary.status, 'pass');
  assert.equal(localSummary.localReviewCertified, true);
  assert.equal(localSummary.authorityDone, false);
  assert.equal(localSummary.fullAuthorityDone, false);
  assert.equal(localSummary.duplicateVerdicts, 1);

  // Authority host verdicts are host opinions, not verified native gate_decision receipts.
  // Per docs/requirements/decisions/lattice-authority-live-integration.md, native receipt
  // verification is owned by the authority executor/verifier; the verdict summary reports a passing
  // multi-host wave (multiHostVerified=true) but must NEVER set authorityDone from host agreement.
  // (fullAuthorityDone is intentionally not asserted here: its receipt-coupling is owned by the
  // executor/verifier path and is the subject of active design, so this smoke pins only the durable
  // invariant — host verdicts never mint native-receipt authorityDone.)
  run(['lattice', 'authority', 'verdict', 'submit', '--jobId=job-1', '--runId=run-2', '--hostId=claude-host', '--provider=claude', '--sessionId=s3', '--decision=pass', '--materialDigest=mat-2', '--json']);
  run(['lattice', 'authority', 'verdict', 'submit', '--jobId=job-1', '--runId=run-2', '--hostId=gemini-host', '--provider=gemini', '--sessionId=s4', '--decision=pass', '--materialDigest=mat-2', '--json']);
  const authoritySummary = run(['lattice', 'authority', 'verdict', 'list', '--jobId=job-1', '--runId=run-2', '--json']);
  assert.equal(authoritySummary.status, 'pass');
  assert.equal(authoritySummary.multiHostVerified, true);
  assert.equal(authoritySummary.authorityDone, false, 'host verdicts do not replace verified native gate_decision receipts');

  // authority job status projects the verdict summary without minting or replacing native receipts
  const authorityJobStatus = run(['lattice', 'authority', 'job', 'status', '--jobId=job-1', '--runId=run-2', '--json']);
  assert.equal(authorityJobStatus.schemaVersion, 'lattice.authority_job_status.v1');
  assert.equal(authorityJobStatus.status, 'pass');
  assert.equal(authorityJobStatus.passingIndependentHosts, 2);
  assert.equal(authorityJobStatus.multiHostVerified, true);
  assert.equal(authorityJobStatus.authorityDone, false, 'job status must not claim native authorityDone from host verdicts alone');
  assert.equal(authorityJobStatus.nativeReceiptRequired, true);

  // multi-host gate is non-vacuous: a single independent host blocks both local review and authority job status
  const soloLocal = run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-solo', '--runId=run-solo', '--hostId=codex-host', '--provider=codex', '--sessionId=s-solo', '--decision=pass', '--materialDigest=mat-solo', '--json']);
  assert.equal(soloLocal.schemaVersion, 'lattice.host_verdict.v1');
  const soloLocalStatus = run(['lattice', 'autopilot', 'review', 'status', '--storyId=B-solo', '--runId=run-solo', '--json']);
  assert.equal(soloLocalStatus.status, 'blocked');
  assert.equal(soloLocalStatus.localReviewCertified, false);
  assert.equal(soloLocalStatus.multiHostVerified, false);

  run(['lattice', 'authority', 'verdict', 'submit', '--jobId=job-solo', '--runId=run-solo', '--hostId=claude-host', '--provider=claude', '--sessionId=s-solo', '--decision=pass', '--materialDigest=mat-solo', '--json']);
  const soloAuthorityStatus = run(['lattice', 'authority', 'job', 'status', '--jobId=job-solo', '--runId=run-solo', '--json']);
  assert.equal(soloAuthorityStatus.status, 'blocked');
  assert.equal(soloAuthorityStatus.fullAuthorityDone, false);
  assert.equal(soloAuthorityStatus.multiHostVerified, false);
  assert(soloAuthorityStatus.blockedReason, 'single-host authority job status must explain the multi-host shortfall');
} finally {
  resetConfigCache();
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ planner unattended smoke passed: autonomous/interview/decision-gated modes, source-aligned redevelopment block/pass, typed plannedSteps + story.resolve, authority job status, and multi-host local/authority verdict block/pass verified');
