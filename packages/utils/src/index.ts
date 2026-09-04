/**
 * @proof-or-stop/utils public entry point
 *
 * Usage (inside a bootstrap script):
 *   import { register, utilsToolDefs } from '@proof-or-stop/utils';
 *   register(registry, ctx);
 *   await runCli({ extraTools: utilsToolDefs });
 */
export { register } from './register.js';
export {
  utilsAllowedPhases,
  utilsOwnershipClasses,
  utilsToolDefs,
} from './tool-defs.js';
