/** 把 unified diff 文本着色成 ANSI:`-` 行红、`+` 行绿、`@@` 头品红、
 *  前 headerLength 行(默认 2,即 ---/+++ 文件头)黄。 */
declare module '@npmcli/disparity-colors' {
  export default function disparityColors(diff: string, opts?: { headerLength?: number }): string
}
