import { isRecord } from './typed'

// Both ends of a long message: the instruction is often at the top, the question at the bottom.
export function clip(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, Math.floor(n / 2))}\n…\n${text.slice(-Math.floor(n / 2))}`
}

const STDERR_HEAD_CHARS = 200

// The head of a failed command's stderr, to quote in a line for the person.
export function stderrHead(stderr: string): string {
  return stderr.trim().slice(0, STDERR_HEAD_CHARS)
}

// The one-line head of a tool call's input: the first of these keys that is set.
export function toolInputHead(input: unknown): string {
  if (!isRecord(input)) return ''
  return String(input.command || input.file_path || input.description || input.prompt || input.skill || '')
}

// An absolute path with its `.` and `..` folded, so one file is one path however it was written.
export function absolutePath(path: string, cwd: string): string {
  const full = path.startsWith('/') ? path : `${cwd}/${path}`
  const kept: string[] = []
  for (const part of full.split('/')) {
    if (part === '..') kept.pop()
    else if (part !== '' && part !== '.') kept.push(part)
  }
  return `/${kept.join('/')}`
}

// The paths one tool use touches: a Write, Edit or NotebookEdit's file, a SendUserFile's files.
export function touchedBy(tool: string, input: unknown): string[] {
  if (!isRecord(input)) return []
  if (tool === 'Write' || tool === 'Edit') return typeof input.file_path === 'string' && input.file_path !== '' ? [input.file_path] : []
  if (tool === 'NotebookEdit') return typeof input.notebook_path === 'string' && input.notebook_path !== '' ? [input.notebook_path] : []
  if (tool === 'SendUserFile' && Array.isArray(input.files)) return input.files.filter((f): f is string => typeof f === 'string' && f !== '')
  return []
}

// The agent message before a typed turn, as a reader needs it: its text and its tool calls.
export function actionSummary(message: unknown): string {
  if (!isRecord(message)) return '(session start)'
  const content = message.content ?? []
  if (typeof content === 'string') return `TEXT: ${clip(content.trim(), 600)}`
  if (!Array.isArray(content)) return '(no content)'
  const out: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') out.push(`TEXT: ${clip(block.text.trim(), 600)}`)
    else if (block.type === 'tool_use') out.push(`TOOL ${String(block.name)}: ${clip(toolInputHead(block.input).trim(), 300)}`)
  }
  return out.length > 0 ? out.join('\n') : '(no content)'
}
