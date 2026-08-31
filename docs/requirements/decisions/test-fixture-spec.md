# @test Annotation and Fixture Specification

## @test Annotation Placement Rule

**It must be written in the function/method-level `@task` block, not at the top of the file.**

```js
// ✅ Correct: each function is annotated individually
/**
 * @task S-001
 * @checklist CHK-001
 * @title Send message
 * @type feature
 * @priority high
 * @description Send a message to the room
 * @changes
 *   - [CHK-001] Add sendRoomMessage
 * @test application/agent-service-facade
 */
sendRoomMessage(conversationKey, content) { ... }

/**
 * @task S-001
 * @checklist CHK-002
 * @title Reply to message
 * @type feature
 * @priority high
 * @description Reply to a specified message
 * @changes
 *   - [CHK-002] Add replyRoomMessage
 * @test application/agent-service-facade
 */
replyRoomMessage(conversationKey, targetEventId, content) { ... }
```

```js
// ❌ Wrong: @test at the top of the file, so all functions inherit the same fixture
/**
 * @task S-001
 * @checklist CHK-001
 * @title AgentServiceFacade
 * @test application/agent-service-facade   ← @test should not be here
 */
```

**Reason**: a file-level `@task` has no `functionName`, but if the `@task` blocks written on the methods all point to the same fixture, test_auto will run all of the fixture's cases for every function. You need to distinguish them with the `fn` field (see below).

## Fixture Path Mapping

`@test application/agent-service-facade` → `{fixturesDir}/application/agent-service-facade.json`

- The path is relative to the `fixturesDir` of `proof-or-stop.config.json`
- No `.json` suffix
- Multiple functions can point to the same fixture file (use the `fn` field to distinguish which case belongs to which)

## Fixture JSON Format

### Basic Structure

```json
{
  "cases": [
    {
      "name": "case description",
      "input": { ... },
      "expect": { ... }
    }
  ]
}
```

### Case Fields

| Field | Required | Type | Description |
|------|------|------|------|
| `name` | Yes | string | case description |
| `executor` | No | string | Executor ID; when omitted, a case with `execute` uses `js.execute` and a case with `command` uses `command` |
| `input` | No | any | Arguments passed to the function (in a function executor, an array is spread into multiple args, an object is passed as a single arg) |
| `fn` | No | string | Specifies which function to call (required when multiple functions share a fixture) |
| `command` | No | string / array | The command for the `command` executor; the array form is `[cmd, ...args]` |
| `args` | No | string[] | Arguments appended to `command` |
| `execute` | No | string | legacy JS executor function body |
| `expect` | No | any | Expected return value (partial match) |
| `throws` | No | string | Expected error-message fragment to be thrown (mutually exclusive with expect) |
| `intentRef` | No | string | Associated testIntent (such as CHK-001:happy:0) |

### Executor Protocol

A fixture is a language-agnostic test protocol, not a JS script container. `execute` represents only the legacy `js.execute` executor; cross-language code must use `command`, a language executor, or a native test command as evidence.

Built-in executors:

| executor | Description |
|---|---|
| `js.execute` | Compatible with the old format; executes the JS `execute` function body and injects `$handlers` / `$root` / `$ctx` |
| `command` | General process-boundary executor, suitable for `pytest`, `go test`, `ctest`, `mvn test`, `swift test`, `xcodebuild test` |
| `python.function` | Python function-level executor, calls the `fn` in `file` via JSON |
| `go.test` | Go standard test entry, runs `go test ./...` by default |
| `java.junit` | Java/JUnit standard test entry, runs `mvn test` by default, and runs the Gradle test when `buildTool:"gradle"` |
| `cpp.binary` | C/C++ compiled test binary entry, runs `binary` or `command` |
| `swift.test` | Swift Package test entry, runs `swift test` by default |
| `objc.xcodebuild` | Objective-C / Apple-platform test entry, runs `xcodebuild test` by default |
| `rust.cargo` | Rust Cargo test entry, runs `cargo test` by default |

