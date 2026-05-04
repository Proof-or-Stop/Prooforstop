## 触发事件
2026-05-04 用户确认：每次 koala init 生成新的 src/ 文件夹看起来没有用。代码检查显示 init 会硬创建 src/core、src/shells 和 tests，并把 scanRoot 默认写成 src。

## 关键洞察
这些 src 模板是早期 starter/demo 资产，不是 Koala 流程必需资产。对已有项目来说，默认创建空 src 会污染项目结构，并可能让 scanRoot 指到空目录。

## 方案取舍
默认 init 只生成 Koala 管理资产；新增显式 --starter/--with-template 才生成业务模板。scanRoot 检测必须发生在模板创建之前，避免 init 自己创建的 src 影响判断。

## 对话纹理
用户不是要重构 Koala Lab，而是确认这个 src 是否无用并同意把它改成不默认生成；回答要直接，改动也要小而可验证。
