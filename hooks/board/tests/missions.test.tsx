import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

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
const NARROW = 60
const ROOT = '/work/demo'
const START = 1_767_000_000_000
// Seconds, as `git show --format=%ct` prints them.
const DATES: Record<string, number> = {
  aaaaaaa: 1_766_000_000,
  bbbbbbb: 1_766_500_000,
  ccccccc: 1_766_900_000,
}

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

type Tree = { branch: string; id: string; isMerged?: boolean }
type Roster = { id: string; type: string; description: string }
type Run = {
  agentId: string
  type: string
  model: string
  description: string
  started: number
  ended: number
  cost: number
}

type Scene = {
  // CLAUDE.local.md
  state: string
  // notes/<name>
  notes?: Record<string, string>
  // NOTES.local.md
  journal?: string
  // Worktrees of agents, at `.claude/worktrees/agent-<id>`.
  trees?: Tree[]
  free?: string[]
  agents?: Roster[]
  runs?: Run[]
  // Hashes that are ancestors of the base.
  ancestors?: string[]
  store?: Record<string, unknown>
  // Commits merged since the last report, oldest first.
  merged?: { sha: string; subject: string; at: number }[]
}

const porcelain = (trees: Tree[]) =>
  [
    `worktree ${ROOT}\nHEAD 1111111aaaa\nbranch refs/heads/main\n`,
    ...trees.map(
      tree =>
        `worktree ${ROOT}/.claude/worktrees/agent-${tree.id}\nHEAD 2222222bbbb\nbranch refs/heads/${tree.branch}\n`,
    ),
  ].join('\n')

const status = (scene: Scene) =>
  JSON.stringify({
    v: 1,
    project: ROOT,
    base: { name: 'main', tip: '1111111' },
    lastReport: null,
    state: { exists: true, sections: [] },
    worktrees: (scene.trees ?? []).map(tree => ({
      branch: tree.branch,
      path: `${ROOT}/.claude/worktrees/agent-${tree.id}`,
      rel: `.claude/worktrees/agent-${tree.id}`,
      merged: tree.isMerged === true,
      last: null,
      dirty: false,
    })),
    free: (scene.free ?? []).map(branch => ({ branch, sha: '3333333', subject: 'work' })),
    report:
      scene.merged === undefined
        ? null
        : {
            since: { sha: '0000000', at: START - 86_400_000 },
            base: 'main',
            merged: scene.merged,
            agents: { error: 'none' },
            quota: { error: 'none' },
            context: { error: 'none' },
          },
    agents: {
      since: START,
      runs: (scene.runs ?? []).map(one => ({
        ...one,
        requests: 1,
        tokens: { input: 1, write5m: 0, write1h: 0, read: 0, output: 1 },
        advisor: { calls: 0, cost: 0 },
        finished: true,
      })),
      total: { cost: 1, advisor: { calls: 0, cost: 0 } },
    },
    quota: { error: 'none' },
    context: { error: 'none' },
  })

type Reads = { journal: number; state: number; notes: string[] }

// The world under the board for a scene. `reads` counts what the light sensor
// reads, `ancestorCalls` the `merge-base` runs.
// The engine resolves a path against the host (a drive letter and backslashes
// on Windows): files are keyed by their POSIX spelling.
const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const world = (on: Kit[1], scene: Scene) => {
  const reads: Reads = { journal: 0, state: 0, notes: [] }
  const ancestorCalls: string[] = []
  const files: Record<string, string> = {
    [`${ROOT}/CLAUDE.local.md`]: scene.state,
    ...(scene.journal === undefined ? {} : { [`${ROOT}/NOTES.local.md`]: scene.journal }),
    ...Object.fromEntries(
      Object.entries(scene.notes ?? {}).map(([name, text]) => [`${ROOT}/notes/${name}`, text]),
    ),
  }

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.root', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('fs.exists', (_, e) => ({
    value: e.path.endsWith('profile.json') || norm(e.path) in files,
  }))
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
  on('fs.read', (_, e) => {
    if (e.path.endsWith('NOTES.local.md')) {
      reads.journal += 1
    } else if (e.path.endsWith('CLAUDE.local.md')) {
      reads.state += 1
    } else {
      reads.notes.push(e.path)
    }

    return { value: files[norm(e.path)] ?? '' }
  })
  on('store.get', (_, e) => ({ value: scene.store?.[e.key] }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: 1 }, rateLimits: [] },
  }))
  on('agent.list', () => ({
    value: (scene.agents ?? []).map(agent => ({ ...agent, status: 'running' })),
  }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git' && e.argv[1] === 'worktree') {
      return run(porcelain(scene.trees ?? []))
    }
    if (e.argv[0] === 'git' && e.argv[1] === 'merge-base') {
      ancestorCalls.push(e.argv[3])

      return run('', (scene.ancestors ?? []).includes(e.argv[3]) ? 0 : 1)
    }
    if (e.argv[0] === 'git' && e.argv[1] === 'show') {
      return run(`${DATES[e.argv[4]] ?? 1}\n`)
    }
    if (e.argv[1]?.endsWith('statusline.js') === true) {
      return run('')
    }

    return run(status(scene))
  })
  mock.clock(on, { now: START })

  return { reads, ancestorCalls }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30))

