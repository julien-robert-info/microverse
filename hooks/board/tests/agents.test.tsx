import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { parseBrief, safeBranch } from '../brief'

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

type Use = { tool: string; input: Record<string, unknown>; text?: string }
type Message = { role: 'user' | 'assistant'; text: string; toolUses: Use[] }
type Roster = { id: string; type: string; description: string }

type Scene = {
  agents?: Roster[]
  // Worktrees of agents: id -> branch.
  trees?: Record<string, string>
  store?: Record<string, unknown>
  // agentId -> transcript; 'refused' makes the call throw.
  messages?: Record<string, Message[] | 'refused'>
  // Makes `store.set` fail.
  isStoreBroken?: boolean
  // The answer of agent-check.
  check?: { stdout: string; exitCode?: number }
  // agent-check waits for this to be released.
  hold?: Promise<void>
}

const porcelain = (trees: Record<string, string>) =>
  [
    `worktree ${ROOT}\nHEAD 1111111aaaa\nbranch refs/heads/main\n`,
    ...Object.entries(trees).map(
      ([id, branch]) =>
        `worktree ${ROOT}/.claude/worktrees/agent-${id}\nHEAD 2222222bbbb\nbranch refs/heads/${branch}\n`,
    ),
  ].join('\n')

const status = (scene: Scene) =>
  JSON.stringify({
    v: 1,
    project: ROOT,
    base: { name: 'main', tip: '1111111' },
    lastReport: null,
    state: { exists: true, sections: [] },
    worktrees: [],
    free: [],
    report: null,
    agents: {
      since: START,
      runs: (scene.agents ?? []).map(one => ({
        agentId: one.id,
        type: one.type,
        model: 'claude-sonnet-5',
        description: one.description,
        started: START - 600_000,
        ended: START,
        cost: 1.5,
        requests: 1,
        tokens: { input: 12_000, write5m: 0, write1h: 0, read: 34_000, output: 5_000 },
        advisor: { calls: 0, cost: 0 },
        finished: false,
      })),
      total: { cost: 1.5, advisor: { calls: 0, cost: 0 } },
    },
    quota: { error: 'none' },
    context: { error: 'none' },
  })

const GREEN = JSON.stringify({
  v: 1,
  branch: 'feat/seven',
  base: 'main',
  verdict: 'needs-fixes',
  commits: 2,
  checks: [
    { name: 'tests', state: 'ok', detail: '58 passed', lines: [] },
    { name: 'lint', state: 'fail', detail: '2 errors', lines: ['a.ts:1'] },
    { name: 'secrets', state: 'skip', detail: 'no scanner', lines: [] },
  ],
})

const PASSING = JSON.stringify({
  v: 1,
  branch: 'feat/seven',
  base: 'main',
  verdict: 'green',
  commits: 1,
  checks: [{ name: 'tests', state: 'ok', detail: '', lines: [] }],
})

