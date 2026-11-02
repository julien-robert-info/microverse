
import type { BoardUi } from '../../types/board'
import {
  LIGHT_SURFACES,
  PALETTE,
  ROLE,
  SPACE,
  TONE,
  textColor,
  tint,
  type Role,
} from './tokens'

// What the surface and the theme allow, derived once per render. The elements
// below read it from `ui` (see `withLook`), so a call site never repeats a test.
export type Look = {
  surface: string
  // Null when the theme is `auto` or unknown: no background is painted then, so
  // a card cannot clash with the host theme.
  theme: 'dark' | 'light' | null
  // The VS Code extension ignores Button `variant`/`plain` and Text `size`.
  hasVariant: boolean
  hasSize: boolean
}

export const lookFor = (surface: string | undefined, theme: Look['theme']): Look => ({
  surface: surface ?? 'terminal',
  theme,
  hasVariant: surface !== 'vscode',
  hasSize: surface !== 'vscode',
})

const DEFAULT_LOOK = lookFor('terminal', null)

export const withLook = (ui: BoardUi, look: Look): BoardUi => ({ ...ui, look }) as unknown as BoardUi

export const lookOf = (ui: BoardUi): Look => (ui as unknown as { look?: Look }).look ?? DEFAULT_LOOK

export const hasSvg = (ui: BoardUi) => ui.Svg !== undefined

// The `theme` line of `$.config.list()`: `dark`/`light` and their variants give
// a theme, `auto` or anything else gives null.
export const themeOf = (list: unknown): Look['theme'] => {
  const entries: unknown[] = Array.isArray(list)
    ? list
    : typeof list === 'object' && list !== null
      ? Object.entries(list)
      : []
  const value = entries
    .map((entry): unknown => {
      if (typeof entry === 'string') {
        const found = /^\s*theme\s*[:=]\s*(.+)$/i.exec(entry)

        return found === null ? undefined : found[1]
      }
      const pair = Array.isArray(entry)
        ? { key: entry[0], value: entry[1] }
        : (entry as { key?: unknown; name?: unknown; value?: unknown })

      return (pair.key ?? (pair as { name?: unknown }).name) === 'theme' ? pair.value : undefined
    })
    .find(one => typeof one === 'string')
  const word = typeof value === 'string' ? value.toLowerCase() : ''

  return word.includes('light') ? 'light' : word.includes('dark') ? 'dark' : null
}

// Read at each render so a changed setting shows at once. `list` is a thunk
// (`() => $.config.list()`): the engine refuses `$.config` passed as a value.
// A failing read is an unknown theme, never a guessed one.
export const readTheme = async (list: () => Promise<unknown>): Promise<Look['theme']> => {
  try {
    return themeOf(await list())
  } catch {
    return null
  }
}

const surfaces = (look: Look) =>
  look.theme === 'light' ? { ...PALETTE, ...LIGHT_SURFACES } : PALETTE

// A background that follows the theme: absent when the theme is unknown.
const paint = (look: Look, hex: string) => (look.theme === null ? {} : { backgroundColor: hex })
const tinted = (look: Look, hue: string) => paint(look, tint(hue, 0.15, surfaces(look).card))

// Text props of a role. The big figure keeps a bold weight where `size` is lost.
export const roleProps = (ui: BoardUi, role: Role): Record<string, unknown> => {
  const look = lookOf(ui)
  const { size: _size, mono: _mono, tabular: _tabular, ...rest } = ROLE[role] as Record<string, unknown>

  return look.hasSize
    ? { ...ROLE[role] }
    : { ...rest, ...(role === 'figure' || role === 'title' ? { weight: 'bold' } : {}) }
}

// Button `variant`, absent where the surface ignores it.
const variantOf = (ui: BoardUi, variant: 'primary' | 'secondary') =>
  lookOf(ui).hasVariant ? { variant } : {}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

// Bar width in cells for a pane of `columns`.
export const cellsFor = (columns: number) => clamp(Math.floor(columns * 0.25), 10, 30)

export type Marker = { at: number; hue: string }

export const fillOf = (percent: number, cells: number) => {
  const fill = clamp(Math.round((percent / 100) * cells), 0, cells)

  return percent > 0 ? Math.max(1, fill) : fill
}

export const markerOf = (at: number, cells: number) =>
  clamp(Math.round((at / 100) * cells), 0, cells - 1)

