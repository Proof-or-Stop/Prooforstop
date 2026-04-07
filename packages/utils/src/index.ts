/**
 * @koala-agent/utils 公共入口
 *
 * 用法（在 bootstrap 脚本里）：
 *   import { register, utilsToolDefs } from '@koala-agent/utils';
 *   register(registry, ctx);
 *   await runCli({ extraTools: utilsToolDefs });
 */
export { register } from './register.js';
export { utilsToolDefs } from './tool-defs.js';
