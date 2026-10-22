import { expect, test } from 'claude-code/testing'

import { imageNumbersIn, pngSize, projectDirName, savedImageKey, sourceLinesIn, thumbnailBox } from './images'

// The first 24 bytes of a 1280x720 PNG: signature, IHDR length and type, width, height.
const PNG_1280_BY_720 = 'iVBORw0KGgoAAAANSUhEUgAABQAAAALQ'

test('reads the saved file of each image from its source line', () => {
  expect(
    sourceLinesIn(
      '[Image: source: /private/tmp/claude-501/project/session-a/images/1.png]\n' +
        '[Image: source: /private/tmp/claude-501/project/session-b/images/12.png]',
    ),
  ).toEqual([
    { imageNumber: 1, path: '/private/tmp/claude-501/project/session-a/images/1.png' },
    { imageNumber: 12, path: '/private/tmp/claude-501/project/session-b/images/12.png' },
  ])
  expect(sourceLinesIn('[Image #1] look')).toEqual([])
})

test('keeps the same image number apart across sessions', () => {
  expect(savedImageKey('session-a', 1)).not.toBe(savedImageKey('session-b', 1))
})

test('names the project folder the way Claude Code does', () => {
  expect(projectDirName('/Users/jane.doe/code/my-app')).toBe('-Users-jane-doe-code-my-app')
})

test('finds each placeholder once', () => {
  expect(imageNumbersIn('[Image #3] and [Image #4], again [Image #3]')).toEqual([3, 4])
  expect(imageNumbersIn('no images here')).toEqual([])
})

test('reads the size from a PNG header and rejects anything else', () => {
  expect(pngSize(PNG_1280_BY_720)).toEqual({ width: 1280, height: 720 })
  expect(pngSize('aGVsbG8gd29ybGQsIHRoaXMgaXMgbm90IGEgcG5n')).toBeUndefined()
})

test('keeps proportions within the limits', () => {
  expect(thumbnailBox({ width: 1280, height: 720 }, 60, 16)).toEqual({ columns: 57, rows: 16 })
  expect(thumbnailBox({ width: 2000, height: 400 }, 60, 16)).toEqual({ columns: 60, rows: 6 })
})