// Runs of equal cells, `hue` null being the track.
export const barRuns = (percent: number, cells: number, hue: string, markers: Marker[] = []) => {
  const fill = fillOf(percent, cells)
  const color = percent > 100 ? TONE.error : hue
  const cell: (string | null)[] = Array.from({ length: cells }, (_, index) =>
    index < fill ? color : null,
  )
  for (const marker of markers) {
    cell[markerOf(marker.at, cells)] = marker.hue
  }
  const runs: { width: number; hue: string | null }[] = []
  for (const one of cell) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.hue === one) {
      last.width += 1
    } else {
      runs.push({ width: 1, hue: one })
    }
  }

  return runs
}

// Largest-remainder split of `cells` between `values`; a non-zero part keeps
// at least one cell. The sum is `cells`, or 0 when every value is 0.
export const splitCells = (values: number[], cells: number) => {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0)
  if (total <= 0) {
    return values.map(() => 0)
  }
  const quota = values.map(value => (Math.max(0, value) / total) * cells)
  const shares = quota.map(Math.floor)
  const order = quota
    .map((one, index) => ({ index, rest: one - Math.floor(one) }))
    .sort((one, other) => other.rest - one.rest || one.index - other.index)
  for (let left = cells - shares.reduce((sum, one) => sum + one, 0), at = 0; left > 0; left -= 1) {
    shares[order[at % order.length].index] += 1
    at += 1
  }
  for (const [index, value] of values.entries()) {
    if (value > 0 && shares[index] === 0) {
      const biggest = shares.indexOf(Math.max(...shares))
      shares[biggest] -= 1
      shares[index] = 1
    }
  }

  return shares
}

type Children = { children?: unknown }

export const Card = (
  ui: BoardUi,
  props: Children & { inner?: boolean; hue?: string; box?: Record<string, unknown> },
) => {
  const { Box } = ui
  const look = lookOf(ui)
  const { inner = false, hue, children, box = {} } = props
  const body = (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
      {children}
    </Box>
  )

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      paddingX={SPACE.cardX}
      paddingY={SPACE.cardY}
      minWidth={0}
      {...paint(look, inner ? surfaces(look).inner : surfaces(look).card)}
      {...box}
    >
      {hue === undefined ? (
        body
      ) : (
        <Box flexDirection="row" gap={1} minWidth={0}>
          <Box width={1} flexShrink={0} backgroundColor={hue} />
          {body}
        </Box>
      )}
    </Box>
  )
}

export const Pill = (ui: BoardUi, props: { label: string; hue: string }) => {
  const { Box, Text } = ui
  const look = lookOf(ui)

  return (
    <Box paddingX={1} flexShrink={1} minWidth={0} {...tinted(look, props.hue)}>
      {props.hue === TONE.muted ? (
        <Text dimColor wrap="truncate">
          {props.label}
        </Text>
      ) : (
        <Text color={textColor(props.hue)} weight="semibold" wrap="truncate">
          {props.label}
        </Text>
      )}
    </Box>
  )
}

// A run of cells painted with background; an empty `Box` has no height unless
// it is given one.
const Run = (ui: BoardUi, width: number, color: string | undefined, key: string) => {
  const { Box } = ui

  return (
    <Box
      key={key}
      width={width}
      height={1}
      flexShrink={0}
      {...(color === undefined ? {} : { backgroundColor: color })}
    />
  )
}

export const Bar = (
  ui: BoardUi,
  props: { percent: number; cells: number; hue: string; markers?: Marker[] },
) => {
  const { Box } = ui
  const look = lookOf(ui)
  const track = look.theme === null ? undefined : surfaces(look).track

  return (
    <Box flexDirection="row" width={props.cells} height={1} flexShrink={0}>
      {barRuns(props.percent, props.cells, props.hue, props.markers).map((run, index) =>
        Run(ui, run.width, run.hue ?? track, `run:${index}`),
      )}
    </Box>
  )
}

export type Part = { label: string; value: number; hue: string }

export const StackedBar = (ui: BoardUi, props: { parts: Part[]; cells: number }) => {
  const { Box } = ui
  const shares = splitCells(
    props.parts.map(part => part.value),
    props.cells,
  )

  return (
    <Box flexDirection="row" width={props.cells} height={1} flexShrink={0}>
      {props.parts.map((part, index) =>
        shares[index] === 0 ? null : Run(ui, shares[index], part.hue, `part:${index}`),
      )}
    </Box>
  )
}

