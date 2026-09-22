import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BOARD_ENVELOPE_MAX_BYTES, boardPostFitsWireLimit, boardPostWireBytes,
} from '../board_payload.js'

const attachment = dataLength => ({
  mime: 'image/jpeg', data_b64: 'A'.repeat(dataLength), w: 1600, h: 1200,
})

test('gallery budgeting counts the compatibility copy, thumbnails and UTF-8 bytes', () => {
  const originals = Array.from({ length: 4 }, () => attachment(293_600))
  const thumbnails = Array.from({ length: 4 }, () => ({
    mime: 'image/webp', data_b64: 'A'.repeat(163_840), w: 640, h: 480,
  }))
  const payload = { text: 'Photo 📸', attachments: originals, thumbnails }

  assert.equal(boardPostFitsWireLimit(payload), false)
  assert.ok(boardPostWireBytes(payload) > BOARD_ENVELOPE_MAX_BYTES)
})

test('the exact 2 MiB boundary is accepted and the next byte is rejected', () => {
  const payload = dataLength => ({
    text: '', attachments: Array.from({ length: 4 }, () => attachment(dataLength)),
  })
  let low = 0
  let high = 1_400_000
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    const size = boardPostWireBytes(payload(middle))
    if (size <= BOARD_ENVELOPE_MAX_BYTES) low = middle
    else high = middle
  }

  assert.equal(boardPostFitsWireLimit(payload(low)), true)
  assert.equal(boardPostFitsWireLimit(payload(high)), false)
})
