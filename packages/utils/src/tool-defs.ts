/**
 * @koala-agent/utils 提供的辅助工具 CLI 注册表。
 * 通过 bootstrap 脚本传给 main 的 runCli，与 main 自身的 mainToolDefs 合并。
 */
import { z } from 'zod';
import type { ToolDef } from '../../main/dist/cli-engine.js';

export const utilsToolDefs: ToolDef[] = [
  // Doc 列表
  { name: 'aux_doc_list', description: '列出项目文档（PLAN 阶段挑选 relatedDocs 用）', schema: {
    format: z.enum(['text','json']).optional().describe('输出格式（默认 text）'),
  }},

  // Trace / 诊断
  { name: 'aux_diagnose', description: '自动诊断 case 失败根因（trace diff + git diff）', schema: {
    caseName: z.string().describe('case 名'),
    fixturePath: z.string().optional().describe('fixture 路径（可选）'),
  }},
  { name: 'aux_trace', description: '基于 trace 数据提取架构（逻辑线 + 影响图 + 盲区）', schema: {
    format: z.enum(['json', 'mermaid']).optional().describe('输出格式（默认 json）'),
  }},

  // 元数据扫描 / 查询
  { name: 'aux_scan', description: '扫描元数据 + 校验合规性', schema: {
    format: z.enum(['json','markdown']).optional().describe('输出格式'),
    type: z.string().optional().describe('按类型筛选'), priority: z.string().optional().describe('按优先级筛选'),
    id: z.string().optional().describe('按 task ID 筛选'),
  }},
  { name: 'aux_detail', description: '按文件查详情（签名、属性、import）', schema: {
    files: z.array(z.string()).describe('文件名数组（相对 scanRoot）'),
  }},
  { name: 'aux_sync', description: '元数据同步：extract/clean/validate/status', schema: {
    direction: z.enum(['extract','clean','validate','status']).describe('操作方向'),
  }},
  { name: 'aux_coverage', description: '检查 story 的 task 覆盖率', schema: {
    storyId: z.union([z.string(), z.array(z.string())]).describe('Story ID 或 ID 数组'),
  }},
  { name: 'aux_locate', description: '按关键字模糊查找 task', schema: {
    query: z.string().describe('查询字符串'),
  }},

  // Truth 真相源
  { name: 'truth_scan', description: '扫描真相源', schema: { summary: z.boolean().optional().describe('摘要模式') }},
  { name: 'truth_extract', description: '从代码+Story反向提取真相源文档', schema: {}},
  { name: 'truth_nav', description: '生成导航索引', schema: {}},
  { name: 'truth_analyze', description: '分析真相源矛盾/缺失', schema: {}},
  { name: 'truth_to_story', description: '从需求拆解 Story 建议', schema: {}},

  // Gap / 收敛
  { name: 'gap_analyze', description: '真相源 vs 代码差距报告', schema: {}},
  { name: 'convergence_check', description: '项目收敛检查', schema: {}},

  // Tool 使用统计
  { name: 'tool_status', description: '统计 activity.jsonl（.koala/ + docs/story/ 双源）里的工具使用情况', schema: {
    source: z.enum(['cli','claude','codex','all']).optional().describe('数据源（默认 all）'),
    role: z.string().optional().describe('按 activity role 过滤（如 reviewer / intent / main）'),
    days: z.number().optional().describe('时间窗口天数（默认 30）'),
    limit: z.number().optional().describe('Top N（默认 20）'),
    format: z.enum(['text','json']).optional().describe('输出格式（默认 text）'),
  }},
];
