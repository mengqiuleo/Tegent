// 针对 integration.ts 的 expandMcpServerVariables：插件 .mcp.json 里 stdio
// server 的 command / args / cwd / env 要展开 ${pluginDir} 等变量，其中
// ${CLAUDE_PLUGIN_ROOT} 是 ${pluginDir} 的别名（Claude Code 插件兼容）；
// HTTP server 配置原样保留，未知变量保留原样让 spawn 报错可见。
import { describe, expect, it } from 'vitest'

import type { VariableContext } from '../src/hooks/variables.js'
import { expandMcpServerVariables } from '../src/plugins/integration.js'
import type { McpServerConfig } from '../src/mcp/types.js'

const vars: VariableContext = {
  pluginDir: '/cache/demo',
  pluginDataDir: '/data/demo',
  cwd: '/work',
  homedir: '/home/user',
  sep: '/',
}

describe('expandMcpServerVariables', () => {
  it('expands ${pluginDir} in command/args/cwd/env of stdio servers', () => {
    const servers: Record<string, McpServerConfig> = {
      demo: {
        command: 'node',
        args: ['${pluginDir}/mcp/server.mjs', '--data', '${pluginDataDir}'],
        cwd: '${pluginDir}',
        env: { LOG_DIR: '${pluginDataDir}/logs' },
      },
    }

    expect(expandMcpServerVariables(servers, vars)).toEqual({
      demo: {
        command: 'node',
        args: ['/cache/demo/mcp/server.mjs', '--data', '/data/demo'],
        cwd: '/cache/demo',
        env: { LOG_DIR: '/data/demo/logs' },
      },
    })
  })

  it('treats ${CLAUDE_PLUGIN_ROOT} as ${pluginDir} (Claude Code plugin compat)', () => {
    const servers: Record<string, McpServerConfig> = {
      linear: { command: 'npx', args: ['-y', '${CLAUDE_PLUGIN_ROOT}/bin/server.js'] },
    }

    expect(expandMcpServerVariables(servers, vars)).toEqual({
      linear: { command: 'npx', args: ['-y', '/cache/demo/bin/server.js'] },
    })
  })

  it('leaves unknown variables untouched so spawn errors stay diagnosable', () => {
    const servers: Record<string, McpServerConfig> = {
      demo: { command: '${notAVar}/server.js' },
    }

    expect(expandMcpServerVariables(servers, vars)).toEqual({ demo: { command: '${notAVar}/server.js' } })
  })

  it('expands ${env:NAME} from the process environment', () => {
    process.env.TEGENT_TEST_MCP_TOKEN = 'sekret'
    try {
      const servers: Record<string, McpServerConfig> = {
        demo: { command: 'node', env: { TOKEN: '${env:TEGENT_TEST_MCP_TOKEN}' } },
      }
      expect(expandMcpServerVariables(servers, vars)).toEqual({
        demo: { command: 'node', env: { TOKEN: 'sekret' } },
      })
    } finally {
      delete process.env.TEGENT_TEST_MCP_TOKEN
    }
  })

  it('passes http servers through unchanged', () => {
    const servers: Record<string, McpServerConfig> = {
      remote: { url: 'https://${pluginDir}/api', headers: { 'X-Plugin': '${pluginDir}' } },
    }

    expect(expandMcpServerVariables(servers, vars)).toEqual(servers)
  })
})
