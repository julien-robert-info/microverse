import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { lookFor, withLook } from '../kit'
import {
  counterText,
  fillAnswer,
  freeText,
  parseBlocks,
  parseStateQuestions,
  renderQuestionDetail,
  renderQuestions,
} from '../questions'

type Kit = Parameters<TestBody>

const pane = (surface: 'terminal' | 'desktop', bodyColumns: number) =>
  ({
    plugin: 'microverse',
    component: 'Pane',
    requestId: 'microverse-board',
    surface,
    props: {
      title: 'Board',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

const SURFACES = ['terminal', 'desktop'] as const
const WIDE = 140
const ROOT = '/work/demo'
const START = 1_767_000_000_000

const run = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const done = () => ({
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
})

const status = () =>
  JSON.stringify({
    v: 1,
    project: ROOT,
    base: { name: 'main', tip: '1111111' },
    lastReport: null,
    state: { exists: true, sections: [] },
    worktrees: [],
    free: [],
    report: null,
    agents: { since: START, runs: [], total: { cost: 0, advisor: { calls: 0, cost: 0 } } },
    quota: { error: 'none' },
    context: { error: 'none' },
  })

type Fill = { text: string; mode: string | undefined }

// The engine resolves a path against the host (a drive letter and backslashes
// on Windows): files are keyed by their POSIX spelling.
const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// The world under the board: the files by POSIX path (mutable, a test changes
// the state file), the prompt box and what was written to it.
const world = (on: Kit[1], initial: Record<string, string>) => {
  const files: Record<string, string> = Object.fromEntries(
    Object.entries(initial).map(([name, text]) => [`${ROOT}/${name}`, text]),
  )
  const box = { draft: '', fills: [] as Fill[], result: { isFilled: true } as { isFilled: boolean; refusal?: string } }

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.root', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('profile.json') || norm(e.path) in files }))
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: (files[norm(e.path)] ?? '').length, mtimeMs: 7, isLink: false },
  }))
  on('fs.list', (_, e) => ({
    value: Object.entries(files)
      .filter(([path]) => path.startsWith(`${norm(e.path)}/`))
      .map(([path, text]) => ({
        name: path.slice(norm(e.path).length + 1),
        kind: 'file' as const,
        size: text.length,
        mtimeMs: 7,
        isLink: false,
      })),
  }))
  on('fs.read', (_, e) => ({ value: files[norm(e.path)] ?? '' }))
  on('store.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: 1 }, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_, e) =>
    e.argv[0] === 'git' && e.argv[1] === 'worktree'
      ? run(`worktree ${ROOT}\nHEAD 1111111aaaa\nbranch refs/heads/main\n`)
      : e.argv[1]?.endsWith('statusline.js') === true
        ? run('')
        : run(status()),
  )
  on('prompt.read', () => ({ value: { text: box.draft, cursor: box.draft.length } }))
  on('prompt.fill', (_, e) => {
    box.fills.push({ text: e.text, mode: e.mode })
    if (box.result.isFilled) {
      box.draft = e.text
    }

    return { text: e.text, cursor: e.text.length, ...box.result } as never
  })
  // The box is emptied by the send, after the hooks ran.
  on('prompt.submit', (_, e) => {
    box.draft = ''

    return e
  })
  mock.clock(on, { now: START })

  return { files, box }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30))

const start = async ($: Kit[0], on: Kit[1], initial: Record<string, string>) => {
  const seen = world(on, initial)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.turn.complete(done())
  await settle()

  return seen
}

type Mounted = Awaited<ReturnType<Kit[0]['ui']['mount']>>

const shows = async (ui: Mounted, text: RegExp) =>
  (await ui.find({ type: 'Text', text })) !== undefined

const has = async (ui: Mounted, key: string) => (await ui.find({ key })) !== undefined

const press = async (ui: Mounted, key: string) => {
  await ui.press({ key })
  await settle()
}