const start = async ($: Kit[0], on: Kit[1], scene: Scene) => {
  const seen = world(on, scene)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.turn.complete(done())
  await settle()

  return seen
}

type Mounted = Awaited<ReturnType<Kit[0]['ui']['mount']>>

const shows = async (ui: Mounted, text: RegExp) =>
  (await ui.find({ type: 'Text', text })) !== undefined

// A column header is sibling `Text`s: the label, then its count in brackets.
const heading = async (ui: Mounted, label: string, count: number) =>
  (await ui.find({ type: 'Text', text: new RegExp(`^${label}$`) })) !== undefined &&
  (await ui.find({ type: 'Text', text: new RegExp(`^\\(${count}\\)$`) })) !== undefined

const TABLE = (...rows: string[]) => ['| Id | Branche | État |', '|---|---|---|', ...rows].join('\n')

// The four lines of a state file: two ranges, a deleted branch with its hash,
// a notes file in the branch cell.
const FOUR = TABLE(
  '| E1-E9 | séries du mois (NOTES § 3) | mergés ; release `aaaaaaa` |',
  '| E10-E11 | séries suivantes | mergés ; release `bbbbbbb` |',
  '| E12 | `feat/gone-branch` | mergé (`ccccccc`) : première mission |',
  '| E13 | `notes/E13.md` | conception faite |',
)

for (const surface of SURFACES) {
  test(`T1 ranges and a deleted branch are Merged, a notes file alone is Design (${surface})`, async ($, on) => {
    await start($, on, {
      state: FOUR,
      notes: { 'E13.md': '# E13\n\n## Mesures\n\nthree things.\n' },
      ancestors: ['aaaaaaa', 'bbbbbbb', 'ccccccc'],
    })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await heading(ui, 'Merged', 3)).toBe(true)
    expect(await heading(ui, 'Design', 1)).toBe(true)
    expect(await shows(ui, /^Other/)).toBe(false)
    expect(await ui.find({ key: 'open:E13' })).toBeDefined()
    expect(await ui.find({ key: 'open:E12' })).toBeDefined()
    await ui.unmount()
  })

  test(`T2 a morty running in agent-<id> on a row's branch is Building and linked (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE('| E7 | `feat/seven` | en cours |', '| E8 | `feat/eight` | en cours |'),
      trees: [{ branch: 'feat/seven', id: 'm1' }],
      agents: [{ id: 'm1', type: 'microverse:morty', description: 'implement the thing' }],
      runs: [
        {
          agentId: 'm1',
          type: 'microverse:morty',
          model: 'claude-sonnet-5',
          description: 'implement the thing',
          started: START - 600_000,
          ended: START,
          cost: 1.5,
        },
      ],
    })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await heading(ui, 'Building', 1)).toBe(true)
    expect(await heading(ui, 'To merge', 0)).toBe(true)
    await ui.press({ key: 'open:E7' })
    await settle()
    expect(await shows(ui, /Runs \(1\)/)).toBe(true)
    expect(await shows(ui, /sonnet-5 · 10 min · \$1\.50/)).toBe(true)
    await ui.unmount()
  })

  test(`T3 a council whose description is "E7 review" gives Review (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE('| E7 | `feat/seven` | rendu |'),
      trees: [{ branch: 'feat/seven', id: 'm1' }],
      agents: [{ id: 'c1', type: 'microverse:council', description: 'E7 review' }],
    })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await heading(ui, 'Review', 1)).toBe(true)
    expect(await heading(ui, 'To merge', 0)).toBe(true)
    await ui.unmount()
  })

  test(`T4 a worktree with no agent is To merge (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE('| E7 | `feat/seven` | rendu |'),
      trees: [{ branch: 'feat/seven', id: 'm1' }],
    })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await heading(ui, 'To merge', 1)).toBe(true)
    expect(await heading(ui, 'Building', 0)).toBe(true)
    expect(await ui.find({ type: 'Button', text: /Merge|Launch|diff/i })).toBeUndefined()
    await ui.unmount()
  })

  test(`T5 a "Brouillon de brief" title and no branch gives Brief (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE('| E9 | `notes/E9.md` | conçue |', '| E10 | `notes/E10.md` | conçue |'),
      notes: {
        'E9.md': '# E9\n\n## Brouillon de brief\n\n1. Branche.\n',
        'E10.md': '# E10\n\n## Mesures\n\nunits.\n',
      },
    })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await heading(ui, 'Brief', 1)).toBe(true)
    expect(await heading(ui, 'Design', 1)).toBe(true)
    await ui.unmount()
  })
}

