import type { EngineInterface } from 'claude-code'

import type {
  AnsweredQuestion,
  BoardContext,
  PendingQuestion,
  QuestionBlock,
  QuestionOption,
  QuestionsLight,
} from '../../types/board'
import { at } from './sensors'

type Engine = EngineInterface

const STATE_FILE = 'CLAUDE.local.md'
const NOTES_DIR = 'notes'
// `$.fs.read` refuses more than this.
const READ_LIMIT = 4 * 1024 * 1024
const MAX_LINE = 500
const SHOWN_ANSWERED = 5
// "Répondu", "Répondue(s)", "Répondus" and "Answered", whatever follows.
const ANSWERED = /^(répondu(?:e|s|es)?|answered)(?![\p{L}])/iu
const WAITING_PREFIX = /^(?:en attente|pending|waiting)\s*:\s*/iu

const stampOf = (stat: { mtimeMs: number; size: number }) => `${stat.mtimeMs}:${stat.size}`

// A question can be answered again once the state file has changed.
export const sentKey = (id: string, stateStamp: string | null) => `${id}@${stateStamp}`

// ---- State file (rule D-2) ------------------------------------------------

// A bullet may continue on indented lines.
const bulletsIn = (lines: string[]): string[] => {
  const start = lines.findIndex(line => /^#{1,6}\s/.test(line) && /question/i.test(line))
  if (start < 0) {
    return []
  }
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^#{1,6}\s/.test(line))
  const bullets: string[] = []
  for (const line of end < 0 ? rest : rest.slice(0, end)) {
    if (/^[-*]\s/.test(line)) {
      bullets.push(line.slice(2).replace(/[`*]/g, '').trim())
    } else if (/^\s+\S/.test(line)) {
      const last = bullets.pop()
      if (last !== undefined) {
        bullets.push(`${last} ${line.replace(/[`*]/g, '').trim()}`)
      }
    }
  }

  return bullets
}

const idsOf = (text: string) => [...new Set(text.match(/\bQ\d+\b/g) ?? [])]

// The file comes from text of the state file: only a plain name under notes/.
const fileOf = (bullet: string) => /\((notes\/[\w.-]+\.md)\)/.exec(bullet)?.[1] ?? null

const titleOf = (bullet: string) => {
  const first = /\bQ\d+\b/.exec(bullet)
  const colon = first === null ? -1 : bullet.slice(first.index).search(/\s*:\s/)
  if (first !== null && colon >= 0) {
    return bullet.slice(first.index + colon).replace(/^\s*:\s*/, '').trim()
  }

  return bullet.replace(/\(notes\/[^)]*\)/, '').replace(/\bQ\d+\b/g, '').trim()
}

// One answer bullet: `Q34 d, Q35 oui`, the answer being a letter or a word.
const answersOf = (bullet: string): AnsweredQuestion[] => {
  const date = /\b\d{4}-\d{2}-\d{2}\b/.exec(bullet)?.[0] ?? null

  return bullet.split(/[,;]/).flatMap(piece =>
    [...piece.matchAll(/\b(Q\d+)\b((?:(?!\bQ\d+\b).)*)/g)].map(found => ({
      id: found[1],
      answer: found[2].replace(/^[\s=:→–-]+/u, '').replace(/[\s.]+$/, '').slice(0, 80),
      date,
    })),
  )
}

// A bullet without `Q<n>` is a note. One that cites several questions lists
// each of them, and an answer settles a question whatever bullet listed it.
export const parseStateQuestions = (
  text: string,
): { pending: PendingQuestion[]; answered: AnsweredQuestion[] } => {
  const answered = new Map<string, AnsweredQuestion>()
  const pending = new Map<string, PendingQuestion>()
  for (const raw of bulletsIn(text.split(/\r?\n/))) {
    if (ANSWERED.test(raw)) {
      answersOf(raw).forEach(one => answered.set(one.id, one))
      continue
    }
    const bullet = raw.replace(WAITING_PREFIX, '')
    const file = fileOf(bullet)
    const title = titleOf(bullet)
    for (const id of idsOf(bullet)) {
      if (!pending.has(id)) {
        pending.set(id, { id, file, title })
      }
    }
  }

  return {
    pending: [...pending.values()].filter(one => !answered.has(one.id)),
    answered: [...answered.values()],
  }
}

// ---- Question block (rule D-1) ---------------------------------------------

const OPTION = /^[-*]\s+\*\*([a-z])[.)]?\*\*\s*(.*)$/
const RECOMMENDATION = /^\*\*\s*(?:Recommandation|Recommendation)\s*:\s*([a-z])\.?\s*\*\*\s*(.*)$/is
const WAITS = /^\*\*\s*(?:Attend|Waits)\s*:?\s*\*\*\s*:?\s*(.*)$/is

// `title : what it changes`; the space before the colon may be a no-break one.
const splitOption = (text: string): { title: string; effect: string } => {
  const found = /^(.*?)\s+:\s+(.*)$/s.exec(text) ?? /^(.*?):\s+(.*)$/s.exec(text)

  return found === null
    ? { title: text.trim(), effect: '' }
    : { title: found[1].trim(), effect: found[2].trim() }
}

const blockOfLines = (id: string, title: string, lines: string[]): QuestionBlock => {
  type Item = { kind: 'option' | 'para'; text: string }
  const items: Item[] = []
  let current: Item | null = null
  for (const line of lines) {
    if (line.trim() === '') {
      current = null
    } else if (OPTION.test(line)) {
      current = { kind: 'option', text: line }
      items.push(current)
    } else if (current !== null && /^\s+\S/.test(line)) {
      current.text += ` ${line.trim()}`
    } else if (current !== null && current.kind === 'para') {
      current.text += ` ${line.trim()}`
    } else {
      current = { kind: 'para', text: line.trim() }
      items.push(current)
    }
  }

  const options: QuestionOption[] = []
  const paragraphs: string[] = []
  let recommended: string | null = null
  let waits: string | null = null
  for (const item of items) {
    const option = item.kind === 'option' ? OPTION.exec(item.text) : null
    const recommendation = item.kind === 'para' ? RECOMMENDATION.exec(item.text) : null
    const wait = item.kind === 'para' ? WAITS.exec(item.text) : null
    if (option !== null) {
      options.push({ letter: option[1], ...splitOption(option[2]) })
    } else if (recommendation !== null) {
      recommended = recommendation[1]
    } else if (wait !== null) {
      waits = wait[1].trim()
    } else {
      paragraphs.push(item.text)
    }
  }

  return {
    id,
    title,
    context: paragraphs.join('\n\n'),
    options,
    // A letter that names no option marks nothing.
    recommended: options.some(one => one.letter === recommended) ? recommended : null,
    waits,
  }
}

// Every `### Q<n>. <question>` block of a notes file. The number is anchored:
// `Q3` never reads a `Q37` block.
export const parseBlocks = (markdown: string): QuestionBlock[] => {
  const lines = markdown.split(/\r?\n/)
  const blocks: QuestionBlock[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const head = /^(#{2,4})\s+(Q\d+)\b\s*[.:)–—-]?\s*(.*)$/u.exec(lines[index])
    if (head === null) {
      continue
    }
    const rest = lines.slice(index + 1)
    const end = rest.findIndex(line => {
      const heading = /^(#{1,6})\s/.exec(line)

      return heading !== null && heading[1].length <= head[1].length
    })
    blocks.push(blockOfLines(head[2], head[3].trim(), end < 0 ? rest : rest.slice(0, end)))
  }

  return blocks
}

// ---- Sensor ----------------------------------------------------------------

// The `.md` files of notes/ that carry blocks: the ones the bullets name, or
// all of them (`wanted` null) once a detail is opened (rule D-3). Re-read only
// when the stamp changed.
export async function readBlockFiles(
  $: Engine,
  root: string,
  wanted: string[] | null,
  previous: QuestionsLight['files'],
): Promise<QuestionsLight['files']> {
  const entries = await $.fs
    .list(at(root, NOTES_DIR))
    .catch(() => [] as Awaited<ReturnType<Engine['fs']['list']>>)
  const files: QuestionsLight['files'] = {}
  for (const entry of entries) {
    if (
      entry.kind !== 'file' ||
      !/^[\w.-]+\.md$/.test(entry.name) ||
      (wanted !== null && !wanted.includes(entry.name)) ||
      entry.size > READ_LIMIT
    ) {
      continue
    }
    const stamp = stampOf(entry)
    const old = previous[entry.name]
    files[entry.name] =
      old?.stamp === stamp
        ? old
        : {
            stamp,
            blocks: parseBlocks(String(await $.fs.read(at(root, `${NOTES_DIR}/${entry.name}`)))),
          }
  }

  return files
}

const namesOf = (pending: PendingQuestion[]) =>
  pending.flatMap(one => (one.file === null ? [] : [one.file.slice(`${NOTES_DIR}/`.length)]))

// Light sensor of the questions: the state file when its stamp changed, the
// notes files the bullets name when theirs did. No model token.
export async function readQuestionsLight(
  $: Engine,
  root: string,
  previous: QuestionsLight | undefined,
  failures: string[],
): Promise<QuestionsLight> {
  const out: QuestionsLight = {
    stateStamp: previous?.stateStamp ?? null,
    pending: previous?.pending ?? [],
    answered: previous?.answered ?? [],
    files: previous?.files ?? {},
    isScanned: previous?.isScanned ?? false,
  }
  const stateFile = at(root, STATE_FILE)
  try {
    const stat = await $.fs.stat(stateFile)
    const stamp = stampOf(stat)
    if (stamp !== previous?.stateStamp) {
      if (stat.size > READ_LIMIT) {
        throw new Error('file too large')
      }
      Object.assign(out, parseStateQuestions(String(await $.fs.read(stateFile))), {
        stateStamp: stamp,
      })
    }
  } catch (error) {
    if (!(await $.fs.exists(stateFile).catch(() => true))) {
      out.pending = []
      out.answered = []
      out.stateStamp = null
    } else {
      failures.push(`questions: ${String(error).replace(/\s+/g, ' ').slice(0, 80)}`)
    }
  }
  try {
    out.files = await readBlockFiles($, root, out.isScanned ? null : namesOf(out.pending), out.files)
  } catch (error) {
    failures.push(`question notes: ${String(error).replace(/\s+/g, ' ').slice(0, 80)}`)
  }

  return out
}

// The block of a question: the one of the file its bullet names; else, once the
// notes were scanned, the only one in all of them. Two candidates are none: a
// wrong set of options is worse than a free answer.
export const blockOf = (questions: QuestionsLight, question: PendingQuestion): QuestionBlock | null => {
  const named =
    question.file === null ? undefined : questions.files[question.file.slice(`${NOTES_DIR}/`.length)]
  const own = named?.blocks.filter(one => one.id === question.id) ?? []
  if (own.length > 0) {
    return own.length === 1 ? own[0] : null
  }
  if (!questions.isScanned) {
    return null
  }
  const all = Object.values(questions.files).flatMap(file =>
    file.blocks.filter(one => one.id === question.id),
  )

  return all.length === 1 ? all[0] : null
}

// ---- Texts that reach the prompt box (rule R4) -----------------------------

// The only text of the option route: built from an Id read in the state file
// and a letter read in a block, never from file text.
export const optionText = (id: string, letter: string): string | null => {
  const text = `${id} ${letter}`

  return /^Q\d+ [a-z]$/.test(text) ? text : null
}

// Julien's own words: one line, no control character, no Unicode separator,
// `Q<id> ` included in the 500 characters. Null when nothing is left.
export const freeText = (id: string, text: string): string | null => {
  if (!/^Q\d+$/.test(id)) {
    return null
  }
  const cleaned = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Zs}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned === '' ? null : Array.from(`${id} ${cleaned}`).slice(0, MAX_LINE).join('').trimEnd()
}

export type Refusal = 'dialog' | 'no_composer' | 'draft' | 'unknown'

// Fills the prompt box, never over a draft: `fill` without `mode` replaces it.
// A function declaration, so that the engine sees `$.prompt` here. Null when the
// box holds the text.
export async function fillAnswer($: Engine, text: string): Promise<Refusal | null> {
  try {
    if ((await $.prompt.read()).text !== '') {
      return 'draft'
    }
    const result = await $.prompt.fill({ text, mode: 'replace' })

    return result.isFilled ? null : (result.refusal ?? 'unknown')
  } catch {
    return 'unknown'
  }
}

// ---- Renders ---------------------------------------------------------------

const REFUSALS: Record<Refusal, string> = {
  dialog: 'A dialog holds the keyboard: close it, then fill again.',
  no_composer: 'This session has no input box here: type the answer yourself.',
  draft: 'Your input box holds a draft: send or clear it, then fill again.',
  unknown: 'The input box did not take the text.',
}

const missionOf = (file: string | null) => file?.slice(`${NOTES_DIR}/`.length).split('.')[0] ?? null

// Markdown draws tab and newline only.
const printable = (text: string) => text.replace(/[^\P{Cc}\t\n]/gu, ' ')

// The answer buttons of one question, on the two-press principle: the first
// press marks, "Fill Q37 a" appears, the second fills the box.
const answerParts = (context: BoardContext, question: PendingQuestion, block: QuestionBlock | null) => {
  const { ui, board, actions } = context
  const { Box, Text, Button } = ui
  const questions = board.light?.questions
  const marked = board.answer.pending?.question === question.id ? board.answer.pending.option : null
  const refusal = board.answer.refusal?.question === question.id ? board.answer.refusal.cause : null
  const isSent = board.answer.sent.includes(sentKey(question.id, questions?.stateStamp ?? null))

  return {
    isSent,
    buttons: (
      <Box flexDirection="column">
        {isSent ? (
          <Text color="success">
            {`${question.id} is in your input box: press Enter there to send it.`}
          </Text>
        ) : (
          <Box flexDirection="column">
            {block?.options.map(option => (
              <Button
                key={`answer:${question.id}:${option.letter}`}
                label={`${marked === option.letter ? '● ' : ''}${option.letter}. ${option.title}${block.recommended === option.letter ? ' (recommended)' : ''}`}
                onPress={() => actions.chooseAnswer(question.id, option.letter)}
              />
            ))}
            {marked !== null && (
              <Button
                key={`fill:${question.id}`}
                label={`Fill ${question.id} ${marked}`}
                onPress={() => actions.sendAnswer()}
              />
            )}
            {refusal !== null && <Text color="warning">{REFUSALS[refusal]}</Text>}
          </Box>
        )}
      </Box>
    ),
  }
}

export const renderQuestions = (context: BoardContext) => {
  const { ui, board, actions } = context
  const { Box, Text, Button } = ui
  const questions = board.light?.questions
  if (questions === undefined || (questions.pending.length === 0 && questions.answered.length === 0)) {
    return null
  }
  const isOpen = board.view.toggled.includes('answered')

  return (
    <Box flexDirection="column">
      <Text weight="semibold">{`Needs your decision (${questions.pending.length})`}</Text>
      {questions.pending.length === 0 && <Text dimColor>Nothing waits on you.</Text>}
      {questions.pending.map(question => (
        <Box key={`question:${question.id}`} flexDirection="column">
          <Box gap={1}>
            <Button
              key={`open:question:${question.id}`}
              plain
              onPress={() => actions.openQuestion(question.id)}
            >
              <Text color="warning" weight="semibold">{question.id}</Text>
              <Text wrap="truncate">{` ${question.title}`}</Text>
            </Button>
          </Box>
          {answerParts(context, question, blockOf(questions, question)).buttons}
        </Box>
      ))}
      {questions.answered.length > 0 && (
        <Box flexDirection="column">
          <Button key="fold:answered" plain onPress={() => actions.toggle('answered')}>
            <Text dimColor>{`${isOpen ? '▾' : '▸'} Answered (${questions.answered.length})`}</Text>
          </Button>
          {isOpen &&
            questions.answered.slice(-SHOWN_ANSWERED).reverse().map(one => (
              <Text key={`answered:${one.id}`} dimColor wrap="truncate">
                {`${one.id} ${one.answer}${one.date === null ? '' : ` · ${one.date}`}`}
              </Text>
            ))}
        </Box>
      )}
    </Box>
  )
}

export const renderQuestionDetail = (context: BoardContext) => {
  const { ui, board, actions } = context
  // The mobile surface has no `Input`: no free answer there.
  const { Box, Text, Markdown, Input } = ui
  const questions = board.light?.questions
  const id = board.view.detail?.id ?? ''
  const question = questions?.pending.find(one => one.id === id)
  if (questions === undefined || question === undefined) {
    const answer = questions?.answered.find(one => one.id === id)

    return (
      <Box flexDirection="column">
        <Text weight="semibold">{id}</Text>
        <Text dimColor>
          {answer === undefined ? 'This question is no longer waiting.' : `Answered: ${answer.answer}`}
        </Text>
      </Box>
    )
  }
  const block = blockOf(questions, question)
  const { isSent, buttons } = answerParts(context, question, block)
  const mission = missionOf(question.file)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text weight="semibold">{`${question.id} ${block?.title ?? question.title}`}</Text>
        {mission !== null && <Text dimColor>{`Mission ${mission}`}</Text>}
      </Box>
      {block === null ? (
        <Box flexDirection="column">
          <Text>{question.title}</Text>
          <Text dimColor>No block found for this question: answer in your own words.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" gap={1}>
          {block.context !== '' && <Markdown key="question:context" text={printable(block.context)} />}
          {block.options.map(option => (
            <Box key={`option:${option.letter}`} flexDirection="column">
              <Text weight="semibold" color={block.recommended === option.letter ? 'success' : undefined}>
                {`${option.letter}. ${option.title}${block.recommended === option.letter ? ' · recommended' : ''}`}
              </Text>
              {option.effect !== '' && <Text dimColor>{option.effect}</Text>}
            </Box>
          ))}
          {block.waits !== null && <Text>{`Waits on: ${block.waits}`}</Text>}
        </Box>
      )}
      {buttons}
      {Input !== undefined && !isSent && (
        <Input
          key={`free:${question.id}`}
          label="Your answer"
          placeholder="in your own words"
          submitLabel="fill"
          onSubmit={(text: string) => actions.sendFreeAnswer(question.id, text)}
        />
      )}
      {questions.answered.length > 0 && (
        <Box flexDirection="column">
          <Text weight="semibold">Answered before</Text>
          {questions.answered.slice(-SHOWN_ANSWERED).reverse().map(one => (
            <Text key={`before:${one.id}`} dimColor wrap="truncate">
              {`${one.id} ${one.answer}${one.date === null ? '' : ` · ${one.date}`}`}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}
