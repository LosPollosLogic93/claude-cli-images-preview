import { atom, read, update } from 'claude-code'
import type { ApiContentBlock, EngineInterface, ImageSource, PromptOrigin, Register, Timer } from 'claude-code'

import type { ViewedImage } from '../types'
import { imageNumbersIn, pngSize, projectDirName, savedImageKey, sourceLinesIn, thumbnailBox, type ImageSize } from './images'

interface LoadedImage {
  path: string
  source: ImageSource
  size: ImageSize
}

interface NumberedImage {
  imageNumber: number
  image: LoadedImage
}

type DraftLoad = { status: 'loading' } | { status: 'loaded'; image: LoadedImage } | { status: 'missing' }

const MAX_COLUMNS = 60
const MAX_ROWS = 16
const ROW_INDENT = 2
const DEFAULT_VIEWPORT_COLUMNS = 80
const DEFAULT_VIEWPORT_ROWS = 24
// `$.fs.read` rejects larger files.
const MAX_READ_BYTES = 4 * 1024 * 1024
// The Image element takes at most 2 MiB of decoded PNG bytes; larger files are named instead.
const MAX_INLINE_BASE64 = Math.floor((2 * 1024 * 1024 * 4) / 3)
const TMP_ROOTS = ['/private/tmp', '/tmp']
// Prompts the person sent: typed at the terminal, or from another device over Remote Control.
const PASTED_BY_PERSON: ReadonlySet<PromptOrigin['kind']> = new Set(['composer', 'bridge'])

const MAX_DRAFT_COLUMNS = 30
const MAX_DRAFT_ROWS = 8
const DRAFT_GAP = 2
// The frame's border and padding, and its header, the gap under it and the enlarge row.
const DRAFT_FRAME_COLUMNS = 4
const DRAFT_FRAME_ROWS = 5
// A paste may still be on its way to disk when the placeholder appears.
const DRAFT_RETRY_MS = 200
const DRAFT_LOAD_ATTEMPTS = 25
const SPINNER_MS = 120
// An image paste raises no `prompt.edit`, so the box is also read on a timer.
const DRAFT_POLL_MS = 250
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const ENLARGED_PANE = 'pasted-image'
// The enlarge mark lights while the pointer is anywhere over its picture.
const ENLARGE_HOVER = { color: 'cyan', bold: true } as const
// Rows left to the transcript and the prompt while the enlarged picture is open.
const ENLARGED_ROW_MARGIN = 8
const MIN_ENLARGED_ROWS = 10

const savedImagesAtom = atom({ plugin: 'pasted-images', key: 'savedImages' } as const, {})
const draftImageNumbersAtom = atom({ plugin: 'pasted-images', key: 'draftImageNumbers' } as const, [])
const viewedImageAtom = atom({ plugin: 'pasted-images', key: 'viewedImage' } as const, null)

// Derived caches of hits only, rebuilt from disk after a reload; a paste still being written is looked up again.
const foundPaths = new Map<string, string>()
const imageCache = new Map<string, LoadedImage>()
// Draft previews by `savedImageKey`, loaded off the drawing so the band shows a spinner meanwhile.
const draftLoads = new Map<string, DraftLoad>()
let spinnerFrame = 0
let spinner: Timer | null = null
let isSyncingDraft = false

const textOf = (blocks: readonly ApiContentBlock[]) => blocks.map(block => (block.type === 'text' ? block.text : '')).join('\n')

// Where Claude Code saves a paste of this session: `<tmp>/claude-<uid>/<project>/<session>/images/N.png`.
async function findSavedPath($: EngineInterface, sessionId: string, imageNumber: number): Promise<string | null> {
  const key = savedImageKey(sessionId, imageNumber)
  const cached = foundPaths.get(key)
  if (cached) return cached
  const projectDirs = new Set([await $.session.root(), await $.session.cwd()].map(projectDirName))
  for (const tmpRoot of TMP_ROOTS) {
    const claudeDirs = await $.fs.list(tmpRoot).then(
      entries => entries.filter(entry => entry.kind === 'dir' && entry.name.startsWith('claude-')).map(entry => entry.name),
      () => [],
    )
    for (const claudeDir of claudeDirs) {
      for (const projectDir of projectDirs) {
        const path = `${tmpRoot}/${claudeDir}/${projectDir}/${sessionId}/images/${imageNumber}.png`
        const isFile = await $.fs.stat(path).then(stat => stat.kind === 'file', () => false)
        if (isFile) {
          foundPaths.set(key, path)
          return path
        }
      }
    }
  }
  return null
}

async function loadImage($: EngineInterface, path: string): Promise<LoadedImage | null> {
  const cached = imageCache.get(path)
  if (cached) return cached
  const fitsOneRead = await $.fs.stat(path).then(stat => stat.size <= MAX_READ_BYTES, () => false)
  if (!fitsOneRead) return null
  const base64 = await $.fs.read(path, { as: 'bytes' }).then(bytes => bytes.base64, () => '')
  const size = pngSize(base64)
  if (!size) return null
  const source: ImageSource = base64.length <= MAX_INLINE_BASE64 ? { png: base64 } : { file: path, format: 'png' }
  const image = { path, source, size }
  imageCache.set(path, image)
  return image
}

