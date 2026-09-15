import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const cli = join(repository, 'packages/main/dist/cli.js');
const { StoryStore } = await import('../dist/core/store.js');
const { createHostRunHandlers } = await import('../dist/handlers/host-run.js');
const { runManagedHostRunWorker } = await import('../dist/core/managed-host-run.js');
const { invalidInitReviewerDeliveries, missingRequiredInitCheckAgents, recomputeInitCheckHash } = await import('../dist/core/init-check-gate.js');

const root = mkdtempSync(join(tmpdir(), 'managed-init-dispatch-e2e-'));
const storyId = 'B-managed-init-e2e';
const bin = join(root, 'bin');
const oldPath = process.env.PATH;
const oldProjectRoot = process.env.PROOF_OR_STOP_PROJECT_ROOT;

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

try {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: 'src', outDir: 'dist', testsDir: 'tests',
    fixturesDir: 'tests/fixtures', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'subject.ts'), 'export const subject = true;\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Managed INIT fixture');
  git('config', 'user.email', 'managed-init@example.invalid');

  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'managed-init-e2e', title: 'Managed INIT reviewer delivery',
    description: 'Verify exact managed reviewer prompt delivery and bound independent evidence.',
    type: 'bug', phase: 'INIT', priority: 'high', createdAt: new Date().toISOString(), events: [],
  });
  store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Verify managed delivery', context: 'Regression fixture.', status: 'todo' }] });
  writeFileSync(store.storyFilePath(storyId, 'background.md'), [
    '# Trigger Event', 'A benchmark exposed caller-supplied INIT reviewer identities.',
    '# Key Insights', 'Independent evidence requires a controller-owned provider process.',
    '# Solution Tradeoffs', 'Use managed delivery and preserve explicit fallback.',
    '# Conversational Texture', 'The user requires a mechanical fix rather than prompt guidance.',
  ].join('\n\n'));
  git('add', '.');
  git('commit', '-qm', 'fixture');

  const direct = spawnSync(process.execPath, [cli, 'init_check_set', JSON.stringify({ storyId, issues: [], agentId: 'proof-or-stop-review-story-init' })], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root, PROOF_OR_STOP_AGENT: '' },
  });
  assert.notEqual(direct.status, 0, 'a caller-supplied required reviewer role must fail closed');
  assert.match(`${direct.stderr}\n${direct.stdout}`, /delivery_not_acknowledged/);
  const envSpoof = spawnSync(process.execPath, [cli, 'init_check_set', JSON.stringify({ storyId, issues: [], agentId: 'proof-or-stop-review-story-init' })], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root, PROOF_OR_STOP_AGENT: 'proof-or-stop-review-story-init' },
  });
  assert.notEqual(envSpoof.status, 0, 'an unbound PROOF_OR_STOP_AGENT value must fail closed');
  assert.match(`${envSpoof.stderr}\n${envSpoof.stdout}`, /delivery_not_acknowledged/);

  const fakeCodex = join(bin, 'codex');
  const unifiedExecShim = join(bin, 'unified-exec-shim.mjs');
  writeFileSync(unifiedExecShim, `import { spawn } from 'node:child_process';\nconst [mode, ...argv] = process.argv.slice(2);\nconst env = { ...process.env };\nif (mode !== 'normal') {\n  const attestation = JSON.parse(env.LATTICE_MANAGED_INIT_INVOCATION);\n  if (mode === 'tamper-story') attestation.storyId += '-wrong';\n  else if (mode === 'tamper-role') attestation.providerAgent += '-wrong';\n  else throw new Error('unknown shim mode');\n  env.LATTICE_MANAGED_INIT_INVOCATION = JSON.stringify(attestation);\n}\nconst child = spawn(process.execPath, argv, { detached: true, stdio: 'inherit', env });\nchild.on('exit', (code, signal) => process.exitCode = signal ? 70 : (code ?? 71));\n`);
  writeFileSync(fakeCodex, `#!/bin/sh\nset -eu\ncat > "${root}/delivered-$PROOF_OR_STOP_AGENT.txt"\ncase "$(cat "${root}/delivered-$PROOF_OR_STOP_AGENT.txt")" in *"Review the initial background + checklist"*|*"Review whether the INIT"*) ;; *) exit 41;; esac\n: > "${root}/ready-$PROOF_OR_STOP_AGENT"\ni=0\nwhile [ ! -f "${root}/ready-proof-or-stop-review-story-init" ] || [ ! -f "${root}/ready-proof-or-stop-product-reviewer" ]; do\n  i=$((i+1))\n  if [ "$i" -gt 500 ]; then echo 'barrier timeout: peer reviewer never became ready' >&2; exit 42; fi\n  sleep 0.02\ndone\nprintf '%s' "$LATTICE_MANAGED_INIT_INVOCATION" > "${root}/attestation-$PROOF_OR_STOP_AGENT.json"\nfor mode in tamper-story tamper-role; do\n  if "${process.execPath}" "${unifiedExecShim}" "$mode" "${cli}" init_check_set "{\\"storyId\\":\\"${storyId}\\",\\"issues\\":[],\\"agentId\\":\\"$PROOF_OR_STOP_AGENT\\"}"; then exit 43; fi\ndone\n"${process.execPath}" "${unifiedExecShim}" normal "${cli}" init_check_set "{\\"storyId\\":\\"${storyId}\\",\\"issues\\":[],\\"agentId\\":\\"$PROOF_OR_STOP_AGENT\\"}"\nif "${process.execPath}" "${unifiedExecShim}" normal "${cli}" init_check_set "{\\"storyId\\":\\"${storyId}\\",\\"issues\\":[],\\"agentId\\":\\"$PROOF_OR_STOP_AGENT\\"}"; then exit 44; fi\nprintf '%s\\n' '{"type":"turn.completed","usage":{}}'\n`);
  chmodSync(fakeCodex, 0o755);
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  process.env.PROOF_OR_STOP_PROJECT_ROOT = root;

  const handlers = createHostRunHandlers({ root, scanRoot: root, store }, {
    launchWorker: async request => {
      void runManagedHostRunWorker(request, { env: process.env });
      return { pid: process.pid };
    },
  });
  const agentTypes = ['proof-or-stop-review-story-init', 'proof-or-stop-product-reviewer'];
  const results = await Promise.all(agentTypes.map(async agentType => {
    const result = await handlers.host_run({
      host: 'codex', storyId, agentType,
      managedDispatch: true, deadlineMs: 30_000, timeoutMs: 20_000, json: true,
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(readFileSync(join(root, `delivered-${agentType}.txt`), 'utf8'), /do not spawn or delegate another reviewer/i);
    return result;
  }));
  const runIds = results.map(result => result.runId);
  const evidence = store.readInitCheck(storyId);
  assert.deepEqual(evidence?.agentResults?.map(row => row.agentId).sort(),
    ['proof-or-stop-product-reviewer', 'proof-or-stop-review-story-init']);
  assert.deepEqual(evidence?.agentResults?.map(row => row.deliveryRunId).sort(), runIds.sort());
  assert.equal(new Set(runIds).size, 2, 'the two reviewer lanes must have distinct managed run identities');
  assert.deepEqual(missingRequiredInitCheckAgents(evidence), []);
  assert.deepEqual(invalidInitReviewerDeliveries(evidence, root, storyId), [],
    'INIT gate must revalidate the completed managed delivery receipts');
  for (const agentType of agentTypes) {
    const terminalReplay = spawnSync(process.execPath, [cli, 'init_check_set', JSON.stringify({ storyId, issues: [], agentId: agentType })], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PROOF_OR_STOP_PROJECT_ROOT: root,
        PROOF_OR_STOP_AGENT: agentType,
        LATTICE_MANAGED_INIT_INVOCATION: readFileSync(join(root, `attestation-${agentType}.json`), 'utf8'),
      },
    });
    assert.notEqual(terminalReplay.status, 0, 'a terminal managed dispatch attestation must stay unusable');
    assert.match(`${terminalReplay.stderr}\n${terminalReplay.stdout}`, /delivery_not_acknowledged/);
  }
  const substituted = structuredClone(evidence);
  substituted.agentResults[0].deliveryRunId = '00000000-0000-4000-8000-000000000000';
  substituted._hash = recomputeInitCheckHash(storyId, store, root, substituted);
  assert.match(invalidInitReviewerDeliveries(substituted, root, storyId)[0]?.reason ?? '', /not found|ENOENT/i,
    'a re-signed caller-substituted delivery id must still fail receipt validation');
  console.log('MANAGED_INIT_REVIEWER_DISPATCH_E2E_GREEN');
} finally {
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  if (oldProjectRoot === undefined) delete process.env.PROOF_OR_STOP_PROJECT_ROOT; else process.env.PROOF_OR_STOP_PROJECT_ROOT = oldProjectRoot;
  rmSync(root, { recursive: true, force: true });
}