const STATE = (...bullets: string[]) =>
  ['# État', '', '## Questions à Julien', '', ...bullets, '', '## Suite', '', '- Q99 hors section', ''].join('\n')

const BLOCK = (id: string, lines: string[] = []) =>
  [
    '# E9',
    '',
    `### ${id}. Which format?`,
    '',
    'First paragraph of context.',
    '',
    'Second paragraph.',
    '',
    '- **a.** Fixed : one rule for every question',
    '- **b.** Free : each rick writes its own',
    '- **c.** None : keep today',
    '',
    ...lines,
    '',
    '## Next section',
  ].join('\n')

const RECOMMENDED = ['**Recommandation : a.** Simplest.', '', '**Attend :** the report of M14.']

const M10 = STATE(
  '- Répondues le 2026-10-28 : Q34 d, Q35 oui',
  '- En attente : rien',
  '- Push mobile : à tester sur le téléphone',
  '- Q37 (notes/E9.md) : choisir le format',
)

for (const surface of SURFACES) {
  test(`T1 the M10 state file gives one pending question and reads the answers (${surface})`, async ($, on) => {
    await start($, on, { 'CLAUDE.local.md': M10, 'notes/E9.md': BLOCK('Q37', RECOMMENDED) })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await shows(ui, /^Needs your decision \(1\)$/)).toBe(true)
    expect(await shows(ui, /1 question needs you/)).toBe(true)
    expect(await has(ui, 'open:question:Q37')).toBe(true)
    expect(await shows(ui, /rien|Push mobile|Q99/)).toBe(false)
    expect(await shows(ui, /^▸ Answered \(2\)$/)).toBe(true)
    await press(ui, 'fold:answered')
    expect(await shows(ui, /^Q35 oui · 2026-10-28$/)).toBe(true)
    expect(await shows(ui, /^Q34 d · 2026-10-28$/)).toBe(true)
    await ui.unmount()
  })

  test(`T2 a D-1 block gives options a, b, c, the recommended one and what it waits on (${surface})`, async ($, on) => {
    await start($, on, { 'CLAUDE.local.md': M10, 'notes/E9.md': BLOCK('Q37', RECOMMENDED) })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect((await ui.find({ key: 'answer:Q37:a' }))?.text).toMatch(/^a\. Fixed$/)
    expect((await ui.find({ key: 'answer:Q37:b' }))?.text).toMatch(/^b\. Free$/)
    expect(await has(ui, 'answer:Q37:c')).toBe(true)
    await press(ui, 'open:question:Q37')
    expect(await shows(ui, /^recommended$/)).toBe(true)
    expect(await shows(ui, /^Fixed$/)).toBe(true)
    expect(await shows(ui, /^Free$/)).toBe(true)
    expect(await shows(ui, /^one rule for every question$/)).toBe(true)
    expect(await shows(ui, /^Waits on: the report of M14\.$/)).toBe(true)
    expect(await shows(ui, /^Mission E9$/)).toBe(true)
    expect(await shows(ui, /^Why it is asked$/)).toBe(true)
    expect(await shows(ui, /^First paragraph of context\.$/)).toBe(true)
    expect(await shows(ui, /^• notes\/E9\.md$/)).toBe(true)
    expect(await shows(ui, /^Pending$/)).toBe(true)
    await ui.unmount()
  })

  test(`T3 a block without a recommendation marks no option (${surface})`, async ($, on) => {
    await start($, on, { 'CLAUDE.local.md': M10, 'notes/E9.md': BLOCK('Q37') })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect((await ui.find({ key: 'answer:Q37:a' }))?.text).toBe('a. Fixed')
    await press(ui, 'open:question:Q37')
    expect(await shows(ui, /recommended/)).toBe(false)
    expect(await shows(ui, /^Waits on/)).toBe(false)
    await ui.unmount()
  })

  test(`T4 without a block the bullet stays and only a free answer is offered (${surface})`, async ($, on) => {
    await start($, on, { 'CLAUDE.local.md': STATE('- Q37 (notes/E9.md) : choisir le format') })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await has(ui, 'answer:Q37:a')).toBe(false)
    await press(ui, 'open:question:Q37')
    expect(await shows(ui, /^No block found for this question/)).toBe(true)
    expect(await shows(ui, /^choisir le format$/)).toBe(true)
    expect(await has(ui, 'free:Q37')).toBe(true)
    await ui.unmount()
  })

  test(`T4b a bullet with no file finds its block in the notes at detail open only (${surface})`, async ($, on) => {
    await start($, on, {
      'CLAUDE.local.md': STATE('- Q37 : choisir le format'),
      'notes/E9.md': BLOCK('Q37', RECOMMENDED),
    })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await has(ui, 'answer:Q37:a')).toBe(false)
    await press(ui, 'open:question:Q37')
    expect(await shows(ui, /^recommended$/)).toBe(true)
    expect(await has(ui, 'answer:Q37:a')).toBe(true)
    await ui.unmount()
  })

  test(`T5 two presses fill exactly "Q37 a", one press alone writes nothing (${surface})`, async ($, on) => {
    const { box } = await start($, on, { 'CLAUDE.local.md': M10, 'notes/E9.md': BLOCK('Q37', RECOMMENDED) })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await has(ui, 'fill:Q37')).toBe(false)
    await press(ui, 'answer:Q37:a')
    expect(box.fills).toEqual([])
    expect((await ui.find({ key: 'fill:Q37' }))?.text).toBe('Fill Q37 a')
    await press(ui, 'fill:Q37')
    expect(box.fills).toEqual([{ text: 'Q37 a', mode: 'replace' }])
    expect(await shows(ui, /^1 answer waits in your input box: press Enter there to send it.$/)).toBe(true)
    expect(await has(ui, 'answer:Q37:a')).toBe(true)
    await ui.unmount()
  })

  test(`T6 a free answer is cleaned of control characters and cut at 500 (${surface})`, async ($, on) => {
    const { box } = await start($, on, { 'CLAUDE.local.md': STATE('- Q37 : choisir le format') })
    const ui = await $.ui.mount(pane(surface, WIDE))

    await press(ui, 'open:question:Q37')
    await ui.input({ key: 'free:Q37', text: `oui\u0007 mais\nplus tard​${'x'.repeat(600)}` })
    await settle()
    expect(box.fills).toHaveLength(1)
    const text = box.fills[0].text
    expect(text.startsWith('Q37 oui mais plus tard')).toBe(true)
    expect(text).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    expect(text.length).toBe(500)
    await ui.unmount()
  })

  test(`T7 two questions from two files each get their own options (${surface})`, async ($, on) => {
    await start($, on, {
      'CLAUDE.local.md': STATE('- Q37 (notes/E9.md) : un', '- Q38 (notes/E10.md) : deux'),
      'notes/E9.md': BLOCK('Q37', RECOMMENDED),
      'notes/E10.md': [
        '### Q38. Other one?',
        '',
        '- **a.** Yes : go',
        '- **b.** No : stop',
        '',
        '**Recommendation: b.**',
      ].join('\n'),
    })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await shows(ui, /^Needs your decision \(2\)$/)).toBe(true)
    expect((await ui.find({ key: 'answer:Q37:a' }))?.text).toBe('a. Fixed')
    expect((await ui.find({ key: 'answer:Q38:b' }))?.text).toBe('b. No')
    expect(await has(ui, 'answer:Q38:c')).toBe(false)
    expect(await has(ui, 'answer:Q37:c')).toBe(true)
    await ui.unmount()
  })

  test(`T8 a block titled Q37 is not taken for Q38, nor a Q3 block for Q37 (${surface})`, async ($, on) => {
    await start($, on, {
      'CLAUDE.local.md': STATE('- Q38 (notes/E9.md) : deux', '- Q37 (notes/E10.md) : un'),
      'notes/E9.md': BLOCK('Q37'),
      'notes/E10.md': BLOCK('Q3'),
    })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await has(ui, 'answer:Q38:a')).toBe(false)
    expect(await has(ui, 'answer:Q37:a')).toBe(false)
    await press(ui, 'open:question:Q38')
    // The scan finds a Q37 block, which is not Q38's.
    expect(await has(ui, 'answer:Q38:a')).toBe(false)
    expect(await shows(ui, /^No block found/)).toBe(true)
    await ui.unmount()
  })

  test(`A1 a double press fills once (${surface})`, async ($, on) => {
    const { box } = await start($, on, { 'CLAUDE.local.md': M10, 'notes/E9.md': BLOCK('Q37', RECOMMENDED) })
    const ui = await $.ui.mount(pane(surface, WIDE))

    await press(ui, 'answer:Q37:b')
    await Promise.all([ui.press({ key: 'fill:Q37' }), ui.press({ key: 'fill:Q37' })])
    await settle()
    expect(box.fills).toEqual([{ text: 'Q37 b', mode: 'replace' }])
    await ui.unmount()
  })

  test(`A2 a refused fill is said in the panel and does not mark the question as sent (${surface})`, async ($, on) => {
    const { box } = await start($, on, { 'CLAUDE.local.md': M10, 'notes/E9.md': BLOCK('Q37', RECOMMENDED) })
    const ui = await $.ui.mount(pane(surface, WIDE))

    // The kit's site strips a cause a mocked hook writes (only the engine's own
    // refusals carry one), so the cause reaching the panel here is "unknown".
    box.result = { isFilled: false, refusal: 'dialog' }
    await press(ui, 'answer:Q37:a')
    await press(ui, 'fill:Q37')
    expect(await shows(ui, /did not take the text/)).toBe(true)
    expect(await has(ui, 'fill:Q37')).toBe(true)
    expect(await shows(ui, /answer waits in your input box/)).toBe(false)
    box.result = { isFilled: true }
    await press(ui, 'fill:Q37')
    expect(box.fills.map(one => one.text)).toEqual(['Q37 a', 'Q37 a'])
    expect(await shows(ui, /^1 answer waits in your input box/)).toBe(true)
    await ui.unmount()
  })

  test(`A3 a draft in the input box is never overwritten (${surface})`, async ($, on) => {
    const { box } = await start($, on, { 'CLAUDE.local.md': M10, 'notes/E9.md': BLOCK('Q37', RECOMMENDED) })
    const ui = await $.ui.mount(pane(surface, WIDE))

    box.draft = 'half typed'
    await press(ui, 'answer:Q37:a')
    await press(ui, 'fill:Q37')
    expect(box.fills).toEqual([])
    expect(await shows(ui, /holds a draft/)).toBe(true)
    box.draft = ''
    await press(ui, 'fill:Q37')
    expect(box.fills).toEqual([{ text: 'Q37 a', mode: 'replace' }])
    await ui.unmount()
  })

  test(`A4 an answer with nothing printable writes nothing (${surface})`, async ($, on) => {
    const { box } = await start($, on, { 'CLAUDE.local.md': STATE('- Q37 : choisir le format') })
    const ui = await $.ui.mount(pane(surface, WIDE))

    await press(ui, 'open:question:Q37')
    await ui.input({ key: 'free:Q37', text: '\u0007​ \n' })
    await settle()
    expect(box.fills).toEqual([])
    await ui.unmount()
  })

  test(`A5 the question can be answered again once the state file changed (${surface})`, async ($, on) => {
    const { box, files } = await start($, on, {
      'CLAUDE.local.md': M10,
      'notes/E9.md': BLOCK('Q37', RECOMMENDED),
    })
    const ui = await $.ui.mount(pane(surface, WIDE))

    await press(ui, 'answer:Q37:a')
    await press(ui, 'fill:Q37')
    expect(box.fills).toHaveLength(1)
    await $.prompt.submit({ text: 'Q37 a' })
    await settle()
    expect(await shows(ui, /^Q37 was sent\.$/)).toBe(true)
    files[`${ROOT}/CLAUDE.local.md`] = `${M10}\n- Q37 reste ouverte\n`
    await press(ui, 'refresh')
    await press(ui, 'answer:Q37:c')
    await press(ui, 'fill:Q37')
    expect(box.fills.map(one => one.text)).toEqual(['Q37 a', 'Q37 c'])
    await ui.unmount()
  })
}

