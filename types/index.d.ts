// `${sessionId}:${imageNumber}` → the PNG Claude Code saved for that paste.
export type SavedImages = Record<string, string>

// The picture the enlarge pane shows.
export interface ViewedImage {
  imageNumber: number
  path: string
}

declare module 'claude-code' {
  interface PluginState {
    'pasted-images': {
      savedImages: SavedImages
      // The `[Image #N]` the prompt box holds now, before it is sent.
      draftImageNumbers: number[]
      viewedImage: ViewedImage | null
    }
  }
}
