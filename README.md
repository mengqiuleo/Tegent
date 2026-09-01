# Tegent

Tegent 是一个运行在终端里的交互式 AI 开发助手。

启动命令（目前仅支持交互模式）：

```bash
tegent
```


## 主要能力

- **交互式开发会话**：在终端中连续对话，围绕同一个仓库逐步阅读、修改和验证代码。
- **多模型接入**：支持 Claude、GPT、DeepSeek、Gemini、Qwen、Grok、GLM、Kimi，以及 OpenAI 兼容接口。
- **代码库工具**：内置文件读取、文件编辑、代码搜索、Shell 执行、网页抓取、任务追踪等工具。
- **权限确认**：涉及写文件或执行敏感命令时会先请求确认，适合在真实项目里谨慎使用。
- **计划模式**：通过 `/plan` 进入先分析、后执行的工作流，适合重构、迁移、排障这类多步骤任务。
- **会话恢复**：通过 `/resume` 回到历史会话，继续之前的上下文。
- **上下文管理**：长对话可自动压缩，也可以用 `/compact` 手动整理上下文。
- **项目记忆**：支持用户级和项目级知识文件，并可在 `.tegent` 下保存项目本地状态。
- **扩展能力**：支持 Skills、子 Agent、MCP、插件和 Hooks，在交互会话里按需管理和使用。
- **Hooks 生命周期回调**：插件可以在会话开始、用户提交、工具调用前后、上下文压缩、子 Agent 启停、单轮完成和会话结束等节点执行自定义命令。

## 安装与运行

```bash
npm install -g @tegent/cli
pnpm add -g @tegent/cli
yarn global add @tegent/cli
```


## API Key 配置

Tegent 不内置免费模型。启动前至少配置一个模型提供商的 API Key；也可以在项目根目录放 `.env`，Tegent 启动时会加载。

| 环境变量 | 提供商 |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `OPENAI_API_KEY` | OpenAI GPT |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini |
| `ALIBABA_API_KEY` | 阿里通义 Qwen |
| `XAI_API_KEY` | xAI Grok |
| `ZHIPU_API_KEY` | 智谱 GLM |
| `MOONSHOT_API_KEY` | Moonshot Kimi |

自定义 OpenAI 兼容服务可配置：

```bash
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_BASE_URL=...
OPENAI_COMPATIBLE_MODEL=...
```

网页搜索是可选能力，可配置：

```bash
TAVILY_API_KEY=...
```

### 配置示例

Linux、macOS、Git Bash 或 WSL：

```bash
export DEEPSEEK_API_KEY=sk-...
tegent
```

Windows PowerShell：

```powershell
$env:DEEPSEEK_API_KEY = 'sk-...'
tegent
```

如需长期生效，可以写入系统环境变量。

```dotenv
DEEPSEEK_API_KEY=sk-...
TAVILY_API_KEY=...
```


## 交互命令

Tegent 会话内支持斜杠命令。

| 命令 | 说明 |
| --- | --- |
| `/help` | 查看帮助和可用命令 |
| `/model` | 查看或切换当前模型 |
| `/thinking` | 开启或关闭模型思考模式 |
| `/plan` | 开启或关闭计划模式 |
| `/usage` | 查看当前会话 Token 用量 |
| `/usage-history` | 查看历史会话用量 |
| `/clear` | 清空当前会话 |
| `/compact` | 压缩上下文 |
| `/resume` | 恢复历史会话 |
| `/rewind` | 回退到本会话较早位置 |
| `/init` | 为项目生成或更新 `AGENTS.md` |
| `/review` | 进入代码评审流程 |
| `/memory` | 查看当前记忆内容 |
| `/skill` | 管理 Skills |
| `/mcp` | 管理 MCP 服务器 |
| `/plugin` | 管理插件 |
| `/doctor` | 检查本地运行环境 |
| `/exit` | 保存并退出会话 |

## 本地目录

Tegent 使用 `.tegent` 保存项目级本地状态，例如历史会话、计划文件、记忆、权限记录和项目级扩展配置。

用户级配置默认位于：

```text
~/.tegent
```

Windows 上对应：

```text
%USERPROFILE%\.tegent
```

项目级配置位于：

```text
<repo>/.tegent
```