test('the state file bullets: several questions in one bullet, a word as an answer', () => {
  const read = parseStateQuestions(
    STATE('- Q40 et Q41 (notes/E9.md) : deux à la fois', '- Q41 oui', '- Répondu : Q40 non, Q42 b'),
  )

  expect(read.pending.map(one => one.id)).toEqual(['Q41'])
  expect(read.answered.map(one => `${one.id}=${one.answer}`)).toEqual(['Q40=non', 'Q42=b'])
})

test('a file named by a bullet must be a plain name under notes/', () => {
  const read = parseStateQuestions(STATE('- Q40 (notes/../secret.md) : x', '- Q41 (/etc/passwd) : y'))

  expect(read.pending.map(one => one.file)).toEqual([null, null])
})

test('the block parser anchors the number and reads both languages', () => {
  const blocks = parseBlocks(
    [
      '### Q3. Short',
      '',
      '- **a.** One : first',
      '',
      '### Q37. Long',
      '',
      '- **a.** Two : second',
      '',
      '**Recommendation: z.**',
      '',
      '**Waits:** nothing',
    ].join('\n'),
  )

  expect(blocks.map(one => one.id)).toEqual(['Q3', 'Q37'])
  expect(blocks[1].options).toEqual([{ letter: 'a', title: 'Two', effect: 'second' }])
  // A recommended letter that names no option marks nothing.
  expect(blocks[1].recommended).toBeNull()
  expect(blocks[1].waits).toBe('nothing')
})

