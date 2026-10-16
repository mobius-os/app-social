import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BOARD_ENVELOPE_MAX_BYTES, boardPostFitsWireLimit, boardPostWireBytes,
} from '../board_payload.js'
import { attachmentBytes, galleryFitsMediaLimits, GIF_MAX_BYTES, IMAGE_MAX_BYTES, GALLERY_MAX_BYTES } from '../media_limits.js'

const attachment = dataLength => ({
  mime: 'image/jpeg', data_b64: 'A'.repeat(dataLength), w: 1600, h: 1200,
})

test('gallery budgeting counts the compatibility copy, thumbnails and UTF-8 bytes', () => {
  const originals = Array.from({ length: 4 }, () => attachment(293_600))
  const thumbnails = Array.from({ length: 4 }, () => ({
    mime: 'image/webp', data_b64: 'A'.repeat(163_840), w: 640, h: 480,
  }))
  const payload = { text: 'Photo 📸', attachments: originals, thumbnails }

  const withoutThumbnails = boardPostWireBytes({ text: '', attachments: originals })
  assert.ok(withoutThumbnails > 5 * originals[0].data_b64.length)
  assert.ok(boardPostWireBytes(payload) > withoutThumbnails + 4 * thumbnails[0].data_b64.length)
  assert.equal(boardPostFitsWireLimit(payload), true)
})

test('the 60 MiB wire boundary counts metadata and rejects the next byte', () => {
  const payload = dataLength => ({ text: '', attachment: attachment(dataLength) })
  const metadataBytes = boardPostWireBytes(payload(0))
  assert.equal(boardPostFitsWireLimit(payload(BOARD_ENVELOPE_MAX_BYTES - metadataBytes)), true)
  assert.equal(boardPostFitsWireLimit(payload(BOARD_ENVELOPE_MAX_BYTES - metadataBytes + 1)), false)
})

test('20 MiB gallery originals fit without counting the legacy duplicate as a second upload', () => {
  const image = (bytes, mime = 'image/gif') => ({ mime, data_b64: Buffer.alloc(bytes).toString('base64'), w: 12, h: 8 })
  const gif = image(GIF_MAX_BYTES)
  assert.equal(attachmentBytes(gif), GIF_MAX_BYTES)
  assert.equal(galleryFitsMediaLimits([gif]), true)
  assert.equal(boardPostFitsWireLimit({ attachments: [gif] }), true)
  assert.equal(galleryFitsMediaLimits([gif, image(1)]), false)
  assert.equal(galleryFitsMediaLimits([image(IMAGE_MAX_BYTES + 1, 'image/png')]), false)
  const photos = Array.from({length: 4}, () => image(IMAGE_MAX_BYTES, 'image/png'))
  assert.equal(photos.reduce((sum, photo) => sum + attachmentBytes(photo), 0), GALLERY_MAX_BYTES)
  assert.equal(galleryFitsMediaLimits(photos), true)
  assert.equal(galleryFitsMediaLimits(Array.from({length: 5}, () => image(1))), false)
  assert.equal(attachmentBytes(image(2)), 2)
  assert.equal(attachmentBytes(image(3)), 3)
})
