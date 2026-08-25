// PowerShell 和 cmd 每遇到一次解析 / 语法错误，都会输出一整段多行诊断：
// `At line:X char:Y` 头部、出错源码行、插入符下划线（`+ ~~~~`）、一行自由文本描述，
// 以及尾部标记（`+ CategoryInfo` 和 `+ FullyQualifiedErrorId`）。
// 如果 agent 因为命令引号写错而反复尝试，这些 5-10 行的错误块会很快塞满上下文，
// 真正有价值的诊断反而被噪声淹没。因此这里把每个 PowerShell 错误块折叠成一行。
//
// 检测规则：
//   - 匹配 `At line:X char:Y` 的行表示一个错误块开始；
//   - 错误块结束于最先出现的三种情况之一：
//     (a) `FullyQualifiedErrorId` 行（PowerShell 标准终止行）；
//     (b) 另一个错误块开始；
//     (c) 达到硬扫描上限；
//   - 扫描上限用于防御异常输入：如果缺少 FQID 行，也不会把后面无关输出全吞掉。

/** 单个错误块最多消费的行数。
 *  PowerShell 错误栈通常约 5 行，基本不会接近 12 行；超过这个数大概率已经不是同一块。 */
const BLOCK_SCAN_LIMIT = 12

const PS_BLOCK_START = /^At line:\d+ char:\d+/
const PS_FQID_LINE = /^\s*\+\s*FullyQualifiedErrorId\s*:/

function isBlockStart(line: string): boolean {
  return PS_BLOCK_START.test(line)
}

function isFqidTerminator(line: string): boolean {
  return PS_FQID_LINE.test(line)
}

/**
 * 把 `text` 中的 PowerShell 错误块逐个折叠成单行摘要。
 *
 * 摘要会保留开头的 `At line:X char:Y`，这是我们保留下来的主要诊断信号；
 * 源码正文、插入符、CategoryInfo、FullyQualifiedErrorId 等后续行都会丢弃。
 *
 * 如果没有识别到错误块，则原样返回输入。这个函数可以安全地用于任意 shell 输出：
 * 不在错误块内部的行会逐字透传。
 */
export function foldShellErrorNoise(text: string): string {
  if (!text) return text
  // 快速路径：绝大多数 shell 输出都不是 PowerShell 错误栈。
  if (!text.includes('At line:')) return text

  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!isBlockStart(line)) {
      out.push(line)
      i++
      continue
    }

    out.push(`${line.trim()} [PS parse error — details folded]`)
    i++

    // 消费错误块主体。遇到自然终止行（`FullyQualifiedErrorId`）或新的错误块头部就停止；
    // 后者用于处理多个错误拼在一起的情况。扫描上限是防御性保险，真实 PS 错误基本触不到。
    let scanned = 0
    while (i < lines.length && scanned < BLOCK_SCAN_LIMIT) {
      if (isBlockStart(lines[i])) break
      const terminator = isFqidTerminator(lines[i])
      i++
      scanned++
      if (terminator) break
    }
  }

  return out.join('\n')
}
