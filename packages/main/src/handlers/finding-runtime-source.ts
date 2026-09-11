import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Run historical bytes without checking out/resetting the owner's workspace.
 * No mutable ref is accepted. Failed/dirty probes are retained, never forced away. */
export function withFindingRuntimeSource<T>(root: string, sourceRef: string | undefined, run: (sourceRoot: string) => T): T {
  if (!sourceRef) return run(root);
  if (!/^[a-f0-9]{40,64}$/.test(sourceRef)) throw new Error('runtime-evidence: immutable sourceRef required');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const head = git('rev-parse', 'HEAD');
  if (git('rev-parse', `${sourceRef}^{commit}`) !== sourceRef) throw new Error('runtime-evidence: sourceRef is not an exact commit');
  git('merge-base', '--is-ancestor', sourceRef, head);
  const probe = mkdtempSync(join(tmpdir(), 'proof-or-stop-finding-base-'));
  git('worktree', 'add', '--detach', probe, sourceRef);
  let succeeded = false;
  try {
    const result = run(probe);
    if (git('rev-parse', 'HEAD') !== head) throw new Error('runtime-evidence: owner HEAD moved during historical execution');
    succeeded = true; return result;
  } finally {
    if (succeeded) {
      try { git('worktree', 'remove', probe); }
      catch { process.stderr.write(`runtime-evidence: historical probe retained for cleanup: ${probe}\n`); }
    } else process.stderr.write(`runtime-evidence: failed historical probe retained: ${probe}\n`);
  }
}
