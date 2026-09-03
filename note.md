你现在的这套 eval，可以先理解成：

> 给 Agent 准备几道固定题目，让它在一个临时项目里作答，最后自动检查答案和文件修改结果。

它不是神秘的 AI 技术，本质上是“自动化考试”。

## 一、几个核心概念

### Task

`Task` 是一道具体的题目。

例如：

```text
把 config.json 里的 enabled 改成 true。
```

在你的代码里，Task 对应 `tasks.jsonl` 的一行，包含：

- `id`：题目编号
- `prompt`：给 Agent 的指令
- `fixture`：初始项目文件
- `files`：直接创建的初始文件
- `checks`：评分规则

### Scenario

`Scenario` 是更大的使用场景。

例如：

```text
场景：Agent 修改一个现有项目中的配置文件。
题目：把 config.json 的 enabled 改成 true。
```

你现在的代码里没有单独定义 `Scenario` 类型。当前可以把一个 `Task` 看成一个完整 Scenario。以后任务多了，可以增加：

```json
{
  "scenario": "修改现有项目",
  "task": "把 enabled 改成 true"
}
```

### Expected Outcome

`Expected Outcome` 是“做完之后，什么状态才算正确”。

例如：

```text
config.json.enabled 必须是 true
name 必须保持 demo
只能修改 config.json
```

你现在没有叫 `expectedOutcome` 的字段，而是用 `checks` 表示它。

例如：

```json
"checks": [
  {
    "type": "jsonPathEquals",
    "path": "config.json",
    "pathExpr": "enabled",
    "value": true
  }
]
```

### Check / Grader

`Check` 是一条评分规则。

`Grader` 是执行这些评分规则的评分器。

你当前有 5 种：

- `answerContains`：最终回答中必须包含某些文字
- `fileEquals`：文件内容必须完全一致
- `jsonPathEquals`：JSON 某个字段必须等于指定值
- `command`：执行命令，退出码必须是 `0`
- `onlyFiles`：只能修改指定文件

例如：

```json
{
  "type": "command",
  "command": "node verify.mjs"
}
```

意思是：Agent 做完之后，运行测试命令，成功才算通过。

### Outcome

`Outcome` 是 Agent 实际完成后的结果。

例如：

```text
Agent 修改了 math.mjs
node verify.mjs 通过
只修改了 math.mjs
```

在代码中，最终结果是 `EvalResult`：

```ts
success: true
changedFiles: ["math.mjs"]
checks: [...]
```

`Expected Outcome` 是标准答案，`Outcome` 是 Agent 实际交卷结果。

### Trace

`Trace` 是一次任务执行过程的完整记录，可以理解成“考试录像”。

你的 `EvalTrace` 记录：

```ts
type EvalTrace = {
  text: string
  tools: ToolTrace[]
  errors: string[]
  usage?: TokenUsage
}
```

也就是：

- Agent 最后说了什么
- 调用了哪些工具
- 有没有错误
- 用了多少 token

### Span

`Span` 是 Trace 中的一小段操作。

例如一次完整任务的 Trace：

```text
Trace: 完成 fix-test
  Span 1: 调用 readFile
  Span 2: 调用 edit
  Span 3: 调用 shell
  Span 4: Agent 最终回答
```

你目前还没有正式实现 `Span`。当前的 `ToolTrace` 最接近 Span，但它没有记录开始时间、结束时间、父子关系。

所以现在：

```ts
ToolTrace ≈ 简化版 Span
EvalTrace ≈ 整个任务的 Trace
```

## 二、一次评测具体怎么执行

执行：

```bash
pnpm eval -- --task fix-test --model deepseek:deepseek-chat
```

实际过程如下：

### 1. 启动 eval

根目录 `package.json`：

```json
"eval": "pnpm --filter @tegent/evals eval"
```

它进入 evals 包，执行：

```json
"eval": "tsx src/run-vitest.ts"
```

### 2. 读取配置和模型

`run.ts` 会：

- 加载仓库根目录 `.env`
- 读取 `--model`
- 创建现有的模型 Registry
- 获取 `agentLoop` 使用的模型

### 3. 读取任务

代码读取：

```text
packages/evals/tasks.jsonl
```

每一行都是一道独立题目。

例如 `fix-test`：

```text
初始 math.mjs 有 bug
verify.mjs 是测试
要求 Agent 修复 math.mjs
最后运行 node verify.mjs
```

### 4. 创建临时工作区

代码不会直接让 Agent 修改你的 Tegent 仓库。

它会创建类似这样的目录：

```text
C:\Users\...\AppData\Local\Temp\tegent-eval-...\fix-test-...
```

然后把 fixture 文件复制进去。

这就是：

```ts
createWorkspace(task, runId)
```

### 5. 记录修改前状态

`listFiles()` 会读取临时目录里的所有文件，并为每个文件计算 SHA-256：

```text
math.mjs -> hash-before
verify.mjs -> hash-before
```

这是为了之后判断哪些文件被修改了。

### 6. 运行 Agent

核心调用是：

```ts
await agentLoop(
  task.prompt,
  model,
  { modelId, trustMode: false, maxTurns },
  createCallbacks(trace),
)
```

