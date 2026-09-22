import test from 'node:test'
import assert from 'node:assert/strict'
import { previewFor, textParts } from '../links.js'

test('post links stay clickable without swallowing trailing punctuation', () => {
  assert.deepEqual(textParts('See https://example.com/path, then reply.'), [
    { type: 'text', value: 'See ' },
    { type: 'link', value: 'https://example.com/path' },
    { type: 'text', value: ',' },
    { type: 'text', value: ' then reply.' },
  ])
})

test('social links produce a restrained platform preview', () => {
  assert.deepEqual(previewFor('New post https://x.com/mobius/status/1'), {
    url: 'https://x.com/mobius/status/1',
    label: 'X',
    detail: 'x.com/mobius/status/1',
    social: true,
  })
})