test('freeText builds one line of at most 500 characters from an Id and clean text', () => {
  expect(freeText('Q37', 'a\r\nb')).toBe('Q37 a b')
  expect(freeText('Q37', '\u0007')).toBeNull()
  expect(freeText('37; rm', 'x')).toBeNull()
  expect(Array.from(freeText('Q37', 'é'.repeat(900)) ?? '')).toHaveLength(500)
})

// ---- Several answers in one message ----------------------------------------

const TWO = {
  'CLAUDE.local.md': STATE('- Q96 (notes/E9.md) : un', '- Q97 (notes/E10.md) : deux'),
  'notes/E9.md': BLOCK('Q96', RECOMMENDED),
  'notes/E10.md': ['### Q97. Other one?', '', '- **a.** Yes : go', '- **b.** No : stop', '', '**Recommendation: b.**'].join(
    '\n',
  ),
}

const answer = async (ui: Mounted, id: string, letter: string) => {
  await press(ui, `answer:${id}:${letter}`)
  await press(ui, `fill:${id}`)
}

const texts = (box: { fills: Fill[] }) => box.fills.map(one => one.text)

test('B1 two answers fill one text, in replace mode', async ($, on) => {
  const { box } = await start($, on, TWO)
  const ui = await $.ui.mount(pane('desktop', WIDE))

  await answer(ui, 'Q96', 'a')
  await answer(ui, 'Q97', 'b')
  expect(box.fills).toEqual([
    { text: 'Q96 a', mode: 'replace' },
    { text: 'Q96 a, Q97 b', mode: 'replace' },
  ])
  expect(await shows(ui, /^2 answers wait in your input box: press Enter there to send them\.$/)).toBe(true)
  await ui.unmount()
})

