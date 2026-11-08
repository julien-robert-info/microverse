import { expect, test } from 'claude-code/testing'

import { parseRows } from '../notes'
import { parseStateQuestions } from '../questions'

// A copy of the skeleton of skills/orchestration/state-file.md: this runtime
// reads no plugin file, and tests/state-file.test.js fails when the two differ.
const SKELETON = `## Missions

| Id | Branch | State |
| --- | --- | --- |

## Questions

## Resume
`

test('T1 the skeleton plus one mission row gives that row', async () => {
  const text = SKELETON.replace(
    '| --- | --- | --- |\n',
    '| --- | --- | --- |\n| M1 | `feat/example` | merged `abc1234` |\n',
  )
  const rows = parseRows(text)

  expect(rows.length).toBe(1)
  expect(rows[0].id).toBe('M1')
  expect(rows[0].branch).toBe('feat/example')
  expect(rows[0].hashes).toEqual(['abc1234'])
})

test('T2 the skeleton with a pending and an answered bullet gives one of each', async () => {
  const text = SKELETON.replace(
    '## Questions\n',
    '## Questions\n\n- Q1 (notes/M1.md) : Example?\n- Answered: Q2 a (2026-01-01)\n',
  )
  const found = parseStateQuestions(text)

  expect(found.pending.length).toBe(1)
  expect(found.pending[0].id).toBe('Q1')
  expect(found.pending[0].file).toBe('notes/M1.md')
  expect(found.pending[0].title).toBe('Example?')
  expect(found.answered.length).toBe(1)
  expect(found.answered[0].id).toBe('Q2')
  expect(found.answered[0].answer.startsWith('a')).toBe(true)
  expect(found.answered[0].date).toBe('2026-01-01')
})

test('T3 the unfilled skeleton gives no row and no question', async () => {
  expect(parseRows(SKELETON).length).toBe(0)
  const found = parseStateQuestions(SKELETON)
  expect(found.pending.length).toBe(0)
  expect(found.answered.length).toBe(0)
})

test('T4 a question line without a heading and a first cell with a title give nothing', async () => {
  const loose = 'Pending questions:\n- Q1 (notes/M1.md) : Example?\n'
  expect(parseStateQuestions(loose).pending.length).toBe(0)

  const titled = '| Id | Branch | State |\n| --- | --- | --- |\n| M1 Feed schema | `feat/example` | open |\n'
  expect(parseRows(titled).length).toBe(0)
})
