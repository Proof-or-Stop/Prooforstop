/**
 * Proves `--json` prints status and exits WITHOUT starting a listener.
 *
 * The flag's whole point is machine-readable status with no server, so a regression
 * that quietly started listening would be invisible from the output alone. The port is
 * checked free before and after, and the command must exit 0 with parseable JSON.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const PORT = Number(process.env.GRAPH_VERIFY_PORT ?? 8815);

const holders = p => {
  try {
    return execFileSync('lsof', ['-ti', `:${p}`], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })
      .split('\n').filter(Boolean);
  } catch { return [] }
};

const failures = [];
if (holders(PORT).length) {
  console.error(`PORT_BUSY: ${PORT} already in use; set GRAPH_VERIFY_PORT to a free port.`);
  process.exit(1);
}

const out = execFileSync('node', ['bin/proof-or-stop.js', 'graph', '--json', `--port=${PORT}`],
  { cwd: repo, encoding: 'utf8' });

const after = holders(PORT);
if (after.length) failures.push(`--json left a listener on ${PORT}: pids ${after.join(',')}`);

// The CLI prefixes progress lines, so take the JSON object out of the output.
const start = out.indexOf('{');
const end = out.lastIndexOf('}');
let status = null;
if (start < 0 || end < 0) failures.push('--json printed no JSON object');
else {
  try { status = JSON.parse(out.slice(start, end + 1)) } catch (e) { failures.push(`--json output is not valid JSON: ${e.message}`) }
}
if (status && typeof status.stories !== 'number') failures.push('--json status has no numeric story count');

if (failures.length) {
  console.error('JSON_MODE_BROKEN');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`--json → ${status.stories} stories, ${status.edges} edges, no listener on ${PORT}`);
console.log('JSON_NO_LISTENER_OK');
