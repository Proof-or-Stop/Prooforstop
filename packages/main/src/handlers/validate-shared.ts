/**
 * validate-shared — 跨 validate-* CLI gate 的共享常量。
 *
 * 当前只有 DEFAULT_BASE（git diff / git log 的默认 base 分支），
 * 被 validate-channel.ts 和 validate-concept.ts 同名常量重复定义 →
 * 抽到此处统一 export（F-008 修复）。
 */

/** git diff / git log 的默认 base 分支（story 分支相对 main 比较）。 */
export const DEFAULT_BASE = 'main';