const CLASSES = [
  '# E14',
  '',
  '## Règles décidées',
  '',
  'Rule one holds.',
  '',
  '## Mesures',
  '',
  'Twelve units measured.',
  '',
  '## Zones à risque',
  '',
  'The parser is fragile.',
  '',
  '## À confirmer',
  '',
  'Which unit?',
  '',
  '## Carte',
  '',
  'A map of the code.',
  '',
].join('\n')

for (const surface of SURFACES) {
  test(`T6 headings are classed by type, an unknown heading is Other (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE('| E14 | `notes/E14.md` | conçue |'),
      notes: { 'E14.md': CLASSES },
    })
    const ui = await $.ui.mount(pane(surface, WIDE))
    await ui.press({ key: 'open:E14' })
    await settle()

    for (const line of [
      /Decided · 1/,
      /Measures · 1/,
      /Risks · 1/,
      /Open points · 1/,
      /Other · 1/,
    ]) {
      expect(await shows(ui, line)).toBe(true)
    }
    expect(await shows(ui, /Verified/)).toBe(false)
    expect(await shows(ui, /Twelve units measured\./)).toBe(true)
    await ui.unmount()
  })

  test(`T7 Raw shows the Markdown as written (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE('| E14 | `notes/E14.md` | conçue |'),
      notes: { 'E14.md': CLASSES },
    })
    const ui = await $.ui.mount(pane(surface, WIDE))
    await ui.press({ key: 'open:E14' })
    await settle()
    expect(await shows(ui, /^## Mesures$/)).toBe(false)

    await ui.press({ key: 'mission:raw' })
    await settle()
    expect(await shows(ui, /^## Mesures$/)).toBe(true)
    expect(await shows(ui, /Measures · 1/)).toBe(false)

    await ui.press({ key: 'mission:structured' })
    await settle()
    expect(await shows(ui, /Measures · 1/)).toBe(true)
    await ui.unmount()
  })

  test(`T8 a linked run is listed and an unattributed one is counted apart (${surface})`, async ($, on) => {
    const runOf = (agentId: string, description: string): Run => ({
      agentId,
      type: 'microverse:rick',
      model: 'claude-opus-4',
      description,
      started: START - 120_000,
      ended: START,
      cost: 2,
    })
    await start($, on, {
      state: TABLE('| E7 | `notes/E7.md` | conçue |'),
      notes: { 'E7.md': '# E7\n\n## Mesures\n\nunits.\n' },
      runs: [runOf('r1', 'E7 design'), runOf('r2', 'explore the cache')],
    })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await shows(ui, /1 run not attributed to a mission/)).toBe(true)
    await ui.press({ key: 'open:E7' })
    await settle()
    expect(await shows(ui, /Runs \(1\)/)).toBe(true)
    expect(await shows(ui, /opus-4 · 2 min · \$2\.00/)).toBe(true)
    await ui.unmount()
  })

  test(`a range row is never the target of a link, even through its branch cell (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE('| E1-E9 | `feat/shared` | mergés |', '| E10 | `feat/ten` | en cours |'),
      trees: [{ branch: 'feat/shared', id: 'm1' }],
      runs: [
        {
          agentId: 'm1',
          type: 'microverse:morty',
          model: 'claude-sonnet-5',
          description: 'E1-E9 cleanup',
          started: START - 60_000,
          ended: START,
          cost: 1,
        },
      ],
    })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await shows(ui, /1 run not attributed to a mission/)).toBe(true)
    await ui.unmount()
  })

  test(`T9 two missions, one linked by E33a in the description, one by its branch (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE('| E33 | `feat/board` | en cours |', '| E34 | `feat/quota` | en cours |'),
      trees: [{ branch: 'feat/quota', id: 'm2' }],
      agents: [
        { id: 'm1', type: 'microverse:morty', description: 'E33a board foundation' },
        { id: 'm2', type: 'microverse:morty', description: 'quota work' },
      ],
    })
    const ui = await $.ui.mount(pane(surface, WIDE))

    expect(await heading(ui, 'Building', 2)).toBe(true)
    expect(await heading(ui, 'Design', 0)).toBe(true)
    await ui.press({ key: 'open:E33' })
    await settle()
    expect(await shows(ui, /Runs \(1\)/)).toBe(true)
    // The drawer's line is the whole text; the cockpit's agent list appends a
    // duration to the same words.
    expect(await shows(ui, /^running · E33a board foundation$/)).toBe(true)
    expect(await shows(ui, /^running · quota work$/)).toBe(false)
    await ui.press({ key: 'open:E34' })
    await settle()
    expect(await shows(ui, /^running · quota work$/)).toBe(true)
    expect(await shows(ui, /^running · E33a board foundation$/)).toBe(false)
    await ui.unmount()
  })
}

