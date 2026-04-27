## 触发事件
2026-04-27 用户特别点名 Android 原生开发测试，并扩展到 C++、Java、Swift、Objective-C 等原生栈。当前 Gradle test 和 Swift Package 有基础支持，但 Android connectedAndroidTest、Xcode scheme/destination、CMake build dir 都依赖本机环境，直接默认执行很容易误伤体验。

## 关键洞察
移动端和 C++ 不适合像 pytest 一样盲跑。Android emulator、iOS simulator、Xcode scheme、CMake build 目录通常需要项目配置或本机设备状态。Koala 应该能识别这些项目并给出安全计划：默认跑低风险单元测试，昂贵或设备依赖测试通过 optional/config 显式启用。

## 方案取舍
选择把 Android、Xcode、CMake 作为第二层 detector：可以生成建议和可选命令，但不在无配置时强跑设备测试。CMake 只有发现已有 build/CTestTestfile.cmake 时默认 ctest，否则提示 validate.commands。Xcode 只在配置 scheme/destination 后执行。

## 对话纹理
用户要的是其它项目能放心使用 Koala，而不是每次在移动端项目里被模拟器、scheme 或 build dir 卡住。因此这个 story 的用户价值是安全、清楚、可配置：Koala 知道这是 Android/iOS/C++ 项目，也知道什么时候应该停下来要求配置。
