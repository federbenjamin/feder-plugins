const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Both ends of a long message: the instruction is often at the top, the question at the bottom.
export function clip(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, Math.floor(n / 2))}\n…\n${text.slice(-Math.floor(n / 2))}`
}

// The one-line head of a tool call's input: the first of these keys that is set.
export function toolInputHead(input: unknown): string {
  if (!isRecord(input)) return ''
  return String(input.command || input.file_path || input.description || input.prompt || input.skill || '')
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