test('a narrow pane lists one folded line per column and Merged shows the three latest', async ($, on) => {
  const dated = ['aaaaaaa', 'bbbbbbb', 'ccccccc', 'ddddddd']
  await start($, on, {
    state: TABLE(
      ...dated.map((hash, index) => `| E${20 + index} | \`feat/old-${index}\` | mergé (\`${hash}\`) |`),
      '| E30 | autre | rien |',
    ),
    ancestors: dated,
  })
  const ui = await $.ui.mount(pane('terminal', NARROW))

  expect(await shows(ui, /Merged · 4/)).toBe(true)
  expect(await ui.find({ key: 'open:E20' })).toBeUndefined()
  await ui.press({ key: 'fold:merged' })
  await settle()
  // DATES has no entry for the fourth hash: it sorts last and is cut.
  expect(await ui.find({ key: 'open:E22' })).toBeDefined()
  expect(await ui.find({ key: 'open:E23' })).toBeUndefined()
  expect(await shows(ui, /\+1 more/)).toBe(true)
  expect(await shows(ui, /Other · 1/)).toBe(true)
  expect(await ui.find({ key: 'open:E30' })).toBeUndefined()
  await ui.press({ key: 'fold:other' })
  await settle()
  expect(await ui.find({ key: 'open:E30' })).toBeDefined()
  await ui.unmount()
})

test('NOTES.local.md is read again only when its stamp changes, one merge-base per cited hash', async ($, on) => {
  const seen = await start($, on, {
    state: TABLE('| E40 | `notes/E40.md` | en cours (NOTES § 2) `aaaaaaa` |'),
    notes: { 'E40.md': '# E40\n\n## Mesures\n\nunits.\n' },
    journal: '## 1. Start\n\nfirst.\n\n## 2. Plan\n\nThe plan reads like this.\n',
    ancestors: [],
  })
  const ui = await $.ui.mount(pane('desktop', WIDE))
  expect(await shows(ui, /E40 · § 2 Plan/)).toBe(false)
  await ui.press({ key: 'fold:notes:E40' })
  await settle()
  expect(await shows(ui, /E40 · § 2 Plan/)).toBe(true)
  expect(await shows(ui, /The plan reads like this\./)).toBe(true)

  await ui.press({ key: 'refresh' })
  await settle()
  await ui.press({ key: 'refresh' })
  await settle()
  expect(seen.reads.journal).toBe(1)
  expect(seen.ancestorCalls.length).toBeGreaterThan(0)
  expect(seen.ancestorCalls.every(hash => hash === 'aaaaaaa')).toBe(true)
  await ui.unmount()
})

