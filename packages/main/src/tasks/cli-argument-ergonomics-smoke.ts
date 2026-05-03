import assert from 'node:assert/strict';
import { z } from 'zod';
import { MAIN_TOOLS, parseFlags } from '../cli-engine.js';

function schemaFor(name: string) {
  const tool = MAIN_TOOLS.find(t => t.name === name);
  assert.ok(tool, `missing tool schema: ${name}`);
  return z.object(tool.schema);
}

const relatedDocsFlags = parseFlags(
  ['--storyId=B-smoke', '--itemId=CHK-001', '--relatedDocs=["AGENTS.md","CLAUDE.md"]'],
  MAIN_TOOLS.find(t => t.name === 'checklist_update')!.schema,
);
assert.deepEqual(relatedDocsFlags.relatedDocs, ['AGENTS.md', 'CLAUDE.md']);
assert.equal(schemaFor('checklist_update').safeParse(relatedDocsFlags).success, true);

const repeatedRelatedDocsFlags = parseFlags(
  ['--storyId=B-smoke', '--itemId=CHK-001', '--relatedDocs=AGENTS.md', '--relatedDocs=CLAUDE.md'],
  MAIN_TOOLS.find(t => t.name === 'checklist_update')!.schema,
);
assert.deepEqual(repeatedRelatedDocsFlags.relatedDocs, ['AGENTS.md', 'CLAUDE.md']);
assert.equal(schemaFor('checklist_update').safeParse(repeatedRelatedDocsFlags).success, true);

const storyCreate = schemaFor('story_create').parse({
  name: 'test-type-alias',
  title: 'Test type alias',
  description: 'A validation-only story should not force users to guess chore.',
  type: 'test',
  priority: 'medium',
  background: [
    '## 触发事件',
    '2026-05-03 用户反馈验证类 story 使用 type test 会被拒绝，导致第一次创建验证任务时必须猜测 chore 类型。',
    '',
    '## 关键洞察',
    '验证类任务在 Koala 语义里更接近 chore，但用户自然会输入 test；CLI 应该吸收这个常见表达差异。',
    '',
    '## 方案取舍',
    '保持持久化 StoryType 集合不扩大，只在 CLI schema 层把 test 归一到 chore，避免破坏下游类型判断。',
    '',
    '## 对话纹理',
    '用户是在验证框架行为时遇到这个限制，期望命令继续执行，而不是先学习内部四类枚举边界。',
  ].join('\n'),
});
assert.equal(storyCreate.type, 'chore');

console.log('cli argument ergonomics smoke passed');