// The world under the board for a scene. `spawned` is what reached the engine
// under the mod's hook, `store` the mod's store, `argvs` every process run.
const world = (on: Kit[1], scene: Scene) => {
  const store = new Map<string, unknown>(Object.entries(scene.store ?? {}))
  const spawned: { prompt: string; description: string; resume?: string }[] = []
  const argvs: string[][] = []
  let n = 0

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.root', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('profile.json') }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 0, mtimeMs: 7, isLink: false } }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => ({ value: '' }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: 1 }, rateLimits: [] },
  }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', async (_, e) => {
    if (scene.isStoreBroken === true) {
      throw new Error('disk full')
    }
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('agent.spawn', (_, e) => {
    spawned.push({ prompt: e.prompt, description: e.description, resume: e.resume })
    n += 1

    return { model: 'claude-sonnet-5', agentId: `n${n}` }
  })
  on('agent.list', () => ({
    value: (scene.agents ?? []).map(agent => ({ ...agent, status: 'running' })),
  }))
  on('session.messages', (_, e) => {
    const found = scene.messages?.[e.agentId ?? '']
    if (found === 'refused') {
      throw new Error('refused')
    }

    return { value: found ?? [] }
  })
  on('process.run', async (_, e) => {
    argvs.push(e.argv)
    if (e.argv[0] === 'git' && e.argv[1] === 'worktree') {
      return run(porcelain(scene.trees ?? {}))
    }
    if (e.argv[0] === 'git' && e.argv[1] === 'rev-list') {
      return run('2\n')
    }
    if (e.argv[0] === 'git' && e.argv[1] === 'diff') {
      return run('10\t2\thooks/a.ts\n')
    }
    if (e.argv[0] === 'git' && e.argv[1] === 'status') {
      return run(' M hooks/a.ts\n')
    }
    if (e.argv[1]?.endsWith('agent-check') === true) {
      await scene.hold
      const answer = scene.check ?? { stdout: GREEN }

      return run(answer.stdout, answer.exitCode ?? 1)
    }
    if (e.argv[1]?.endsWith('statusline.js') === true) {
      return run('')
    }

    return run(status(scene))
  })
  mock.clock(on, { now: START })

  return { store, spawned, argvs }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 40))

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

const TEMPLATE = [
  '**Branche** : `feat/seven`',
  '',
  '1. **Objectif** : build the agents section.',
  '2. **Zone** : `hooks/board/` only.',
  '3. **Règles décidées**',
  '- R1 capture without blocking',
  '- R2 summary of the brief',
  '- R3 activity every 30 s',
  '4. **Pièges**',
  '- never respond without next',
  '- brief text is never an argv',
  '5. **Tests attendus**',
  '- T1 capture',
  '- T2 raw',
  '- T3 prune',
  '- T4 resume',
  '6. **Vérification** : run the checks.',
].join('\n')

const RAW = Array.from({ length: 60 }, (_, index) => `line ${index + 1} of a free text`).join('\n')

const OPEN = (surface: 'terminal' | 'desktop') => pane(surface, WIDE)

const MORTY = { id: 'a1', type: 'microverse:morty', description: 'E7 build it' }

