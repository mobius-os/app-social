import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

const root = new URL('..', import.meta.url).pathname

test('every UI module reachable from the entry is packaged by the manifest', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'mobius.json'), 'utf8'))
  const packaged = new Set([manifest.entry, ...manifest.source_files])
  const seen = new Set()
  const visit = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    const source = readFileSync(join(root, file), 'utf8')
    for (const [, path] of source.matchAll(/^import[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      visit(normalize(join(dirname(file), path)))
    }
  }
  visit(manifest.entry)
  assert.deepEqual([...seen].filter((file) => !packaged.has(file)), [])
})
