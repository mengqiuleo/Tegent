// 这里声明每个 provider 的 API 是否能在用户消息和工具结果中原生接收图片 / PDF
// 内容片段。文件导入流程会用它决定“直接内联发送”还是“先做 OCR/文本化”；
// provider-compat 也会用它在发送前移除不被支持的二进制内容，避免 provider 直接拒绝请求。
//
// 注意：这是 provider 级别，不是模型级别。部分 provider（例如 alibaba、zhipu）
// 会把视觉能力拆到专门的模型 ID 上；如果用户选择的是纯文本 Qwen/GLM 变体后再粘贴图片，
// API 仍然可能报错。这是有意保留的简化：按模型 ID 维护能力表需要大量细粒度数据，
// 而这些模型列表很容易过期。

export interface ProviderCapabilities {
  /** Provider 能在用户消息中接收内联图片片段（base64 或 URL）。 */
  image: boolean
  /** Provider 能接收内联 PDF 文件片段。 */
  pdf: boolean
  /** Provider 有专用的 /files 上传接口，可以通过 file_id 引用文件。 */
  filesApi: boolean
}

const CAPS: Record<string, ProviderCapabilities> = {
  anthropic: { image: true, pdf: true, filesApi: true },
  openai: { image: true, pdf: true, filesApi: true },
  google: { image: true, pdf: true, filesApi: true },
  xai: { image: true, pdf: true, filesApi: true },
  moonshotai: { image: true, pdf: true, filesApi: true },
  alibaba: { image: true, pdf: true, filesApi: true },
  zhipu: { image: true, pdf: true, filesApi: true },
  deepseek: { image: false, pdf: false, filesApi: false },
  // 自定义 OpenAI 兼容端点默认保守处理为纯文本。
  // 如果之后增加类似 X_CODE_CUSTOM_SUPPORTS_IMAGE=1 的环境变量，知道自己端点支持视觉的
  // 用户可以再显式开启。
  custom: { image: false, pdf: false, filesApi: false },
}

/** 从 `provider:model` 形式的模型 ID 中提取 provider。
 *  如果找不到分隔符，就返回 `unknown`。这是防御式兜底；正常解析后的模型 ID 不应发生。 */
export function providerOf(modelId: string): string {
  const idx = modelId.indexOf(':')
  return idx > 0 ? modelId.slice(0, idx) : 'unknown'
}

/** 根据模型 ID 查询 provider 能力。未知 provider 默认当作纯文本处理，
 *  这比盲目假设它支持视觉能力更安全。 */
export function capabilitiesOf(modelId: string): ProviderCapabilities {
  return CAPS[providerOf(modelId)] ?? { image: false, pdf: false, filesApi: false }
}
