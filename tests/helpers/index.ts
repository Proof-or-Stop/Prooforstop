/**
 * @task B-010
 * @checklist CHK-008
 * @title 测试辅助工具
 * @type feature
 * @priority high
 * @date 2026-04-01
 * @description
 *   测试辅助模块，提供常用的测试工具函数。
 *   当自动化测试遇到新模式时，Claude 自动在此目录补充 helper。
 * @changes
 *   - [CHK-008] 新增 deepClone 函数
 *   - [CHK-008] 新增 createTempDir 函数
 *   - [CHK-008] 新增 mockConsole 函数
 */

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/** 深拷贝对象 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/** 创建临时目录，返回路径和清理函数 */
export function createTempDir(prefix: string = 'koala-test-'): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    path: dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/** Mock console，捕获输出 */
export function mockConsole(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;

  console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args: any[]) => { errors.push(args.map(String).join(' ')); };

  return {
    logs,
    errors,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}
