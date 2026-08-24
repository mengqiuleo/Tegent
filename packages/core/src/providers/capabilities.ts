export interface ProviderCapabilities {
  image: boolean
  pdf: boolean
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
  custom: { image: false, pdf: false, filesApi: false },
}

export function providerOf(modelId: string): string {
  const idx = modelId.indexOf(':')
  return idx > 0 ? modelId.slice(0, idx) : 'unknown'
}

export function capabilitiesOf(modelId: string): ProviderCapabilities {
  return CAPS[providerOf(modelId)] ?? { image: false, pdf: false, filesApi: false }
}
