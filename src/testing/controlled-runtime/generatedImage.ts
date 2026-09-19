import { deflateSync } from 'node:zlib'

/** Controlled fixture pixels, not a borrowed screenshot or desktop clipboard.
 * PNG keeps the input portable; native decoding/normalization is observed by
 * the capture rather than inferred from this tiny fixture generator. */
export function generatedPng(width = 100, height = 80, variant = 0): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 8_000_000) throw new Error('Invalid fixture dimensions')
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * (width * 4 + 1) + 1 + x * 4
    pixels[index] = (x + variant * 47) % 256; pixels[index + 1] = (y + variant * 29) % 256
    pixels[index + 2] = ((x >> 3) ^ (y >> 3)) % 2 ? 255 : 0; pixels[index + 3] = 255
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, body, checksum])
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

export function countInputImages(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countInputImages(item), 0)
  if (!value || typeof value !== 'object') return 0
  const item = value as Record<string, unknown>
  if (['image', 'input_image', 'image_url'].includes(String(item.type))) return 1
  return Object.values(item).reduce<number>((sum, child) => sum + countInputImages(child), 0)
}
