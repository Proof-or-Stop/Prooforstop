#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRoutineValidationIdentity,
  classifyTrustedValidationLineage,
  evaluateRoutineValidationReuse,
  isCompleteRoutineValidationIdentity,
  summarizeRoutineCommandExecution,
} from '../core/validation-evidence-reuse.js';
import { captureEvidenceHashSnapshot, checkEvidenceHashSnapshotReuse } from '../core/evidence-freshness.js';
import type { TestEvidenceData, VerificationCoverageReport } from '../core/types.js';
import type { RoutineValidationIdentity, RoutineValidationSourceKind, ValidationCommand } from '../core/validation-types.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'validation-reuse-smoke',
      GIT_AUTHOR_EMAIL: 'validation-reuse-smoke@example.com',
      GIT_COMMITTER_NAME: 'validation-reuse-smoke',
      GIT_COMMITTER_EMAIL: 'validation-reuse-smoke@example.com',
    },
  }).trim();
}

function cliPath(): string {
  return join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'cli.js');
}

function assertHandlerExecutedThenReused(
  sourceKind: 'configured' | 'fallback' | 'validate-file',
  commandCount = 1,
  semanticResult?: Record<string, unknown>,
): void {
  const root = mkdtempSync(join(tmpdir(), `lattice-validation-reuse-${sourceKind}-`));
  const counterPath = join(tmpdir(), `lattice-validation-reuse-counter-${process.pid}-${Date.now()}.log`);
  const storyId = 'B-reuse-handler';
  try {
    writeFileSync(join(root, '.gitignore'), '.lattice/activity.jsonl\n.lattice/locks/\n', 'utf8');
    writeFileSync(join(root, 'probe.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.VALIDATION_REUSE_SMOKE_COUNTER, 'run\\n'); console.log('handler probe PASS');\n`, 'utf8');
    writeFileSync(join(root, 'source.ts'), 'export const handlerReuse = true;\n', 'utf8');
    const configuredCommands = Array.from({ length: commandCount }, (_, index) => ({
      label: `handler probe ${index + 1}`,
      command: process.execPath,
      args: ['probe.mjs'],
      timeoutMs: 10_000,
    }));
    writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
      scanRoot: '.',
      rootDir: '.',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'light' },
      ...(sourceKind === 'configured' ? { validate: { commands: configuredCommands } } : {}),
    }, null, 2), 'utf8');
    if (sourceKind === 'fallback') {
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'validation-reuse-fallback-smoke',
        private: true,
        scripts: { test: 'node probe.mjs' },
      }, null, 2), 'utf8');
    }
    if (sourceKind === 'validate-file') {
      const result = semanticResult ?? {
        provider: 'validate-file-smoke',
        status: 'pass',
        allPass: true,
        summary: 'semantic PASS',
        details: [],
        warnings: [],
      };
      writeFileSync(join(root, 'validate.ts'), [
        "import { appendFileSync } from 'node:fs';",
        "appendFileSync(process.env.VALIDATION_REUSE_SMOKE_COUNTER!, 'run\\n');",
        `console.log(JSON.stringify(${JSON.stringify(result)}));`,
        '',
      ].join('\n'), 'utf8');
    }
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    const now = '2026-07-16T00:00:00.000Z';
    const story: StoryInfo = {
      storyId,
      name: 'reuse-handler',
      title: 'reuse handler smoke',
      description: `Proves ${sourceKind} executed then metadata-descendant reuse through the real validate handler.`,
      type: 'bug',
      phase: 'TEST',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      riskSignals: [],
      events: [{ phase: 'TEST', action: 'advance', timestamp: now }],
    };
    const checklist: ChecklistData = { items: [{
      id: 'CHK-001',
      title: 'handler reuse',
      context: 'No required intents keeps current coverage complete for the smoke.',
      status: 'done',
      startTime: now,
      endTime: now,
    }] };
    store.writeStory(storyId, story);
    store.writeChecklist(storyId, checklist);
    git(root, ['add', '.lattice']);
    git(root, ['commit', '-m', 'seed story metadata']);

    const runWith = (extraEnv: Record<string, string> = {}) => spawnSync(process.execPath, [cliPath(), 'validate', `--story=${storyId}`, '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, LATTICE_PROJECT_ROOT: root, LATTICE_SESSION_ID: 'validation-reuse-smoke', VALIDATION_REUSE_SMOKE_COUNTER: counterPath, ...extraEnv },
    });
    const run = () => runWith();
    const first = run();
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(`${first.stdout}\n${first.stderr}`, /"disposition":"executed"/);
    assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, commandCount);
    // Simulate the trusted checklist verificationEvidence refresh that followed
    // B-19ca's command PASS. Some runtime audit rows intentionally remain after
    // the evidence auto-commit; committing those metadata-only rows establishes
    // the clean descendant on which reuse is decided.
    if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) {
      git(root, ['add', '.lattice']);
      git(root, ['commit', '-m', 'refresh checklist verificationEvidence metadata']);
    }
    const evidencePath = join(root, '.lattice/story/actives', storyId, 'test-evidence.json');
    const evidenceBefore = readFileSync(evidencePath, 'utf8');
    const parsedEvidence = JSON.parse(evidenceBefore) as TestEvidenceData;
    const semanticPass = sourceKind !== 'validate-file'
      || semanticResult === undefined
      || (String(semanticResult.status ?? '').trim().toLowerCase() === 'pass'
        && semanticResult.allPass !== false
        && semanticResult.allPassed !== false);
    if (!semanticPass) {
      assert.equal(parsedEvidence.commandExecution?.status, 'FAIL', 'non-PASS semantic JSON must record commandExecution FAIL');
      const secondFailure = run();
      assert.equal(secondFailure.status, 0, `${secondFailure.stdout}\n${secondFailure.stderr}`);
      assert.match(`${secondFailure.stdout}\n${secondFailure.stderr}`, /"disposition":"executed"/);
      const expectedRefusalReasons = parsedEvidence.result === 'PASS'
        ? 'prior-command-execution-not-pass'
        : 'prior-command-execution-not-pass,prior-overall-result-not-reusable';
      assert.match(
        `${secondFailure.stdout}\n${secondFailure.stderr}`,
        new RegExp(
          `routine validation reuse refused: refusalReasons=${expectedRefusalReasons} `
          + `priorIdentityDigest=${parsedEvidence.routineValidationIdentity?.digest} `
          + `currentIdentityDigest=${parsedEvidence.routineValidationIdentity?.digest}`,
        ),
        'refused reuse must expose stable reasons and only identity digests',
      );
      assert.doesNotMatch(
        `${secondFailure.stdout}\n${secondFailure.stderr}`,
        /VALIDATION_REUSE_SMOKE_COUNTER=/,
        'reuse refusal diagnostics must not expose raw environment values',
      );
      assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, commandCount * 2, 'semantic validator non-PASS must never reuse');
      return;
    }
    const headBefore = git(root, ['rev-parse', 'HEAD']);
    const statusBefore = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);

    const second = run();
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(`${second.stdout}\n${second.stderr}`, /"disposition":"reused"/);
    assert.match(`${second.stdout}\n${second.stderr}`, /"commandExecutions":0/);
    assert.match(`${second.stdout}\n${second.stderr}`, /trusted-story-metadata-descendant/);
    assert.doesNotMatch(
      `${second.stdout}\n${second.stderr}`,
      /routine validation reuse refused:/,
      'successful reuse must not emit refusal diagnostics',
    );
    assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, commandCount, 'reuse must invoke zero project commands');
    assert.equal(readFileSync(evidencePath, 'utf8'), evidenceBefore, 'real reused handler path must not rewrite evidence');
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore, 'real reused handler path must not auto-commit or move HEAD');
    const statusAfter = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    assert.deepEqual(
      statusAfter.split('\n').filter(Boolean).filter((line) => !line.includes('/owner-lease.json')),
      statusBefore.split('\n').filter(Boolean).filter((line) => !line.includes('/owner-lease.json')),
      'real reused handler path must not create any dirty path beyond the CLI owner heartbeat',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(counterPath, { force: true });
  }
}

