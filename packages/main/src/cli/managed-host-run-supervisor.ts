import module from 'node:module';

// Internal detached owner. It receives no prompt, provider credential, or review
// signing capability; it can only reconcile this already sealed run.
// Its readiness window covers loading the CLI module graph: reuse the on-disk
// compile cache the CLI already fills (cli.ts) before importing it, so a
// loaded host does not recompile ~200 modules first. NODE_DISABLE_COMPILE_CACHE=1 turns it off.
try { (module as { enableCompileCache?: () => unknown }).enableCompileCache?.(); } catch { /* optional speed-up */ }
(await import('../core/git-read-cache.js')).installGitReadCache();
const { runManagedHostRunSupervisor } = await import('../core/managed-host-run.js');
const [root, runId] = process.argv.slice(2);
if (!root || !runId) throw new Error('managed supervisor requires root and runId');
runManagedHostRunSupervisor({ root, runId }, () => {
  process.send?.({ type: 'managed-supervisor-ready', runId });
}).catch(error => {
  console.error(`managed supervisor: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
