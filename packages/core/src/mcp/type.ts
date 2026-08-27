// ============================================================
// Tool 抽象接口
// ============================================================

/**
 * Tool 的 JSON Schema 输入描述。
 * MCP Server 的 tools/list 返回的就是原生 JSON Schema 对象，
 * 我们不做二次建模，直接透传给模型。
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description: string;
    enum?: string[];
  }>;
  required: string[];
  /** 附加字段：JSON Schema 还有 items/default 等可选关键字，放开索引签名以便透传。 */
  [key: string]: unknown;
}

/**
 * 工具执行结果。
 * 对应 Claude Code: ToolResult<T>（src/Tool.ts 第 321-336 行）
 */
export interface ToolResult {
  /** 返回给模型的文本内容 */
  content: string;
  /** 执行是否出错 */
  isError: boolean;
}

/**
 * 工具抽象接口。
 * 对应 Claude Code: Tool 类型（src/Tool.ts 第 362-695 行）
 *
 * Claude Code 的 Tool 类型极其庞大（50+ 个字段），包含了权限检查、
 * UI 渲染、进度回报、分组显示等。我们提取其中最核心的 5 个字段。
 */
export interface Tool {
  /** 工具名称，如 "mcp__github__create_issue"。对应 Tool.name */
  name: string;

  /** 工具描述，供模型理解何时使用该工具。对应 Tool.description() */
  description: string;

  /**
   * 输入参数的 JSON Schema。
   * Claude Code 用 Zod schema + 运行时转换，MCP 工具直接使用 Server 给的 JSON Schema。
   * 对应 Tool.inputSchema
   */
  inputSchema: ToolInputSchema;

  /**
   * 执行工具逻辑。
   * Claude Code 的 Tool.call() 签名是：
   *   call(args, context, canUseTool, parentMessage, onProgress?)
   * 我们简化为只接收参数和工作目录。
   */
  execute(args: Record<string, unknown>, cwd: string): Promise<ToolResult>;

  /**
   * 该工具是否只读（不改变文件系统状态）。
   * 对应 Tool.isReadOnly()
   */
  isReadOnly: boolean;
}
