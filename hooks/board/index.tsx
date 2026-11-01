import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type {
  Activity,
  BoardActions,
  CheckResult,
  Heavy,
  Light,
  View,
} from '../../types/board'
import { safeBranch } from './brief'
import { renderCockpit } from './cockpit'
import { readFacts, readMissions } from './notes'
import {
  captureBrief,
  readActivity,
  readAhead,
  readBranch,
  readBrief,
  runAgentCheck,
  runningAgents,
  worktreeOf,
} from './observe'
import { isDue, readQuota, sendQuota } from './quota'
import { hasProfile, readHeavy, readLight, samePath } from './sensors'

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
    const sensed: Light = await readLight($, root, previous)
    const next: Light = {
      ...sensed,
      missions: await readMissions(
        $,
        root,
        previous !== null && samePath(previous.root, root) ? previous.missions : undefined,
        (sensed.agents?.value ?? []).map(agent => agent.id),
        sensed.failures,
      ),
    }
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
    const sensed: Heavy = await readHeavy($, root, options, previous)
    const status = sensed.status?.value
    const light = await read($, lightAtom)
    // The rows come from the light reading; a heavy one that races ahead of the
    // first light reading reads them itself.
    const rows =
      light?.missions?.rows ?? (await readMissions($, root, undefined, [], [])).rows
    const runs = status?.report?.agents ?? status?.agents ?? undefined
    const next: Heavy = {
      ...sensed,
      missions:
        status === undefined
          ? previous?.missions
          : await readFacts(
              $,
              root,
              status.base.name,
              rows,
              runs !== undefined && 'runs' in runs ? runs.runs.map(run => run.agentId) : [],
              previous?.missions,
            ),
    }
    await update($, heavyAtom, () => next)
  } finally {
    run.isHeavyRunning = false
  }
}

// E33g: agents. What this load keeps for them: its own timer (the roster is
// read at the light rhythm, only for an open pane) and the branches an
// agent-check is running on, one lock per branch.
type Watch = {
  cancel: (() => void) | undefined
  isRunning: boolean
  checking: Set<string>
}

const ACTIVITY_KEPT = 40

const refreshAgents = async ($: EngineInterface, watch: Watch) => {
  if (watch.isRunning) {
    return
  }
  watch.isRunning = true
  try {
    const light = await read($, lightAtom)
    if (light === null) {
      return
    }
    const heavy = await read($, heavyAtom)
    // Null until the heavy reading has run: "ahead" then says nothing.
    const base = heavy?.status?.value.base.name
    const trees = light.worktrees?.value ?? []
    const previous = (await read($, activityAtom)) as Record<string, Activity>
    const seen = new Map((light.agents?.value ?? []).map(agent => [agent.id, agent.firstSeenAt]))
    const next: Record<string, Activity> = {}
    for (const agent of await runningAgents($)) {
      const before = previous[agent.id]
      const startedAt = before?.startedAt ?? seen.get(agent.id) ?? (await $.clock.now())
      const activity = await readActivity($, agent, startedAt, before)
      next[agent.id] = {
        ...activity,
        ahead: await readAhead($, worktreeOf(light.project, agent.id, trees).path, base),
        brief: before?.brief,
        branch: before?.branch,
      }
    }
    await update($, activityAtom, (current: Record<string, Activity>) => {
      const merged = { ...current, ...next }
      const recent = Object.keys(merged)
        .sort((one, other) => merged[other].updatedAt - merged[one].updatedAt)
        .slice(0, ACTIVITY_KEPT)

      return Object.fromEntries(recent.map(id => [id, merged[id]]))
    })
  } finally {
    watch.isRunning = false
  }
}

const agentActions = (
  $: EngineInterface,
  watch: Watch,
): Pick<BoardActions, 'openAgent' | 'runCheck'> => ({
  openAgent: id =>
    guarded($, 'agent', async () => {
      await update($, viewAtom, (current: View) => ({ ...current, detail: { kind: 'agent', id } }))
      const light = await read($, lightAtom)
      const heavy = await read($, heavyAtom)
      const known =
        light?.agents?.value.find(agent => agent.id === id) ??
        (await $.agent.list()).find(agent => agent.id === id)
      const brief = await readBrief($, {
        id,
        type: known?.type ?? '',
        description: known?.description ?? '',
      })
      const tree = worktreeOf(light?.project ?? (await $.session.root()), id, light?.worktrees?.value ?? [])
      const branch = await readBranch($, tree.path, heavy?.status?.value.base.name)
      const now = await $.clock.now()
      await update($, activityAtom, (current: Record<string, Activity>) => ({
        ...current,
        [id]: {
          lastTool: '',
          calls: 0,
          step: '',
          startedAt: now,
          updatedAt: now,
          ...current[id],
          brief,
          branch,
        },
      }))
    }),
  runCheck: branch =>
    guarded($, 'check', async () => {
      const put = (result: CheckResult) =>
        update($, checksAtom, (current: Record<string, CheckResult>) => ({
          ...current,
          [branch]: result,
        }))
      const now = await $.clock.now()
      if (!safeBranch(branch)) {
        await put({ at: now, state: 'error', checks: [], error: 'invalid branch name' })

        return
      }
      if (watch.checking.has(branch)) {
        await update($, checksAtom, (current: Record<string, CheckResult>) =>
          current[branch] === undefined
            ? current
            : { ...current, [branch]: { ...current[branch], note: 'already running' } },
        )

        return
      }
      watch.checking.add(branch)
      try {
        await put({ at: now, state: 'running', checks: [] })
        const light = await read($, lightAtom)
        await put(await runAgentCheck($, light?.project ?? (await $.session.root()), branch))
      } finally {
        watch.checking.delete(branch)
      }
    }),
})

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
  const watch: Watch = { cancel: undefined, isRunning: false, checking: new Set() }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // E33g. A check marked running by an earlier load cannot still be running.
    await guarded($, 'agents', async () => {
      await update($, checksAtom, (current: Record<string, CheckResult>) =>
        Object.fromEntries(
          Object.entries(current).map(([branch, result]) => [
            branch,
            result.state === 'running' ? { ...result, state: 'error', error: 'interrupted' } : result,
          ]),
        ),
      )
    })
    await guarded($, 'start', async () => {
      const root = await ensure($, run)
      if (root === undefined) {
        return
      }
      // Its own timer: the light rhythm of the cards, started only for a
      // project with a profile.
      if (watch.cancel === undefined) {
        watch.cancel = $.clock.every(LIGHT_MS, () => {
          void guarded($, 'agents', async () => {
            if (await isPaneOpen($)) {
              await refreshAgents($, watch)
            }
          })
        })
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
    void guarded($, 'agents', () => refreshAgents($, watch))
    void guarded($, 'open', async () => {
      const root = await ensure($, run)
      if (root !== undefined) {
        await refreshHeavy($, run, options, root, false)
      }
    })

    return opened
  })

  // E33g. Rule R1: the launch passes unchanged and never waits for the store.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const agentId = (result as { agentId?: string }).agentId
    if (e.resume === undefined && agentId !== undefined) {
      void guarded($, 'brief', () => captureBrief($, e, agentId, result.model))
    }

    return result
  }).catch(($, e, next) => next(e))

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
      ...agentActions($, watch),
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