这就是把题目交给你的 Agent。

### 7. 通过回调记录过程

`createCallbacks()` 把 Agent 的事件保存下来：

```ts
onTextDelta
onToolCall
onToolResult
onUsageUpdate
onError
```

例如 Agent 调用：

```text
readFile
edit
shell
```

就会被放入 `trace.tools`。

### 8. 自动处理权限

当前代码里：

```ts
onAskPermission: async () => 'yes'
```

意思是：评测过程中，所有权限请求都自动同意。

这是为了让功能评测能够自动运行，但它还不能准确评估“Agent 是否正确请求权限”。

### 9. 检查最终结果

Agent 结束后，系统再次扫描文件：

```text
math.mjs -> hash-after
verify.mjs -> hash-after
```

然后得到：

```text
changedFiles = ["math.mjs"]
```

接下来运行所有 `checks`。

### 10. 计算成功或失败

成功条件是：

```ts
所有 checks 通过
并且 Agent 没有报错
```

对应：

```ts
success: checks.every(...) && trace.errors.length === 0
```

### 11. 保存结果

结果写入：

```text
packages/evals/results/时间.json
```

里面包含：

```json
{
  "success": true,
  "turnCount": 5,
  "toolCalls": 8,
  "changedFiles": ["math.mjs"],
  "checks": [],
  "finalText": "..."
}
```

## 三、每个文件是做什么的

### `packages/evals/src/run-vitest.ts`

默认评测入口，负责：

- 解析 `--model`、`--task`、`--max-turns`、`--keep`
- 设置 `TEGENT_EVAL_*` 环境变量
- 启动 Vitest
- 使用 `vitest-evals/reporter` 输出报告

### `packages/evals/evals/coding.eval.ts`

真实 agent 行为评测定义，使用 `describeEval()` 把 Tegent harness 接入 Vitest。

### `packages/evals/src/vitest-harness.ts`

`vitest-evals` 适配器，负责把 `TegentCodingAgentHarness` 的结果转换成 `HarnessRun`：

- `output`：结构化评测结果
- `session.events`：用户消息、工具调用、工具结果、最终回答
- `usage`：token 和工具调用数量
- `traces`：agent/span 信息
- `artifacts`：checks、changedFiles、workspacePath 等调试数据

### `packages/evals/src/run.ts`

旧的手写 JSONL runner，保留给学习和调试用。默认 `pnpm eval` 不再走这个文件；要运行它，用：

```bash
pnpm --filter @tegent/evals eval:jsonl
```

它负责：

- 读取参数
- 加载任务
- 创建模型和 harness
- 输出结果

它相当于旧版“考场管理员”。

### `packages/evals/src/tegent-harness.ts`

Tegent agent 的评测适配器，负责：

- 创建临时工作区
- 启动 `agentLoop`
- 收集 Trace
- 执行 Checks
- 返回 `EvalResult`

它相当于把真实 Agent 接进评测系统的“考试接口”。

### `packages/evals/src/checks.ts`

评分器，负责执行 `answerContains`、`fileEquals`、`jsonPathEquals`、`command` 和 `onlyFiles`。

### `packages/evals/src/workspace.ts`

临时工作区工具，负责复制 fixtures、计算文件 hash、判断哪些文件被修改。

### `packages/evals/tasks.jsonl`

题库。

当前有 5 道题：

- `read-json`：读取并回答
- `create-file`：创建精确文件
- `edit-json`：修改 JSON 字段
- `fix-test`：修复代码并通过测试
- `scope-control`：只修改允许的文件

### `packages/evals/fixtures/`

每道题的初始项目文件。

例如：

```text
packages/evals/fixtures/fix-test/math.mjs
packages/evals/fixtures/fix-test/verify.mjs
```

它们组成 Agent 开始工作时看到的项目状态。

### `packages/evals/tsconfig.json`

只用于检查 eval 代码本身的 TypeScript 类型。

它不会改变正式 core 构建结构。

### `packages/evals/results/`

保存每次评测的 JSON 结果。

这个目录已经加入 `.gitignore`，不会提交到 Git。

### `package.json`

新增根目录命令：

```bash
pnpm eval
```

### `packages/evals/package.json`

新增 evals 包内部命令：

```bash
tsx src/run-vitest.ts
```

## 四、当前实现的限制

这版是入门版，已经可以回答：

```text
Agent 做没做对？
修改了哪些文件？
测试是否通过？
调用了多少工具？
花了多少轮？
```

但它还没有：

- 正式的 `Scenario` 类型
- 正式的 `Span` 时间结构
- 多次运行取平均值
- 新旧版本对比
- 复杂代码补丁评分
- 安全权限专门评分
- 并发运行多个任务
- LLM Judge 主观评分

你现在最应该先掌握这一条主线：

```text
Task
  -> 创建初始工作区
  -> Agent 执行
  -> Trace 记录过程
  -> Check 检查结果
  -> EvalResult 输出分数
```

其中最重要的不是 Trace，而是：

> **先把“什么叫成功”写成明确的 Check。**

没有明确 Check，就只有演示；有了 Check，才真正开始叫 eval。
