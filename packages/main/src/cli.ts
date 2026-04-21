#!/usr/bin/env node
/**
 * koala bin 入口（main 单独可用模式）
 *
 * 这个脚本只加载 main 自带的工具（流程类）。如果想同时启用 @koala-agent/utils
 * 的辅助工具，使用 packages/koala/bin/koala.js 这个 bootstrap 脚本。
 *
 * 动态 import 带 ?t= cache buster 时 import.meta.url 含查询参数，跳过 runCli。
 */

import { runCli } from './cli-engine.js';

const _isDirectRun = !import.meta.url.includes('?');
if (_isDirectRun) {
  runCli().catch(e => { console.error(e); process.exit(1); });
}