const coverage: VerificationCoverageReport = {
  total: 1,
  required: 1,
  covered: 1,
  missingRequired: 0,
  entries: [{
    intentRef: 'CHK-001:happy:0',
    itemId: 'CHK-001',
    lane: 'happy',
    desc: 'commands remain unchanged',
    type: 'logic',
    priority: 'must',
    status: 'covered',
  }],
};

function identity(root: string, sourceKind: RoutineValidationSourceKind, commands: ValidationCommand[], overrides: Partial<{
  full: boolean | string;
  focus: string;
  profile: string;
  policy: unknown;
  sourceInputs: unknown;
  entrypointPath: string;
  env: NodeJS.ProcessEnv;
}> = {}): RoutineValidationIdentity {
  return buildRoutineValidationIdentity({
    projectRoot: root,
    sourceKind,
    sourceInputs: overrides.sourceInputs ?? { sourceKind },
    commands,
    ...(overrides.full !== undefined ? { full: overrides.full } : {}),
    ...(overrides.focus ? { focus: overrides.focus } : {}),
    profile: overrides.profile ?? 'strict',
    verificationPolicyInputs: overrides.policy ?? { required: ['CHK-001:happy:0'], workflow: 'strict' },
    ...(overrides.entrypointPath ? { entrypointPath: overrides.entrypointPath } : {}),
    processEnvironment: overrides.env ?? { PATH: process.env.PATH, VALIDATION_SECRET: 'smoke-secret-value' },
  });
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-validation-reuse-'));
  try {
    writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({ storyDir: '.lattice/story/actives', scanRoot: '.', requirementsDir: 'docs/requirements' }), 'utf8');
    writeFileSync(join(root, 'validate.ts'), 'console.log("pass")\n', 'utf8');
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n', 'utf8');
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    const baseHead = git(root, ['rev-parse', 'HEAD']);

    const baseCommand: ValidationCommand = {
      label: 'root full test suite',
      command: 'node',
      args: ['--test'],
      cwd: '.',
      env: { VALIDATION_MODE: 'strict' },
      timeoutMs: 1_200_000,
      optional: false,
      focus: ['full'],
    };

    for (const sourceKind of ['configured', 'fallback', 'validate-file'] as const) {
      const first = identity(root, sourceKind, [baseCommand], sourceKind === 'validate-file' ? { entrypointPath: join(root, 'validate.ts') } : {});
      const second = identity(root, sourceKind, [baseCommand], sourceKind === 'validate-file' ? { entrypointPath: join(root, 'validate.ts') } : {});
      assert.equal(first.digest, second.digest, `${sourceKind} identity must be deterministic`);
      assert.equal(isCompleteRoutineValidationIdentity(first), true);
    }

    const configured = identity(root, 'configured', [baseCommand]);
    const variations = [
      identity(root, 'configured', [{ ...baseCommand, args: ['--test', 'changed'] }]),
      identity(root, 'configured', [{ ...baseCommand, cwd: 'nested' }]),
      identity(root, 'configured', [{ ...baseCommand, env: { VALIDATION_MODE: 'changed' } }]),
      identity(root, 'configured', [{ ...baseCommand, timeoutMs: 10 }]),
      identity(root, 'configured', [{ ...baseCommand, optional: true }]),
      identity(root, 'configured', [{ ...baseCommand, focus: ['fast'] }]),
      identity(root, 'configured', [baseCommand], { full: 'changed' }),
      identity(root, 'configured', [baseCommand], { focus: 'fast' }),
      identity(root, 'configured', [baseCommand], { profile: 'light' }),
      identity(root, 'configured', [baseCommand], { policy: { required: ['different'] } }),
      identity(root, 'configured', [baseCommand], { sourceInputs: { configured: 'changed' } }),
      identity(root, 'configured', [baseCommand], { env: { PATH: process.env.PATH, VALIDATION_SECRET: 'changed-secret' } }),
    ];
    for (const changed of variations) assert.notEqual(changed.digest, configured.digest, 'each behavior-affecting input must invalidate identity');
    assert.equal(JSON.stringify(configured).includes('smoke-secret-value'), false, 'raw effective environment secret must not be persisted');

    const commandExecution = summarizeRoutineCommandExecution([{
      label: baseCommand.label,
      command: baseCommand.command,
      args: baseCommand.args,
      code: 0,
      output: '',
      durationMs: 1,
    }], 1);
    assert.equal(summarizeRoutineCommandExecution([{
      label: 'polluting optional command',
      command: 'node',
      args: [],
      optional: true,
      code: 0,
      output: '',
      durationMs: 1,
      worktreePollution: { statusLines: [' M source.ts'], paths: ['source.ts'], blocking: true },
    }], 1).status, 'FAIL', 'blocking validation side effects are command-execution failure, not coverage-only failure');
    const evidence: TestEvidenceData = {
      command: 'lattice validate --story=B-19ca --json',
      output: '{}',
      result: 'FAIL', // coverage-only historical FAIL is intentionally reusable.
      timestamp: '2026-07-16T00:00:00.000Z',
      headHash: baseHead,
      materialHash: 'material',
      storyFilesHash: 'story-files',
      verificationCoverage: { ...coverage, covered: 0, missingRequired: 1 },
      routineValidationIdentity: configured,
      commandExecution,
      disposition: 'executed',
    };
    const evidencePath = join(root, 'evidence-copy.json');
    writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');
    const beforeBytes = readFileSync(evidencePath, 'utf8');
    const exact = evaluateRoutineValidationReuse({
      root,
      gitCwd: root,
      evidence,
      currentIdentity: configured,
      currentCoverage: coverage,
      currentMaterialHash: 'material',
      currentStoryFilesHash: 'story-files',
      clean: true,
      headBefore: baseHead,
      headAfter: baseHead,
    });
    assert.equal(exact.reusable, true, 'coverage-only overall FAIL must reuse prior structured command PASS after coverage repair');
    assert.equal(exact.lineage, 'exact-head');
    assert.equal(readFileSync(evidencePath, 'utf8'), beforeBytes, 'reuse classifier must not rewrite evidence');
    assert.equal(git(root, ['rev-parse', 'HEAD']), baseHead, 'reuse classifier must not move HEAD');

    const semanticFailureExecution = summarizeRoutineCommandExecution([{
      label: baseCommand.label,
      command: baseCommand.command,
      args: baseCommand.args,
      code: 0,
      output: '',
      durationMs: 1,
    }], 1, { semanticPass: false });
    const invalidCommandExecutionRows: Array<[string, Record<string, unknown>]> = [
      ['schema mismatch', { ...commandExecution, schema: 'lattice.legacy-command-execution' }],
      ['schema missing', { ...commandExecution, schema: undefined }],
      ['version mismatch', { ...commandExecution, version: 2 }],
      ['version missing', { ...commandExecution, version: undefined }],
      ['status FAIL', { ...commandExecution, status: 'FAIL' }],
      ['status unknown', { ...commandExecution, status: 'WARN' }],
      ['status missing', { ...commandExecution, status: undefined }],
      ['complete false', { ...commandExecution, complete: false }],
      ['complete missing', { ...commandExecution, complete: undefined }],
      ['commandCount zero', { ...commandExecution, commandCount: 0 }],
      ['commandCount mismatch', { ...commandExecution, commandCount: 2 }],
      ['commandCount negative', { ...commandExecution, commandCount: -1 }],
      ['commandCount fractional', { ...commandExecution, commandCount: 1.5 }],
      ['commandCount wrong type', { ...commandExecution, commandCount: '1' }],
      ['commandCount missing', { ...commandExecution, commandCount: undefined }],
      ['requiredFailureCount nonzero', { ...commandExecution, requiredFailureCount: 1 }],
      ['requiredFailureCount negative', { ...commandExecution, requiredFailureCount: -1 }],
      ['requiredFailureCount fractional', { ...commandExecution, requiredFailureCount: 0.5 }],
      ['requiredFailureCount wrong type', { ...commandExecution, requiredFailureCount: '0' }],
      ['requiredFailureCount missing', { ...commandExecution, requiredFailureCount: undefined }],
      ['optionalFailureCount nonzero', { ...commandExecution, optionalFailureCount: 1 }],
      ['optionalFailureCount negative', { ...commandExecution, optionalFailureCount: -1 }],
      ['optionalFailureCount fractional', { ...commandExecution, optionalFailureCount: 0.5 }],
      ['optionalFailureCount wrong type', { ...commandExecution, optionalFailureCount: '0' }],
      ['optionalFailureCount missing', { ...commandExecution, optionalFailureCount: undefined }],
      ['failureKind validation', { ...commandExecution, failureKind: 'validation_failure' }],
      ['failureKind infra', { ...commandExecution, failureKind: 'infra_failure' }],
      ['failureKind unknown', { ...commandExecution, failureKind: 'unknown_failure' }],
      ['semanticPass false summary', semanticFailureExecution],
    ];
    for (const [label, invalidCommandExecution] of invalidCommandExecutionRows) {
      const result = evaluateRoutineValidationReuse({
        root,
        gitCwd: root,
        evidence: {
          ...evidence,
          commandExecution: invalidCommandExecution as unknown as NonNullable<TestEvidenceData['commandExecution']>,
        },
        currentIdentity: configured,
        currentCoverage: coverage,
        currentMaterialHash: 'material',
        currentStoryFilesHash: 'story-files',
        clean: true,
        headBefore: baseHead,
        headAfter: baseHead,
      });
      assert.equal(result.reusable, false, `${label} must execute instead of reusing prior evidence`);
      assert.ok(
        result.refusalReasons.includes('prior-command-execution-not-pass'),
        `${label} must report the command-execution refusal reason`,
      );
    }

    const refusalRows: Array<[string, Partial<Parameters<typeof evaluateRoutineValidationReuse>[0]>]> = [
      ['current-verification-coverage-incomplete', { currentCoverage: { ...coverage, missingRequired: 1 } }],
      ['worktree-dirty', { clean: false }],
      ['material-hash-changed-or-missing', { currentMaterialHash: 'changed' }],
      ['story-files-hash-changed-or-missing', { currentStoryFilesHash: 'changed' }],
      ['validation-identity-changed', { currentIdentity: variations[0] }],
      ['head-changed-during-reuse-evaluation', { headAfter: 'changed-head' }],
      ['prior-overall-result-not-reusable', { evidence: { ...evidence, result: 'FAIL', verificationCoverage: undefined } }],
      ['prior-overall-result-not-reusable', { evidence: { ...evidence, result: 'FAIL', verificationCoverage: { ...coverage, missingRequired: 0 } } }],
      ['prior-overall-result-not-reusable', { evidence: { ...evidence, result: undefined as unknown as 'PASS' } }],
      ['prior-overall-result-not-reusable', { evidence: { ...evidence, result: 'UNKNOWN' as 'PASS' } }],
      ['identity-missing-malformed-or-legacy', { evidence: { ...evidence, routineValidationIdentity: undefined } }],
    ];
    for (const [reason, override] of refusalRows) {
      const result = evaluateRoutineValidationReuse({
        root,
        gitCwd: root,
        evidence,
        currentIdentity: configured,
        currentCoverage: coverage,
        currentMaterialHash: 'material',
        currentStoryFilesHash: 'story-files',
        clean: true,
        headBefore: baseHead,
        headAfter: baseHead,
        ...override,
      });
      assert.equal(result.reusable, false, reason);
      assert.ok(result.refusalReasons.includes(reason), `${reason} must be auditable`);
    }

    mkdirSync(join(root, '.lattice/story/actives/B-19ca'), { recursive: true });
    writeFileSync(join(root, '.lattice/story/actives/B-19ca/checklist.json'), '{}\n', 'utf8');
    git(root, ['add', '.lattice']);
    git(root, ['commit', '-m', 'trusted checklist verificationEvidence refresh']);
    const metadataHead = git(root, ['rev-parse', 'HEAD']);
    assert.equal(classifyTrustedValidationLineage({ root, gitCwd: root, evidenceHead: baseHead, currentHead: metadataHead }).lineage, 'trusted-story-metadata-descendant');

    writeFileSync(join(root, 'source.ts'), 'export const value = 2;\n', 'utf8');
    git(root, ['add', 'source.ts']);
    git(root, ['commit', '-m', 'code change disguised as metadata refresh']);
    const codeHead = git(root, ['rev-parse', 'HEAD']);
    const rejected = classifyTrustedValidationLineage({ root, gitCwd: root, evidenceHead: baseHead, currentHead: codeHead });
    assert.equal(rejected.lineage, 'rejected');
    assert.ok(rejected.reasons.some((reason) => reason === 'untrusted-lineage-path:source.ts'));

    git(root, ['checkout', '--', 'source.ts']);
    const freshnessSnapshot = captureEvidenceHashSnapshot({ gitCwd: root, metadataRoot: root, ref: 'HEAD' });
    writeFileSync(join(root, 'source.ts'), 'export const value = 3;\n', 'utf8');
    const racedFreshness = checkEvidenceHashSnapshotReuse(freshnessSnapshot, { gitCwd: root, metadataRoot: root, ref: 'HEAD' });
    assert.equal(racedFreshness.reusable, false, 'material dirt introduced after the first snapshot must reject reuse');
    assert.equal(racedFreshness.materialDirty, true);
    assert.ok(racedFreshness.materialDirtyFiles.includes('source.ts'));
    git(root, ['checkout', '--', 'source.ts']);

    const fortyFive = Array.from({ length: 45 }, (_, index) => ({ ...baseCommand, label: `command-${index + 1}`, args: ['--test', String(index + 1)] }));
    const b19Identity = identity(root, 'configured', fortyFive);
    const b19Evidence: TestEvidenceData = {
      ...evidence,
      headHash: metadataHead,
      routineValidationIdentity: b19Identity,
      commandExecution: {
        ...commandExecution,
        commandCount: 45,
      },
    };
    const b19 = evaluateRoutineValidationReuse({
      root,
      gitCwd: root,
      evidence: b19Evidence,
      currentIdentity: b19Identity,
      currentCoverage: coverage,
      currentMaterialHash: 'material',
      currentStoryFilesHash: 'story-files',
      clean: true,
      headBefore: metadataHead,
      headAfter: metadataHead,
    });
    assert.equal(b19.reusable, true, 'B-19ca 45-command PASS plus coverage refresh must reuse with zero command runner invocations');

    assert.equal(semanticFailureExecution.status, 'FAIL', 'exit-zero command with semantic validator FAIL must not be reusable command truth');

    assertHandlerExecutedThenReused('configured');
    assertHandlerExecutedThenReused('fallback');
    assertHandlerExecutedThenReused('validate-file');
    for (const semanticResult of [
      { provider: 'validate-file-smoke', status: 'fail', allPass: true },
      { provider: 'validate-file-smoke', status: 'warn', allPass: true },
      { provider: 'validate-file-smoke', status: 'error', allPass: true },
      { provider: 'validate-file-smoke', status: 'unknown', allPass: true },
      { provider: 'validate-file-smoke', allPass: true },
      { provider: 'validate-file-smoke', status: 'pass', allPass: false },
      { provider: 'validate-file-smoke', status: 'pass', allPass: true, allPassed: false },
    ]) assertHandlerExecutedThenReused('validate-file', 1, semanticResult);
    assertHandlerExecutedThenReused('configured', 45);

    console.log('validation-evidence-reuse-smoke PASS (real executed→metadata reuse, 3 sources, B-19ca 45-command reuse, fail-closed matrix, lineage, no-write, secret absence)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