for (const surface of SURFACES) {
  test(`T1 a template brief is stored, next gets the same input, the summary shows it (${surface})`, async ($, on) => {
    const seen = await start($, on, { agents: [{ ...MORTY, id: 'n1' }], trees: { n1: 'feat/seven' } })

    const out = await $.agent.spawn({
      prompt: TEMPLATE,
      description: 'E7 build it',
      subagentType: 'microverse:morty',
    })
    await settle()

    expect(out.agentId).toBe('n1')
    expect(seen.spawned).toHaveLength(1)
    expect(seen.spawned[0].prompt).toBe(TEMPLATE)
    expect(seen.spawned[0].description).toBe('E7 build it')
    const stored = seen.store.get('brief:n1') as Record<string, unknown>
    expect(stored.text).toBe(TEMPLATE)
    expect(stored.mission).toBe('E7')
    expect(stored.branch).toBe('feat/seven')
    expect(stored.model).toBe('claude-sonnet-5')

    const ui = await $.ui.mount(OPEN(surface))
    await ui.press({ key: 'agent:open:n1' })
    await settle()

    expect(await shows(ui, /Goal/)).toBe(true)
    expect(await shows(ui, /Rules · 3/)).toBe(true)
    expect(await shows(ui, /Traps · 2/)).toBe(true)
    expect(await shows(ui, /Tests · 4/)).toBe(true)
    expect(await shows(ui, /Verify/)).toBe(true)
    await ui.unmount()
  })

  test(`T2 a brief without the template is shown as written, 40 lines (${surface})`, async ($, on) => {
    const seen = await start($, on, {
      agents: [{ id: 'n1', type: 'microverse:rick', description: 'E7 design' }],
    })

    await $.agent.spawn({ prompt: RAW, description: 'E7 design', subagentType: 'microverse:rick' })
    await settle()
    expect((seen.store.get('brief:n1') as { text: string }).text).toBe(RAW)

    const ui = await $.ui.mount(OPEN(surface))
    await ui.press({ key: 'agent:open:n1' })
    await settle()

    expect(await shows(ui, /^line 40 of a free text$/)).toBe(true)
    expect(await shows(ui, /^line 41 of a free text$/)).toBe(false)
    expect(await shows(ui, /Rules ·/)).toBe(false)
    await ui.unmount()
  })

  test(`T6 Read, Edit then the checks command: Checks step, last tool, 3 calls (${surface})`, async ($, on) => {
    await start($, on, {
      agents: [MORTY],
      messages: {
        a1: [
          { role: 'user', text: 'brief', toolUses: [] },
          {
            role: 'assistant',
            text: '',
            toolUses: [
              { tool: 'Read', input: { file_path: 'hooks/a.ts' }, text: 'ok' },
              { tool: 'Edit', input: { file_path: 'hooks/a.ts' }, text: 'ok' },
              { tool: 'Bash', input: { command: 'orch-trust --commands checks' }, text: 'ok' },
            ],
          },
        ],
      },
    })
    const ui = await $.ui.mount(OPEN(surface))

    expect(await shows(ui, /✓ Setup {2}✓ Implement {2}● Checks {2}○ Report/)).toBe(true)
    expect(await shows(ui, /orch-trust --commands checks/)).toBe(true)
    expect(await shows(ui, /3 calls/)).toBe(true)
    await ui.unmount()
  })

  test(`T6b a rick has no steps, only its last tool (${surface})`, async ($, on) => {
    await start($, on, {
      agents: [{ id: 'a2', type: 'microverse:rick', description: 'E7 design' }],
      messages: {
        a2: [
          {
            role: 'assistant',
            text: '',
            toolUses: [{ tool: 'Grep', input: { pattern: 'needle' }, text: 'ok' }],
          },
        ],
      },
    })
    const ui = await $.ui.mount(OPEN(surface))

    expect(await shows(ui, /needle/)).toBe(true)
    expect(await shows(ui, /Setup/)).toBe(false)
    await ui.unmount()
  })

  test(`T7 a refused transcript reads "activity unavailable" (${surface})`, async ($, on) => {
    await start($, on, { agents: [MORTY], messages: { a1: 'refused' } })
    const ui = await $.ui.mount(OPEN(surface))

    expect(await shows(ui, /activity unavailable/)).toBe(true)
    expect(await shows(ui, /\d+ calls/)).toBe(false)
    await ui.unmount()
  })

  test(`T8 agent-check runs with --json, never --merged, shows a failing control, one run at a time (${surface})`, async ($, on) => {
    let release: () => void = () => undefined
    const hold = new Promise<void>(resolve => {
      release = resolve
    })
    const seen = await start($, on, {
      agents: [MORTY, { id: 'a2', type: 'microverse:morty', description: 'E8 other' }],
      trees: { a1: 'feat/seven', a2: 'feat/eight' },
      hold,
    })
    const ui = await $.ui.mount(OPEN(surface))
    await ui.press({ key: 'agent:open:a1' })
    await settle()

    // Two clicks in the same instant: one run. The press waits for its
    // handler, which waits for the held check: it is not awaited here.
    const clicks = [
      ui.press({ key: 'check:run:feat/seven' }),
      ui.press({ key: 'check:run:feat/seven' }).catch(() => undefined),
    ]
    await settle()
    const checks = () => seen.argvs.filter(argv => argv[1]?.endsWith('agent-check') === true)

    expect(checks()).toHaveLength(1)
    expect(checks()[0].slice(2)).toEqual(['feat/seven', '--json'])
    expect(checks()[0]).not.toContain('--merged')
    expect(await shows(ui, /Running agent-check/)).toBe(true)
    expect(await ui.find({ key: 'check:run:feat/seven' })).toBeUndefined()

    // Another branch is not blocked by the first.
    await ui.press({ key: 'agent:open:a2' })
    await settle()
    clicks.push(ui.press({ key: 'check:run:feat/eight' }))
    await settle()
    expect(checks()).toHaveLength(2)

    release()
    await Promise.all(clicks)
    await settle()
    await ui.press({ key: 'agent:open:a1' })
    await settle()
    expect(await shows(ui, /^Fail$/)).toBe(true)
    expect(await shows(ui, /^Pass$/)).toBe(true)
    expect(await shows(ui, /^Skip$/)).toBe(true)
    expect(await shows(ui, /1 check failing/)).toBe(true)
    expect(await ui.find({ key: 'check:run:feat/seven' })).toBeDefined()
    await ui.unmount()
  })

  test(`T8b a green run is "checks passed" on the card (${surface})`, async ($, on) => {
    await start($, on, {
      agents: [MORTY],
      trees: { a1: 'feat/seven' },
      check: { stdout: PASSING, exitCode: 0 },
    })
    const ui = await $.ui.mount(OPEN(surface))
    await ui.press({ key: 'agent:open:a1' })
    await settle()
    await ui.press({ key: 'check:run:feat/seven' })
    await settle()

    expect(await shows(ui, /checks passed \d\d:\d\d/)).toBe(true)
    await ui.unmount()
  })

  const REFUSALS: [string, { stdout: string; exitCode: number }, RegExp][] = [
    [
      'an unapproved profile (exit 2)',
      { stdout: JSON.stringify({ v: 1, branch: 'feat/seven', error: 'profile not approved' }), exitCode: 2 },
      /Not run: profile not approved/,
    ],
    [
      'a v other than 1',
      { stdout: JSON.stringify({ v: 2, branch: 'feat/seven', verdict: 'green', checks: [] }), exitCode: 0 },
      /Not run: unreadable output/,
    ],
  ]
  for (const [name, check, expected] of REFUSALS) {
    test(`T8c ${name} is an error, not a verdict (${surface})`, async ($, on) => {
      await start($, on, { agents: [MORTY], trees: { a1: 'feat/seven' }, check })
      const ui = await $.ui.mount(OPEN(surface))
      await ui.press({ key: 'agent:open:a1' })
      await settle()
      await ui.press({ key: 'check:run:feat/seven' })
      await settle()

      expect(await shows(ui, expected)).toBe(true)
      expect(await shows(ui, /checks passed/)).toBe(false)
      await ui.unmount()
    })
  }

  test(`T9 a branch "../x" is refused and nothing runs (${surface})`, async ($, on) => {
    const seen = await start($, on, { agents: [{ ...MORTY, id: 'n1' }] })
    await $.agent.spawn({
      prompt: '**Branche** : `../x`\n\n**Objectif** : go',
      description: 'E7 build it',
      subagentType: 'microverse:morty',
    })
    await settle()
    const ui = await $.ui.mount(OPEN(surface))
    await ui.press({ key: 'agent:open:n1' })
    await settle()
    await ui.press({ key: 'check:run:../x' })
    await settle()

    expect(seen.argvs.filter(argv => argv[1]?.endsWith('agent-check') === true)).toHaveLength(0)
    expect(await shows(ui, /Not run: invalid branch name/)).toBe(true)
    await ui.unmount()
  })

  test(`a check left running by an earlier load reads "interrupted" after a new start (${surface})`, async ($, on) => {
    let release: () => void = () => undefined
    const hold = new Promise<void>(resolve => {
      release = resolve
    })
    await start($, on, { agents: [MORTY], trees: { a1: 'feat/seven' }, hold })
    const ui = await $.ui.mount(OPEN(surface))
    await ui.press({ key: 'agent:open:a1' })
    await settle()
    const click = ui.press({ key: 'check:run:feat/seven' })
    await settle()
    expect(await shows(ui, /Running agent-check/)).toBe(true)

    await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
    await settle()

    expect(await shows(ui, /Not run: interrupted/)).toBe(true)
    release()
    await click
    await ui.unmount()
  })
}

