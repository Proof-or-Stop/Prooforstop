/**
 * @proof-or-stop/utils public entry point
 *
 * Usage (inside a bootstrap script):
 *   import { runCli } from '@proof-or-stop/core/extension-api';
 *   import {
 *     register,
 *     utilsAllowedPhases,
 *     utilsOwnershipClasses,
 *     utilsToolDefs,
 *   } from '@proof-or-stop/utils';
 *   await runCli({
 *     extraTools: utilsToolDefs,
 *     extraRegister: register,
 *     extraOwnershipClasses: utilsOwnershipClasses,
 *     extraAllowedPhases: utilsAllowedPhases,
 *   });
 */
export { register } from './register.js';
export {
  utilsAllowedPhases,
  utilsOwnershipClasses,
  utilsToolDefs,
} from './tool-defs.js';
