import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { newConversationPlan } from '../ui/newConversation.js'

const ada = { host: 'ada.example', handle: 'ada' }
const bo = { host: 'bo.example', handle: 'bo' }
const plan = (fields) => newConversationPlan({ chosen: [], asGroup: false, name: '', canCreateGroup: true, ...fields })

test('one person opens a direct chat unless a group is chosen', () => {
  assert.deepEqual([plan({ chosen: [ada] }).isGroup, plan({ chosen: [ada] }).action], [false, 'Message @ada'])
  const group = plan({ chosen: [ada], asGroup: true })
  assert.deepEqual([group.isGroup, group.action, group.disabled, group.groupName], [true, 'Create group', false, '@ada'])
})

test('a group can be created alone once it has a name', () => {
  assert.deepEqual([plan({}).action, plan({}).disabled], ['Choose someone', true])
  const unnamed = plan({ asGroup: true })
  assert.deepEqual([unnamed.isGroup, unnamed.disabled, unnamed.defaultName], [true, true, ''])
  const named = plan({ asGroup: true, name: '  Book club ' })
  assert.deepEqual([named.disabled, named.groupName], [false, 'Book club'])
})

test('two or more people always make a group, which needs permission', () => {
  const two = plan({ chosen: [ada, bo] })
  assert.deepEqual([two.isGroup, two.groupForced, two.groupName], [true, true, '@ada, @bo'])
  assert.equal(plan({ chosen: [ada, bo], canCreateGroup: false }).disabled, true)
  assert.equal(plan({ chosen: [ada], asGroup: true, canCreateGroup: false }).disabled, true)
  assert.equal(plan({ created: { gid: 'g1' } }).action, 'Open group')
})

test('the picker offers the group choice and creates from the plan', () => {
  const source = readFileSync(new URL('../ui/Messages.jsx', import.meta.url), 'utf8')
  assert.match(source, /newConversationPlan\(/)
  assert.match(source, /Create a group/)
  assert.match(source, /createGroup\(groupName, chosen\.map\(user => user\.host\)\)/)
})
