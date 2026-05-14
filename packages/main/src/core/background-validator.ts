/**
 * B-45ed CHK-006: background.md 四段式格式校验器
 *
 * 真相源层级中，background.md 承担"为什么"维度，是 story 知识库的第一层。
 * 本模块抽成纯函数以供 CHK-007 的 background_set / background_append 复用。
 *
 * 硬下限（与 CLAUDE.md "background.md 四段式格式" 小节对齐）：
 *   - 4 段头齐全（顺序不强制，但每段必须出现恰一次）
 *   - 每段正文 ≥ 50 字符（段头之后、下个段头之前的内容，去掉段头本身）
 *   - 总长 ≥ 300 字符
 *   - "## 触发事件" 段必含 id 正则之一：
 *       B-[a-z0-9]{4} / F-\d+ / CHK-\d+ / [a-f0-9]{7,} hash / ISO 日期 \d{4}-\d{2}-\d{2}
 */

export const REQUIRED_SECTIONS = [
  '触发事件',
  '关键洞察',
  '方案取舍',
  '对话纹理',
] as const;

export type RequiredSection = typeof REQUIRED_SECTIONS[number];

export const BACKGROUND_SECTION_IDS = [
  'trigger_event',
  'key_insight',
  'tradeoff',
  'conversation_texture',
] as const;

export type BackgroundSectionId = typeof BACKGROUND_SECTION_IDS[number];

export const BACKGROUND_SECTION_TITLES: Record<BackgroundSectionId, RequiredSection> = {
  trigger_event: '触发事件',
  key_insight: '关键洞察',
  tradeoff: '方案取舍',
  conversation_texture: '对话纹理',
};

const BACKGROUND_SECTION_ID_BY_TITLE = new Map<string, BackgroundSectionId>(
  Object.entries(BACKGROUND_SECTION_TITLES).map(([id, title]) => [title, id as BackgroundSectionId]),
);

export function normalizeBackgroundSection(value: string): BackgroundSectionId | null {
  const trimmed = value.trim();
  if ((BACKGROUND_SECTION_IDS as readonly string[]).includes(trimmed)) {
    return trimmed as BackgroundSectionId;
  }
  return BACKGROUND_SECTION_ID_BY_TITLE.get(trimmed) ?? null;
}

export function backgroundSectionTitle(sectionId: BackgroundSectionId): RequiredSection {
  return BACKGROUND_SECTION_TITLES[sectionId];
}

const TRIGGER_ID_PATTERNS: RegExp[] = [
  /B-[a-z0-9]{4}\b/,
  /F-\d+\b/,
  /CHK-\d+\b/,
  /\b[a-f0-9]{7,}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
];

export type ValidateResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/**
 * 把 markdown 文本按 "## <title>" 段头拆分，返回每段内容 map。
 * 段头前的 preamble（如 "# Background: xxx" 标题）被忽略。
 * 同名段头多次出现 → 保留首次出现的内容（校验层会单独报错"段头重复"）。
 */
export function parseSections(content: string): { sections: Map<string, string>; headers: string[]; duplicates: string[] } {
  const lines = content.split(/\r?\n/);
  const sections = new Map<string, string>();
  const headers: string[] = [];
  const duplicates: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (current !== null) {
      if (sections.has(current)) {
        if (!duplicates.includes(current)) duplicates.push(current);
      } else {
        sections.set(current, buf.join('\n'));
      }
    }
  };

  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      current = m[1];
      headers.push(current);
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return { sections, headers, duplicates };
}

export function validateBackground(content: string): ValidateResult {
  const errors: string[] = [];

  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, errors: ['background 内容为空'] };
  }

  const totalLen = content.length;
  if (totalLen < 300) {
    errors.push(`总长 ${totalLen} 字符 < 300（硬下限）`);
  }

  const { sections, headers, duplicates } = parseSections(content);

  const missing = REQUIRED_SECTIONS.filter(s => !sections.has(s));
  if (missing.length > 0) {
    errors.push(
      `缺少段头: ${missing.map(s => `"## ${s}"`).join(', ')}；` +
      `期望 4 段: ${REQUIRED_SECTIONS.map(s => `"## ${s}"`).join(' / ')}；` +
      `当前识别到: ${headers.length > 0 ? headers.map(h => `"## ${h}"`).join(', ') : '(无)'}`
    );
  }

  if (duplicates.length > 0) {
    errors.push(`段头重复: ${duplicates.map(s => `"## ${s}"`).join(', ')}（每段仅允许一次）`);
  }

  // 各段正文长度检查（段存在才查，避免重复报错）
  for (const name of REQUIRED_SECTIONS) {
    const body = sections.get(name);
    if (body === undefined) continue; // 已在 missing 里报过
    const trimmed = body.trim();
    if (trimmed.length < 50) {
      errors.push(`"## ${name}" 段正文 ${trimmed.length} 字符 < 50（硬下限）`);
    }
  }

  // 触发事件必须含 id
  const triggerBody = sections.get('触发事件');
  if (triggerBody !== undefined && triggerBody.trim().length > 0) {
    const matched = TRIGGER_ID_PATTERNS.some(re => re.test(triggerBody));
    if (!matched) {
      errors.push(
        '"## 触发事件" 段未匹配任一 id 正则：' +
        'B-[a-z0-9]{4} / F-\\d+ / CHK-\\d+ / [a-f0-9]{7,} / \\d{4}-\\d{2}-\\d{2}；' +
        '必须含具体 story/finding/commit/日期编号，不允许"流程需要优化"类抽象措辞'
      );
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