async function loadImages($: EngineInterface, imageNumbers: readonly number[], pathOf: (imageNumber: number) => Promise<string | null>): Promise<NumberedImage[]> {
  const images: NumberedImage[] = []
  for (const imageNumber of imageNumbers) {
    const path = await pathOf(imageNumber)
    const image = path ? await loadImage($, path) : null
    if (image) images.push({ imageNumber, image })
  }
  return images
}

function startSpinner($: EngineInterface) {
  spinner ??= $.clock.every(SPINNER_MS, () => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length
    $.ui.invalidate('ui.render')
  })
}

function stopSpinnerWhenIdle() {
  if ([...draftLoads.values()].some(load => load.status === 'loading')) return
  spinner?.cancel()
  spinner = null
}

async function loadDraft($: EngineInterface, sessionId: string, imageNumber: number, attempt: number): Promise<void> {
  const path = await findSavedPath($, sessionId, imageNumber).catch(() => null)
  const image = path ? await loadImage($, path).catch(() => null) : null
  if (!image && attempt < DRAFT_LOAD_ATTEMPTS) {
    $.clock.after(DRAFT_RETRY_MS, () => void loadDraft($, sessionId, imageNumber, attempt + 1))
    return
  }
  draftLoads.set(savedImageKey(sessionId, imageNumber), image ? { status: 'loaded', image } : { status: 'missing' })
  stopSpinnerWhenIdle()
  $.ui.invalidate('ui.render')
}

const isSameList = (left: readonly number[], right: readonly number[]) => left.join(',') === right.join(',')

async function syncDraft($: EngineInterface, sessionId: string, text: string) {
  const draftImageNumbers = imageNumbersIn(text)
  await update($, draftImageNumbersAtom, previous => (isSameList(previous, draftImageNumbers) ? previous : draftImageNumbers))
  for (const imageNumber of draftImageNumbers) {
    const key = savedImageKey(sessionId, imageNumber)
    if (draftLoads.has(key)) continue
    draftLoads.set(key, { status: 'loading' })
    startSpinner($)
    // A timer, so the load outlives the dispatch that found the placeholder.
    $.clock.after(0, () => void loadDraft($, sessionId, imageNumber, 1))
  }
}

async function pollDraft($: EngineInterface, sessionId: string) {
  if (isSyncingDraft) return
  isSyncingDraft = true
  try {
    const box = await $.prompt.read()
    await syncDraft($, sessionId, box.text)
  } finally {
    isSyncingDraft = false
  }
}

