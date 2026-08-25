import path from 'node:path'

/** 根据文件扩展名推断 IANA media type。
 *
 * 主要用于给 ImagePart 提供 mediaType 提示。遇到未知扩展名时返回 `image/png` 是安全的：
 * AI SDK 大多把 mediaType 当作提示信息，而不是严格校验依据。
 */
export function mediaTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/png'
}
