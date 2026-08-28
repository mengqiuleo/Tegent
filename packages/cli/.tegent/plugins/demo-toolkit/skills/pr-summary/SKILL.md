---
name: pr-summary
description: 汇总当前分支的改动并生成 PR 描述。当用户要求写 PR 描述、变更总结、release notes 时使用。
---

# PR 摘要助手

生成 PR 描述时遵循：

1. 用 `git log main..HEAD --oneline` 和 `git diff main...HEAD --stat` 了解分支全貌；找不到 `main` 就退化到 `master` 或远端默认分支。
2. 按功能点分组，而不是逐条罗列 commit；零散的杂务 commit 归入"其他"。
3. 输出结构固定为：
   - 一句话概括：这个 PR 做了什么、为什么。
   - 主要改动：每条一个功能点，引用关键文件路径。
   - 测试与验证：怎么确认改动能工作；没验证就如实写"未验证"。
4. 面向 reviewer 写：解释意图和取舍，不复述每一行 diff。
5. 涉及破坏性变更、迁移步骤或配置项变化时，单独列一节说明。
