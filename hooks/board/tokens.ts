// Style tokens of the Board. Colours of the dark mock-up; backgrounds are painted
// only when the host theme is known (see `Look` in kit.tsx).

export const PALETTE = {
  page: '#151513',
  card: '#1e1e1b',
  inner: '#262622',
  border: '#33322d',
  borderStrong: '#3d3c36',
  track: '#2d2c28',
  text: '#ece9e0',
  text2: '#b4b0a4',
  text3: '#8f8b80',
  accent: '#e0825c',
  onAccent: '#1b0f0a',
  green: '#7cc99a',
  yellow: '#e8b657',
  blue: '#86aefc',
  violet: '#b9a2ff',
  teal: '#6fcfc7',
  red: '#f08080',
  mergedBar: '#3f6350',
}

// Surfaces of a light theme. Hues stay the same: they are painted as bars and
// tinted backgrounds, never as the only carrier of a text.
export const LIGHT_SURFACES = {
  card: '#ffffff',
  inner: '#f1efe8',
  track: '#e2dfd5',
}

export const COLUMN_HUE: Record<string, string> = {
  design: PALETTE.violet,
  brief: PALETTE.yellow,
  building: PALETTE.teal,
  review: PALETTE.yellow,
  ready: PALETTE.blue,
  merged: PALETTE.green,
}

export const AGENT_HUE: Record<string, string> = {
  morty: PALETTE.teal,
  rick: PALETTE.violet,
  council: PALETTE.yellow,
}

export const TOOL_HUE: Record<string, string> = {
  Bash: PALETTE.yellow,
  Edit: PALETTE.violet,
  Write: PALETTE.violet,
  Read: PALETTE.blue,
  Grep: PALETTE.blue,
  Glob: PALETTE.blue,
}

export const toolHue = (tool: string) => TOOL_HUE[tool] ?? PALETTE.text2

export const TONE = {
  success: PALETTE.green,
  warning: PALETTE.yellow,
  error: PALETTE.red,
  info: PALETTE.blue,
  muted: PALETTE.text3,
}

// Spacing, in cells.
export const SPACE = { section: 1, inline: 2, cardX: 1, cardY: 0 }

// Text roles, as `Text` props. `size`, `mono` and `tabular` are ignored by the
// VS Code extension; `roleProps` in kit.tsx adds a weight where meaning needs it.
export const ROLE = {
  title: { size: 'title', weight: 'bold' },
  heading: { size: 'heading', weight: 'semibold' },
  body: {},
  secondary: { dimColor: true },
  caption: { size: 'footnote', dimColor: true },
  id: { mono: true },
  figure: { size: 'title', weight: 'semibold', tabular: true },
} as const

export type Role = keyof typeof ROLE

// Text colours use the host theme keys, always legible; the other hues are hex.
const TEXT_KEY: Record<string, string> = {
  [PALETTE.green]: 'success',
  [PALETTE.yellow]: 'warning',
  [PALETTE.red]: 'error',
}

export const textColor = (hue: string) => TEXT_KEY[hue] ?? hue

const channels = (hex: string) =>
  [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16))

// `hex` laid over `over` at `alpha`, as an opaque hex: no rgba() reaches the engine.
export const tint = (hex: string, alpha = 0.15, over = PALETTE.card) => {
  const [top, below] = [channels(hex), channels(over)]

  return `#${top
    .map((value, index) =>
      Math.round(below[index] * (1 - alpha) + value * alpha)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}
