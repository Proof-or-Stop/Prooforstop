# Structured Comment System

## @task comment

The `@task` comment in the code is the project's core metadata, and must be added every time you write code.

### Required fields

| Field | Description |
|---|---|
| `@task` | Story ID (e.g., B-001); use ADHOC-xxx when there is no corresponding Story |
| `@checklist` | Checklist item ID (e.g., CHK-001) |
| `@title` | Task title |
| `@type` | feature / bugfix / refactor / chore |
| `@priority` | critical / high / medium / low |
| `@description` | Multi-line description |
| `@changes` | Change list, in the format `- [CHK-xxx] description` |

### Granularity rules

- New file: at the top of the file (before the imports)
- A single file with multiple features: add an independent @task comment block above each function/method
- A change spanning multiple files: at the top of the main entry file, with @affected listing all the files

### Design decisions

- **Function-level precision** (B-005): the extraction script parses the function declaration immediately adjacent to the comment and returns functionName and functionSignature, realizing a precise bug→checklist→code-function location chain
- **@changes annotated with the Checklist ID**: each change is associated with a specific checklist item, supporting coverage analysis

## @flow business-flow comment

Describes the business-flow chain between functions.

| Field | Description |
|---|---|
| `@flow` | The name of the flow chain |
| `@step` | The step number (starting from 1) |
| `@input` | The input data format |
| `@output` | The output data format |
| `@next` | The name of the next-step function (leave blank for the last step) |

Validation rules: the @next target function must exist, the steps must be consecutive, and the last step must have no @next.

## @test automated-test comment

Points to an external fixture file.

- The fixture path is relative to `tests/fixtures/`, without the `.json` suffix
- Fixture format: `{ "cases": [{ "name": "...", "input": {...}, "expect": {...} }] }`

## MCP Tools

| Tool | Purpose |
|---|---|
| `task_scan` | Scan @task comments + validate compliance |
| `task_coverage` | Coverage of @checklist comments vs checklist.json |
| `task_locate` | Locate a code position by ID/keyword |
| `flow_trace` | Output the full chain by flow name |
| `flow_list` | List a summary of all flows |
