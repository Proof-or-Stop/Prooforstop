## 触发事件
2026-06-02 用户在完成 B-9b76 thin prompt registry assets 后追问：KOALA.md、.Codex/koala.json、bin/koala.js、bin/koala-codex.js 这些新项目资产是不是也应该命名为 Lattice。该问题直接指向新 init 输出的品牌一致性，而不是 prompt registry 本身。

## 关键洞察
上一轮已经把大量 prompt copies 移到 registry/thin 模式，但仍保留了 Koala-branded entrypoint 和 manifest 名称。对新项目来说，这会让 Lattice 产品线继续暴露旧品牌，尤其是本地 launcher 和 Codex manifest。真正的产品化应让 Lattice 成为 primary asset surface，同时让旧 Koala paths 只承担兼容职责。

## 方案取舍
本 story 不做破坏性重命名，不删除旧项目中的 KOALA.md、bin/koala.js、bin/koala-codex.js 或 .Codex/koala.json。新 init 输出改为 Lattice primary paths；managed check、verify_codex 和 runtime detection 继续识别 legacy Koala aliases。若二者并存，诊断应偏向 Lattice primary path 并给出清晰漂移信息。

## 对话纹理
用户先问新项目是否还会有很多 .md 文件，我们确认 thin mode 解决了 prompt copy 数量问题；随后用户指出剩余少量核心资产仍叫 Koala。这不是单纯审美问题，而是新项目第一眼看到的品牌和命令入口是否一致。实现时要保持用户的简洁目标：新项目少文件、Lattice 名称、旧项目不炸。
