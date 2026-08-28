// JavaScript 的 `string.length` 统计的是 UTF-16 码元个数，但终端渲染
// East-Asian Wide（宽）字符时会占两个格子。两者混用会破坏所有
// “按列补空格”或“按列预算截断”的代码——行会超出宽度预算，终端
// 提前换行，用户会看到多出来的幽灵“空行”，以及所有包含
// CJK / 全角标点的行都出现列错位。
//
// 码点范围遵循 Unicode East_Asian_Width=Wide / Fullwidth
// （终端普遍按双宽渲染的那部分子集）。这里是所有渲染器的唯一
// 事实来源——chat-input 边框、scrollback diff（render-diff）、
// markdown 表格布局（render-markdown）。如果只在其中一处添加了
// 范围而其它处没加，就会重新出现这个模块当初抽出来修掉的错位漂移。

export function isWide(cp: number): boolean {
  return (
    // CJK 统一表意文字 + 扩展 A + 兼容表意文字
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    // Hangul：字母 + 音节
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    // 半角与全角形式（全角区：0xff00-0xff60，符号：0xffe0-0xffe6）
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    // CJK 扩展 B-F
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    // CJK 部首补充 + 康熙部首 + 表意文字描述符
    (cp >= 0x2e80 && cp <= 0x2fff) ||
    // CJK 符号和标点 + 平假名 + 片假名 + 注音符号 + 带圈 CJK 字母与月份 + CJK 兼容
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3100 && cp <= 0x312f) ||
    (cp >= 0x3200 && cp <= 0x32ff) ||
    (cp >= 0x3300 && cp <= 0x33ff) ||
    // 彝文音节 + 彝文部首
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    // CJK 兼容形式
    (cp >= 0xfe30 && cp <= 0xfe4f)
  )
}

export function charWidth(ch: string): number {
  return isWide(ch.codePointAt(0)!) ? 2 : 1
}

export function visualWidth(str: string): number {
  let w = 0
  for (const ch of str) w += charWidth(ch)
  return w
}

/** 取 `str` 中显示宽度不超过 `maxCols` 的最长前缀。
 *  在会骑跨边界的宽字符之前停下——绝不把一个宽字符
 *  劈成两半跨行。 */
export function sliceByWidth(str: string, maxCols: number): string {
  let w = 0
  let i = 0
  for (const ch of str) {
    const cw = charWidth(ch)
    if (w + cw > maxCols) break
    w += cw
    i += ch.length
  }
  return str.slice(0, i)
}