test('B2 a change of mind replaces the answer and keeps the order', async ($, on) => {
  const { box } = await start($, on, TWO)
  const ui = await $.ui.mount(pane('desktop', WIDE))

  await answer(ui, 'Q96', 'a')
  await answer(ui, 'Q96', 'c')
  expect(texts(box)).toEqual(['Q96 a', 'Q96 c'])
  await answer(ui, 'Q97', 'a')
  await answer(ui, 'Q96', 'b')
  expect(texts(box).slice(2)).toEqual(['Q96 c, Q97 a', 'Q96 b, Q97 a'])
  await ui.unmount()
})

test('B3 a typed box is refused and nothing moves', async ($, on) => {
  const { box } = await start($, on, TWO)
  const ui = await $.ui.mount(pane('desktop', WIDE))

  await answer(ui, 'Q96', 'a')
  box.draft = 'Q96 a, and a few words'
  await answer(ui, 'Q97', 'b')
  expect(texts(box)).toEqual(['Q96 a'])
  expect(await shows(ui, /holds a draft/)).toBe(true)
  expect(await shows(ui, /^1 answer waits/)).toBe(true)
  await ui.unmount()
})

test('B4 the box read back with a line end or a space is still ours', async ($, on) => {
  const { box } = await start($, on, TWO)
  const ui = await $.ui.mount(pane('desktop', WIDE))

  await answer(ui, 'Q96', 'a')
  box.draft = 'Q96 a \r\n'
  await answer(ui, 'Q97', 'b')
  expect(texts(box)).toEqual(['Q96 a', 'Q96 a, Q97 b'])
  await ui.unmount()
})

