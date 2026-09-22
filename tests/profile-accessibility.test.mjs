import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
const people = readFileSync(new URL('../ui/People.jsx', import.meta.url), 'utf8')
const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')

test('profile avatar controls preserve the visual disc while exposing a 44px hit area', () => {
  assert.match(board, /className="cn-avatar-btn"[\s\S]*className=\{`\$\{className\} cn-avatar-visual`\}/)
  const avatarRule = theme.slice(theme.indexOf('.cn-avatar-btn {'), theme.indexOf('.cn-avatar-btn .cn-avatar-visual'))
  assert.match(avatarRule, /min-width:\s*44px/)
  assert.match(avatarRule, /min-height:\s*44px/)
  assert.match(theme, /\.cn-profile-preview-close \{[\s\S]*min-width:\s*44px; min-height:\s*44px/)
})

test('cross-surface profile dismissal restores focus to a connected People control', () => {
  assert.match(people, /const peopleSearchRef = useRef\(null\)/)
  assert.match(people, /profileReturnFocus\.current = event\.currentTarget/)
  assert.match(people, /if \(target\?\.isConnected\) target\.focus\(\)[\s\S]*peopleSearchRef\.current\?\.focus\(\)/)
})