async function openEnlarged($: EngineInterface, viewed: ViewedImage, viewportRows: number) {
  await update($, viewedImageAtom, () => viewed)
  await $.ui.open({
    id: ENLARGED_PANE,
    title: `Image #${viewed.imageNumber}`,
    focus: true,
    closeOnEscape: true,
    rows: Math.max(MIN_ENLARGED_ROWS, viewportRows - ENLARGED_ROW_MARGIN),
  })
}

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    const result = await next(event)
    const sessionId = await $.session.id()
    $.clock.every(DRAFT_POLL_MS, () => void pollDraft($, sessionId).catch(() => undefined))
    return result
  }).catch(($, event, next) => next(event))

  on('session.append', async ($, event, next) => {
    const result = await next(event)
    const sourceLines = event.agentId ? [] : sourceLinesIn(textOf(event.message.content))
    if (sourceLines.length) {
      const sessionId = await $.session.id()
      const saved = Object.fromEntries(sourceLines.map(line => [savedImageKey(sessionId, line.imageNumber), line.path]))
      await update($, savedImagesAtom, savedImages => ({ ...savedImages, ...saved }))
    }
    return result
  }).catch(($, event, next) => next(event))

  on('ui.render', { component: 'UserMessage' }, async ($, event, next) => {
    const imageNumbers = imageNumbersIn(event.props.text)
    if (event.surface !== 'terminal' || !PASTED_BY_PERSON.has(event.props.origin.kind) || !imageNumbers.length) {
      return next(event)
    }

    const sessionId = await $.session.id()
    const savedImages = await read($, savedImagesAtom)
    const images = await loadImages(
      $,
      imageNumbers,
      async imageNumber => savedImages[savedImageKey(sessionId, imageNumber)] ?? (await findSavedPath($, sessionId, imageNumber)),
    )
    if (!images.length) return next(event)

    const engineRow = await next(event)
    const { Box, Button, Image } = $.ui.resolve(event)
    const viewportColumns = event.viewport?.columns ?? DEFAULT_VIEWPORT_COLUMNS
    const viewportRows = event.viewport?.rows ?? DEFAULT_VIEWPORT_ROWS
    const maxColumns = Math.min(MAX_COLUMNS, viewportColumns - ROW_INDENT * 2)

    return (
      <Box flexDirection="column">
        {engineRow}
        {images.map(({ imageNumber, image }) => {
          const box = thumbnailBox(image.size, maxColumns, MAX_ROWS)
          // The row above already reads `[Image #N]`, so a terminal without pictures shows nothing more.
          return (
            <Box key={`image-${imageNumber}`} flexDirection="column" marginLeft={ROW_INDENT} marginTop={1}>
              <Image source={image.source} columns={box.columns} rows={box.rows} alt=" " />
              <Button
                key={`enlarge-${imageNumber}`}
                plain
                label="⛶"
                hover={ENLARGE_HOVER}
                onPress={() => void openEnlarged($, { imageNumber, path: image.path }, viewportRows)}
              />
            </Box>
          )
        })}
      </Box>
    )
  })

  on('prompt.edit', async ($, event, next) => {
    const box = await next(event)
    await syncDraft($, await $.session.id(), box.text)
    return box
  }).catch(($, event, next) => next(event))

  on('prompt.submit', async ($, event, next) => {
    const result = await next(event)
    await update($, draftImageNumbersAtom, previous => (previous.length ? [] : previous))
    return result
  }).catch(($, event, next) => next(event))

  on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
    const draftImageNumbers = await read($, draftImageNumbersAtom)
    if (event.surface !== 'terminal' || event.props.hasSurvey || !draftImageNumbers.length) return next(event)

    const sessionId = await $.session.id()
    const drafts = draftImageNumbers.map(imageNumber => ({
      imageNumber,
      load: draftLoads.get(savedImageKey(sessionId, imageNumber)) ?? ({ status: 'loading' } as const),
    }))
    const othersBand = await next(event)
    const { Box, Button, Image, Text } = $.ui.resolve(event)
    const viewportRows = event.viewport?.rows ?? DEFAULT_VIEWPORT_ROWS
    const innerColumns = event.props.bodyColumns - DRAFT_FRAME_COLUMNS
    const columnsEach = Math.min(MAX_DRAFT_COLUMNS, Math.floor((innerColumns - DRAFT_GAP * (drafts.length - 1)) / drafts.length))
    const rows = Math.max(1, Math.min(MAX_DRAFT_ROWS, event.props.maxRows - DRAFT_FRAME_ROWS))
    const plural = drafts.length > 1 ? 's' : ''

    return (
      <Box flexDirection="column">
        {othersBand}
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box marginBottom={1}>
            <Text dimColor>{`Pasted image${plural} in your prompt · not sent yet`}</Text>
          </Box>
          <Box flexDirection="row" columnGap={DRAFT_GAP}>
            {drafts.map(({ imageNumber, load }) => {
              if (load.status === 'loading') {
                return <Text key={`draft-${imageNumber}`} dimColor>{`${SPINNER_FRAMES[spinnerFrame]} Loading #${imageNumber}…`}</Text>
              }
              if (load.status === 'missing') {
                return <Text key={`draft-${imageNumber}`} dimColor>{`#${imageNumber}: no preview`}</Text>
              }
              const box = thumbnailBox(load.image.size, columnsEach, rows)
              return (
                <Box key={`draft-${imageNumber}`} flexDirection="column">
                  <Image source={load.image.source} columns={box.columns} rows={box.rows} alt=" " />
                  <Button
                    key={`enlarge-draft-${imageNumber}`}
                    plain
                label="⛶"
                hover={ENLARGE_HOVER}
                    onPress={() => void openEnlarged($, { imageNumber, path: load.image.path }, viewportRows)}
                  />
                </Box>
              )
            })}
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: ENLARGED_PANE }, async ($, event, next) => {
    if (event.surface !== 'terminal') return next(event)
    const { Box, Button, Image, Text } = $.ui.resolve(event)
    const viewed = await read($, viewedImageAtom)
    const image = viewed ? await loadImage($, viewed.path) : null
    const close = () => void $.ui.close({ id: ENLARGED_PANE })
    if (!viewed || !image) {
      return (
        <Box flexDirection="column">
          <Text dimColor>That picture is no longer on disk.</Text>
          <Button key="close" role="dismiss" onPress={close} label="Close" />
        </Box>
      )
    }

    const box = thumbnailBox(image.size, event.props.bodyColumns, Math.max(1, event.props.scroll.bodyRows - 1))
    return (
      <Box flexDirection="column">
        <Image key="enlarged" source={image.source} columns={box.columns} rows={box.rows} alt={`[Image #${viewed.imageNumber}]`} />
        <Box flexDirection="row" columnGap={2}>
          <Button key="close" role="dismiss" autoFocus onPress={close} label="Close" />
          <Text dimColor>Esc closes it too</Text>
        </Box>
      </Box>
    )
  })
}
