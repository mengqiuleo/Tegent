import type { ToolRegistry } from "../types/index.js";
import { connectMcpServer, type ConnectedMcpServer, type McpServerConfig } from "./client.js";
import { wrapMcpTool } from "./mcpTool.js";

/**
 * 读取一组 MCP Server 配置，逐个连接，把它们的工具注册进现有 registry。
 * 一个 Server 连不上不影响其它 Server（fail-soft）。
 *
 * 返回握手成功的连接列表，调用方在会话结束时传给 closeMcpServers 统一回收 ——
 * stdio Server 是本进程 fork 出来的子进程，不关会活到 Agent 退出之后。
 *
 * 串行连接是刻意的：注册顺序决定工具在提示词里的顺序，保持稳定才利于缓存命中。
 */
export async function registerMcpServers(
  registry: ToolRegistry,
  servers: Record<string, McpServerConfig>,
): Promise<ConnectedMcpServer[]> {
  const connectedServers: ConnectedMcpServer[] = [];
  for (const [name, config] of Object.entries(servers)) {
    // 握手成功后才拿得到 client。注册阶段仍可能抛（例如同名工具重复注册，
    // registry.register 会 throw），那时子进程已经起来了——不关掉它就会一直
    // 活到 Agent 退出。所以 client 要放在 try 外面，catch 里才够得着。
    let connected: Awaited<ReturnType<typeof connectMcpServer>> | undefined;
    try {
      connected = await connectMcpServer(name, config);
      for (const def of connected.tools) {
        // 包装成本地 Tool，注册进同一个注册表 —— 循环代码一行不改。
        registry.register(wrapMcpTool(name, connected.client, def));
      }
      connectedServers.push(connected);
    } catch (err) {
      // 单个 Server 失败只警告，不让它拖垮整个 Agent 启动。
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] Failed to connect "${name}": ${msg}`);
      // 失败就把这条连接收干净，别留下没人管的子进程
      await connected?.client.close().catch(() => {});
    }
  }
  return connectedServers;
}

/**
 * 会话结束时统一关闭所有 MCP 连接。
 * 单个连接清理失败只吞掉 —— 清理错误不该盖住正常退出路径。
 */
export async function closeMcpServers(servers: ConnectedMcpServer[]): Promise<void> {
  await Promise.all(servers.map((server) => server.client.close().catch(() => {})));
}
