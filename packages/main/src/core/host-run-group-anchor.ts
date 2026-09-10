/** Keep the owned POSIX group leader alive until provider output pipes close. */
import { spawn } from 'node:child_process';

const [command, ...argv] = process.argv.slice(2);
const child = spawn(command, argv, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
// The provider cannot write the private IPC channel used for spawn diagnostics.
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => { /* A provider may close stdin immediately. */ });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once('error', (error: NodeJS.ErrnoException) => {
  process.send?.({ schema: 'host-group-anchor.v1', event: 'spawn-error', code: error.code });
});
// 'exit' is insufficient: orphan descendants can still own the provider pipes.
// This anchor holds the original group identity until those pipes really close.
child.once('close', (code, signal) => {
  process.stdin.unpipe(child.stdin);
  process.stdin.destroy();
  process.exitCode = code ?? 1;
  if (process.connected) process.send?.({ schema: 'host-group-anchor.v1', event: 'close', code, signal }, () => process.disconnect());
});
