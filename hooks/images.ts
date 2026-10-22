export interface ImageSize {
  width: number
  height: number
}

export interface ThumbnailBox {
  columns: number
  rows: number
}

// One `[Image: source: …/N.png]` line Claude Code stores beside a prompt that carried images.
export interface SourceLine {
  imageNumber: number
  path: string
}

const SOURCE_LINE = /\[Image: source: ([^\]\n]+?\/(\d+)\.png)\]/g
const PLACEHOLDER = /\[Image #(\d+)\]/g

// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2
// The widest box the `Image` element takes.
const MAX_IMAGE_COLUMNS = 255

export function sourceLinesIn(text: string): SourceLine[] {
  return [...text.matchAll(SOURCE_LINE)].map(([, path = '', imageNumber]) => ({ imageNumber: Number(imageNumber), path }))
}

export function imageNumbersIn(text: string): number[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map(match => Number(match[1])))]
}

export function savedImageKey(sessionId: string, imageNumber: number): string {
  return `${sessionId}:${imageNumber}`
}

// Claude Code's folder name for a project: the path with every character outside [A-Za-z0-9] as `-`.
export function projectDirName(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decodeBase64Head(base64: string, byteCount: number): number[] {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of base64) {
    const value = BASE64.indexOf(char)
    if (value < 0) break
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
      if (bytes.length === byteCount) break
    }
  }
  return bytes
}

const uint32At = (bytes: number[], offset: number) =>
  bytes.slice(offset, offset + 4).reduce((value, byte) => value * 256 + byte, 0)

// Width and height from a base64 PNG's IHDR chunk, or undefined when it is not a PNG.
export function pngSize(base64: string): ImageSize | undefined {
  const bytes = decodeBase64Head(base64.slice(0, 32), 24)
  const isPng = bytes.length === 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (!isPng) return undefined
  return { width: uint32At(bytes, 16), height: uint32At(bytes, 20) }
}

// The largest box within the limits that keeps the picture's proportions.
export function thumbnailBox(size: ImageSize, maxColumns: number, maxRows: number): ThumbnailBox {
  const rowsPerColumn = size.height / size.width / CELL_ASPECT
  let columns = Math.max(1, Math.min(MAX_IMAGE_COLUMNS, Math.floor(maxColumns)))
  let rows = Math.round(columns * rowsPerColumn)
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.round(rows / rowsPerColumn))
  }
  return { columns, rows: Math.max(1, rows) }
}