export const Legend = (ui: BoardUi, props: { parts: Part[] }) => {
  const { Box, Text } = ui

  return (
    <Box flexDirection="row" flexWrap="wrap" gap={2} minWidth={0}>
      {props.parts.map((part, index) => (
        <Box key={`legend:${index}`} flexDirection="row" gap={1} minWidth={0}>
          <Text color={textColor(part.hue)}>●</Text>
          <Text wrap="truncate">{part.label}</Text>
        </Box>
      ))}
    </Box>
  )
}

export const Segmented = (
  ui: BoardUi,
  props: {
    keyOf: (id: string) => string
    items: { id: string; label: string }[]
    active: string
    onSelect: (id: string) => unknown
  },
) => {
  const { Box, Button, Text } = ui

  return (
    <Box flexDirection="row" gap={1} borderStyle="round" paddingX={1} alignSelf="flex-start">
      {props.items.map(item => {
        const isActive = item.id === props.active

        return (
          <Button
            key={props.keyOf(item.id)}
            {...variantOf(ui, isActive ? 'primary' : 'secondary')}
            onPress={() => props.onSelect(item.id)}
          >
            <Text weight={isActive ? 'bold' : undefined} dimColor={!isActive}>
              {isActive ? `▸ ${item.label}` : item.label}
            </Text>
          </Button>
        )
      })}
    </Box>
  )
}

export const Action = (
  ui: BoardUi,
  props: { keyName: string; label: string; primary?: boolean; onPress: () => unknown },
) => {
  const { Button } = ui

  return (
    <Button
      key={props.keyName}
      label={props.label}
      {...variantOf(ui, props.primary === true ? 'primary' : 'secondary')}
      onPress={props.onPress}
    />
  )
}

export const Avatar = (ui: BoardUi, props: { letter: string; hue: string }) => {
  const { Box, Text } = ui

  return (
    <Box width={3} flexShrink={0} justifyContent="center" {...tinted(lookOf(ui), props.hue)}>
      <Text weight="bold" color={textColor(props.hue)}>
        {props.letter}
      </Text>
    </Box>
  )
}

export type Step = { label: string; state: 'done' | 'doing' | 'todo'; when?: string }

export const Steps = (ui: BoardUi, props: { steps: Step[] }) => {
  const { Box, Text } = ui

  return (
    <Box flexDirection="row" flexWrap="wrap" gap={2} minWidth={0}>
      {props.steps.map((step, index) => (
        <Box key={`step:${index}`} flexDirection="row" gap={1} minWidth={0}>
          <Text
            color={
              step.state === 'done'
                ? textColor(TONE.success)
                : step.state === 'doing'
                  ? textColor(TONE.warning)
                  : undefined
            }
            dimColor={step.state === 'todo'}
          >
            ━
          </Text>
          <Text wrap="truncate" dimColor={step.state === 'todo'}>
            {step.when === undefined ? step.label : `${step.label} ${step.when}`}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

export const FoldHeader = (
  ui: BoardUi,
  props: {
    keyName: string
    open: boolean
    label: string
    count?: number
    hue?: string
    onPress: () => unknown
  },
) => {
  const { Box, Button, Text } = ui

  return (
    <Box flexDirection="row" gap={1} minWidth={0}>
      {props.hue !== undefined && <Text color={textColor(props.hue)}>●</Text>}
      <Button key={props.keyName} plain onPress={props.onPress}>
        <Text weight="semibold">
          {`${props.open ? '▾' : '▸'} ${props.label}${props.count === undefined ? '' : ` · ${props.count}`}`}
        </Text>
      </Button>
    </Box>
  )
}

export const Tile = (ui: BoardUi, props: { label: string; value: string; note?: string }) => {
  const { Box, Text } = ui

  return Card(ui, {
    inner: true,
    children: (
      <Box flexDirection="column" minWidth={0}>
        <Text {...roleProps(ui, 'caption')}>{props.label}</Text>
        <Text {...roleProps(ui, 'figure')}>{props.value}</Text>
        {props.note !== undefined && <Text {...roleProps(ui, 'caption')}>{props.note}</Text>}
      </Box>
    ),
  })
}
