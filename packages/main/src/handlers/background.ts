/**
 * background CLI 三件套 — B-45ed CHK-007
 *
 * background.md 是真相源层级中"为什么"维度（第一层），
 * 路径固定：docs/story/actives/{storyId}/background.md
 *
 * 三个命令：
 *   - background_set({ storyId, content })        全量覆盖，复用 CHK-006 的 validateBackground 格式校验
 *   - background_append({ storyId, section, content }) 追加内容到指定段末尾，不影响其他段
 *   - background_get({ storyId })                  返回当前 background.md 内容
 *
 * 设计约束：
 *   - 不读写 docs/story/actives/{storyId}/ 之外路径
 *   - append 的 section 白名单 = REQUIRED_SECTIONS（4 个）
 *   - background.md 不存在时 append / get 报错引导 `background_set`
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import {
  REQUIRED_SECTIONS,
  parseSections,
  validateBackground,
  type RequiredSection,
} from '../core/background-validator.js';

function backgroundPath(root: string, storyId: string): string {
  return join(root, 'docs', 'story', 'actives', storyId, 'background.md');
}

export function createBackgroundHandlers(ctx: HandlerContext) {
  const { root } = ctx;

  return {
    background_get(args: { storyId: string }): { content: string } {
      if (!args.storyId) throw new Error('storyId is required');
      const p = backgroundPath(root, args.storyId);
      if (!existsSync(p)) {
        throw new Error(
          `background.md not found for ${args.storyId}, use background_set first`
        );
      }
      return { content: readFileSync(p, 'utf-8') };
    },

    background_set(args: { storyId: string; content: string }): { path: string; bytes: number } {
      if (!args.storyId) throw new Error('storyId is required');
      if (typeof args.content !== 'string') throw new Error('content is required (string)');

      const result = validateBackground(args.content);
      if (!result.ok) {
        throw new Error(
          'background 格式校验失败:\n' +
          result.errors.map(e => `  - ${e}`).join('\n') + '\n' +
          '期望 4 段: "## 触发事件" / "## 关键洞察" / "## 方案取舍" / "## 对话纹理"\n' +
          '每段 ≥ 50 字符，总长 ≥ 300 字符，触发事件段须含具体编号'
        );
      }

      const p = backgroundPath(root, args.storyId);
      // 保证以换行结尾，与 story_create 落盘惯例一致
      const content = args.content.endsWith('\n') ? args.content : args.content + '\n';
      writeFileSync(p, content, 'utf-8');
      return { path: p, bytes: Buffer.byteLength(content, 'utf-8') };
    },

    background_append(args: {
      storyId: string;
      section: string;
      content: string;
    }): { path: string; section: string; appendedBytes: number } {
      if (!args.storyId) throw new Error('storyId is required');
      if (!args.section) throw new Error('section is required');
      if (typeof args.content !== 'string' || args.content.length === 0) {
        throw new Error('content is required (non-empty string)');
      }

      if (!(REQUIRED_SECTIONS as readonly string[]).includes(args.section)) {
        throw new Error(
          `非法 section "${args.section}"；合法段头: ${REQUIRED_SECTIONS.map(s => `"${s}"`).join(' / ')}`
        );
      }
      const targetSection = args.section as RequiredSection;

      const p = backgroundPath(root, args.storyId);
      if (!existsSync(p)) {
        throw new Error(
          `background.md not found for ${args.storyId}, use background_set first`
        );
      }

      const original = readFileSync(p, 'utf-8');
      const lines = original.split(/\r?\n/);
      // 记录原文是否以换行结尾（split 会产生末尾空字符串），写回时保持一致
      const hadTrailingNewline = original.endsWith('\n');
      const workLines = hadTrailingNewline && lines[lines.length - 1] === ''
        ? lines.slice(0, -1)
        : lines;

      // 定位目标段：段头行 index + 段结束 index（下一个 "## " 或 EOF）
      let startIdx = -1;
      for (let i = 0; i < workLines.length; i++) {
        const m = workLines[i].match(/^##\s+(.+?)\s*$/);
        if (m && m[1] === targetSection) { startIdx = i; break; }
      }
      if (startIdx === -1) {
        // 段头不存在（background.md 缺段）— 报错引导用 background_set 修复格式
        const existing = parseSections(original);
        throw new Error(
          `段 "## ${targetSection}" 在 background.md 中未找到；` +
          `当前段头: ${existing.headers.length > 0 ? existing.headers.map(h => `"## ${h}"`).join(', ') : '(无)'}；` +
          `请先用 background_set 修复四段式格式`
        );
      }

      let endIdx = workLines.length;
      for (let i = startIdx + 1; i < workLines.length; i++) {
        if (/^##\s+/.test(workLines[i])) { endIdx = i; break; }
      }

      // 向前回退，跳过段末的空行，找到最后一个非空内容行后的插入点
      let insertAfter = endIdx - 1;
      while (insertAfter > startIdx && workLines[insertAfter].trim() === '') {
        insertAfter--;
      }

      // 追加：在 insertAfter 之后插入新内容（原段内容 + \n + content）
      const contentLines = args.content.split(/\r?\n/);
      const newLines = [
        ...workLines.slice(0, insertAfter + 1),
        ...contentLines,
        ...workLines.slice(insertAfter + 1),
      ];
      const rebuilt = newLines.join('\n') + (hadTrailingNewline ? '\n' : '');
      writeFileSync(p, rebuilt, 'utf-8');
      return {
        path: p,
        section: targetSection,
        appendedBytes: Buffer.byteLength(args.content, 'utf-8'),
      };
    },
  };
}
