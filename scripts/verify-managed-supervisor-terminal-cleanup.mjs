import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { currentMaterialHash } from '../packages/main/dist/core/evidence-freshness.js';
import { managedHostRunDirectory, submitManagedHostRun } from '../packages/main/dist/core/managed-host-run.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const parent = realpathSync(mkdtempSync(join(tmpdir(), 'supervisor-terminal-cleanup-')));
const root = join(parent, 'project');
const core = join(repository, 'packages/main/dist/core/managed-host-run.js');
const entry = join(repository, 'packages/main/dist/cli/managed-host-run-supervisor.js');
let scratch;
try {
  mkdirSync(root);
  const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8'}).trim();
  git('init', '-q');
  git('config', 'user.name', 'Supervisor witness');
  git('config', 'user.email', 'supervisor-witness@example.invalid');
  writeFileSync(join(root, 'README.md'), 'A bounded terminal-cleanup fixture.\n');
  git('add', 'README.md');
  git('commit', '-qm', 'fixture baseline');
  const bin = join(parent, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 7\n', {mode:0o700});
  const worker = join(parent, 'worker.mjs');
  writeFileSync(worker, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.linkSync;
fs.linkSync = function(from, to, ...rest) {
  const result = original.call(this, from, to, ...rest);
  if (String(to).endsWith('/terminal.json')) process.kill(process.pid, 'SIGKILL');
  return result;
};
syncBuiltinESMExports();
const {runManagedHostRunWorker} = await import(${JSON.stringify(pathToFileURL(core).href)});
await runManagedHostRunWorker({root:process.argv[2],runId:process.argv[3]});
`);
  let exited;
  const run = await submitManagedHostRun({root,cwd:root,host:'codex',storyId:'B-terminal-cleanup',
    phase:'REVIEW',agentType:'proof-or-stop-review-quality',lane:'proof-or-stop-review-quality',
    reviewRunId:'B-terminal-cleanup:RR-001',profile:'managed_reviewer',isolateManagedReview:true,
    promptText:'The real child fails; this run cannot grant review evidence.',deadlineMs:30000,
    projectRootHash:'sha256:terminal-cleanup-witness',
    environment:{PATH:`${bin}:${process.env.PATH}`,PROOF_OR_STOP_USAGE_LEDGER:'0'},
    reviewBinding:{headHash:git('rev-parse','HEAD'),materialHash:currentMaterialHash(root),
      storyFilesHash:'fixture-story-files',promptHash:'fixture-prompt',managedPromptDigest:`sha256:${'a'.repeat(64)}`,envelopeId:null},
  }, {launchWorker:async request => {
    const child = spawn(process.execPath, [worker, root, request.runId], {stdio:'ignore',detached:true});
    exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code,signal})));
    return {pid:child.pid};
  }});
  assert.equal((await exited).signal, 'SIGKILL', 'worker must actually die immediately after terminal publication');
  const directory = managedHostRunDirectory(root, run.runId);
  const terminalPath = join(directory, 'terminal.json');
  const terminalBytes = readFileSync(terminalPath, 'utf8');
  assert.equal(JSON.parse(terminalBytes).replacementSafe, true, 'the real failed child was reaped before terminal sealing');
  scratch = JSON.parse(readFileSync(join(directory, 'spec.json'), 'utf8')).managedReviewScratch;
  assert.ok(existsSync(scratch.cwd), 'the SIGKILL must leave the registered scratch for recovery');

  const loader = join(parent, 'skip-terminal-cleanup.mjs');
  writeFileSync(loader, `import {readFileSync} from 'node:fs';
export async function load(url, context, nextLoad) {
  if (url === ${JSON.stringify(pathToFileURL(core).href)}) {
    const text = readFileSync(new URL(url), 'utf8');
    const target = /if \\(run\\.terminal\\) \\{\\s*await reconcileManagedHostRunUnlocked\\(paths, Date\\.now\\(\\)\\);\\s*return true;\\s*\\}/;
    if (!target.test(text)) throw new Error('terminal-cleanup mutation no longer applies');
    return {format:'module',source:text.replace(target,'if (run.terminal) return true;'),shortCircuit:true};
  }
  return nextLoad(url, context);
}
`);
  const register = join(parent, 'register.mjs');
  writeFileSync(register, `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);`);
  execFileSync(process.execPath, ['--import',register,entry,root,run.runId], {timeout:10000});
  assert.ok(existsSync(scratch.cwd), 'negative control: skipping terminal recovery must leave the scratch');
  execFileSync(process.execPath, [entry,root,run.runId], {timeout:10000});
  assert.ok(!existsSync(scratch.parent), 'supervisor must recover scratch cleanup after terminal publication');
  assert.equal(readFileSync(terminalPath, 'utf8'), terminalBytes, 'cleanup cannot rewrite the terminal receipt');
  assert.ok(!git('worktree','list','--porcelain').includes(scratch.cwd), 'Git registration must also be removed');
  console.log('PASS U02 terminal-publication crash recovered; real skip-cleanup mutation discriminated');
} finally {
  if (scratch && existsSync(scratch.cwd)) {
    execFileSync('git', ['worktree','remove','--force',scratch.cwd], {cwd:root});
    rmSync(scratch.parent, {recursive:true,force:true});
  }
  rmSync(parent, {recursive:true,force:true});
}
