import type { EngineInterface } from 'claude-code'

import type {
  MissionRow,
  MissionsHeavy,
  MissionsLight,
  NoteType,
  NotesFile,
  NotesItem,
} from '../../types/board'
import { at } from './sensors'

type Engine = EngineInterface

const STATE_FILE = 'CLAUDE.local.md'
const NOTES_FILE = 'NOTES.local.md'
const NOTES_DIR = 'notes'
// `$.fs.read` refuses more than this.
const READ_LIMIT = 4 * 1024 * 1024
const BRANCH_PREFIXES = /^(?:feat|fix|docs|chore|refactor|test|perf)\//
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' }
const TITLE_CUT = 60
const ITEM_CUT = 280
const MAX_HASHES = 80

// `\b` does not see accented letters: the edges are explicit.
const word = (source: string) =>
  new RegExp(`(?<![\\p{L}])(?:${source})(?![\\p{L}])`, 'iu')

// Tried in this order; the first match gives the type of a heading.
const VOCABULARY: [NoteType, RegExp][] = [
  ['brief', word('brouillons? de brief|draft brief|briefs?')],
  ['decided', word('d[ée]cid[ée]e?s?|decided')],
  ['measures', word('mesures?|constats?|measure(?:ment)?s?')],
  ['risks', word('risques?|d[ée]fauts?|risk(?:y|s)?|defects?')],
  ['open', word('points? ouverts?|questions?|[àa] confirmer|open points?|to confirm')],
  ['verified', word('r[ée]sultats?|essais|v[ée]rifi[ée]e?s?|verified|results?|trials?')],
]

export const NOTE_TYPES: NoteType[] = [
  'decided',
  'measures',
  'risks',
  'open',
  'verified',
  'brief',
  'other',
]

const typeOfTitle = (title: string): NoteType | null =>
  VOCABULARY.find(([, pattern]) => pattern.test(title))?.[0] ?? null

const plain = (text: string) =>
  text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()

const cut = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())

const ticks = (text: string): string[] =>
  [...text.matchAll(/`([^`]+)`/g)].map(match => match[1].trim())

const ID = /^[A-Za-z]+\d+[A-Za-z0-9]*$/
const RANGE = /^[A-Za-z]+\d+[A-Za-z0-9]*(?:\s*(?:[-–,]|et)\s*[A-Za-z]*\d+[A-Za-z0-9]*)+$/

const sectionsCited = (text: string): string[] => {
  const numbers: string[] = []
  for (const match of text.matchAll(/NOTES\s*§§?\s*(\d+)(?:\s*[-–]\s*(\d+))?/g)) {
    const first = Number(match[1])
    const last = match[2] === undefined ? first : Math.min(Number(match[2]), first + 30)
    for (let number = first; number <= last; number += 1) {
      numbers.push(String(number))
    }
  }

  return numbers
}

// Rule E-1. The table is free text in a free language: a line is a mission
// when its first cell looks like an Id (or a range of Ids).
export const parseRows = (text: string): MissionRow[] => {
  const rows: MissionRow[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) {
      continue
    }
    const cells = cellsOf(line)
    const id = cells[0]?.replace(/`/g, '') ?? ''
    const isRange = RANGE.test(id)
    if (cells.length < 2 || !(ID.test(id) || isRange)) {
      continue
    }
    const branch = ticks(cells[1] ?? '').find(token => BRANCH_PREFIXES.test(token)) ?? null
    const state = cells.slice(2).join(' | ')
    rows.push({
      id,
      isRange,
      branch,
      title: cut(plain(state), TITLE_CUT),
      hashes: ticks(line).filter(token => /^[0-9a-f]{7,40}$/.test(token)),
      sections: isRange ? [] : sectionsCited(line),
    })
  }

  return rows
}

const headingOf = (line: string) => /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)

