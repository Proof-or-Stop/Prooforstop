
















import { failures } from "./data.mjs";
import { selectedGroup, selectedGroups } from './data.mjs';

export async function check(groups, name, fn) {
  // Archived migration campaigns require explicit opt-in, including for no selector.
  if (groups.includes('identity-migration-archive') && !selectedGroups?.includes('identity-migration-archive')) return;
  if (selectedGroups !== null && !groups.some(group => selectedGroups.includes(group))) return;
  const startedAt = process.hrtime.bigint();
  let status = 'fail';
  try {
    await fn();
    status = 'pass';
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stderr.write(`FAIL ${name}: ${error?.message ?? error}\n`);
  } finally {
    process.stderr.write('IDENTITY_CHECK_TIMING ' + JSON.stringify({
      pid: process.pid, group: selectedGroup, name, status,
      elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    }) + '\n');
  }
}
