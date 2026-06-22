/**
 * @lattice-agent/utils public entry point
 *
 * Usage (inside a bootstrap script):
 *   import { register, utilsToolDefs } from '@lattice-agent/utils';
 *   register(registry, ctx);
 *   await runCli({ extraTools: utilsToolDefs });
 */
export { register } from './register.js';
export { utilsToolDefs } from './tool-defs.js';