test('B5 sending both tokens marks both as sent and clears the list', async ($, on) => {
  const { box } = await start($, on, TWO)
  const ui = await $.ui.mount(pane('desktop', WIDE))

  await answer(ui, 'Q96', 'a')
  await answer(ui, 'Q97', 'b')
  await $.prompt.submit({ text: 'Q96 a, Q97 b' })
  await settle()
  expect(await shows(ui, /^Q96 was sent\.$/)).toBe(true)
  expect(await shows(ui, /^Q97 was sent\.$/)).toBe(true)
  expect(await shows(ui, /answers? waits?/)).toBe(false)
  await ui.unmount()
  expect(box.fills).toHaveLength(2)
})

test('B6 sending one token only leaves the other answerable once the box is empty', async ($, on) => {
  const { box } = await start($, on, TWO)
  const ui = await $.ui.mount(pane('desktop', WIDE))

  await answer(ui, 'Q96', 'a')
  await answer(ui, 'Q97', 'b')
  await $.prompt.submit({ text: 'Q96 a' })
  await settle()
  expect(await shows(ui, /^Q96 was sent\.$/)).toBe(true)
  expect(await has(ui, 'answer:Q97:b')).toBe(true)
  await answer(ui, 'Q97', 'a')
  expect(texts(box).at(-1)).toBe('Q97 a')
  await ui.unmount()
})

test('B7 a box emptied by hand marks nothing and the next answer starts clean', async ($, on) => {
  const { box } = await start($, on, TWO)
  const ui = await $.ui.mount(pane('desktop', WIDE))

  await answer(ui, 'Q96', 'a')
  box.draft = ''
  await answer(ui, 'Q97', 'b')
  expect(texts(box)).toEqual(['Q96 a', 'Q97 b'])
  expect(await shows(ui, /was sent/)).toBe(false)
  await ui.unmount()
})

test('B8 a free answer with a comma and a Q id inside is one token, never re-read', async ($, on) => {
  const { box } = await start($, on, TWO)
  const ui = await $.ui.mount(pane('desktop', WIDE))

  await answer(ui, 'Q96', 'a')
  box.draft = 'Q96 a'
  await press(ui, 'open:question:Q97')
  await ui.input({ key: 'free:Q97', text: 'no, see Q96 b' })
  await settle()
  box.draft = 'Q96 a, Q97 no, see Q96 b'
  await answer(ui, 'Q96', 'c')
  expect(texts(box)).toEqual(['Q96 a', 'Q96 a, Q97 no, see Q96 b', 'Q96 c, Q97 no, see Q96 b'])
  await ui.unmount()
})

