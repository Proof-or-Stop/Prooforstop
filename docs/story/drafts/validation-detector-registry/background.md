## 触发事件
2026-04-27 用户追问 Android 原生开发测试、PHP 开发测试、Python 开发测试是否都支持。当前 Koala 已能发现 npm test、pytest、go test、cargo test、swift test、mvn test、gradle test，但 PHP、uv pytest、composer test、phpunit、nox/tox 优先级和 detector 可解释性不足。

## 关键洞察
语言支持不应该写成 if else 堆在 verifier handler 里。每个语言 detector 应该只负责识别项目文件和产生 ValidationCommand 候选，核心执行器只负责执行计划。配置 validate.commands 必须始终优先，自动探测只能做默认兜底。

## 方案取舍
选择先实现轻量 detector registry，而不是引入插件系统或外部包。第一批覆盖高频后端语言和包管理器：Node、Python、PHP、Go、Rust、Java Maven、Gradle、Swift Package。Android instrumentation、Xcode、CMake 进入后续 story，因为这些环境依赖更强，默认强跑风险大。

## 对话纹理
用户的关切是所有项目都可以使用 Koala，而不是只在 JS/TS 仓库里好用。因此这个 story 的输出应该让用户在 PHP 项目看到 composer test 或 phpunit，在 Python 项目看到 uv run pytest 或 python -m pytest，在 Gradle 项目看到 gradle test，并能解释为什么选择这些命令。
