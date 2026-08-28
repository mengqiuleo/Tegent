# demo-toolkit

tegent 插件系统的演示插件，作为**项目内置插件**放在 `packages/cli/.tegent/plugins/`
（`pnpm run dev` 在 packages/cli 下执行，loader 第二轮扫描的
`<cwd>/.tegent/plugins/` 正是这里）。插件 id 为 `demo-toolkit@local`，
不需要出现在 `installed_plugins.json` 账本里。

manifest 只声明元数据；四类贡献全部走约定式目录发现，无需显式声明路径。

## 结构

```
demo-toolkit/
├── .tegent-plugin/plugin.json   manifest（native 格式，最高优先探测位置）
├── .mcp.json                    MCP server 贡献（约定文件；也支持 manifest 内联）
├── mcp/
│   └── demo-server.mjs          零依赖 stdio MCP server：get-time / word-count
├── skills/                      每个子目录一个 <name>/SKILL.md
│   ├── commit-helper/           起草 Conventional Commits 提交信息
│   └── pr-summary/              汇总分支改动、生成 PR 描述
├── agents/                      每个 .md 一个 sub-agent（frontmatter: name/description/tools）
│   ├── code-reviewer.md         只读代码审查（readFile/grep/glob/listDir）
│   └── test-runner.md           跑测试并汇总失败原因（shell/readFile/grep）
├── commands/                    每个 .md 一个 slash command（支持 $ARGUMENTS 占位符）
│   ├── review.md                /review <文件|目录>，不带参数则审查 git diff
│   └── explain-error.md         /explain-error <报错文本>
└── hooks/
    ├── hooks.json               两条 hook：SessionStart + PostToolUse(matcher: shell)
    └── scripts/                 hook 实际执行的 node 脚本
```

## hooks 说明

命令里的 `${pluginDir}` / `${pluginDataDir}` 由 tegent 在执行前展开：
前者是插件根目录（随版本变化），后者是 `~/.tegent/plugins/data/demo-toolkit_local/`
（升级重装后仍保留，脚本自己负责 mkdir）。事件 payload 以 JSON 写入脚本 stdin；
不输出决策 JSON 即默认 allow。

## MCP 说明

`.mcp.json` 里 stdio server 的 `command` / `args` / `cwd` / `env` 同样支持
`${pluginDir}` 等变量展开（`${CLAUDE_PLUGIN_ROOT}` 是 `${pluginDir}` 的别名，
因此 Claude Code 插件的 `.mcp.json` 无需修改即可使用）。`mcp/demo-server.mjs`
是零依赖的 newline-delimited JSON-RPC server，暴露 `get-time` 和 `word-count`
两个工具。

## 验证方式

```bash
pnpm run dev
# 会话启动后：
#   /plugin list           应看到 demo-toolkit@local（project 作用域，默认启用）
#   /mcp list              应看到 demo-toolkit 服务器已连接（2 个工具）
#   /review packages/core/src/plugins/paths.ts
#   /explain-error <贴一段报错>
#   "现在几点了？用 MCP 工具查"  # 触发 demo-toolkit__get-time
#   让模型调用 code-reviewer / test-runner，或说"帮我写 commit message"触发 skill
#   ls ~/.tegent/plugins/data/demo-toolkit_local/     # sessions.log、shell-audit.log
```
