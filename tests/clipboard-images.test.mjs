import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { clipboardImageFile } from '../ui/interactionRules.js'

const item = (type, file) => ({ kind: 'file', type, getAsFile: () => file })
test('image pastes select the first readable image without swallowing ordinary text or documents', () => {
  const image = { type: 'image/png' }
  const other = { type: 'image/jpeg' }
  assert.equal(clipboardImageFile({ items: [item('application/pdf', {}), item('image/png', image), item('image/jpeg', other)] }), image)
  assert.equal(clipboardImageFile({ items: [{ kind: 'string', type: 'text/plain' }] }), null)
  assert.equal(clipboardImageFile({ items: [item('application/pdf', {})] }), null)
  assert.equal(clipboardImageFile(undefined), null)
})
test('unreadable clipboard entries do not hide a later valid image', () => {
  const image = { type: 'image/png' }
  assert.equal(clipboardImageFile({ items: [item('image/png', null), item('image/png', image)] }), image)
})
test('direct and group pastes share the picker preparation and sending gate', () => {
  for (const name of ['Thread', 'GroupThread']) {
    const source = readFileSync(new URL(`../ui/${name}.jsx`, import.meta.url), 'utf8')
    assert.match(source, /<TimelineComposer timeline=\{timeline\} onOpenImage=\{onOpenImage\} \/>/)
  }
  {
    const source = readFileSync(new URL('../ui/useMessageTimeline.jsx', import.meta.url), 'utf8')
    assert.match(source, /await selectImage\(file\)/)
    assert.match(source, /onImagePaste=\{sending \? undefined : selectImage\}/)
    assert.match(source, /setSelectedImage\(await prepareImage\(file\)\)/)
  }
  const composer = readFileSync(new URL('../ui/Composer.jsx', import.meta.url), 'utf8')
  assert.match(composer, /if \(!onImagePaste \|\| disabled\) return/)
  assert.match(composer, /if \(!file\) return\s+event.preventDefault\(\)\s+onImagePaste\(file\)/)
})
