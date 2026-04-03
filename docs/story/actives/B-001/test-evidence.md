# 测试证据 — B-001

## 环境
- Node: v22.x
- OS: macOS Darwin 25.2.0
- 时间: 2026-04-01

## 测试 1: MCP Server 启动 + initialize
**目的:** 验证 MCP Server 能正常启动并响应 initialize 请求
**命令:**
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | node packages/main/dist/mcp/server.js
```
**预期:** 返回 serverInfo.name = "koala-main"
**实际输出:**
```json
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"koala-main","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```
**结果:** PASS

## 测试 2: tools/list 返回全部 10 个工具
**目的:** 验证所有 MCP 工具注册成功
**命令:**
```bash
printf '...initialize...\n...notifications/initialized...\n...tools/list...\n' | node packages/main/dist/mcp/server.js
```
**预期:** 返回 10 个工具定义
**实际输出:** 返回 story_init, story_update, story_get, checklist_get, checklist_update, bug_add, bug_update, bug_list, test_evidence_add, test_evidence_get 共 10 个工具
**结果:** PASS

## 测试 3: story_init 创建 Story 文件
**目的:** 验证 story_init 能正确创建 index.json + checklist.json
**命令:**
```bash
printf '...story_init {"storyId":"TEST-001","title":"测试Story","backlogId":"TEST-001","checklist":[{"id":"CHK-001","title":"测试项"}]}...\n' | KOALA_PROJECT_ROOT=/tmp/koala-test node packages/main/dist/mcp/server.js
```
**预期:** 创建 /tmp/koala-test/docs/story/actives/TEST-001/index.json 和 checklist.json
**实际输出:**
```json
{"result":{"content":[{"type":"text","text":"Story TEST-001 created with 1 checklist items"}]},"jsonrpc":"2.0","id":2}
```
文件内容验证：index.json 包含 status:"INIT", checklist.json 包含 1 个 pending 项
**结果:** PASS

## 测试 4: story_update 门禁检查 — checklist 未完成时拦截 TEST
**目的:** 验证 checklist 未全部 done 时无法进入 TEST 阶段
**命令:**
```bash
printf '...story_update {"storyId":"TEST-001","phase":"TEST"}...\n' | KOALA_PROJECT_ROOT=/tmp/koala-test node packages/main/dist/mcp/server.js
```
**预期:** 返回错误信息，拒绝进入 TEST
**实际输出:**
```json
{"result":{"content":[{"type":"text","text":"Cannot enter TEST: 1 checklist item(s) not done: CHK-001"}],"isError":true},"jsonrpc":"2.0","id":2}
```
**结果:** PASS

## 测试 5: TypeScript 编译
**目的:** 验证 tsc 编译无错误
**命令:**
```bash
cd packages/main && npm run build
```
**预期:** 编译成功，无错误
**实际输出:** `> tsc` (无错误输出)
**结果:** PASS
