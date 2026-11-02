import { expect, test } from 'claude-code/testing'

import { linkAgent, type LinkRow } from '../link'

const row = (id: string): LinkRow => ({ id, branch: null, isRange: false })
const link = (description: string, rows: LinkRow[]) =>
  linkAgent({ agentId: 'x1', description }, rows, [])

test('J6 a sub-mission token, with or without a number, gives its mission', async () => {
  const rows = [row('E33'), row('E34')]

  expect(link('E33f2 board answers batch', rows)).toBe('E33')
  expect(link('E33j passe de fidélité', rows)).toBe('E33')
  expect(link('E33a board foundation', rows)).toBe('E33')
})

test('J6b an exact row wins over the stem, a shorter id is not a prefix', async () => {
  expect(link('E33f2 board', [row('E33'), row('E33f2')])).toBe('E33f2')
  expect(link('E3 board', [row('E33')])).toBeNull()
  expect(link('E3a board', [row('E33')])).toBeNull()
  expect(link('E33 board', [row('E33')])).toBe('E33')
})
