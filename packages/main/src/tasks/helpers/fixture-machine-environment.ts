/** Test-only machine-registry namespace. Never imported by production executors. */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createFixtureMachineEnvironment(): { env: NodeJS.ProcessEnv; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-fixture-machine-'));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const preload = join(root, 'preload.mjs');
  // A concrete path in the preload makes every descendant use the same pool.
  // HOME and os.homedir remain untouched: this isolates registries, not credentials.
  writeFileSync(preload, `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
const original = os.userInfo;
os.userInfo = (...args) => ({ ...original(...args), homedir: ${JSON.stringify(home)} });
syncBuiltinESMExports();
`, { mode: 0o600 });
  const flag = `--import=${pathToFileURL(preload).href}`;
  return {
    root,
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, flag].filter(Boolean).join(' ') },
    cleanup: () => {
      const entries = readdirSync(home, { recursive: true });
      if (entries.some(entry => /\.(ticket|choosing)$|(?:^|[\\/])slot-\d+\.json$/.test(String(entry)))) {
        throw new Error(`fixture machine still has admission records; retained ${root}`);
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