test('B9 a stored value of the first shape (no list, no filled) works', async () => {
  const seen: string[] = []
  const $ = {
    prompt: {
      read: async () => ({ text: '' }),
      fill: async (one: { text: string }) => (seen.push(one.text), { isFilled: true }),
    },
  }
  const out = await fillAnswer($ as never, { pending: null, sent: [] } as never, [
    { question: 'Q96', token: 'Q96 a' },
  ])

  expect(out).toEqual({ refusal: null, answers: [{ question: 'Q96', token: 'Q96 a' }], filled: 'Q96 a' })
  expect(seen).toEqual(['Q96 a'])
})

test('B10 prompt.submit never blocks: odd events pass, meta and commands are ignored', async ($, on) => {
  await start($, on, TWO)
  const ui = await $.ui.mount(pane('desktop', WIDE))

  await answer(ui, 'Q96', 'a')
  await $.prompt.submit({ text: 'Q96 a', isMeta: true } as never)
  await $.prompt.submit({ text: 'Q96 a', command: 'board' } as never)
  await $.prompt.submit({ text: '' })
  await settle()
  expect(await shows(ui, /was sent/)).toBe(false)
  expect(await shows(ui, /^1 answer waits/)).toBe(true)
  await ui.unmount()
})

test('B11 the counter says one answer or N answers', async () => {

  expect(counterText(1)).toBe('1 answer waits in your input box: press Enter there to send it.')
  expect(counterText(3)).toBe('3 answers wait in your input box: press Enter there to send them.')
})

test('B12 "Fill all recommended" fills every recommendation at once and respects a draft', async ($, on) => {
  const { box } = await start($, on, TWO)
  const ui = await $.ui.mount(pane('desktop', WIDE))

  box.draft = 'typing'
  await press(ui, 'fill:recommended')
  expect(box.fills).toEqual([])
  box.draft = ''
  await press(ui, 'fill:recommended')
  expect(box.fills).toEqual([{ text: 'Q96 a, Q97 b', mode: 'replace' }])
  await ui.unmount()
})

// ---- Style of the section and of the detail --------------------------------

type Node = { type?: unknown; key?: unknown; props?: Record<string, unknown>; children?: unknown }

const kids = (node: Node): Node[] =>
  [node.children, node.props?.children]
    .flat(Infinity)
    .filter((one): one is Node => typeof one === 'object' && one !== null)

const textOf = (node: Node) =>
  [node.children, node.props?.children]
    .flat(Infinity)
    .filter((one): one is string => typeof one === 'string')
    .join('')

const walk = (node: Node, visit: (node: Node, parent: Node | null) => void, parent: Node | null = null) => {
  visit(node, parent)
  for (const child of kids(node)) {
    walk(child, visit, node)
  }
}

const collect = (tree: Node, test: (node: Node) => boolean) => {
  const found: { node: Node; parent: Node | null }[] = []
  walk(tree, (node, parent) => {
    if (test(node)) {
      found.push({ node, parent })
    }
  })

  return found
}

const EFFECT = 'e'.repeat(200)