// D4-1: one item per `##` or `###` heading, the first paragraph under it. A
// heading the vocabulary does not know takes the type of the heading it sits
// under, and is `other` when none is classified. A heading with no text of its
// own and sub-headings below is a container, not an item.
export const itemsOf = (markdown: string): NotesItem[] => {
  const lines = markdown.split(/\r?\n/)
  const items: NotesItem[] = []
  const parents: { level: number; type: NoteType | null }[] = []
  let fence = false
  const headings: { index: number; level: number; title: string }[] = []
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
    }
    const heading = fence ? null : headingOf(line)
    if (heading !== null) {
      headings.push({ index, level: heading[1].length, title: heading[2] })
    }
  })
  headings.forEach((heading, position) => {
    while (parents.length > 0 && parents[parents.length - 1].level >= heading.level) {
      parents.pop()
    }
    const own = typeOfTitle(heading.title)
    const inherited = [...parents].reverse().find(parent => parent.type !== null)?.type ?? null
    parents.push({ level: heading.level, type: own })
    if (heading.level !== 2 && heading.level !== 3) {
      return
    }
    const next = headings[position + 1]
    const body = lines.slice(heading.index + 1, next?.index ?? lines.length)
    const first = body.findIndex(line => line.trim() !== '')
    const paragraph: string[] = []
    if (first >= 0) {
      for (const line of body.slice(first)) {
        if (line.trim() === '') {
          break
        }
        paragraph.push(line.trim())
      }
    }
    const text = cut(plain(paragraph.join(' ')), ITEM_CUT)
    if (text === '' && next !== undefined && next.level > heading.level) {
      return
    }
    items.push({
      title: plain(heading.title),
      type: own ?? inherited ?? 'other',
      text,
    })
  })

  return items
}

// D4: the bullets of a section with no `###` that start with « Vérifié » or
// « Décidé » are items of those types.
const bulletItems = (markdown: string): NotesItem[] => {
  const items: NotesItem[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^[-*]\s+(?:\*\*)?(v[ée]rifi[ée]e?s?|d[ée]cid[ée]e?s?)(?![\p{L}])/iu.exec(line)
    if (match !== null) {
      const text = plain(line.replace(/^[-*]\s+/, ''))
      items.push({
        title: cut(text.split(/[:.]/)[0], TITLE_CUT),
        type: /^v/i.test(match[1]) ? 'verified' : 'decided',
        text: cut(text, ITEM_CUT),
      })
    }
  }

  return items
}

// The `## N.` sections of NOTES.local.md, by number.
export const sectionsOf = (markdown: string): Record<string, { title: string; body: string }> => {
  const sections: Record<string, { title: string; body: string }> = {}
  let current: string | null = null
  let fence = false
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
    }
    const heading = fence ? null : /^##\s+(\d+)\.?\s*(.*)$/.exec(line)
    if (heading !== null) {
      current = heading[1]
      sections[current] = { title: plain(heading[2]), body: '' }
    } else if (current !== null) {
      sections[current].body += `${line}\n`
    }
  }

  return sections
}

const stampOf = (stat: { mtimeMs: number; size: number }) => `${stat.mtimeMs}:${stat.size}`

const parseFile = (raw: string, stamp: string): NotesFile => ({
  stamp,
  raw,
  items: itemsOf(raw),
})

const noteFileOf = (name: string, id: string) =>
  name === `${id}.md` || (name.startsWith(`${id}.review-`) && name.endsWith('.md'))

// The notes files of one mission, `notes/<Id>.md` first.
export const filesOf = (missions: MissionsLight, id: string): string[] =>
  Object.keys(missions.notes)
    .filter(name => noteFileOf(name, id))
    .sort()

