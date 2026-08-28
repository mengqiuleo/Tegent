---
name: commit-helper
description: 按 Conventional Commits 规范起草提交信息。当用户要求写 commit message、提交代码、生成提交说明时使用。
---

# 提交信息助手

起草提交信息时按以下步骤执行：

1. 运行 `git status` 和 `git diff --staged`（没有 staged 改动时看 `git diff`）确认本次提交实际包含的改动。
2. 只依据改动内容判断类型：
   - `feat`：新功能
   - `fix`：缺陷修复
   - `refactor`：既不是新功能也不是修复的结构调整
   - `docs` / `test` / `chore`：文档、测试、构建杂务
3. 标题行格式 `<type>(<scope>): <主题>`：scope 用包名或模块名（如 `core`、`cli`），主题用中文动词短语，不超过 50 字，结尾不加句号。
4. 正文（可选）说明"为什么改"而不是复述 diff；一行一条，每条不超过 72 字符。
5. 输出提交信息后停下，不要主动执行 `git commit`，除非用户明确要求提交。

示例：

```
feat(plugins): 支持项目内置插件目录

- loader 第二轮扫描 <cwd>/.tegent/plugins/ 下的目录插件
- 项目插件不写入 installed_plugins.json，marketplace 固定为 local
```
