# Test Fixtures

单函数白盒测试的 fixture 文件，由 @test 注释引用。

## 文件格式

```json
{
  "cases": [
    {
      "name": "测试用例名称",
      "input": { ... },
      "expect": { ... }
    },
    {
      "name": "异常情况",
      "input": { ... },
      "throws": "ErrorName"
    }
  ]
}
```

## 目录结构

按业务域/功能分子目录，文件名对应函数名：

```
tests/fixtures/
  story/
    story_create.json
    story_advance.json
  local-bot/
    sendLocalBotRequest.json
    handleBotRouting.json
```
