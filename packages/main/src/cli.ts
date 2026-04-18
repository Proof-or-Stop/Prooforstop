#!/usr/bin/env node
/**
 * koala bin 入口（main 单独可用模式）
 *
 * 这个脚本只加载 main 自带的工具（流程类）。如果想同时启用 @koala-agent/utils
 * 的辅助工具，使用 packages/koala/bin/koala.js 这个 bootstrap 脚本。
 *
 * test_auto 的 importAndExecute 会带 ?t= cache buster 重复 import 这个文件，
 * 那种情况下 import.meta.url 含查询参数，跳过 runCli。
 */

import { runCli } from './cli-engine.js';
import { z } from './core/zod.js';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

async function loadOptionalLabExtension() {
  const distDir = dirname(fileURLToPath(import.meta.url));
  const localLabDist = pathToFileURL(join(distDir, '..', '..', 'lab', 'dist', 'index.js')).href;
  const candidates = ['@koala-agent/lab', localLabDist];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      const createLabToolDefs = mod.createLabToolDefs;
      const register = mod.register;
      if (typeof createLabToolDefs === 'function' && typeof register === 'function') {
        return {
          tools: createLabToolDefs(z),
          register,
        };
      }
    } catch (error: any) {
      const code = error?.code || '';
      if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
        process.env.KOALA_LAB_IMPORT_ERROR = error?.message || String(error);
      }
    }
  }
  return null;
}

const _isDirectRun = !import.meta.url.includes('?');
if (_isDirectRun) {
  loadOptionalLabExtension()
    .then((lab) => runCli(lab ? {
      extraTools: lab.tools,
      extraRegister: lab.register,
    } : undefined))
    .catch(e => { console.error(e); process.exit(1); });
}
