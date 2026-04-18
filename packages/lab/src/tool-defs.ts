/**
 * @koala-agent/lab 提供的 CLI 工具定义。
 */
interface RuntimeToolDef {
  name: string;
  description: string;
  longHelp?: string;
  guardrails?: {
    supportsDryRun?: boolean;
    requiresConfirm?: boolean;
  };
  schema: Record<string, unknown>;
}

export function createLabToolDefs(z: any): RuntimeToolDef[] {
  return [
  {
    name: 'lab_create',
    description: '创建 koala-lab 实验配置骨架',
    schema: {
      target: z.string().describe('优化目标，如 test-case-reviewer'),
      profile: z.string().describe('评估 profile，如 reviewer-quality-v1'),
      id: z.string().optional().describe('实验 ID（默认自动生成）'),
      name: z.string().optional().describe('实验名称'),
      editableFiles: z.array(z.string()).optional().describe('覆盖默认 editableFiles 白名单'),
    },
  },
  {
    name: 'lab_run',
    description: '运行 koala-lab 实验（dry-run 预览或 confirm 创建 sandbox）',
    guardrails: {
      supportsDryRun: true,
      requiresConfirm: true,
    },
    schema: {
      config: z.string().describe('experiment.json 路径（相对项目根或绝对路径）'),
      dryRun: z.boolean().optional().describe('仅预览 sandbox、branch 和 artifacts，不实际创建'),
      confirm: z.boolean().optional().describe('显式确认创建 sandbox worktree 和基础 run artifacts'),
    },
  },
  {
    name: 'lab_eval',
    description: '评估候选 patch 是否满足基础 patch policy',
    schema: {
      config: z.string().describe('experiment.json 路径'),
      patchFile: z.string().optional().describe('unified diff 文件路径'),
      files: z.array(z.string()).optional().describe('直接指定 touched files（与 patchFile 二选一）'),
    },
  },
  {
    name: 'lab_compare',
    description: '查看 baseline 与已记录 run 的对比摘要',
    schema: {
      config: z.string().describe('experiment.json 路径'),
    },
  },
  {
    name: 'lab_promote',
    description: '输出当前最佳 run 的 promote 建议',
    schema: {
      config: z.string().describe('experiment.json 路径'),
    },
  },
  ];
}