const direct = (surface: 'terminal' | 'desktop', render: typeof renderQuestions, columns = 40) => {
  const ui = withLook(
    { Box: 'Box', Text: 'Text', Button: 'Button', Input: 'Input' } as never,
    lookFor(surface, surface === 'desktop' ? 'dark' : null),
  )
  const block = {
    id: 'Q37',
    title: 'Which format?',
    context: 'First paragraph.\n\nSecond paragraph.',
    options: [
      { letter: 'a', title: 'Fixed', effect: EFFECT },
      { letter: 'b', title: 'Free', effect: 'short' },
    ],
    recommended: 'a',
    waits: 'the report',
  }

  return render({
    ui,
    columns,
    actions: { toggle: () => undefined, openQuestion: () => undefined, chooseAnswer: () => undefined } as never,
    board: {
      light: {
        questions: {
          stateStamp: 's',
          pending: [
            { id: 'Q37', file: 'notes/E9.md', title: 'Which format?' },
            { id: 'Q38', file: 'notes/E9.md', title: 'Other?' },
          ],
          answered: [{ id: 'Q1', answer: 'a', date: null }],
          files: { 'E9.md': { stamp: 'x', blocks: [block, { ...block, id: 'Q38' }] } },
          isScanned: false,
        },
      },
      view: { tab: 'cockpit', detail: { kind: 'question', id: 'Q37' }, toggled: [] },
      answer: { pending: null, sent: [] },
    },
  } as never) as Node
}

for (const surface of SURFACES) {
  test(`S1 the recommended option is a primary action, the others secondary (${surface})`, () => {
    for (const render of [renderQuestions, renderQuestionDetail]) {
      const tree = direct(surface, render)
      const variant = (key: string) =>
        collect(tree, node => node.type === 'Button' && node.props?.key === key)[0].node.props?.variant

      expect(variant('answer:Q37:a')).toBe('primary')
      expect(variant('answer:Q37:b')).toBe('secondary')
    }
  })

  test(`S2 no coloured Text sits inside a Text in the section nor the detail (${surface})`, () => {
    const found: string[] = []
    for (const render of [renderQuestions, renderQuestionDetail]) {
      const tree = direct(surface, render)
      // Every ancestor counts, not only the parent.
      const visit = (node: Node, inText: boolean) => {
        if (node.type === 'Text' && inText && node.props?.color !== undefined) {
          found.push(`${String(node.props.color)}:${textOf(node)}`)
        }
        kids(node).forEach(child => visit(child, inText || node.type === 'Text'))
      }
      visit(tree, false)
      expect(collect(tree, node => node.type === 'Text' && node.props?.color !== undefined).length).toBeGreaterThan(1)
    }

    expect(found).toEqual([])
  })

  test(`S3 at 40 columns an effect of 200 characters wraps in a box that can shrink (${surface})`, () => {
    const tree = direct(surface, renderQuestionDetail, 40)
    const effect = collect(tree, node => node.type === 'Text' && textOf(node) === EFFECT)[0]

    expect(effect.node.props?.wrap).toBe('wrap')
    expect(effect.parent?.props?.flexShrink).toBe(1)
    expect(effect.parent?.props?.minWidth).toBe(0)
    // The title of a question in the section wraps too.
    const title = collect(
      direct(surface, renderQuestions, 40),
      node => node.type === 'Text' && textOf(node) === ' Which format?',
    )

    expect(title[0].node.props?.wrap).toBe('wrap')
  })

  test(`S4 the keys of the section and of the detail are unchanged (${surface})`, async ($, on) => {
    await start($, on, TWO)
    const ui = await $.ui.mount(pane(surface, WIDE))

    for (const key of ['open:question:Q96', 'open:question:Q97', 'answer:Q96:a', 'answer:Q96:c', 'answer:Q97:b', 'fill:recommended']) {
      expect(await has(ui, key)).toBe(true)
    }
    await press(ui, 'open:question:Q96')
    expect(await has(ui, 'free:Q96')).toBe(true)
    expect(await has(ui, 'answer:Q96:b')).toBe(true)
    expect((await ui.find({ key: 'fill:recommended' }))?.text).toBe('Fill all recommended')
    await ui.unmount()
  })

  test(`S5 the answered questions fold under fold:answered (${surface})`, async ($, on) => {
    await start($, on, { 'CLAUDE.local.md': M10, 'notes/E9.md': BLOCK('Q37', RECOMMENDED) })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await has(ui, 'fold:answered')).toBe(true)
    await ui.unmount()
  })
}