test('T3 the 41st brief deletes the oldest, whatever the order the store lists', async ($, on) => {
  const old: Record<string, unknown> = {}
  // Listed newest first: the oldest is the last key.
  for (let at = 40; at >= 1; at -= 1) {
    old[`brief:old${at}`] = { at, type: 't', model: 'm', description: 'd', branch: null, mission: null, text: 'x' }
  }
  const seen = await start($, on, { store: old })

  await $.agent.spawn({ prompt: 'new', description: 'd', subagentType: 'microverse:morty' })
  await settle()

  const keys = [...seen.store.keys()]
  expect(keys).toHaveLength(40)
  expect(keys).not.toContain('brief:old1')
  expect(keys).toContain('brief:old2')
  expect(keys).toContain('brief:n1')
})

test('T4 a resumed agent stores nothing', async ($, on) => {
  const seen = await start($, on, {})

  await $.agent.spawn({
    prompt: 'again',
    description: 'E7 build it',
    subagentType: 'microverse:morty',
    resume: 'a9',
  } as never)
  await settle()

  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0].resume).toBe('a9')
  expect([...seen.store.keys()]).toHaveLength(0)
})

test('T5 a failing store.set does not stop the launch', async ($, on) => {
  const seen = await start($, on, { isStoreBroken: true })

  // No description: the capture itself throws, besides the store failing.
  const out = await $.agent.spawn({ prompt: 'go', subagentType: 'microverse:morty' })
  await settle()

  expect(out.agentId).toBe('n1')
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0].prompt).toBe('go')
  // The failure took effect: nothing was stored.
  expect(seen.store.size).toBe(0)
})