Language strategy:

- New languages should prefer `command`, ensuring any CLI/test framework can be integrated.
- Common languages use a dedicated executor to fix the default command, reducing the per-fixture repetition of command details.
- A dedicated executor does not change the assertion model; `expect`, `throws`, `timeoutMs`, `cwd`, and `env` are still handled by the unified runner.

#### command Example

```json
{
  "name": "go package tests pass",
  "run_type": "cli",
  "executor": "command",
  "command": ["go", "test", "./..."],
  "expect": { "pattern": "PASS|ok" },
  "intentRef": "CHK-001:happy:0"
}
```

#### python.function Example

```json
{
  "name": "calculator add",
  "run_type": "cli",
  "executor": "python.function",
  "file": "src/calculator.py",
  "fn": "add",
  "input": [1, 2],
  "expect": 3,
  "intentRef": "CHK-001:happy:0"
}
```

#### Common-Language Executor Examples

```json
{
  "name": "go package tests pass",
  "run_type": "cli",
  "executor": "go.test",
  "packages": ["./..."],
  "expect": { "pattern": "PASS|ok" }
}
```

```json
{
  "name": "java junit tests pass",
  "run_type": "cli",
  "executor": "java.junit",
  "buildTool": "gradle",
  "args": ["test"],
  "expect": { "pattern": "BUILD SUCCESSFUL|BUILD SUCCESS" }
}
```

```json
{
  "name": "cpp test binary passes",
  "run_type": "cli",
  "executor": "cpp.binary",
  "binary": "./build/calculator_tests",
  "expect": { "pattern": "PASS|OK" }
}
```

```json
{
  "name": "swift package tests pass",
  "run_type": "cli",
  "executor": "swift.test",
  "expect": { "pattern": "Test Suite.*passed|Build complete" }
}
```

```json
{
  "name": "objc xcode tests pass",
  "run_type": "cli",
  "executor": "objc.xcodebuild",
  "workspace": "App.xcworkspace",
  "scheme": "AppTests",
  "destination": "platform=iOS Simulator,name=iPhone 15",
  "expect": { "pattern": "TEST SUCCEEDED" }
}
```

## Phase Semantics

- The `DEV` phase can add fixtures early with `fixture_batch_add`, mainly for compatibility verification or writing-and-running as you go; this is not a necessary condition for completing the test phase.
- The `TEST_CASE` phase is the phase for formally completing fixture coverage. After writing the cases, you should immediately run `test_story --storyId=...` to verify the cases associated with the current story.
- `checklist_update --status=done` no longer requires that the fixture intentRef be covered; fixture coverage is the responsibility of the `testintent_check` / TEST_CASE_REVIEW gate.
- If `testintent_check` reports fixture coverage missing, add an `intentRef` to the corresponding case, in a format such as `CHK-001:happy:0`. In a story worktree, `fixture_batch_add` will automatically complete it into a scoped ref with the storyId.

### expect Matching Rules

