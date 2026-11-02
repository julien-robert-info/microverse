import { expect, test } from 'claude-code/testing'

import { Bar, StackedBar, barRuns, markerOf, splitCells, withLook, lookFor } from '../kit'
import { PALETTE, TONE, tint } from '../tokens'

// Components as plain strings: an element is then `{ type, props }` to walk.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fake = (surface = 'terminal'): any =>
  withLook({ Box: 'Box', Text: 'Text', Button: 'Button' } as never, lookFor(surface, null))

// The test runtime keeps children beside `props`, not inside.
type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown }

const cellsOf = (bar: Node) => {
  const list = [bar.children].flat(2) as Node[]

  return list
    .filter(one => one !== null && one !== undefined)
    .map(one => ({
      width: one.props?.width as number,
      color: one.props?.backgroundColor as string | undefined,
    }))
}

const sum = (values: number[]) => values.reduce((one, other) => one + other, 0)

test('T1 tint lays a hue over a surface as an opaque hex', async () => {
  expect(tint('#7cc99a', 0.15, '#1e1e1b')).toBe('#2c382e')
  expect(tint('#ffffff', 0, '#102030')).toBe('#102030')
  expect(tint('#ffffff', 1, '#102030')).toBe('#ffffff')
})

test('T2 a bar fills round(p/100*cells), at least one cell above 0, red above 100 %', async () => {
  const filled = (percent: number) => {
    const runs = barRuns(percent, 10, PALETTE.green)

    return {
      cells: sum(runs.filter(run => run.hue !== null).map(run => run.width)),
      hues: new Set(runs.map(run => run.hue)),
    }
  }

  expect(filled(0).cells).toBe(0)
  expect(filled(4).cells).toBe(1)
  expect(filled(50).cells).toBe(5)
  expect(filled(15).cells).toBe(2)
  expect(filled(96).cells).toBe(10)
  expect(filled(100).cells).toBe(10)
  const over = filled(130)
  expect(over.cells).toBe(10)
  expect(over.hues.has(TONE.error)).toBe(true)
  expect(over.hues.has(PALETTE.green)).toBe(false)

  // The same through the element: 4 widths of a 10-cell row.
  const bar = cellsOf(Bar(fake(), { percent: 50, cells: 10, hue: PALETTE.teal }))
  expect(sum(bar.map(one => one.width))).toBe(10)
  expect(sum(bar.filter(one => one.color === PALETTE.teal).map(one => one.width))).toBe(5)

  expect([-5, 0, 100, 140].map(at => markerOf(at, 10))).toEqual([0, 0, 9, 9])
  const marked = barRuns(10, 10, PALETTE.green, [{ at: 60, hue: PALETTE.text }])
  expect(marked.find(run => run.hue === PALETTE.text)?.width).toBe(1)
  expect(sum(marked.map(run => run.width))).toBe(10)
})

test('T3 a stacked bar shares its cells by largest remainder and sums exactly', async () => {
  expect(splitCells([88, 12], 10)).toEqual([9, 1])
  expect(splitCells([1, 1, 98], 10)).toEqual([1, 1, 8])
  expect(splitCells([0, 100], 10)).toEqual([0, 10])

  for (const values of [[88, 12], [1, 1, 98], [0, 100], [33, 33, 34], [7, 7, 7, 79]]) {
    expect(sum(splitCells(values, 10))).toBe(10)
  }

  const stacked = cellsOf(
    StackedBar(fake(), {
      parts: [
        { label: 'a', value: 0, hue: PALETTE.violet },
        { label: 'b', value: 100, hue: PALETTE.teal },
      ],
      cells: 10,
    }),
  )
  expect(stacked).toEqual([{ width: 10, color: PALETTE.teal }])
})
