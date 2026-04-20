/**
 * @koala-agent/utils 提供的辅助工具 CLI 注册表。
 * 通过 bootstrap 脚本传给 main 的 runCli，与 main 自身的 mainToolDefs 合并。
 */
import { z } from '../../main/dist/core/zod.js';

/**
 * 注意：这里不要直接复用 main/dist 导出的 ToolDef 类型。
 *
 * main 的 d.ts 里 `schema` 绑定的是它那边解析到的 `zod` 类型身份，而 utils
 * 自己也依赖 zod。两边版本/安装位置一旦不同，TS 会把两个 `ZodType` 视为不兼容，
 * 导致 utils 明明运行时没问题却无法 build。这里保持 runtime 需要的最小结构，
 * 让 bootstrap 时按鸭子类型交给 runCli 即可。
 */
interface RuntimeToolDef {
  name: string;
  description: string;
  longHelp?: string;
  schema: Record<string, unknown>;
}

export const utilsToolDefs: RuntimeToolDef[] = [
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

  // Tool 使用统计
  { name: 'tool_status', description: '统计 .koala/activity.jsonl + legacy docs/story/activity.jsonl 里的工具使用情况', schema: {
    source: z.enum(['cli','claude','codex','all']).optional().describe('数据源（默认 all）'),
    role: z.string().optional().describe('按 role 过滤（如 main / reviewer / intent）'),
    days: z.number().optional().describe('时间窗口天数（默认 30）'),
    limit: z.number().optional().describe('Top N（默认 20）'),
    format: z.enum(['text','json']).optional().describe('输出格式（默认 text）'),
  }},
];
