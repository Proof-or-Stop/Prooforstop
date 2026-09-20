// Build dist first. Real supervised children are local Node fixtures, never models.
import assert from 'node:assert/strict';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'shared-quota-process-')));
const savedUserInfo = os.userInfo;
os.userInfo = (...args) => ({ ...savedUserInfo(...args), homedir: root });
syncBuiltinESMExports();
try {
  const { runSupervisedProviderProcess } = await import('../packages/main/dist/providers/supervised-process.js');
  const adapters = {
    codex: (await import('../packages/main/dist/providers/codex-cli.js')).runBoundedCodexProvider,
    claude: (await import('../packages/main/dist/providers/claude-cli.js')).runBoundedClaudeProvider,
    gemini: (await import('../packages/main/dist/providers/gemini-cli.js')).runBoundedGeminiProvider,
  };
  for (const [provider, adapter] of Object.entries(adapters)) {
    const counter = join(root, provider + '.calls');
    const argv = ['-e', 'require("node:fs").appendFileSync(process.argv[1], "call\\n")', counter];
    const request = { provider, cwd: root, env: {
      PROOF_OR_STOP_RUN_BUDGET_ID: provider, PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS: '2',
    }, argv, timeoutMs: 5000, maxAttempts: 5 };
    // Use the real supervisor with the exact delegated options object.
    const runner = (_binary, args, options) => runSupervisedProviderProcess(process.execPath, args, options);
    for (let i = 0; i < 2; i++) {
      const result = adapter(request, runner);
      assert.equal(result.exitCode, 0); assert.equal(result.attempts, 1);
    }
    assert.throws(() => adapter(request, runner), /reservations exhausted/);
    assert.equal(readFileSync(counter, 'utf8'), 'call\ncall\n');
  }
  const options = { cwd: root, env: { PROOF_OR_STOP_RUN_BUDGET_ID: 'direct-supervisor',
    PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS: '1' }, timeoutMs: 5000 };
  assert.equal(runSupervisedProviderProcess(process.execPath, ['-e', ''], options).status, 0);
  assert.throws(() => runSupervisedProviderProcess(process.execPath, ['-e', ''], options), /reservations exhausted/);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const counter = join(root, 'probe.calls');
  const binary = join(bin, 'codex');
  writeFileSync(binary, '#!' + process.execPath + '\n' +
    'require("node:fs").appendFileSync(' + JSON.stringify(counter) + ',"call\\n");console.log("fixture 1.0.0");\n', {mode:0o755});
  const { probeHostExecutionReadiness } = await import('../packages/main/dist/core/host-execution-readiness.js');
  const budgetEnv = { PROOF_OR_STOP_RUN_BUDGET_ID:'readiness-explicit', PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS:'1' };
  const probe = { host:'codex', executablePath:binary, versionOk:true, cwd:root, env:{}, budgetRoot:root, budgetEnv, timeoutMs:5000 };
  assert.equal(probeHostExecutionReadiness(probe).reviewReady, true);
  assert.throws(() => probeHostExecutionReadiness(probe), /reservations exhausted/);
  assert.equal(readFileSync(counter, 'utf8'), 'call\n');
  // Batch identity requires a native executable; compile an inert local probe.
  const source=join(root,'probe.c');
  writeFileSync(source,'#include <stdio.h>\nint main(void){FILE *f=fopen('+JSON.stringify(counter)+',"a");if(!f)return 2;fputs("call\\n",f);fclose(f);puts("fixture 1.0.0");return 0;}\n');
  execFileSync('cc',[source,'-o',binary],{timeout:30000});
  execFileSync('git',['init','-q'],{cwd:root});
  const { admitExecutionBatch } = await import('../packages/main/dist/core/reviewer-batch-producer.js');
  const home=join(root,'home');mkdirSync(home);mkdirSync(join(home,'.codex'));
  writeFileSync(join(home,'.codex/auth.json'),JSON.stringify({OPENAI_API_KEY:'inert-local-fixture'}),{mode:0o600});
  const effectiveBaseEnvironment={PATH:bin,HOME:home,CODEX_HOME:join(home,'.codex'),
    PROOF_OR_STOP_RUN_BUDGET_ID:'batch-probes', PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS:'2'};
  const batch = subjectIdentity => ({root, subjectIdentity, deriveSubjectIdentity:()=>subjectIdentity,
    profile:'managed_reviewer',assignments:[{lane:'concept',kind:'managed',host:'codex'}],effectiveBaseEnvironment});
  const first=await admitExecutionBatch(batch('quota-batch-first'));
  assert.equal(first.state,'ADMITTED',JSON.stringify(first));
  const second=await admitExecutionBatch(batch('quota-batch-second'));
  assert.equal(second.state,'BLOCKED',JSON.stringify(second));
  assert.equal(readFileSync(counter,'utf8'),'call\ncall\ncall\n');
  console.log('SHARED_QUOTA_PROCESS_GREEN three adapter/supervisor chains, direct supervisor, explicit readiness and shared batch probes; ten real local Node/native children, paid calls=0');

} finally {
  os.userInfo = savedUserInfo; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true });
}
