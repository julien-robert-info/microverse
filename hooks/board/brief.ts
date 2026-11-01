// The brief an agent was given, read for the Board (rule R2). Pure: the text
// is data, shown as text, never passed to a process.

// What a stored brief keeps (rule R1) and how many briefs are kept.
export const BRIEF_LIMIT = 16_384
export const BRIEF_KEEP = 40
// Lines shown for a brief that does not follow the template.
export const RAW_LINES = 40
const ITEM_CUT = 100
const TEXT_CUT = 280

type Part = 'branch' | 'goal' | 'zone' | 'rules' | 'interface' | 'aside' | 'traps' | 'tests' | 'verify'

// Bold labels at the start of a line, in French and in English, as the labels
// are written in skills/orchestration/brief.md. Compared without accents and
// as a whole word: `But` is a label, `Butter` is not.
const LABELS: [Part, string][] = [
  ['branch', 'branche|branch'],
  ['goal', 'objectif|but|goal'],
  ['zone', 'zone'],
  ['rules', 'regles decidees|decided rules'],
  ['interface', 'stockage et interface|storage and interface|interface|storage'],
  ['aside', 'a cote|along the way'],
  ['traps', 'pieges|traps'],
  ['tests', 'tests attendus|expected tests'],
  ['verify', 'verification'],
]
const MATCHERS = LABELS.map(([part, source]) => ({ part, pattern: new RegExp(`^(?:${source})(?![a-z])`) }))
// The template is recognised from at least this many of these four labels.
const SIGNATURE: Part[] = ['goal', 'zone', 'rules', 'tests']
const SIGNATURE_MIN = 3

// `**Label**` at the start of a line, numbered or not: `4. **Decided rules**,`.
const LABEL_LINE = /^\s{0,3}(?:\d+[.)]\s+)?\*\*([^*]+)\*\*(.*)$/

export type Brief = {
  isTemplate: boolean
  branch: string | null
  goal: string
  zone: string
  verify: string
  // One line per item, in the order written.
  rules: string[]
  traps: string[]
  tests: string[]
  // The first RAW_LINES lines as written.
  raw: string[]
}

const plain = (text: string) => text.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim()

const cut = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

const partOf = (label: string): Part | undefined => {
  const name = fold(label)

  return MATCHERS.find(({ pattern }) => pattern.test(name))?.part
}

// `R1`, `T3` at the start of a line or of a bullet; the first line of an id
// gives its text, and a later mention of the id in a sentence is not an item.
const itemsOf = (lines: string[], letter: 'R' | 'T'): string[] => {
  const start = new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*)?(${letter}\\d+)\\b(.*)$`)
  const seen = new Set<string>()
  const items: string[] = []
  for (const line of lines) {
    const found = start.exec(line)
    if (found !== null && !seen.has(found[1])) {
      seen.add(found[1])
      items.push(cut(plain(`${found[1]} ${found[2]}`), ITEM_CUT))
    }
  }

  return items
}

// The bullets of the least indented level: a sub-bullet belongs to its trap.
const bulletsOf = (lines: string[]): string[] => {
  const bullets = lines
    .map(line => /^(\s*)(?:[-*]|\d+[.)])\s+(.*)$/.exec(line))
    .filter((found): found is RegExpExecArray => found !== null)
  if (bullets.length === 0) {
    return []
  }
  const top = Math.min(...bullets.map(found => found[1].length))

  return bullets
    .filter(found => found[1].length === top)
    .map(found => cut(plain(found[2]), ITEM_CUT))
}

const branchOf = (lines: string[]): string | null => {
  const text = lines.join(' ')
  for (const found of text.matchAll(/`([^`]+)`/g)) {
    if (/^[\w./-]+$/.test(found[1]) && found[1].includes('/')) {
      return found[1]
    }
  }

  return null
}

const paragraph = (lines: string[]) => {
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '')

  return cut(plain((end < 0 ? lines : lines.slice(0, end)).join(' ')), TEXT_CUT)
}

export const parseBrief = (text: string): Brief => {
  const all = text.split(/\r?\n/)
  const sections = new Map<Part, string[]>()
  let current: string[] | undefined
  for (const line of all) {
    const found = LABEL_LINE.exec(line)
    const part = found === null ? undefined : partOf(found[1])
    if (found !== null && part !== undefined && !sections.has(part)) {
      // What follows the label on its own line is the first line of the section.
      current = [found[2].replace(/^[\s:,.–—-]+/, '')]
      sections.set(part, current)
    } else if (current !== undefined) {
      current.push(line)
    }
  }
  const lines = (part: Part) => sections.get(part) ?? []

  return {
    isTemplate: SIGNATURE.filter(part => sections.has(part)).length >= SIGNATURE_MIN,
    branch: branchOf(lines('branch')),
    goal: paragraph(lines('goal')),
    zone: paragraph(lines('zone')),
    verify: paragraph(lines('verify')),
    rules: itemsOf(lines('rules'), 'R'),
    traps: bulletsOf(lines('traps')),
    tests: itemsOf(lines('tests'), 'T'),
    raw: all.slice(0, RAW_LINES),
  }
}

// `E33g board agents` gives `E33g`: the convention of the agent descriptions.
export const missionOf = (description: string): string | null =>
  /^([A-Z]+\d+[a-z]?\d*)(?![\w])/.exec(description.trim())?.[1] ?? null

// A branch name goes to a process as an argument: no `..`, and no leading
// dash that a program would read as an option.
export const safeBranch = (branch: string): boolean =>
  /^[\w./-]+$/.test(branch) && !branch.includes('..') && !branch.startsWith('-')
