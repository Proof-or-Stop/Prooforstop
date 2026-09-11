/** Test-only OS isolation for native-broker fixtures. Never used by production
 * handlers: no host policy, process observer or broker verification is replaced.
 * The worker owns only disposable test repositories and its own broker keys. */
import { mkdtempSync, openSync, closeSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { sanitizedFixtureChildEnvironment } from './fixture-environment.js';

const MARKER = '--isolated-finding-fixture-worker';
export async function runIsolatedFindingFixture(entry: string): Promise<boolean> {
  if (process.argv.includes(MARKER)) return false;
  const file = fileURLToPath(entry);
  if (!['dynamic-finding-runtime-integration-smoke.js', 'finding-material-reattestation-smoke.js', 'evidence-state-gate-smoke.js',
    'finding-qualification-independence-smoke.js', 'finding-identity-lineage-smoke.js', 'reviewer-batch-smoke.js'].some(name => file.endsWith('/' + name))) {
    throw new Error('isolated Finding fixture entry is not allowlisted');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'dfec-native-worker-'));
  const output = join(scratch, 'output.log'); const outcome = join(scratch, 'outcome.json');
  const fd = openSync(output, 'w', 0o600);
  let workerPid: number | undefined;
  const code = `import {writeFileSync,renameSync} from 'node:fs';
const launcher = Number(process.argv[1]);
while (process.ppid === launcher) await new Promise(resolve => setTimeout(resolve, 10));
process.argv.push(...${JSON.stringify(process.argv.slice(2))}, ${JSON.stringify(MARKER)});
let code = 0;
try { await import(${JSON.stringify(entry)}); code = Number(process.exitCode || 0); }
catch (error) { console.error(error); code = 1; }
writeFileSync(${JSON.stringify(outcome + '.pending')}, JSON.stringify({code}));
renameSync(${JSON.stringify(outcome + '.pending')}, ${JSON.stringify(outcome)});
process.exit(code);`;
  const launcherCode = `import {spawn} from 'node:child_process';
const worker = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(code)}, String(process.pid)],
  {detached:true, stdio:['ignore',1,2], env:process.env});
worker.once('spawn', () => { process.send({pid:worker.pid}, () => {worker.unref(); process.disconnect();}); });
worker.once('error', error => {console.error(error); process.exitCode=1; process.disconnect();});`;
  try {
    const launcher = spawn(process.execPath, ['--input-type=module', '--eval', launcherCode], {
      cwd: process.cwd(), env: sanitizedFixtureChildEnvironment(process.env), stdio: ['ignore', fd, fd, 'ipc'],
    });
    launcher.on('message', value => { workerPid = (value as { pid: number }).pid; });
    await new Promise<void>((resolve, reject) => {
      launcher.once('error', reject);
      launcher.once('exit', code => code === 0 && workerPid ? resolve() : reject(new Error('isolated fixture launcher failed')));
    });
    // The 58-case routes integration performs real target executions and
    // exceeded 120 s twice at case 46 under the independent Claude host.
    // Keep its bounded fixture budget separate from production command limits.
    const budgetMs = file.endsWith('/finding-identity-lineage-smoke.js') ? 300_000 : 120_000;
    const deadline = Date.now() + budgetMs;
    while (!existsSync(outcome) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    process.stdout.write(readFileSync(output, 'utf8'));
    if (!existsSync(outcome)) throw new Error('isolated Finding fixture timed out');
    const result = JSON.parse(readFileSync(outcome, 'utf8')) as { code: number };
    if (result.code !== 0) throw new Error(`isolated Finding fixture failed with exit ${result.code}`);
    return true;
  } finally {
    // Only the process group created by this invocation; never a host/provider.
    if (workerPid && !existsSync(outcome)) { try { process.kill(-workerPid, 'SIGTERM'); } catch { /* already exited */ } }
    closeSync(fd); rmSync(scratch, { recursive: true, force: true });
  }
}
