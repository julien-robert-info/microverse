import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type {
  Activity,
  BoardActions,
  Heavy,
  Light,
  View,
} from '../../types/board'
import { renderCockpit } from './cockpit'
import { isDue, readQuota, sendQuota } from './quota'
import { hasProfile, readHeavy, readLight } from './sensors'

// The engine lists what a module reads and writes from the atoms declared in
// this file, with literal references. The shape tag changes with the shape of
// what the atom holds: a reload declines what an earlier version stored.
const lightAtom = atom({ plugin: 'microverse', key: 'light' } as const, null, {
  shape: 'light-1',
})
const heavyAtom = atom({ plugin: 'microverse', key: 'heavy' } as const, null, {
  shape: 'heavy-1',
})
const viewAtom = atom(
  { plugin: 'microverse', key: 'view' } as const,
  { tab: 'cockpit', detail: null, toggled: [] } as View,
  { shape: 'view-1' },
)
// Agent-check results, the last quota reading sent, the answer in progress and
// the per-agent activity. The shape tag keeps a reload from reading an older
// shape.
const checksAtom = atom({ plugin: 'microverse', key: 'checks' } as const, {}, {
  shape: 'checks-1',
})
const quotaSentAtom = atom({ plugin: 'microverse', key: 'quotaSent' } as const, null, {
  shape: 'quotaSent-1',
})
const answerAtom = atom(
  { plugin: 'microverse', key: 'answer' } as const,
  { pending: null, sent: [] },
  { shape: 'answer-1' },
)
const activityAtom = atom({ plugin: 'microverse', key: 'activity' } as const, {}, {
  shape: 'activity-1',
})
void [checksAtom, answerAtom, activityAtom]

const PANE = 'microverse-board'
const LIGHT_MS = 30_000
const HEAVY_EVERY_MS = 120_000

// What one load of the module keeps between hooks. It lives in `register`'s
// closure, not at module level: two sessions never share a timer or a lock.
// The helpers below sit at the top of the file because the engine follows `$`
// only through functions declared there.
type Run = {
  cancel: (() => void) | undefined
  isHeavyRunning: boolean
  isLightRunning: boolean
  lastHeavyAt: number | undefined
  // The last `bodyColumns` logged.
  columns: number | undefined
}

const reasonOf = (error: unknown) =>
  String(error).replace(/\s+/g, ' ').slice(0, 80)

// No hook of the board throws into the engine: a failure is a debug line.
const guarded = async ($: EngineInterface, what: string, body: () => Promise<void>) => {
  try {
    await body()
  } catch (error) {
    $.ui.log(`board: ${what} failed: ${reasonOf(error)}`, { to: 'debug' })
  }
}

// Rule C1: from the main loop's end of turn only, with or without a profile.
// A failed write is one line at the foot of the pane and is tried again at the
// next turn, since `quotaSent` moves only on success.
const recordQuota = async ($: EngineInterface) => {
  const reading = await readQuota($)
  if (reading === null) {
    return
  }
  const now = await $.clock.now()
  if (!isDue(await read($, quotaSentAtom), reading.sent, now)) {
    return
  }
  try {
    await sendQuota($, reading.payload)
  } catch (error) {
    const line = `quota: ${reasonOf(error)}`
    $.ui.log(`board: ${line}`, { to: 'debug' })
    await update($, lightAtom, (light: Light | null) =>
      light === null
        ? light
        : { ...light, failures: [...light.failures.filter(item => !item.startsWith('quota: ')), line] },
    )

    return
  }
  await update($, quotaSentAtom, () => ({ at: now, ...reading.sent }))
}

const stop = (run: Run) => {
  run.cancel?.()
  run.cancel = undefined
}

const isPaneOpen = async ($: EngineInterface) =>
  (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE)

const refreshLight = async ($: EngineInterface, run: Run, root: string) => {
  if (run.isLightRunning) {
    return
  }
  run.isLightRunning = true
  try {
    const previous = await read($, lightAtom)
    const next: Light = await readLight($, root, previous)
    await update($, lightAtom, () => next)
  } finally {
    run.isLightRunning = false
  }
}

