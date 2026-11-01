import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Kit = Parameters<TestBody>

const ROOT = '/work/demo'
const START = 1_767_000_000_000
const FIVE_MS = 5 * 60_000
const PANE = {
  plugin: 'microverse',
  component: 'Pane',
  requestId: 'microverse-board',
  surface: 'desktop',
  props: {
    title: 'Board',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

const FIVE: Limit = { kind: 'five_hour', percentUsed: 78, resetsAt: '2026-01-01T22:40:00Z' }
const WEEK: Limit = { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-01-04T09:00:00Z' }
const SPEND: Limit = { kind: 'spend_limit', percentUsed: 12, resetsAt: '2026-02-01T00:00:00Z' }

const run = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const done = (agentId?: string) => ({
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  ...(agentId === undefined ? {} : { agentId }),
})

type Sent = { argv: string[]; stdin: string | undefined }

// A session whose counters are `limits.current`, with the recorder's writes
// collected in `sent` and every other process in `others`.
const world = (
  on: Kit[1],
  options: {
    profile?: boolean
    sessionId?: string
    fail?: boolean
    limits?: Limit[]
  } = {},
) => {
  const { profile = false, sessionId = 'sess-1', fail = false } = options
  const state = { limits: options.limits ?? [FIVE, WEEK] }
  const sent: Sent[] = []
  const others: string[][] = []

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.root', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.id', () => ({ value: sessionId }))
  on('fs.exists', (_, e) => ({ value: profile || !e.path.endsWith('profile.json') }))
  on('fs.read', () => ({ value: '' }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, percent: 42 },
      rateLimits: state.limits,
    },
  }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    if (e.argv[1]?.endsWith('scripts/statusline.js') === true) {
      sent.push({ argv: [...e.argv], stdin: e.init?.stdin })
      if (fail) {
        return run('', 3)
      }

      return run('')
    }
    others.push([...e.argv])
    if (e.argv[0] === 'git') {
      return run([`worktree ${ROOT}`, 'HEAD 1111111aaaa', 'branch refs/heads/main', ''].join('\n'))
    }

    return run('not json')
  })

  return { sent, others, state, clock: mock.clock(on, { now: START }) }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

const payloadOf = (sent: Sent) => JSON.parse(sent.stdin ?? '{}')

test('T1 a main turn sends both windows to statusline.js, resets in seconds', async ($, on) => {
  const { sent } = world(on)
  await $.turn.complete(done())
  await settle()

  expect(sent).toHaveLength(1)
  expect(sent[0]?.argv[0]).toBe('node')
  expect(sent[0]?.argv[1]).toMatch(/scripts\/statusline\.js$/)
  expect(payloadOf(sent[0]!)).toEqual({
    session_id: 'sess-1',
    rate_limits: {
      five_hour: { used_percentage: 78, resets_at: Date.parse('2026-01-01T22:40:00Z') / 1000 },
      seven_day: { used_percentage: 41, resets_at: Date.parse('2026-01-04T09:00:00Z') / 1000 },
    },
  })
})

test('T2 a subagent turn sends nothing', async ($, on) => {
  const { sent } = world(on)
  await $.turn.complete(done('a1'))
  await settle()

  expect(sent).toHaveLength(0)
})

test('T3 equal values wait five minutes, a changed value goes at once', async ($, on) => {
  const { sent, state, clock } = world(on)
  await $.turn.complete(done())
  await settle()
  await clock.advance(60_000)
  await $.turn.complete(done())
  await settle()
  expect(sent).toHaveLength(1)

  state.limits = [{ ...FIVE, percentUsed: 80 }, WEEK]
  await $.turn.complete(done())
  await settle()
  expect(sent).toHaveLength(2)

  // Only the reset moves: the window changed, so it goes out.
  state.limits = [{ ...FIVE, percentUsed: 80, resetsAt: '2026-01-02T03:40:00Z' }, WEEK]
  await $.turn.complete(done())
  await settle()
  expect(sent).toHaveLength(3)

  await clock.advance(FIVE_MS - 1000)
  await $.turn.complete(done())
  await settle()
  expect(sent).toHaveLength(3)

  await clock.advance(1000)
  await $.turn.complete(done())
  await settle()
  expect(sent).toHaveLength(4)
})

test('T4 spend_limit alone sends nothing, beside five_hour only five_hour goes', async ($, on) => {
  const { sent, state } = world(on, { limits: [SPEND] })
  await $.turn.complete(done())
  await settle()
  expect(sent).toHaveLength(0)

  state.limits = [SPEND, FIVE]
  await $.turn.complete(done())
  await settle()
  expect(sent).toHaveLength(1)
  expect(Object.keys(payloadOf(sent[0]!).rate_limits)).toEqual(['five_hour'])
})

test('T5 a window without resetsAt is left out', async ($, on) => {
  const { sent } = world(on, { limits: [FIVE, { kind: 'seven_day', percentUsed: 41 }] })
  await $.turn.complete(done())
  await settle()

  expect(sent).toHaveLength(1)
  expect(Object.keys(payloadOf(sent[0]!).rate_limits)).toEqual(['five_hour'])
})

test('T6 an invalid session id sends nothing', async ($, on) => {
  const { sent } = world(on, { sessionId: '../escape' })
  await $.turn.complete(done())
  await settle()

  expect(sent).toHaveLength(0)
})

test('T7 without a profile the reading goes and nothing else runs', async ($, on) => {
  const { sent, others } = world(on, { profile: false })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.turn.complete(done())
  await settle()

  expect(sent).toHaveLength(1)
  expect(others).toHaveLength(0)
})

test('T8 a failing write is one failures line and the turn ends', async ($, on) => {
  const { sent, clock } = world(on, { profile: true, fail: true })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await clock.settle()
  const turn = await $.turn.complete(done())
  await settle()

  expect(turn.text).toBe('')
  expect(sent).toHaveLength(1)

  // The failure is retried at the next turn, not recorded as sent, and the
  // line is not stacked.
  await $.turn.complete(done())
  await settle()
  expect(sent).toHaveLength(2)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^! quota: Error: exit 3$/ })).toBeDefined()
  await ui.unmount()
})
