import assert from 'node:assert/strict'
import test from 'node:test'
import { selectCodexImageReferences } from '../src/image-references.mjs'

const ref = attachmentId => ({ attachmentId, mediaType: 'image/png', bytes: 100, width: 1, height: 1 })
const upload = (...attachments) => ({
  type: 'user/message', data: { source: { kind: 'user' },
    content: attachments.map(attachment => ({ type: 'image', attachment })) },
})

test('a later sibling result is outside the model’s reference cut', () => {
  const original = ref('original')
  const sibling = ref('sibling')
  const events = [
    upload(original),
    call('codex_generate_image', 'a', 1), result('a', 1, { attachment: original }),
    call('codex_edit_image', 'b', 2), result('b', 2, { attachment: sibling }),
  ].map((event, seq) => ({ ...event, seq }))
  assert.deepEqual(selectCodexImageReferences(events, [{ source: 'latest_generated', index: 1 }], { generatedBefore: 3 }), [original])
})
const call = (name, callId, step) => ({ type: 'tool/call', data: { name, callId, turn: 1, step } })
const result = (callId, step, meta) => ({ type: 'tool/result',
  data: { turn: 1, step, message: { toolCallId: callId, isError: false }, meta } })

test('scope and ordered indices select this turn’s uploads and latest Codex result', () => {
  const older = ref('older')
  const [first, second, source] = ['first', 'second', 'uploaded'].map(ref)
  const events = [
    upload(older),
    call('codex_generate_image', 'a', 1), result('a', 1, { attachment: older }),
    call('codex_edit_image', 'b', 2), result('b', 2, { attachments: [first, second], requested: 2 }),
    call('other_tool', 'b', 3), result('b', 3, { attachment: older }),
    upload(source),
  ]
  assert.deepEqual(selectCodexImageReferences(events, [
    { source: 'latest_generated', index: 2 }, { source: 'current_upload', index: 1 }, { source: 'latest_generated', index: 1 },
  ]), [second, source, first])
})

test('legacy image results are editable and past uploads do not stand in for this turn', () => {
  const old = ref('legacy')
  const events = [upload(old), call('codex_generate_image', 'a', 1), result('a', 1, { attachment: old }), upload()]
  assert.deepEqual(selectCodexImageReferences(events, [{ source: 'latest_generated', index: 1 }]), [old])
  for (const reference of [{ source: 'latest_generated', index: 2 }, { source: 'current_upload', index: 1 }]) {
    assert.throws(() => selectCodexImageReferences(events, [reference]), { code: 'CODEX_IMAGE_REFERENCE' })
  }
})
