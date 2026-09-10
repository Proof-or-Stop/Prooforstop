/** Keep the owned POSIX group leader alive until controller cleanup. */
import { spawn } from 'node:child_process';

if (typeof process.send !== 'function') throw new Error('HOST_GROUP_ANCHOR_REQUIRES_IPC');
// Only the controller launches this private helper in a new process group.
// If the controller disappears, do not orphan the group waiting for an ack.
const stopOwnedGroup = (): void => {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
};
process.once('disconnect', stopOwnedGroup);
process.on('message', message => {
  if (message && typeof message === 'object'
    && (message as { schema?: string }).schema === 'host-group-anchor.v1'
    && (message as { event?: string }).event === 'terminate') stopOwnedGroup();
});
const [command, ...argv] = process.argv.slice(2);
const child = spawn(command, argv, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
// The provider cannot write the private IPC channel used for spawn diagnostics.
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => { /* A provider may close stdin immediately. */ });
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.once('error', (error: NodeJS.ErrnoException) => {
  process.send?.({ schema: 'host-group-anchor.v1', event: 'spawn-error', code: error.code });
});
// 'exit' is insufficient: orphan descendants can still own the provider pipes.
// After pipes close, retain the group identity until the controller kills the
// group, including background descendants that already released their pipes.
child.once('close', (code, signal) => {
  process.stdin.unpipe(child.stdin);
  process.stdin.destroy();
  // Flush already forwarded bytes before authorizing termination of the anchor.
  // Private IPC is not ordered relative to stdout/stderr pipe delivery.
  let pending = 2;
  const flushed = (): void => {
    if (--pending !== 0) return;
    process.send?.({ schema: 'host-group-anchor.v1', event: 'close', code, signal });
  };
  process.stdout.write('', flushed);
  process.stderr.write('', flushed);
});