// At most once per HEAVY_EVERY_MS unless `force`, and never two at a time.
const refreshHeavy = async (
  $: EngineInterface,
  run: Run,
  options: PluginOptions,
  root: string,
  force: boolean,
) => {
  // The lock is taken before the first await: a second caller arriving while
  // this one waits for the clock must find it held.
  if (run.isHeavyRunning) {
    return
  }
  run.isHeavyRunning = true
  try {
    const now = await $.clock.now()
    if (!force && run.lastHeavyAt !== undefined && now - run.lastHeavyAt < HEAVY_EVERY_MS) {
      return
    }
    run.lastHeavyAt = now
    const previous = await read($, heavyAtom)
    const next: Heavy = await readHeavy($, root, options, previous)
    await update($, heavyAtom, () => next)
  } finally {
    run.isHeavyRunning = false
  }
}

// The gate of rule A4: with no profile nothing is started, and a profile that
// disappears stops the timer.
const ensure = async ($: EngineInterface, run: Run): Promise<string | undefined> => {
  const root = await $.session.root()
  if (!(await hasProfile($, root))) {
    stop(run)

    return undefined
  }
  if (run.cancel === undefined) {
    await $.command.register({
      name: 'board',
      description: 'Open the orchestration board',
      immediate: true,
    })
    run.cancel = $.clock.every(LIGHT_MS, () => {
      void guarded($, 'refresh', async () => {
        const current = await ensure($, run)
        if (current !== undefined && (await isPaneOpen($))) {
          await refreshLight($, run, current)
        }
      })
    })
  }

  return root
}

export const register: Register = (on, options) => {
  const run: Run = {
    cancel: undefined,
    isHeavyRunning: false,
    isLightRunning: false,
    lastHeavyAt: undefined,
    columns: undefined,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await guarded($, 'start', async () => {
      const root = await ensure($, run)
      if (root === undefined) {
        return
      }
      // On a terminal an unasked pane opens inline in the transcript: only
      // /board opens it there, and the light sensors read only for an open pane.
      if ((await $.session.surfaces()).includes('desktop')) {
        await refreshLight($, run, root)
        await $.ui.open({ id: PANE, title: 'Board' })
      }
    })

    return started
  })

  on('command.run', { command: 'board' }, async $ => {
    let opened = false
    await guarded($, 'command', async () => {
      const root = await ensure($, run)
      if (root === undefined) {
        return
      }
      await $.ui.open({ id: PANE, title: 'Board' })
      await refreshLight($, run, root)
      opened = true
    })

    return { text: opened ? 'Board opened.' : 'No orchestration profile in this project.' }
  })

  // Opening the pane, by /board, at start or by the person, reads the heavy
  // sensor once (throttled).
  on('ui.open', { id: PANE }, async ($, e, next) => {
    const opened = await next(e)
    void guarded($, 'open', async () => {
      const root = await ensure($, run)
      if (root !== undefined) {
        await refreshHeavy($, run, options, root, false)
      }
    })

    return opened
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A subagent's end carries agentId: it is not a turn of the orchestrator.
    if (e.agentId === undefined) {
      void guarded($, 'quota', () => recordQuota($))
      void guarded($, 'turn', async () => {
        const root = await ensure($, run)
        if (root !== undefined) {
          await refreshHeavy($, run, options, root, false)
        }
      })
    }

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const [light, heavy, view, checks, answer, activity] = [
      await read($, lightAtom),
      await read($, heavyAtom),
      await read($, viewAtom),
      await read($, checksAtom),
      await read($, answerAtom),
      await read($, activityAtom),
    ]
    const actions: BoardActions = {
      refresh: () =>
        guarded($, 'refresh', async () => {
          const root = await ensure($, run)
          if (root !== undefined) {
            await Promise.all([
              refreshLight($, run, root),
              refreshHeavy($, run, options, root, true),
            ])
          }
        }),
      setTab: tab => update($, viewAtom, (current: View) => ({ ...current, tab })),
      closeDetail: () => update($, viewAtom, (current: View) => ({ ...current, detail: null })),
      openDetail: (kind, id) =>
        update($, viewAtom, (current: View) => ({ ...current, detail: { kind, id } })),
      toggle: key =>
        update($, viewAtom, (current: View) => ({
          ...current,
          toggled: current.toggled.includes(key)
            ? current.toggled.filter(item => item !== key)
            : [...current.toggled, key],
        })),
    }
    // Logged when the width changes, not at every redraw.
    if (run.columns !== e.props.bodyColumns) {
      run.columns = e.props.bodyColumns
      $.ui.log(`board: bodyColumns ${e.props.bodyColumns}`, { to: 'debug' })
    }

    return renderCockpit({
      ui,
      board: { light, heavy, view, checks, answer, activity: activity as Record<string, Activity> },
      columns: e.props.bodyColumns,
      actions,
    })
  })
}