const SIX = ['design', 'brief', 'building', 'review', 'merge', 'merged']
const MERGED_BAR = '#3f6350'

type Node = { props?: Record<string, unknown>; children?: Node[] }

// `find` does not filter on props: walk the first Box (the whole tree) for a fill.
const hasFill = async (ui: Mounted, hex: string) => {
  const walk = (node: Node | undefined): boolean =>
    node !== undefined &&
    (node.props?.backgroundColor === hex || (node.children ?? []).some(child => walk(child)))

  return walk((await ui.find({ type: 'Box' })) as Node | undefined)
}

for (const surface of SURFACES) {
  test(`J1 at 120 columns the six columns share the row with width 0 and grow 1 (${surface})`, async ($, on) => {
    await start($, on, { state: TABLE('| E7 | `feat/seven` | rendu |') })
    const ui = await $.ui.mount(pane(surface, 120))

    for (const name of SIX) {
      expect((await ui.find({ key: `column:${name}` }))?.props).toMatchObject({
        width: 0,
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
      })
      expect(await ui.find({ key: `fold:${name}` })).toBeUndefined()
    }
    await ui.unmount()
  })

  test(`J1b the table starts at 89 columns, one less folds (${surface})`, async ($, on) => {
    await start($, on, { state: TABLE('| E7 | `feat/seven` | rendu |') })
    const wide = await $.ui.mount(pane(surface, 89))
    expect(await wide.find({ key: 'fold:merged' })).toBeUndefined()
    expect((await wide.find({ key: 'column:merged' }))?.props).toMatchObject({ width: 0 })
    await wide.unmount()

    const folded = await $.ui.mount(pane(surface, 88))
    expect(await folded.find({ key: 'fold:merged' })).toBeDefined()
    await folded.unmount()
  })

  test(`J2 at 80 columns the columns fold and a list counts them (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE('| E13 | `notes/E13.md` | conçue |'),
      notes: { 'E13.md': '# E13\n\n## Mesures\n\nthree things.\n' },
    })
    const ui = await $.ui.mount(pane(surface, 80))

    for (const name of SIX) {
      expect(await ui.find({ key: `fold:${name}` })).toBeDefined()
    }
    expect(await shows(ui, /Design 1/)).toBe(true)
    expect(await shows(ui, /^· 1$/)).toBe(true)
    await ui.unmount()
  })

  test(`J3 the title is the H1 without its id; no file or no id keeps the state cell (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE(
        '| E33j | `notes/E33j.md` | conçue |',
        '| E34 | `notes/E34.md` | état trente-quatre |',
        '| E35 | `notes/E35.md` | état trente-cinq |',
        '| E36 | `feat/36` | état trente-six |',
      ),
      notes: {
        'E33j.md': '# E33j — passe de fidélité\n\n## Mesures\n\nunits.\n',
        'E34.md': '# Autre titre sans identifiant\n\n## Mesures\n\nunits.\n',
        'E35.md': '## Mesures\n\nno H1 at all.\n',
      },
      trees: [{ branch: 'feat/36', id: 'm36' }],
    })
    const ui = await $.ui.mount(pane(surface, 120))

    const seen = {
      title: await shows(ui, /^passe de fidélité$/),
      lead: await shows(ui, /E33j —/),
      noId: await shows(ui, /^état trente-quatre$/),
      noH1: await shows(ui, /^état trente-cinq$/),
      noFile: await shows(ui, /^état trente-six$/),
    }
    expect(seen).toEqual({ title: true, lead: false, noId: true, noH1: true, noFile: true })
    await ui.unmount()
  })

  test(`J4 a column header is one level of truncated sibling Text (${surface})`, async ($, on) => {
    await start($, on, { state: TABLE('| E7 | `feat/seven` | rendu |') })
    const ui = await $.ui.mount(pane(surface, 120))

    expect(await shows(ui, /^To merge \(0\)$/)).toBe(false)
    expect((await ui.find({ type: 'Text', text: /^To merge$/ }))?.props).toMatchObject({ wrap: 'truncate' })
    expect((await ui.find({ type: 'Text', text: /^\(0\)$/ }))?.props).toMatchObject({
      wrap: 'truncate',
      dimColor: true,
    })
    expect((await ui.find({ type: 'Text', text: /^●$/ }))?.props).toMatchObject({ wrap: 'truncate' })
    await ui.unmount()
  })

  test(`J5 a Merged card has the merged bar for its edge, other cards do not (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE('| E12 | `feat/gone-branch` | mergé (`ccccccc`) : première mission |'),
      ancestors: ['ccccccc'],
    })
    const merged = await $.ui.mount(pane(surface, 120))
    expect(await merged.find({ key: 'open:E12' })).toBeDefined()
    expect(await hasFill(merged, MERGED_BAR)).toBe(true)
    await merged.unmount()
  })

  test(`J5b a card in another column does not carry the merged bar (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE('| E7 | `feat/seven` | rendu |'),
      trees: [{ branch: 'feat/seven', id: 'm1' }],
    })
    const other = await $.ui.mount(pane(surface, 120))
    expect(await other.find({ key: 'open:E7' })).toBeDefined()
    expect(await hasFill(other, MERGED_BAR)).toBe(false)
    await other.unmount()
  })

  test(`J7 Since the last report lists five merges, then the rest (${surface})`, async ($, on) => {
    const merged = Array.from({ length: 7 }, (_, index) => ({
      sha: `a00000${index + 1}`,
      subject: `change number ${index + 1}`,
      at: START - (7 - index) * 3_600_000,
    }))
    await start($, on, { state: TABLE('| E7 | `feat/seven` | rendu |'), merged })
    const ui = await $.ui.mount(pane(surface, 120))

    expect(await shows(ui, /Since the last report/)).toBe(true)
    // The newest five; the two oldest fall into the count.
    for (const index of [3, 4, 5, 6, 7]) {
      expect(await shows(ui, new RegExp(`^a00000${index}$`))).toBe(true)
    }
    for (const index of [1, 2]) {
      expect(await shows(ui, new RegExp(`^a00000${index}$`))).toBe(false)
    }
    expect(await shows(ui, /^\+2 more$/)).toBe(true)
    await ui.unmount()
  })

  test(`J7b without a report nothing is listed (${surface})`, async ($, on) => {
    await start($, on, { state: TABLE('| E7 | `feat/seven` | rendu |') })
    const ui = await $.ui.mount(pane(surface, 120))

    expect(await shows(ui, /Since the last report/)).toBe(false)
    await ui.unmount()
  })

  test(`J8 the keys stay, a note fold opens its sections (${surface})`, async ($, on) => {
    await start($, on, {
      state: TABLE(
        '| E40 | `notes/E40.md` | en cours (NOTES § 2) |',
        '| E12 | `feat/gone` | mergé (`ccccccc`) |',
        '| E30 | autre | rien |',
      ),
      notes: { 'E40.md': '# E40\n\n## Mesures\n\nunits.\n' },
      journal: '## 1. Start\n\nfirst.\n\n## 2. Plan\n\nThe plan reads like this.\n',
      ancestors: ['ccccccc'],
    })
    const wide = await $.ui.mount(pane(surface, 120))
    expect(await wide.find({ key: 'open:E40' })).toBeDefined()
    expect(await wide.find({ key: 'open:E12' })).toBeDefined()
    expect(await wide.find({ key: 'fold:other' })).toBeDefined()
    expect(await wide.find({ key: 'fold:notes:E40' })).toBeDefined()
    expect(await shows(wide, /^The plan reads like this\.$/)).toBe(true)
    await wide.unmount()

    const narrow = await $.ui.mount(pane(surface, 60))
    expect(await narrow.find({ key: 'fold:merged' })).toBeDefined()
    expect(await narrow.find({ key: 'fold:other' })).toBeDefined()
    await narrow.press({ key: 'fold:notes:E40' })
    await settle()
    expect(await shows(narrow, /E40 · § 2 Plan/)).toBe(true)
    await narrow.unmount()
  })
}