// Light sensor of the missions. The state file is read when its stamp changed,
// NOTES.local.md (111 KB and more) only when its stamp changed and a row cites
// one of its sections, each notes file when its own stamp changed.
export async function readMissions(
  $: Engine,
  root: string,
  previous: MissionsLight | undefined,
  agentIds: string[],
  failures: string[],
): Promise<MissionsLight> {
  const missions: MissionsLight = {
    stateStamp: previous?.stateStamp ?? null,
    rows: previous?.rows ?? [],
    notes: {},
    sections: previous?.sections ?? {},
    notesStamp: previous?.notesStamp ?? null,
    briefs: {},
  }
  const stateFile = at(root, STATE_FILE)
  try {
    const stat = await $.fs.stat(stateFile)
    const stamp = stampOf(stat)
    if (stamp !== previous?.stateStamp) {
      if (stat.size > READ_LIMIT) {
        throw new Error('file too large')
      }
      missions.rows = parseRows(String(await $.fs.read(stateFile)))
      missions.stateStamp = stamp
    }
  } catch (error) {
    if (!(await $.fs.exists(stateFile).catch(() => true))) {
      missions.rows = []
      missions.stateStamp = null
    } else {
      failures.push(`missions: ${String(error).replace(/\s+/g, ' ').slice(0, 80)}`)
    }
  }

  try {
    const entries = await $.fs
      .list(at(root, NOTES_DIR))
      .catch(() => [] as Awaited<ReturnType<Engine['fs']['list']>>)
    const wanted = missions.rows.filter(row => !row.isRange)
    for (const entry of entries) {
      if (entry.kind !== 'file' || !wanted.some(row => noteFileOf(entry.name, row.id))) {
        continue
      }
      const stamp = stampOf(entry)
      const old = previous?.notes[entry.name]
      if (old?.stamp === stamp) {
        missions.notes[entry.name] = old
      } else if (entry.size <= READ_LIMIT) {
        missions.notes[entry.name] = parseFile(
          String(await $.fs.read(at(root, `${NOTES_DIR}/${entry.name}`))),
          stamp,
        )
      }
    }
  } catch (error) {
    failures.push(`missions notes: ${String(error).replace(/\s+/g, ' ').slice(0, 80)}`)
  }

  const cited = [...new Set(missions.rows.flatMap(row => row.sections))]
  if (cited.length === 0) {
    missions.sections = {}
    missions.notesStamp = null
  } else {
    try {
      const notesFile = at(root, NOTES_FILE)
      const stat = await $.fs.stat(notesFile)
      const stamp = stampOf(stat)
      const unchanged =
        stamp === previous?.notesStamp && cited.every(number => number in missions.sections)
      if (!unchanged && stat.size <= READ_LIMIT) {
        const all = sectionsOf(String(await $.fs.read(notesFile)))
        missions.sections = {}
        for (const number of cited) {
          const section = all[number]
          if (section !== undefined) {
            missions.sections[number] = {
              title: section.title,
              stamp,
              raw: section.body.trim(),
              items: [...itemsOf(section.body), ...bulletItems(section.body)],
            }
          }
        }
        missions.notesStamp = stamp
      }
    } catch {
      // No NOTES.local.md: the rows still stand without their excerpts.
      missions.sections = {}
      missions.notesStamp = null
    }
  }

  for (const id of agentIds) {
    const branch = await briefBranch($, id)
    if (branch !== null) {
      missions.briefs[id] = branch
    }
  }

  return missions
}

// The brief E33g captures under `brief:<agentId>`; absent until it is merged.
export async function briefBranch($: Engine, agentId: string): Promise<string | null> {
  try {
    const brief = (await $.store.get(`brief:${agentId}`)) as { branch?: unknown } | undefined

    return typeof brief?.branch === 'string' && brief.branch !== '' ? brief.branch : null
  } catch {
    return null
  }
}

// Heavy sensor of the missions: one `merge-base --is-ancestor` per cited hash
// that is not yet known to be an ancestor (an ancestor stays one), and the
// briefs of the runs the report lists.
export async function readFacts(
  $: Engine,
  root: string,
  base: string,
  rows: MissionRow[],
  runIds: string[],
  previous: MissionsHeavy | undefined,
): Promise<MissionsHeavy> {
  const facts: MissionsHeavy = { hashes: {}, briefs: { ...previous?.briefs } }
  const hashes = [...new Set(rows.flatMap(row => row.hashes))].slice(0, MAX_HASHES)
  for (const hash of hashes) {
    const known = previous?.hashes[hash]
    if (known?.ancestor === true) {
      facts.hashes[hash] = known
      continue
    }
    try {
      const run = await $.process.run(['git', 'merge-base', '--is-ancestor', hash, base], {
        cwd: root,
        env: GIT_ENV,
      })
      if (run.exitCode !== 0) {
        facts.hashes[hash] = { ancestor: false, at: null }
        continue
      }
      const shown = await $.process.run(['git', 'show', '-s', '--format=%ct', hash], {
        cwd: root,
        env: GIT_ENV,
      })
      const seconds = Number(shown.stdout.trim())
      facts.hashes[hash] = {
        ancestor: true,
        at: shown.exitCode === 0 && Number.isFinite(seconds) ? seconds * 1000 : null,
      }
    } catch {
      // A failed call leaves the hash unknown, not "not merged".
      if (known !== undefined) {
        facts.hashes[hash] = known
      }
    }
  }
  for (const id of runIds) {
    if (!(id in facts.briefs)) {
      const branch = await briefBranch($, id)
      if (branch !== null) {
        facts.briefs[id] = branch
      }
    }
  }

  return facts
}