test('the brief of an agent launched before the mod loaded is its first message', async ($, on) => {
  await start($, on, {
    agents: [MORTY],
    messages: { a1: [{ role: 'user', text: TEMPLATE, toolUses: [] }] },
  })
  const ui = await $.ui.mount(OPEN('desktop'))
  await ui.press({ key: 'agent:open:a1' })
  await settle()

  expect(await shows(ui, /Rules · 3/)).toBe(true)
  await ui.unmount()
})

test('parser: French and English labels, numbered or not, with a suffix before the colon', () => {
  const french = parseBrief(TEMPLATE)
  expect(french.isTemplate).toBe(true)
  expect(french.goal).toBe('build the agents section.')
  expect(french.rules).toHaveLength(3)
  expect(french.traps).toEqual(['never respond without next', 'brief text is never an argv'])
  expect(french.tests).toHaveLength(4)
  expect(french.verify).toBe('run the checks.')
  expect(french.branch).toBe('feat/seven')

  const english = parseBrief(
    ['**Goal** (short): ship it', '**Zone**: `a/`', '**Decided rules**', 'R1 one', '**Expected tests**', 'T1 one'].join('\n'),
  )
  expect(english.isTemplate).toBe(true)
  expect(english.goal).toBe('(short): ship it')
  expect(english.rules).toEqual(['R1 one'])
  expect(english.tests).toEqual(['T1 one'])

  // Two of the four signature labels are not a template.
  expect(parseBrief('**Goal**: x\n**Zone**: y').isTemplate).toBe(false)
  // A word that only starts like a label is not one.
  expect(parseBrief('**Butter**: x\n**Zones**: y\n**Rulesx**: z').isTemplate).toBe(false)
  expect(parseBrief(RAW).raw).toHaveLength(40)
})

test('safeBranch refuses "..", a leading dash and anything off the set', () => {
  expect(safeBranch('feat/seven')).toBe(true)
  expect(safeBranch('../x')).toBe(false)
  expect(safeBranch('a/../b')).toBe(false)
  expect(safeBranch('--merged')).toBe(false)
  expect(safeBranch('a b')).toBe(false)
  expect(safeBranch('a;rm')).toBe(false)
})
