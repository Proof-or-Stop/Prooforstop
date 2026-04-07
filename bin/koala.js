#!/usr/bin/env node
/**
 * koala bootstrap — main + utils 组装入口
 *
 * 这个脚本是 packages/koala 工作区的 koala 命令入口。它把 main 自带的工具
 * 和 @koala-agent/utils 提供的辅助工具一起注册，然后把控制权交给 main 的
 * runCli。
 *
 * main 单独使用时（不挂载 utils）请直接跑 packages/main/dist/cli.js。
 */

import { runCli } from '../packages/main/dist/cli-engine.js';
import { register, utilsToolDefs } from '../packages/utils/dist/index.js';

runCli({
  extraTools: utilsToolDefs,
  extraRegister: register,
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