1. **Partial match**: each field in expect must exist in actual and be equal; actual may have extra fields
2. **pattern regex**: if expect contains a `pattern` field, match actual with a regex (a string is matched directly, an object is JSON.stringify'd first)
3. **throws error match**: the throws field is a string, and it passes if the actual error message contains that string

### Examples

#### 1. Function returns a string, matched with pattern

```json
{
  "name": "create story with checklist",
  "input": { "name": "test", "title": "Test", "type": "feature", "priority": "high" },
  "expect": { "pattern": "Story [A-Z]+-[a-f0-9]+ created" }
}
```

#### 2. Function returns an object, partial match

```json
{
  "name": "list room context returns empty",
  "fn": "listRoomContext",
  "input": { "conversationKey": "bot1:room1" },
  "expect": { "recentTurns": [], "summary": "" }
}
```

#### 3. Expect a throw

```json
{
  "name": "throws when adapter absent",
  "fn": "sendRoomMessage",
  "input": { "conversationKey": "bot1:room1", "content": "Hello" },
  "throws": "roomAdapter is not configured"
}
```

#### 4. Prerequisite case + $prev reference (replaces the old setup field)

A fixture needing prerequisite data creates the data via a prerequisite case, and a later case references the output of the previous case with `$prev.xxx`:

```json
{
  "cases": [
    {
      "name": "prereq: create story",
      "fn": "story_create",
      "input": { "name": "t", "title": "T", "description": "t", "type": "feature", "priority": "high" },
      "expect": { "pattern": "created" }
    },
    {
      "name": "advance to PLAN",
      "fn": "story_advance",
      "input": { "storyId": "$prev.storyId", "phase": "PLAN" },
      "expect": { "pattern": "advanced to PLAN" }
    }
  ]
}
```

context-passing mechanism:
- The executor maintains a shared `context` object, and automatically extracts return-value fields after each case executes
- String return value: automatically matches patterns such as `Story B-xxxx`→`storyId`, `Bug BUG-xxx`→`bugId`
- Object return value: directly `Object.assign`ed into context
- `$prev.xxx` in a later case's input is replaced with the corresponding field in context

#### 5. Multiple functions sharing one fixture file

When multiple methods of a module/class share one fixture, **each case must be annotated with a `fn` field for ownership**:

```json
{
  "cases": [
    {
      "name": "listRoomContext — returns empty",
      "fn": "listRoomContext",
      "input": { "conversationKey": "bot1:room1" },
      "expect": { "recentTurns": [], "summary": "" }
    },
    {
      "name": "sendRoomMessage — throws when absent",
      "fn": "sendRoomMessage",
      "input": { "conversationKey": "bot1:room1", "content": "Hello" },
      "throws": "roomAdapter is not configured"
    },
    {
      "name": "approveAgentAction — invalid decision",
      "fn": "approveAgentAction",
      "input": { "requestId": "req-001", "decision": "maybe" },
      "throws": "decision must be"
    }
  ]
}
```

**A case without a `fn` field is run once by every function that points to that fixture** — this is the root of the Cartesian-product problem.

## Common Wrong Formats

### ❌ Do not use `expect.throws: true`

```json
// ❌ Wrong
{ "expect": { "throws": true, "errorMessageContains": "not configured" } }

// ✅ Correct
{ "throws": "not configured" }
```

### ❌ Do not use `expect.error`

```json
// ❌ Wrong
{ "expect": { "error": "Bug BUG-001 already exists" } }

// ✅ Correct
{ "throws": "Bug BUG-001 already exists" }
```

### ❌ Do not put dispatch routing fields in input

```json
// ❌ Wrong: scenario/method are dispatch-framework fields, proof-or-stop does not recognize them
{ "input": { "scenario": "send_no_adapter", "method": "sendRoomMessage", "content": "Hello" } }

// ✅ Correct: use a top-level fn + clean input
{ "fn": "sendRoomMessage", "input": { "conversationKey": "bot1:room1", "content": "Hello" } }
```

## Batch-Converting the Old Format

For existing dispatch-style fixtures, batch-process them with the conversion script:

```bash
# Convert the entire fixtures directory
node /path/to/proof-or-stop/scripts/convert-fixtures.cjs tests/fixtures

# Convert a single file
node /path/to/proof-or-stop/scripts/convert-fixtures.cjs tests/fixtures/application/agent-service-facade.json
```

Conversion rules:
- `input.method` → top-level `fn`
- `input.scenario` → removed
- `expect.throws: true` + `errorMessageContains` → top-level `throws`
- `expect.throws: false` + custom assertion → marked `_warning`, needs manual check
- The original file is backed up as `.bak`

### Manual Checks Needed After Conversion

1. **Cases marked `_warning`** — contain custom assertions (`resultLength`, `memoryNull`, etc.), which need a wrapper to verify
2. **constructor case** — `fn` will not be set to `constructor`, and needs special handling in the wrapper
3. **`input.deps` / `input.stubTasks`** — test-stub data; the wrapper needs to know how to use it

## Case Execution Routing Mechanism

`test_auto` / `test_story` / `test_fixture` share the executor registry:

```
For each case in the fixture:
  1. If case.executor exists, select the corresponding executor
  2. Otherwise, if case.execute exists, fall back to js.execute
  3. Otherwise, if case.command exists, fall back to command
  4. The executor returns actual or throws
  5. The runner uniformly judges with expect / throws and writes evidence / bug / gate
```

The handler is preferentially part of the `js.execute` compatibility path only; cross-language projects should not depend on JS import, and should use `command` or a language executor.

## test-runtime Mechanism

When `test_auto` runs, it creates a temporary store to isolate the test data, and loads handlers:

1. **Proof-or-Stop itself**: uses `createToolHandlers(testStore, root)` directly
2. **External projects**: point to `tests/test-runtime.js` via the `testRuntime` config of `proof-or-stop.config.json`; that file exports `createTestHandlers(store, projectRoot)`, which returns a handler map

## Browser Real-Machine Tests (browser case)

### Configuration

Add a `browser` config to `proof-or-stop.config.json` (`proof-or-stop init` will auto-detect a browser project):

```json
{
  "browser": {
    "devCommand": "npx vite"
  }
}
```

Supports any HTTP dev server: vite / webpack / next / serve, etc.

### browser case Format

A case with `browser: true` in the fixture is executed by the `browser_test` MCP tool:

```json
{
  "name": "state changes after click",
  "browser": true,
  "steps": [
    { "action": "eval", "code": "document.getElementById('btn').click()" },
    { "action": "assert", "selector": "#status", "contains": "Done" },
    { "action": "screenshot", "saveTo": "result.png" }
  ]
}
```

### steps action Types

| action | Parameters | Description |
|--------|------|------|
| `eval` | `code` | Execute JS in the browser and return the result |
| `click` | `selector` or `x`/`y` | Simulate a click |
| `type` | `selector`, `text` | Simulate keyboard input |
| `assert` | `selector`, `contains` | Assert the DOM text content (auto-polls, default 3s timeout) |
| `screenshot` | `saveTo` | Take a screenshot and save it to tests/screenshots/ |
| `wait` | `ms` | Wait (use assert instead where possible) |
| `call` | `code`(fn name), `text`(args JSON) | Call a function registered in __proof_or_stop_modules |
| `trace` | none | Get the window.__trace call chain |

### How to Run

```
# MCP tool call
browser_test({ projectRoot: "/path/to/browser-app" })

# Specify a fixture
browser_test({ projectRoot: "/path/to/browser-app", fixture: "browser-case" })
```

### How It Works

1. Start the bridge server (WS :9876 + HTTP :9877)
2. Start the project dev server (such as vite :5173)
3. Start the proxy (:5174) → intercept HTML and auto-inject the WS client script
4. Open the browser and visit the proxy address
5. The WS client connects to the bridge → execute steps via the HTTP API
6. The project does not need to change any code

### Example: Gomoku Game Test

```json
{
  "cases": [
    {
      "name": "initial state shows black to move",
      "browser": true,
      "steps": [
        { "action": "assert", "selector": "#status", "contains": "Black" },
        { "action": "screenshot", "saveTo": "initial-state.png" }
      ]
    },
    {
      "name": "switches to white after a move",
      "browser": true,
      "steps": [
        { "action": "eval", "code": "(() => { const c = document.getElementById('board'); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left+30+7*40, clientY: r.top+30+7*40 })); })()" },
        { "action": "assert", "selector": "#status", "contains": "White" },
        { "action": "screenshot", "saveTo": "after-move.png" }
      ]
    }
  ]
}
```
