import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cancelManagedHostRun, getManagedHostRunStatus, managedHostRunDirectory, runManagedHostRunWorker, submitManagedHostRun } from '../packages/main/dist/core/managed-host-run.js';

const root = mkdtempSync(join(tmpdir(), 'supervisor-journal-race-'));
const core = fileURLToPath(new URL('../packages/main/dist/core/managed-host-run.js', import.meta.url));
const entry = fileURLToPath(new URL('../packages/main/dist/cli/managed-host-run-supervisor.js', import.meta.url));
let finish, worker;
try {
  const run = await submitManagedHostRun({root,cwd:root,host:'codex',phase:'DEV',agentType:'journal-race',
    promptText:'Keep the worker alive while its recovery owner observes transactions.',deadlineMs:30000}, {
    launchWorker:async request => {
      worker = runManagedHostRunWorker(request,{heartbeatMs:60000,
        runner:async () => new Promise(resolve => { finish=resolve; })});
      return {pid:process.pid};
    },
  });
  const directory = managedHostRunDirectory(root,run.runId);
  const transitionPath = join(directory,'snapshot-event-transition.json');
  const snapshot = JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8'));
  const transition = {schemaVersion:'lattice.managed_host_run_snapshot_event_transition.v1',runId:run.runId,
    snapshot:{...snapshot,generation:snapshot.generation+1},event:{schemaVersion:snapshot.schemaVersion,
      runId:run.runId,at:new Date().toISOString(),type:'journal-race-witness'}};
  const loader = join(root,'loader.mjs');
  writeFileSync(loader, `import {readFileSync} from 'node:fs';
export async function load(url,context,next) {
  if (process.env.UNLOCKED_CONTROL === '1' && url === ${JSON.stringify(pathToFileURL(core).href)}) {
    const source=readFileSync(new URL(url),'utf8');
    const target=/function recoverAndProjectManagedHostRun\\(paths\\) \\{[\\s\\S]*?\\n\\}/;
    if (!target.test(source)) throw new Error('journal-race negative control no longer applies');
    return {format:'module',shortCircuit:true,source:source.replace(target,
      'function recoverAndProjectManagedHostRun(paths) { recoverPendingSnapshotEventTransition(paths); return projectionFor(paths); }')};
  }
  return next(url,context);
}
`);
  const preload=join(root,'preload.mjs');
  const lockedMarker=join(root,'locked-observation');
  writeFileSync(preload, `import fs from 'node:fs';
import {register,syncBuiltinESMExports} from 'node:module';
register(${JSON.stringify(pathToFileURL(loader).href)},import.meta.url);
const original=fs.existsSync;
fs.existsSync=function(path) {
  if (String(path) === ${JSON.stringify(transitionPath)}) {
    if (original(${JSON.stringify(join(directory,'terminal.lock'))})) {
      fs.writeFileSync(${JSON.stringify(lockedMarker)},'locked');
    } else if (new Error().stack.includes('projectionFor')) {
      fs.writeFileSync(path,${JSON.stringify(JSON.stringify(transition))});
    }
  }
  return original(path);
};
syncBuiltinESMExports();
`);
  const unsafe=spawnSync(process.execPath,['--import',preload,entry,root,run.runId],
    {encoding:'utf8',timeout:8000,env:{...process.env,UNLOCKED_CONTROL:'1'}});
  assert.notEqual(unsafe.status,0,'negative control must fail when a writer enters between recovery and projection');
  assert.match(unsafe.stderr,/snapshot\/event recovery pending/);
  assert.ok(existsSync(transitionPath));
  const before=readFileSync(transitionPath,'utf8');
  await assert.rejects(getManagedHostRunStatus({root,runId:run.runId}),/recovery pending/);
  assert.equal(readFileSync(transitionPath,'utf8'),before,'observation must preserve the interrupted transaction');
  await cancelManagedHostRun({root,runId:run.runId,reason:'journal-race recovery'});
  assert.ok(!existsSync(transitionPath),'explicit cancellation must recover the pending transaction');
  const safe=spawnSync(process.execPath,['--import',preload,entry,root,run.runId],
    {encoding:'utf8',timeout:8000,env:{...process.env,UNLOCKED_CONTROL:'0'}});
  assert.equal(safe.status,0,`locked supervisor must survive and converge: ${safe.stderr}`);
  assert.ok(existsSync(lockedMarker),'real supervisor must observe under the worker transaction lock');
  assert.equal((await getManagedHostRunStatus({root,runId:run.runId})).run.state,'cancelled');
  console.log('PASS U02 journal publication race discriminated; readonly pending state and explicit cancellation recovery');
} finally {
  finish?.({stdout:'',stderr:'',exitCode:0,timedOut:false,terminalReason:'completed'});
  await worker;
  rmSync(root,{recursive:true,force:true});
}
