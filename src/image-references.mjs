import { HarnessError } from '@deepseek-ai/dsh-llm'

export const GENERATE_IMAGE = 'codex_generate_image'
export const EDIT_IMAGE = 'codex_edit_image'
export const PARTIAL_IMAGE_RESULT = 'Codex saved image result: '
export const maxReferences = 5
const maxHistoricalImages = 4

export const missingImageReference = () => new HarnessError(
  'Select an existing image from this turn’s uploads or the latest Codex image result.', 'CODEX_IMAGE_REFERENCE',
)

function attachmentsFromResult(data) {
  if (!data.message?.isError) {
    if (Array.isArray(data.meta?.attachments)) return data.meta.attachments
    return data.meta?.attachment ? [data.meta.attachment] : []
  }
  if (data.error?.code !== 'ABORTED') return []
  const marker = data.message.content?.find(block => block.type === 'text' && block.text.startsWith(PARTIAL_IMAGE_RESULT))
  if (!marker || marker.text.length > 8192) return []
  try {
    const parsed = JSON.parse(marker.text.slice(PARTIAL_IMAGE_RESULT.length))
    return Array.isArray(parsed.attachments) ? parsed.attachments : []
  } catch { return [] }
}

export function selectCodexImageReferences(events, references, { turnStart, generatedBefore } = {}) {
  if (!Array.isArray(references) || references.length < 1 || references.length > maxReferences) throw missingImageReference()
  const codexCalls = new Set()
  const key = ({ turn, step }, callId) => JSON.stringify([turn, step, callId])
  let uploads = []
  let generated = []
  for (const { type, data, seq } of events) {
    if (type === 'user/message' && data.source?.kind === 'user' && (turnStart === undefined || seq >= turnStart)) {
      uploads = data.content.filter(block => block.type === 'image').map(block => block.attachment)
    } else if (type === 'tool/call' && (data.name === GENERATE_IMAGE || data.name === EDIT_IMAGE)) {
      codexCalls.add(key(data, data.callId))
    } else if (type === 'tool/result' && (generatedBefore === undefined || seq < generatedBefore)
      && codexCalls.has(key(data, data.message?.toolCallId))) {
      const available = attachmentsFromResult(data)
      if (available.length > 0 && available.length <= maxHistoricalImages) generated = available
    }
  }
  return references.map(({ source, index }) => {
    const refs = source === 'current_upload' ? uploads : source === 'latest_generated' ? generated : []
    const ref = refs[index - 1]
    if (!Number.isSafeInteger(index) || index < 1 || typeof ref?.attachmentId !== 'string') throw missingImageReference()
    return ref
  })
}
