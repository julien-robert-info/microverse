import type { EngineInterface } from 'claude-code'

import type { QuotaSent } from '../../types/board'

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/
const RESEND_MS = 5 * 60_000
const WRITE_TIMEOUT_MS = 10_000

type Window = { used: number; resetsAt: number }

export type QuotaReading = {
  // What statusline.js reads on stdin.
  payload: {
    session_id: string
    rate_limits: Record<string, { used_percentage: number; resets_at: number }>
  }
  // The same figures as the state keeps them (resets in seconds).
  sent: Omit<QuotaSent, 'at'>
}

const windowOf = (
  limits: { kind: string; percentUsed: number; resetsAt?: string }[],
  kind: string,
): Window | null => {
  const found = limits.find(limit => limit.kind === kind)
  // statusline.js multiplies by 1000: seconds here. A window with no usable
  // reset is left out, never written as 0.
  const resetsAt = Date.parse(found?.resetsAt ?? '') / 1000
  if (found === undefined || !Number.isFinite(found.percentUsed) || !Number.isFinite(resetsAt)) {
    return null
  }

  return { used: found.percentUsed, resetsAt }
}

// The counters of the session as statusline.js takes them, or null when there
// is nothing to record. `spend_limit` is not a counter of the launch pace.
export async function readQuota($: EngineInterface): Promise<QuotaReading | null> {
  const { rateLimits } = await $.session.usage()
  const five = windowOf(rateLimits ?? [], 'five_hour')
  const week = windowOf(rateLimits ?? [], 'seven_day')
  if (five === null && week === null) {
    return null
  }
  const sessionId = await $.session.id()
  if (!SESSION_ID.test(sessionId)) {
    return null
  }
  const limit = (window: Window) => ({
    used_percentage: window.used,
    resets_at: window.resetsAt,
  })

  return {
    payload: {
      session_id: sessionId,
      rate_limits: {
        ...(five !== null && { five_hour: limit(five) }),
        ...(week !== null && { seven_day: limit(week) }),
      },
    },
    sent: { five, week },
  }
}

const same = (a: Window | null, b: Window | null) =>
  a === null || b === null ? a === b : a.used === b.used && a.resetsAt === b.resetsAt

// A repeated, unchanged reading would make `at` look recent while the counters
// are not: it goes out only on a change or after RESEND_MS.
export const isDue = (
  previous: QuotaSent | null,
  next: Omit<QuotaSent, 'at'>,
  now: number,
): boolean =>
  previous === null ||
  !same(previous.five, next.five) ||
  !same(previous.week, next.week) ||
  now - previous.at >= RESEND_MS ||
  now < previous.at

// The write goes through statusline.js: it owns the atomic file and the
// history, and `$.fs.write` cannot append. Throws when the run fails.
export async function sendQuota($: EngineInterface, payload: QuotaReading['payload']) {
  const run = await $.process.run(['node', `${$.plugin.root}/scripts/statusline.js`], {
    stdin: JSON.stringify(payload),
    timeoutMs: WRITE_TIMEOUT_MS,
  })
  if (run.exitCode !== 0) {
    throw new Error(`exit ${run.exitCode}`)
  }
}
