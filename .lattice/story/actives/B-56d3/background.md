## 触发事件
2026-05-16 Lifecycle Phase 1（B-3740 Lifecycle Registry V1 + B-37e9 DONE Oracle Extraction）完成后，启动 Phase 2：拆 story_advance.ts。它仍是 944 行的核心 handler，gate 判定、非 DONE side effects、DONE merge cleanup 全缠在一起。Story 3a 是 Phase 2 三步拆分（3a/3b/3c）的第 1 步。

## 关键洞察
story_advance.ts 里两类逻辑可以最先安全抽出且互不耦合：(1) gate runner——REVIEW→TEST preflight、koala validate gate、TEST→DONE done-oracle gate、cwd/guard failure adapter；(2) 非 DONE 的 transition side effects——process metrics、onPhaseChange hooks、REVIEW metadata auto-commit、relatedDocs hint、next-step 渲染。这两类不涉及 DONE merge 的顺序敏感语义，风险低/中，是 Phase 2 风险递增三步里的第一步。

## 方案取舍
只做机械抽取 + 行为冻结：新建 phase-gates.ts 和 transition-effects.ts，story_advance.ts 仍内联协调但改为调用这两个新模块。gate 判定结果、fail-closed 语义、错误文案、evidence 写入时机全部不变。validate gate 第一版仍允许写 test-evidence.json，但要明确标注「behavior-preserving side effect」，本 story 不强行改纯函数。不碰 DONE merge（那是 3b）、不收口 orchestrator（那是 3c）、不碰 TEST 语义/legacy（Story 4）。

## 对话纹理
用户把 Phase 2 拆成 3a/3b/3c 风险递增三步，明确要求串行、每步 behavior-preserving、story_advance responsibility map 作为 3a 的 PLAN understanding 而非 checklist item。3b（DONE merge）必须单独审，3c（orchestrator 收口）最后做。用户作为裁判会逐 story 独立验收，不把 3a 通过视为 3b/3c 通过。
